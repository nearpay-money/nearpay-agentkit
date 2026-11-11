/**
 * Full loop per framework: agent (`withX402` + agent-signer) → merchant (Express / Hono / fetch
 * handler with the paywall) → facilitator fake (spec-validated, kit Verifier). The x402 E2E against
 * the sandbox runs in nearpay-testbed.
 */
import type { AddressInfo } from "node:net";
import { nearSigner, staticSaltProvider } from "@nearpay-money/agent-signer";
import express from "express";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { honoPaywall } from "../src/hono.js";
import { decodePaymentResponse, paymentOf, paywall, withPaywall, withX402 } from "../src/index.js";
import { fakeFacilitator, SECRET_KEY, USDC } from "./fake-facilitator.js";

const signer = nearSigner({ keyPair: new Uint8Array(32).fill(8) });
const agent = (f: typeof fetch) =>
  withX402(f, signer, { maxAmountPerRequest: { [USDC]: "10030" }, nonceSaltProvider: staticSaltProvider("252812b3") });

describe("Express", () => {
  const fac = fakeFacilitator();
  let base = "";
  let close: () => void = () => {};
  beforeAll(async () => {
    const app = express();
    app.get(
      "/premium",
      paywall(
        { amount: "10000", description: "Premium content" },
        { secretKey: SECRET_KEY, apiBase: "https://api.test", fetch: fac.fetch },
      ),
      (_req, res) => {
        res.json({ content: "secret", payer: (res.locals.x402 as { payer: string }).payer });
      },
    );
    app.get(
      "/boom",
      paywall(
        { amount: "1" },
        {
          secretKey: SECRET_KEY,
          facilitator: {
            requirements: () => Promise.reject(new TypeError("bug")),
            verify: () => Promise.reject(new Error()),
            settle: () => Promise.reject(new Error()),
            supported: () => Promise.reject(new Error()),
          },
        },
      ),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it("402 for a plain request", async () => {
    const r = await fetch(`${base}/premium`);
    expect(r.status).toBe(402);
    expect(r.headers.get("payment-required")).toBeTruthy();
    expect(await r.json()).toStrictEqual({});
  });

  it("an agent pays and gets the resource with PAYMENT-RESPONSE", async () => {
    const r = await agent(fetch)(`${base}/premium?x=1`);
    expect(r.status).toBe(200);
    expect(await r.json()).toStrictEqual({ content: "secret", payer: signer.signerId });
    expect(decodePaymentResponse(r)).toMatchObject({ success: true, payer: signer.signerId, amount: "10000" });
    const issued = [...fac.issued.values()].at(-1);
    expect(issued?.resourceUrl).toBe(`${base}/premium?x=1`);
    expect(issued?.consumed).toBe(true);
  });

  it("facilitator failures answer 503", async () => {
    const r = await fetch(`${base}/boom`);
    expect(r.status).toBe(503);
  });
});

describe("Hono", () => {
  const fac = fakeFacilitator();
  const app = new Hono<{ Variables: { x402: { payer: string } } }>();
  app.use(
    "/premium",
    honoPaywall({ amount: 10000n }, { secretKey: SECRET_KEY, apiBase: "https://api.test", fetch: fac.fetch }),
  );
  app.get("/premium", (c) => c.json({ content: "secret", payer: c.get("x402").payer }));
  const honoFetch = (async (input: string | URL | Request, init?: RequestInit) =>
    app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;

  it("402, then paid", async () => {
    expect((await honoFetch("https://shop.test/premium")).status).toBe(402);
    const r = await agent(honoFetch)("https://shop.test/premium");
    expect(r.status).toBe(200);
    expect(await r.json()).toStrictEqual({ content: "secret", payer: signer.signerId });
    expect(decodePaymentResponse(r)?.success).toBe(true);
  });
});

describe("fetch handlers (Next.js route handlers)", () => {
  const fac = fakeFacilitator();
  const GET = withPaywall(
    (req: Request, ctx: { params: { id: string } }) =>
      Response.json({ id: ctx.params.id, payer: paymentOf(req)?.payer }, { headers: { "x-handler": "1" } }),
    { amount: "10000" },
    { secretKey: SECRET_KEY, apiBase: "https://api.test", fetch: fac.fetch },
  );
  const handlerFetch = (async (input: string | URL | Request, init?: RequestInit) =>
    GET(input instanceof Request ? input : new Request(String(input), init), { params: { id: "42" } })) as typeof fetch;

  it("402 as JSON, then paid with the handler's headers kept", async () => {
    const first = await handlerFetch("https://shop.test/api/items/42");
    expect(first.status).toBe(402);
    expect(first.headers.get("content-type")).toBe("application/json");
    const r = await agent(handlerFetch)(new Request("https://shop.test/api/items/42", { headers: { "x-agent": "a" } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-handler")).toBe("1");
    expect(await r.json()).toStrictEqual({ id: "42", payer: signer.signerId });
    expect(decodePaymentResponse(r)?.payer).toBe(signer.signerId);
  });
});
