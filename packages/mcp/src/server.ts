/**
 * The NearPay MCP server (lld/sdks-and-tools.md §2, Stage 3).
 *
 * Merchant tools (merchant key): `nearpay_create_checkout_session`, `nearpay_get_payment_intent`,
 * `nearpay_list_payments`. Payer tools (the operator's NEAR Intents key, NEP-413):
 * `nearpay_pay_checkout_session` (checkout `…/c/<cs>#<secret>` or hosted invoice `…/i/<in>#<secret>`
 * URLs; sentinel-verified), `nearpay_fetch_paid` (x402, `intents-transfer` and cross-chain
 * `near-intents`), `nearpay_resume_paid_fetch` (a pending cross-chain payment) and `nearpay_get_spending`.
 *
 * Payer safety: every payment must pay a merchant on the configured allow-list, stays within the
 * per-call limit (a tool argument can lower it, never raise it) and the per-session budget (shared by all
 * clients of this server process), and returns evidence links. Keys and secrets never appear in logs or
 * results.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AgentSignerError,
  ApiCallError,
  type BudgetUsage,
  type CheckoutSessionRef,
  type OpenedInvoiceSession,
  openInvoiceSession,
  parsePaymentUrl,
  prepareCheckoutPayment,
  SpendingBudget,
  type SpendLimit,
  submitCheckoutPayment,
  toBaseUnits,
  transferTerms,
  waitForCheckoutOutcome,
} from "@nearpay/agent-signer";
import {
  CheckoutSessionCreate,
  createCheckoutSession,
  getPaymentIntent,
  listPaymentIntents,
  SPEC_VERSION,
  z,
} from "@nearpay/spec";
import {
  isOperationOpen,
  memoryOperationStore,
  type OperationStore,
  resumeX402Operation,
  type WithX402Options,
  withX402,
  X402ClientError,
  type X402Operation,
  type X402PaymentEvent,
} from "@nearpay/x402";
import {
  DEFAULT_API_BASE,
  DEFAULT_LIMITS,
  DEFAULT_PAYMENT_HOSTS,
  type NearPayMcpOptions,
  validateOptions,
} from "./config.js";
import { type EvidenceLink, objectEvidence, txEvidence } from "./evidence.js";
import { type MerchantClient, merchantClient, NearPayApiError } from "./merchant.js";
import { type Logger, redact, stderrLogger } from "./redact.js";

export const SERVER_NAME = "nearpay";
export const SERVER_VERSION = "0.2.0";

export const MERCHANT_TOOLS = [
  "nearpay_create_checkout_session",
  "nearpay_get_payment_intent",
  "nearpay_list_payments",
] as const;
export const PAYER_TOOLS = [
  "nearpay_pay_checkout_session",
  "nearpay_fetch_paid",
  "nearpay_resume_paid_fetch",
  "nearpay_get_spending",
] as const;

/** State shared by every MCP session of one server process (the session budget lives here). */
export interface NearPayMcpContext {
  readonly options: NearPayMcpOptions;
  readonly merchant: MerchantClient | null;
  readonly budget: SpendingBudget | null;
  readonly store: OperationStore | null;
  readonly log: Logger;
  readonly secrets: readonly string[];
}

export function createNearPayMcpContext(options: NearPayMcpOptions): NearPayMcpContext {
  validateOptions(options);
  const secrets = [...(options.secrets ?? []), ...(options.merchantApiKey ? [options.merchantApiKey] : [])];
  const log = options.logger ?? stderrLogger(secrets);
  const p = options.payer;
  if (p && !p.store && p.crossChain) {
    log("warn", "cross-chain operations are kept in memory only; set a state directory to survive restarts");
  }
  return {
    options,
    merchant: options.merchantApiKey
      ? merchantClient({
          apiKey: options.merchantApiKey,
          apiBase: options.apiBase ?? DEFAULT_API_BASE,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : null,
    budget: p ? new SpendingBudget(p.limits ?? DEFAULT_LIMITS) : null,
    store: p ? (p.store ?? memoryOperationStore()) : null,
    log,
    secrets,
  };
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

const jsonSafe = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

function ok(ctx: NearPayMcpContext, data: Record<string, unknown>): CallToolResult {
  // Results carry no secret by construction (checkout URLs of created sessions are the merchant's to share);
  // configured literals (keys, tokens) are masked as a last line of defence.
  const safe = jsonSafe(data) as Record<string, unknown>;
  const text = redact(JSON.stringify(safe, null, 2), ctx.secrets);
  return { content: [{ type: "text", text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
}

export function errorInfo(e: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (e instanceof X402ClientError) {
    return { code: e.code, message: e.message, ...(e.operationId ? { details: { operation_id: e.operationId } } : {}) };
  }
  if (e instanceof ApiCallError) {
    return {
      code: "api_error",
      message: e.message,
      details: { status: e.status, ...(e.apiCode ? { api_code: e.apiCode } : {}) },
    };
  }
  if (e instanceof AgentSignerError)
    return { code: e.code, message: e.message, ...(e.details ? { details: { ...e.details } } : {}) };
  if (e instanceof NearPayApiError) {
    return {
      code: "api_error",
      message: e.message,
      details: {
        status: e.status,
        ...(e.code ? { api_code: e.code } : {}),
        ...(e.param ? { param: e.param } : {}),
        ...(e.requestId ? { request_id: e.requestId } : {}),
      },
    };
  }
  if (e instanceof z.ZodError) return { code: "invalid_arguments", message: z.prettifyError(e) };
  if (e instanceof ToolRefusal) return { code: e.code, message: e.message };
  return { code: "internal_error", message: (e as Error)?.message ?? String(e) };
}

function fail(ctx: NearPayMcpContext, tool: string, e: unknown): CallToolResult {
  const info = errorInfo(e);
  const message = redact(info.message, ctx.secrets);
  ctx.log(info.code === "internal_error" ? "error" : "warn", "tool refused or failed", {
    tool,
    code: info.code,
    message,
  });
  const body = { error: { code: info.code, message, ...(info.details ? { details: jsonSafe(info.details) } : {}) } };
  return {
    isError: true,
    content: [{ type: "text", text: redact(JSON.stringify(body, null, 2), ctx.secrets) }],
    structuredContent: JSON.parse(redact(JSON.stringify(body), ctx.secrets)) as Record<string, unknown>,
  };
}

export class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolRefusal";
  }
}

const usageOut = (u: BudgetUsage) => ({
  asset: u.asset,
  spent: u.committed.toString(),
  reserved: u.reserved.toString(),
  per_call_limit: u.perCall?.toString() ?? null,
  session_limit: u.perSession?.toString() ?? null,
  remaining: u.remaining?.toString() ?? null,
});

/** The per-call limit lowered to `max` (base units) for every asset; never raised. */
export function capLimit(limit: SpendLimit, max: string | undefined): SpendLimit {
  if (max === undefined) return limit;
  const cap = toBaseUnits(max, "max_amount");
  const low = (v: bigint | string | number) => {
    const b = toBaseUnits(v, "limit");
    return (b < cap ? b : cap).toString();
  };
  if (typeof limit === "object") return Object.fromEntries(Object.entries(limit).map(([a, v]) => [a, low(v)]));
  return low(limit);
}

const BaseUnitsArg = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .describe("Base units of the payment asset (e.g. 1000000 = 1.00 USDC).");

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

export function createNearPayMcpServer(ctxOrOptions: NearPayMcpContext | NearPayMcpOptions): McpServer {
  const ctx = "budget" in ctxOrOptions ? ctxOrOptions : createNearPayMcpContext(ctxOrOptions);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        `NearPay (${ctx.options.livemode ? "LIVE mode: real funds" : "test mode: sandbox funds"}, spec ${SPEC_VERSION}).`,
        ctx.merchant ? "Merchant tools act on the configured NearPay account." : "",
        ctx.budget
          ? "Payer tools spend from the agent's wallet: only allow-listed merchants, within per-call and per-session limits (see nearpay_get_spending). Amounts are base units."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    },
  );
  if (ctx.merchant) registerMerchantTools(server, ctx, ctx.merchant);
  if (ctx.budget && ctx.store && ctx.options.payer) registerPayerTools(server, ctx);
  return server;
}

function registerMerchantTools(server: McpServer, ctx: NearPayMcpContext, api: MerchantClient) {
  const createInput = z.object({
    ...CheckoutSessionCreate.shape,
    idempotency_key: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Reuse the same key when retrying, so a retry never creates a second session."),
  });
  server.registerTool(
    "nearpay_create_checkout_session",
    {
      title: "Create a NearPay checkout session",
      description:
        "Creates a hosted (or embedded) checkout session for one payment and returns it, including `url` (share it with the payer; it carries the session's client secret). Amount: fiat minor units (integer) or asset base units (string, with currency `asset` and `asset_id`).",
      inputSchema: createInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { idempotency_key, ...rest } = args as z.infer<typeof createInput>;
        const body = CheckoutSessionCreate.parse(rest);
        const r = await api.call<Record<string, unknown>>(createCheckoutSession, {
          body,
          ...(idempotency_key ? { idempotencyKey: idempotency_key } : {}),
        });
        const { client_secret: _cs, ...session } = r.data;
        return ok(ctx, {
          checkout_session: session,
          idempotency_key: r.idempotencyKey ?? null,
          request_id: r.requestId ?? null,
        });
      } catch (e) {
        return fail(ctx, "nearpay_create_checkout_session", e);
      }
    },
  );

  server.registerTool(
    "nearpay_get_payment_intent",
    {
      title: "Get a NearPay payment intent",
      description:
        "Retrieves a payment intent (`pi_…`) with its status, amounts, fees and attempts; each settled attempt carries its on-chain evidence (`attempts[].evidence.tx_hash`, `explorer_url`).",
      inputSchema: getPaymentIntent.params as z.ZodObject,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const params = (getPaymentIntent.params as z.ZodObject).parse(args) as { id: string };
        const r = await api.call<Record<string, unknown>>(getPaymentIntent, { params });
        return ok(ctx, { payment_intent: r.data });
      } catch (e) {
        return fail(ctx, "nearpay_get_payment_intent", e);
      }
    },
  );

  const listQuery = listPaymentIntents.query as unknown as z.ZodObject;
  const listInput = z.object({
    ...listQuery.shape,
    metadata: z
      .record(z.string().max(40), z.string().max(500))
      .optional()
      .describe("Exact-match metadata filters (up to 10), sent as metadata[key]=value."),
  });
  server.registerTool(
    "nearpay_list_payments",
    {
      title: "List NearPay payments",
      description:
        "Lists payment intents, newest first (limit 1–100; page with starting_after = the last id). Filters: status, created[gte|lte] (unix seconds), amount[…], currency, asset_id, source, customer, checkout_session, invoice, metadata.",
      inputSchema: listInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { metadata, ...rest } = args as z.infer<typeof listInput>;
        const query: Record<string, unknown> = { ...rest };
        for (const [k, v] of Object.entries(metadata ?? {})) query[`metadata[${k}]`] = v;
        const parsed = (listPaymentIntents.query as unknown as z.ZodType).parse(query) as Record<string, unknown>;
        const r = await api.call<{ data: unknown[]; has_more: boolean }>(listPaymentIntents, { query: parsed });
        const last = r.data.data.at(-1) as { id?: string } | undefined;
        return ok(ctx, {
          payments: r.data.data,
          has_more: r.data.has_more,
          next_starting_after: r.data.has_more && last?.id ? last.id : null,
        });
      } catch (e) {
        return fail(ctx, "nearpay_list_payments", e);
      }
    },
  );
}

function registerPayerTools(server: McpServer, ctx: NearPayMcpContext) {
  const p = ctx.options.payer as NonNullable<NearPayMcpOptions["payer"]>;
  const budget = ctx.budget as SpendingBudget;
  const store = ctx.store as OperationStore;
  const limits = p.limits ?? DEFAULT_LIMITS;
  const livemode = ctx.options.livemode;
  const f = ctx.options.fetch ?? fetch;
  const hosts = p.paymentHosts ?? DEFAULT_PAYMENT_HOSTS;

  const checkPaymentUrl = (url: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ToolRefusal("invalid_arguments", "url is not a URL");
    }
    if (!hosts.includes(u.host)) {
      throw new ToolRefusal(
        "payment_host_not_allowed",
        `${u.host} is not a configured NearPay payment host (${hosts.join(", ")})`,
      );
    }
    if (u.protocol !== "https:" && !(p.allowHttp && u.protocol === "http:")) {
      throw new ToolRefusal("invalid_arguments", "payment URLs must use https");
    }
  };

  const checkResourceUrl = (url: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ToolRefusal("invalid_arguments", "url is not a URL");
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    const httpOk = p.allowHttp === true || (!livemode && local);
    if (!(u.protocol === "https:" || (u.protocol === "http:" && httpOk))) {
      throw new ToolRefusal("invalid_arguments", "only https resources can be paid");
    }
  };

  // --- checkout / invoice --------------------------------------------------------------------
  const payInput = z.object({
    url: z
      .string()
      .max(2048)
      .describe(
        "Hosted checkout URL `https://<pay host>/c/cs_…#<client secret>` or hosted invoice URL `https://<pay host>/i/in_…#<invoice secret>`.",
      ),
    max_amount: BaseUnitsArg.optional().describe(
      "Refuse to pay more than this (amount + fee, base units); lowers the per-call limit.",
    ),
    wait_seconds: z
      .int()
      .min(0)
      .max(120)
      .optional()
      .describe("How long to wait for the final payment state (default 30)."),
  });
  server.registerTool(
    "nearpay_pay_checkout_session",
    {
      title: "Pay a NearPay checkout session or invoice",
      description:
        "Pays a NearPay checkout session, or a hosted invoice (opens the invoice's checkout session first), from the agent's NEAR Intents balance. The payment requirement is co-signed by NearPay's sentinel and verified with pinned keys before anything is signed; the merchant must be on the allow-list and the total within the spending limits. Returns the attested merchant, amounts, final status and evidence.",
      inputSchema: payInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const tool = "nearpay_pay_checkout_session";
      try {
        const a = payInput.parse(args);
        checkPaymentUrl(a.url);
        const target = parsePaymentUrl(a.url, p.payApiBase);
        const http = { fetch: f };
        let invoice: OpenedInvoiceSession | null = null;
        let ref: CheckoutSessionRef;
        if (target.kind === "invoice") {
          invoice = await openInvoiceSession(target.ref, { ...http, livemode });
          ref = invoice.checkout;
        } else {
          ref = target.ref;
        }
        const prepared = await prepareCheckoutPayment(ref, p.signer, {
          ...http,
          ...(p.pinnedKeys ? { pinnedKeys: p.pinnedKeys } : {}),
          maxAmount: capLimit(limits.perCall, a.max_amount),
          allowedPayTo: p.allowedPayTo,
          livemode,
          ...(p.nonceSaltProvider ? { nonceSaltProvider: p.nonceSaltProvider } : {}),
        });
        const terms = transferTerms(prepared.requirement);
        const total = BigInt(terms.amount) + BigInt(terms.feeAmount);
        const reservation = budget.reserve(terms.asset, total, {
          label: "checkout payment",
          ...(a.max_amount ? { maxAmount: a.max_amount } : {}),
        });
        let submission: Awaited<ReturnType<typeof submitCheckoutPayment>>;
        try {
          submission = await submitCheckoutPayment(ref, prepared, http);
          reservation.commit();
        } catch (e) {
          // A 4xx means agentpay refused before queueing anything; anything else may have been relayed.
          if (e instanceof ApiCallError && e.status >= 400 && e.status < 500) reservation.release();
          else reservation.commit();
          throw e;
        }
        ctx.log("info", "checkout payment submitted", {
          checkout_session: ref.sessionId,
          agent_payment: submission.agent_payment,
          pay_to: terms.payTo,
          asset: terms.asset,
          total: total.toString(),
        });
        let outcome: Awaited<ReturnType<typeof waitForCheckoutOutcome>> | null = null;
        let outcomeError: string | null = null;
        try {
          outcome = await waitForCheckoutOutcome(ref, {
            ...http,
            waitMs: (a.wait_seconds ?? (p.checkoutWaitMs ?? 30_000) / 1000) * 1000,
          });
        } catch (e) {
          outcomeError = redact((e as Error).message, ctx.secrets);
        }
        const s = outcome?.session;
        const evidence: EvidenceLink[] = [
          objectEvidence("agent_payment", submission.agent_payment, "the merchant sees this agent payment"),
          objectEvidence("checkout_session", ref.sessionId),
          ...(s ? [objectEvidence("payment_intent", s.payment_intent)] : []),
          ...(invoice ? [objectEvidence("invoice", invoice.invoice.id, `invoice ${invoice.invoice.number}`)] : []),
          objectEvidence(
            "attestation",
            prepared.attestation.kid,
            `sentinel attestation verified (destination ${prepared.fingerprint})`,
          ),
        ];
        return ok(ctx, {
          status:
            s?.intent_status === "succeeded"
              ? "succeeded"
              : outcome?.final
                ? (s?.intent_status ?? "unknown")
                : "submitted",
          final: outcome?.final ?? false,
          livemode: prepared.livemode,
          merchant: { ...prepared.merchant, pay_to: terms.payTo, destination_fingerprint: prepared.fingerprint },
          payment: { asset: terms.asset, amount: terms.amount, fee: terms.feeAmount, total: total.toString() },
          checkout_session: { id: ref.sessionId, status: s?.status ?? null, intent_status: s?.intent_status ?? null },
          attempt: { id: submission.attempt.id, status: s?.attempt?.status ?? submission.attempt.status },
          ...(invoice
            ? {
                invoice: {
                  id: invoice.invoice.id,
                  number: invoice.invoice.number,
                  amount_remaining: invoice.invoice.amount_remaining,
                },
              }
            : {}),
          ...(outcomeError ? { status_error: outcomeError } : {}),
          evidence,
          budget: usageOut(budget.usage(terms.asset)),
        });
      } catch (e) {
        return fail(ctx, tool, e);
      }
    },
  );

  // --- x402 -----------------------------------------------------------------------------------
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  const fetchInput = z.object({
    url: z.string().max(4096).describe("The resource to fetch (https)."),
    method: z.enum(methods).optional().describe("HTTP method (default GET)."),
    headers: z.record(z.string().max(256), z.string().max(8192)).optional().describe("Request headers."),
    body: z.string().max(1_000_000).optional().describe("Request body (text)."),
    max_amount: BaseUnitsArg.optional().describe(
      "Refuse to pay more than this (base units); lowers the per-call limit.",
    ),
    cross_chain: z
      .boolean()
      .optional()
      .describe("Allow paying cross-chain (near-intents) when configured (default true)."),
    max_wait_seconds: z
      .int()
      .min(0)
      .max(600)
      .optional()
      .describe("Cross-chain: how long to wait for settlement before answering pending (default 120)."),
  });

  const runPaidFetch = async (
    tool: string,
    send: (opts: WithX402Options, events: X402PaymentEvent[]) => Promise<Response>,
    over: { maxAmount?: string; crossChain?: boolean; waitS?: number },
  ): Promise<CallToolResult> => {
    const events: X402PaymentEvent[] = [];
    const cc = p.crossChain;
    const opts: WithX402Options = {
      maxAmountPerRequest: capLimit(limits.perCall, over.maxAmount),
      allowedPayTo: p.allowedPayTo,
      budget,
      ...(p.nonceSaltProvider ? { nonceSaltProvider: p.nonceSaltProvider } : {}),
      ...(cc && over.crossChain !== false
        ? {
            crossChain: {
              originSigner: cc.originSigner,
              store,
              maxWaitMs: (over.waitS ?? (p.fetchWaitMs ?? 120_000) / 1000) * 1000,
              ...(cc.origins ? { origins: cc.origins } : {}),
              ...(cc.slippageBps !== undefined ? { slippageBps: cc.slippageBps } : {}),
              ...(cc.balance ? { balance: cc.balance } : {}),
            },
          }
        : {}),
      onPayment: (e) => events.push(e),
    };
    try {
      const res = await send(opts, events);
      return ok(ctx, {
        ...(await responseOut(res, p.maxResponseBytes ?? 65_536)),
        ...paymentOut(events, budget, livemode),
      });
    } catch (e) {
      if (e instanceof X402ClientError && e.code === "settlement_pending" && e.operationId) {
        const op = await store.get(e.operationId);
        return ok(ctx, {
          status: "pending",
          paid: true,
          message: `${e.message}. Call nearpay_resume_paid_fetch with this operation_id later; do not pay again.`,
          operation: op ? operationOut(op, livemode) : { id: e.operationId },
        });
      }
      return fail(ctx, tool, e);
    }
  };

  server.registerTool(
    "nearpay_fetch_paid",
    {
      title: "Fetch an x402-paywalled resource, paying with NearPay",
      description:
        "Fetches a URL; if it answers 402 with a NearPay x402 requirement, pays it and retries. Pays from the agent's NEAR Intents balance (intents-transfer) or, when configured, cross-chain from an origin wallet (near-intents: quote, deposit, wait for delivery to the merchant). Only allow-listed merchants, within the spending limits. Returns the response (status, headers, body) and the payment with evidence; a slow cross-chain settlement returns status pending with an operation_id for nearpay_resume_paid_fetch.",
      inputSchema: fetchInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const a = fetchInput.parse(args);
        checkResourceUrl(a.url);
        const headers = new Headers(a.headers);
        headers.delete("payment-signature");
        return runPaidFetch(
          "nearpay_fetch_paid",
          (opts) =>
            withX402(
              f,
              p.signer,
              opts,
            )(a.url, {
              method: a.method ?? "GET",
              headers,
              ...(a.body !== undefined ? { body: a.body } : {}),
            }),
          {
            ...(a.max_amount ? { maxAmount: a.max_amount } : {}),
            ...(a.cross_chain !== undefined ? { crossChain: a.cross_chain } : {}),
            ...(a.max_wait_seconds !== undefined ? { waitS: a.max_wait_seconds } : {}),
          },
        );
      } catch (e) {
        return fail(ctx, "nearpay_fetch_paid", e);
      }
    },
  );

  const resumeInput = z.object({
    operation_id: z.string().max(128).describe("operation_id from a pending nearpay_fetch_paid result."),
    tx_hash: z
      .string()
      .max(256)
      .optional()
      .describe("Only for an operation whose deposit is unknown: the deposit transaction found on chain."),
    headers: z
      .record(z.string().max(256), z.string().max(8192))
      .optional()
      .describe("Request headers for the retried request."),
    body: z.string().max(1_000_000).optional().describe("Request body for the retried request."),
    max_wait_seconds: z.int().min(0).max(600).optional().describe("How long to wait for settlement (default 120)."),
  });
  server.registerTool(
    "nearpay_resume_paid_fetch",
    {
      title: "Resume a pending cross-chain x402 payment",
      description:
        "Presents the deposit of a pending cross-chain payment again and returns the resource once the merchant is paid. Never deposits or pays again.",
      inputSchema: resumeInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const a = resumeInput.parse(args);
        const cc = p.crossChain;
        if (!cc) throw new ToolRefusal("cross_chain_not_configured", "cross-chain payments are not configured");
        const headers = new Headers(a.headers);
        headers.delete("payment-signature");
        return runPaidFetch(
          "nearpay_resume_paid_fetch",
          (opts) =>
            resumeX402Operation(f, a.operation_id, {
              ...opts,
              crossChain: opts.crossChain ?? { originSigner: cc.originSigner, store },
              init: { headers, ...(a.body !== undefined ? { body: a.body } : {}) },
              ...(a.tx_hash ? { txHash: a.tx_hash } : {}),
            }),
          { ...(a.max_wait_seconds !== undefined ? { waitS: a.max_wait_seconds } : {}) },
        );
      } catch (e) {
        return fail(ctx, "nearpay_resume_paid_fetch", e);
      }
    },
  );

  server.registerTool(
    "nearpay_get_spending",
    {
      title: "Show the agent's NearPay spending limits",
      description:
        "Shows what this server may still spend per asset (per-call limit, session limit, spent, remaining), the merchant allow-list, the mode and open cross-chain operations.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const ops = (await store.list()).filter(isOperationOpen);
        return ok(ctx, {
          livemode,
          payer: p.signer.signerId,
          allowed_pay_to: p.allowedPayTo,
          cross_chain: p.crossChain ? { origins: p.crossChain.origins ?? "any payable" } : null,
          sentinel_keys_pinned: (p.pinnedKeys ?? []).length,
          limits: budget.snapshot().map(usageOut),
          open_operations: ops.map((o) => operationOut(o, livemode)),
        });
      } catch (e) {
        return fail(ctx, "nearpay_get_spending", e);
      }
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Payment and response summaries
// ---------------------------------------------------------------------------------------------

const TEXTUAL =
  /^(text\/|application\/(json|xml|javascript|ld\+json|problem\+json|x-www-form-urlencoded)|[^;]*\+json|[^;]*\+xml)/i;

export async function responseOut(res: Response, max: number) {
  const type = res.headers.get("content-type") ?? "";
  const buf = new Uint8Array(await res.arrayBuffer());
  const truncated = buf.length > max;
  const slice = truncated ? buf.slice(0, max) : buf;
  return {
    status: res.status,
    ok: res.ok,
    content_type: type || null,
    ...(TEXTUAL.test(type) || type === ""
      ? { body: new TextDecoder().decode(slice) }
      : { body_base64: Buffer.from(slice).toString("base64") }),
    body_bytes: buf.length,
    truncated,
  };
}

export function operationOut(op: X402Operation, livemode: boolean) {
  return {
    id: op.id,
    state: op.state,
    resource_url: op.resourceUrl,
    origin: {
      network: op.quoted.network,
      asset: op.quoted.extra.originAssetId ?? op.quoted.asset,
      amount: op.quoted.amount,
      deposit_address: op.quoted.payTo,
    },
    merchant: op.quoted.extra.destination,
    refund_to: op.refundTo,
    refund_deadline: op.quoted.extra.refundDeadline ?? null,
    ...(op.txHash ? { deposit: txEvidence("deposit_tx", op.quoted.network, op.txHash, livemode) } : {}),
    ...(op.error ? { error: op.error } : {}),
  };
}

export function paymentOut(events: X402PaymentEvent[], budget: SpendingBudget, livemode: boolean) {
  const e = events.at(-1);
  if (!e) return { paid: false };
  if (e.method === "intents-transfer") {
    const s = e.settlement;
    const total = BigInt(e.requirements.amount) + BigInt(e.requirements.extra.fee.amount);
    const evidence: EvidenceLink[] =
      s?.success && s.transaction ? [txEvidence("settlement_tx", s.network, s.transaction, livemode)] : [];
    return {
      paid: s?.success === true,
      payment: {
        method: e.method,
        success: s?.success ?? null,
        replayed: e.replayed,
        error_reason: s?.errorReason ?? null,
        merchant: e.requirements.payTo,
        asset: e.requirements.asset,
        amount: e.requirements.amount,
        fee: e.requirements.extra.fee.amount,
        total: total.toString(),
        evidence,
      },
      budget: usageOut(budget.usage(e.requirements.asset)),
    };
  }
  const s = e.settlement;
  const op = e.operation;
  const asset = op.quoted.extra.originAssetId ?? op.quoted.asset;
  const evidence: EvidenceLink[] = [
    ...(op.txHash ? [txEvidence("deposit_tx", op.quoted.network, op.txHash, livemode)] : []),
    ...(s?.success && s.transaction ? [txEvidence("settlement_tx", s.network, s.transaction, livemode)] : []),
    ...(s?.extra?.agentPayment
      ? [objectEvidence("agent_payment", s.extra.agentPayment, "the merchant sees this agent payment")]
      : []),
  ];
  return {
    paid: s?.success === true,
    payment: {
      method: e.method,
      success: s?.success ?? null,
      replayed: e.replayed,
      error_reason: s?.errorReason ?? null,
      merchant: op.quoted.extra.destination,
      deposited: { network: op.quoted.network, asset, amount: op.quoted.amount },
      refund_to: op.refundTo,
      operation_id: op.id,
      evidence,
    },
    budget: usageOut(budget.usage(asset)),
  };
}
