/**
 * MCP test harness: a real SDK client connected to the NearPay MCP server over the in-memory transport,
 * with every outbound call routed by origin to spec-driven fakes:
 *   https://api.test               → spec-validating mock (merchant routes)
 *   https://pay.nearpay.localhost  → agent-signer's checkout/invoice/sentinel fake
 *   https://merchant.test          → an x402 paywall (@nearpay-money/x402) backed by the facilitator fake
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { nearSigner, staticSaltProvider } from "@nearpay-money/agent-signer";
import { type PaywallConfig, withPaywall } from "@nearpay-money/x402";
import { fakeCheckoutApi, SENTINEL_KEY } from "../../../agent-signer/test/fake-api.js";
import { hexBytes, vector } from "../../../agent-signer/test/support.js";
import { SECRET_KEY as FACILITATOR_KEY, fakeFacilitator } from "../../../x402/test/fake-facilitator.js";
import { createNearPayMcpContext, createNearPayMcpServer, type NearPayMcpOptions } from "../../src/index.js";
import { specMock } from "./spec-mock.js";

export const NOW = Date.now();
export const MERCHANT_KEY = "sk_test_merchant000000000000000000";
const v = vector("intents-payloads.json");
/** The operator's local NEAR key (test vector seed), as `ed25519:<base58>` would be configured. */
export const NEAR_SEED = hexBytes(v.nep413.seed_hex);
export const signer = nearSigner({ keyPair: NEAR_SEED });

export interface HarnessOptions {
  checkout?: Parameters<typeof fakeCheckoutApi>[0] extends infer T ? Partial<T> : never;
  facilitator?: Parameters<typeof fakeFacilitator>[0];
  paywall?: PaywallConfig;
  options?: (o: NearPayMcpOptions) => NearPayMcpOptions;
}

export async function harness(h: HarnessOptions = {}) {
  const api = specMock();
  const checkout = fakeCheckoutApi({ now: NOW, ...h.checkout });
  const fac = fakeFacilitator(h.facilitator ?? {});
  const served: Request[] = [];
  const paywall = withPaywall(
    async (req) => {
      served.push(req);
      return new Response(JSON.stringify({ premium: true }), { headers: { "content-type": "application/json" } });
    },
    h.paywall ?? { amount: "10000", description: "Premium" },
    { secretKey: FACILITATOR_KEY, apiBase: "https://api.facilitator.test", fetch: fac.fetch },
  );
  const outbound: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const u = new URL(req.url);
    outbound.push(`${req.method} ${u.origin}${u.pathname}`);
    if (u.origin === "https://api.test") return api.fetch(req);
    if (u.origin === "https://pay.nearpay.localhost") {
      const body = req.method === "GET" ? undefined : await req.text();
      return checkout.fetch(req.url, { method: req.method, headers: req.headers, ...(body ? { body } : {}) });
    }
    if (u.origin === "https://merchant.test") return paywall(req);
    throw new TypeError(`unexpected outbound request to ${u.origin}`);
  }) as typeof globalThis.fetch;

  const logs: string[] = [];
  const base: NearPayMcpOptions = {
    livemode: false,
    apiBase: "https://api.test",
    merchantApiKey: MERCHANT_KEY,
    fetch,
    logger: (level, msg, fields) => logs.push(JSON.stringify({ level, msg, ...fields })),
    payer: {
      signer,
      allowedPayTo: ["merchant.near"],
      pinnedKeys: [SENTINEL_KEY],
      paymentHosts: ["pay.nearpay.localhost"],
      nonceSaltProvider: staticSaltProvider("252812b3"),
      checkoutWaitMs: 0,
    },
  };
  const options = h.options ? h.options(base) : base;
  const ctx = createNearPayMcpContext(options);
  const server = createNearPayMcpServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  /** Calls a tool; returns its structured result and whether it is an error. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
    // biome-ignore lint/suspicious/noExplicitAny: test results are inspected loosely
    return { isError: r.isError === true, data: r.structuredContent as any, text };
  };
  return { api, checkout, fac, served, outbound, logs, ctx, client, call, close: () => client.close() };
}
