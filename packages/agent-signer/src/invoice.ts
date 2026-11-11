/**
 * An agent paying a hosted invoice (FR-AGT-05, lld/sdks-and-tools.md §2, billing §5): the hosted URL
 * `<pay origin>/i/<in_…>#<invoice secret>` carries the invoice secret in its fragment. The agent reads the
 * invoice (`getPublicInvoice`), opens or continues its checkout session (`createPublicInvoiceSession`,
 * header `X-NearPay-Invoice-Secret`) and pays that session through the existing checkout flow
 * (`agent_pay/requirements` → sentinel attestation → sign → `agent_pay`). No new contract.
 */
import {
  createPublicInvoiceSession,
  getPublicInvoice,
  HEADERS,
  type InvoicePaymentSession,
  type PublicInvoice,
  type z,
} from "@nearpay-money/spec";
import {
  type CheckoutPaymentOptions,
  type CheckoutPaymentResult,
  type CheckoutSessionRef,
  parseCheckoutUrl,
  payCheckoutSession,
} from "./checkout.js";
import { AgentSignerError } from "./errors.js";
import { callRoute } from "./http.js";
import type { IntentSigner } from "./signers.js";

const INVOICE_SECRET_RE = /^(in_[0-7][0-9a-z]{25})_secret_[0-9A-Za-z]{32}$/;

export type PublicInvoiceT = z.output<typeof PublicInvoice>;
export type InvoicePaymentSessionT = z.output<typeof InvoicePaymentSession>;

export interface InvoiceRef {
  invoiceId: string;
  invoiceSecret: string;
  /** API base of the payer routes (default `<origin>/api`, the same-origin gateway). */
  apiBase: string;
}

/** Reads a hosted invoice URL `…/i/<in_…>#<in_…_secret_…>`. */
export function parseInvoiceUrl(url: string, apiBase?: string): InvoiceRef {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AgentSignerError("invalid_requirements", "invoice URL is not a URL");
  }
  const path = /^\/i\/(in_[0-7][0-9a-z]{25})\/?$/.exec(u.pathname);
  const secret = decodeURIComponent(u.hash.slice(1));
  const m = INVOICE_SECRET_RE.exec(secret);
  if (!path || !m || m[1] !== path[1]) {
    throw new AgentSignerError(
      "invalid_requirements",
      "not a hosted invoice URL with an invoice secret (…/i/in_…#in_…_secret_…)",
    );
  }
  return { invoiceId: path[1] as string, invoiceSecret: secret, apiBase: apiBase ?? `${u.origin}/api` };
}

/** What a payment URL points at: a checkout session, or an invoice whose session is opened on demand. */
export type PaymentUrl = { kind: "checkout"; ref: CheckoutSessionRef } | { kind: "invoice"; ref: InvoiceRef };

/** Classifies a hosted checkout (`/c/`, `/embed/`) or hosted invoice (`/i/`) URL. */
export function parsePaymentUrl(url: string, apiBase?: string): PaymentUrl {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    throw new AgentSignerError("invalid_requirements", "payment URL is not a URL");
  }
  return path.startsWith("/i/")
    ? { kind: "invoice", ref: parseInvoiceUrl(url, apiBase) }
    : { kind: "checkout", ref: parseCheckoutUrl(url, apiBase) };
}

type HttpOptions = Pick<CheckoutPaymentOptions, "fetch" | "timeoutMs">;

const http = (ref: InvoiceRef, o: HttpOptions) => ({
  base: ref.apiBase,
  ...(o.fetch ? { fetch: o.fetch } : {}),
  ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
  params: { id: ref.invoiceId },
  headers: { [HEADERS.invoiceSecret]: ref.invoiceSecret },
});

/** `getPublicInvoice`: the invoice as the hosted page shows it (read-only). */
export async function getInvoice(ref: InvoiceRef, opts: HttpOptions = {}): Promise<PublicInvoiceT> {
  return (await callRoute(getPublicInvoice, http(ref, opts))).data as PublicInvoiceT;
}

export interface OpenedInvoiceSession {
  invoice: PublicInvoiceT;
  session: InvoicePaymentSessionT;
  checkout: CheckoutSessionRef;
}

/**
 * Reads the invoice, refuses one that is not payable (or of the other mode), then creates or continues
 * its checkout session. The returned `checkout` reference pays through `payCheckoutSession`.
 */
export async function openInvoiceSession(
  ref: InvoiceRef,
  opts: HttpOptions & { livemode?: boolean; locale?: string } = {},
): Promise<OpenedInvoiceSession> {
  const invoice = await getInvoice(ref, opts);
  if (opts.livemode !== undefined && invoice.livemode !== opts.livemode) {
    throw new AgentSignerError(
      "invalid_requirements",
      `invoice is in ${invoice.livemode ? "live" : "test"} mode; this agent pays ${opts.livemode ? "live" : "test"} only`,
    );
  }
  if (!invoice.payable) {
    throw new AgentSignerError("invalid_requirements", `invoice ${invoice.number} is not payable (${invoice.status})`);
  }
  const session = (
    await callRoute(createPublicInvoiceSession, {
      ...http(ref, opts),
      body: opts.locale ? { locale: opts.locale } : {},
    })
  ).data as InvoicePaymentSessionT;
  if (!session.client_secret.startsWith(`${session.checkout_session}_secret_`)) {
    throw new AgentSignerError("invalid_requirements", "invoice session returned a client secret of another session");
  }
  return {
    invoice,
    session,
    checkout: { sessionId: session.checkout_session, clientSecret: session.client_secret, apiBase: ref.apiBase },
  };
}

export interface InvoicePaymentResult extends CheckoutPaymentResult {
  invoice: PublicInvoiceT;
  session: InvoicePaymentSessionT;
  checkout: CheckoutSessionRef;
}

/** Pays a hosted invoice: open its session, then the sentinel-verified checkout payment. */
export async function payInvoice(
  target: InvoiceRef | { url: string; apiBase?: string },
  signer: IntentSigner,
  opts: CheckoutPaymentOptions,
): Promise<InvoicePaymentResult> {
  const ref = "url" in target ? parseInvoiceUrl(target.url, target.apiBase) : target;
  const opened = await openInvoiceSession(ref, opts);
  const paid = await payCheckoutSession(opened.checkout, signer, opts);
  return { ...opened, ...paid };
}
