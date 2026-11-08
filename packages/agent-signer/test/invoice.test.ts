/** Hosted invoice payments (FR-AGT-05): invoice secret → invoice session → the sentinel-verified checkout flow. */
import { describe, expect, it } from "vitest";
import {
  type AgentSignerError,
  nearSigner,
  openInvoiceSession,
  parseInvoiceUrl,
  parsePaymentUrl,
  payInvoice,
  staticSaltProvider,
} from "../src/index.js";
import { fakeCheckoutApi, INVOICE, INVOICE_SECRET, SECRET, SENTINEL_KEY, SESSION, USDC } from "./fake-api.js";
import { hexBytes, vector } from "./support.js";

const v = vector("intents-payloads.json");
const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const signer = nearSigner({ keyPair: hexBytes(v.nep413.seed_hex) });
const url = `https://pay.nearpay.localhost/i/${INVOICE}#${INVOICE_SECRET}`;
const opts = (fetch: typeof globalThis.fetch, over: Record<string, unknown> = {}) => ({
  fetch,
  pinnedKeys: [SENTINEL_KEY],
  maxAmount: { [USDC]: "2006000" },
  nonceSaltProvider: staticSaltProvider("252812b3"),
  now: () => NOW,
  ...over,
});
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as AgentSignerError).code;
  }
  return "no error";
};

describe("parseInvoiceUrl / parsePaymentUrl", () => {
  it("reads the invoice id and secret from a hosted invoice URL", () => {
    expect(parseInvoiceUrl(url)).toStrictEqual({
      invoiceId: INVOICE,
      invoiceSecret: INVOICE_SECRET,
      apiBase: "https://pay.nearpay.localhost/api",
    });
    expect(parseInvoiceUrl(url, "https://api.x").apiBase).toBe("https://api.x");
    expect(parsePaymentUrl(url)).toMatchObject({ kind: "invoice", ref: { invoiceId: INVOICE } });
    expect(parsePaymentUrl(`https://pay.nearpay.localhost/c/${SESSION}#${SECRET}`)).toMatchObject({
      kind: "checkout",
      ref: { sessionId: SESSION },
    });
  });
  it.each([
    "not a url",
    `https://pay.nearpay.localhost/i/${INVOICE}`,
    `https://pay.nearpay.localhost/i/${INVOICE}#in_01jbz9k3m4n5p6q7r8s9t0v1w9_secret_${"b".repeat(32)}`,
    `https://pay.nearpay.localhost/x/${INVOICE}#${INVOICE_SECRET}`,
  ])("refuses %s", (u) => {
    expect(() => parseInvoiceUrl(u)).toThrow(/invoice URL/);
  });
  it("refuses a non-URL payment URL", () => {
    expect(() => parsePaymentUrl("nope")).toThrow(/not a URL/);
  });
});

describe("payInvoice", () => {
  it("reads the invoice, opens its session, then pays it through agent_pay", async () => {
    const api = fakeCheckoutApi({ now: NOW });
    const r = await payInvoice({ url }, signer, opts(api.fetch));
    expect(api.calls).toStrictEqual([
      `GET /v1/invoices/${INVOICE}/public`,
      `POST /v1/invoices/${INVOICE}/public/sessions`,
      `POST /v1/checkout/sessions/${SESSION}/agent_pay/requirements`,
      "POST /v1/attestations/deposit_instructions",
      `POST /v1/checkout/sessions/${SESSION}/agent_pay`,
    ]);
    expect(r.invoice.number).toBe("DEMO-0001");
    expect(r.checkout).toStrictEqual({
      sessionId: SESSION,
      clientSecret: SECRET,
      apiBase: "https://pay.nearpay.localhost/api",
    });
    expect(r.submission.status).toBe("submitted");
    expect(api.submitted).toHaveLength(1);
  });
  it("accepts an InvoiceRef and a locale", async () => {
    const api = fakeCheckoutApi({ now: NOW });
    const opened = await openInvoiceSession(parseInvoiceUrl(url), { fetch: api.fetch, locale: "en" });
    expect(opened.session.reused).toBe(false);
    const r = await payInvoice(parseInvoiceUrl(url), signer, opts(api.fetch));
    expect(r.submission.agent_payment).toMatch(/^ap_/);
  });
  it("refuses an invoice that is not payable, before any session is opened", async () => {
    const api = fakeCheckoutApi({ now: NOW, invoicePayable: false, invoiceStatus: "paid" });
    expect(await failure(payInvoice({ url }, signer, opts(api.fetch)))).toBe("invalid_requirements");
    expect(api.calls).toStrictEqual([`GET /v1/invoices/${INVOICE}/public`]);
  });
  it("refuses an invoice of the other mode", async () => {
    const api = fakeCheckoutApi({ now: NOW, invoiceLivemode: true });
    expect(await failure(payInvoice({ url }, signer, opts(api.fetch, { livemode: false })))).toBe(
      "invalid_requirements",
    );
    expect(api.submitted).toHaveLength(0);
  });
  it("refuses a session whose client secret belongs to another session", async () => {
    const api = fakeCheckoutApi({
      now: NOW,
      invoiceClientSecret: `cs_01jbz9k3m4n5p6q7r8s9t0v1w9_secret_${"a".repeat(32)}`,
    });
    expect(await failure(payInvoice({ url }, signer, opts(api.fetch)))).toBe("invalid_requirements");
    expect(api.submitted).toHaveLength(0);
  });
  it("surfaces a wrong invoice secret as an API error", async () => {
    const api = fakeCheckoutApi({ now: NOW });
    const bad = `https://pay.nearpay.localhost/i/${INVOICE}#${INVOICE}_secret_${"c".repeat(32)}`;
    expect(await failure(payInvoice({ url: bad }, signer, opts(api.fetch)))).toBe("api_error");
  });
});
