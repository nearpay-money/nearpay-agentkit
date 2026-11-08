/** Mock-backed agent checkout payments (trace T5): sentinel verification gates every signature. */
import { verifySigned } from "@nearpay-internal/intents";
import { describe, expect, it } from "vitest";
import {
  type AgentSignerError,
  nearSigner,
  parseCheckoutUrl,
  payCheckoutSession,
  prepareCheckoutPayment,
  staticSaltProvider,
} from "../src/index.js";
import { ATTEMPT, fakeCheckoutApi, SECRET, SENTINEL_KEY, SESSION, USDC } from "./fake-api.js";
import { hexBytes, vector } from "./support.js";

const v = vector("intents-payloads.json");
const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const signer = nearSigner({ keyPair: hexBytes(v.nep413.seed_hex) });
const url = `https://pay.nearpay.localhost/c/${SESSION}#${SECRET}`;
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

describe("payCheckoutSession", () => {
  it("requirements → sentinel → verify → sign → submit", async () => {
    const api = fakeCheckoutApi({ now: NOW });
    const r = await payCheckoutSession({ url }, signer, opts(api.fetch));
    expect(api.calls).toStrictEqual([
      `POST /v1/checkout/sessions/${SESSION}/agent_pay/requirements`,
      "POST /v1/attestations/deposit_instructions",
      `POST /v1/checkout/sessions/${SESSION}/agent_pay`,
    ]);
    expect(r.submission).toMatchObject({ status: "submitted", agent_payment: "ap_01jbz9k3m4n5p6q7r8s9t0v1w2" });
    expect(r.prepared).toMatchObject({
      attemptId: ATTEMPT,
      livemode: false,
      merchant: { name: "Demo Shop" },
      fingerprint: "YZMN-R81Z-BR",
    });
    const check = verifySigned(api.submitted[0]);
    expect(check.ok && check.message.intents).toStrictEqual([
      {
        intent: "transfer",
        receiver_id: "merchant.near",
        tokens: { [USDC]: "2000000" },
        memo: api.requirement.binding,
      },
      {
        intent: "transfer",
        receiver_id: "treasury.nearpay.near",
        tokens: { [USDC]: "6000" },
        memo: api.requirement.binding,
      },
    ]);
    expect(check.ok && check.message.deadline).toBe(api.requirement.deadline);
  });

  it("refuses when sentinel attested another recipient (compromised API) — nothing is signed or submitted", async () => {
    const api = fakeCheckoutApi({ now: NOW, attestRequirement: (r) => ({ ...r, pay_to: "attacker.near" }) });
    expect(await failure(payCheckoutSession({ url }, signer, opts(api.fetch)))).toBe("attestation_invalid");
    expect(api.submitted).toHaveLength(0);
    expect(api.calls).toHaveLength(2);
  });

  it("refuses a co-signature by an unpinned key", async () => {
    const api = fakeCheckoutApi({ now: NOW, signWith: new Uint8Array(32).fill(3) });
    expect(await failure(payCheckoutSession({ url }, signer, opts(api.fetch)))).toBe("attestation_invalid");
    expect(api.submitted).toHaveLength(0);
  });

  it.each([409, 503])("fails closed when sentinel answers %i", async (status) => {
    const api = fakeCheckoutApi({ now: NOW, sentinelStatus: status });
    const p = payCheckoutSession({ url }, signer, opts(api.fetch));
    await expect(p).rejects.toMatchObject({ code: "attestation_unavailable", details: { status } });
    expect(api.submitted).toHaveLength(0);
  });

  it("refuses without pinned keys before calling anything", async () => {
    const api = fakeCheckoutApi({ now: NOW });
    expect(await failure(payCheckoutSession({ url }, signer, opts(api.fetch, { pinnedKeys: undefined })))).toBe(
      "no_pinned_keys",
    );
    expect(api.calls).toHaveLength(0);
  });

  it("enforces spend limits, recipients and mode before asking sentinel", async () => {
    const api = fakeCheckoutApi({ now: NOW });
    expect(await failure(prepareCheckoutPayment({ url }, signer, opts(api.fetch, { maxAmount: 2_005_999 })))).toBe(
      "spend_limit_exceeded",
    );
    expect(
      await failure(prepareCheckoutPayment({ url }, signer, opts(api.fetch, { allowedPayTo: ["shop.near"] }))),
    ).toBe("pay_to_not_allowed");
    expect(await failure(prepareCheckoutPayment({ url }, signer, opts(api.fetch, { livemode: true })))).toBe(
      "invalid_requirements",
    );
    expect(api.calls.filter((c) => c.includes("attestations"))).toHaveLength(0);
  });

  it("accepts an attempt status newer than the spec (tolerant parsing, spec 0.1.5)", async () => {
    const api = fakeCheckoutApi({ now: NOW, attemptStatus: "teleporting" });
    const r = await payCheckoutSession({ url }, signer, opts(api.fetch));
    expect(r.submission.attempt.status).toBe("teleporting");
  });

  it("surfaces API errors with their code", async () => {
    const api = fakeCheckoutApi({ now: NOW });
    const target = {
      sessionId: SESSION,
      clientSecret: `${SESSION}_secret_${"b".repeat(32)}`,
      apiBase: "https://api.x",
    };
    await expect(payCheckoutSession(target, signer, opts(api.fetch))).rejects.toMatchObject({
      code: "api_error",
      details: { status: 401, apiCode: "client_secret_invalid" },
    });
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(payCheckoutSession({ url }, signer, opts(down))).rejects.toMatchObject({ code: "api_error" });
    const html = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    await expect(payCheckoutSession({ url }, signer, opts(html))).rejects.toThrow(/unexpected response/);
    const proxy = (async () =>
      new Response("bad gateway", { status: 502, headers: { "X-Request-Id": "req_x" } })) as typeof fetch;
    await expect(payCheckoutSession({ url }, signer, opts(proxy))).rejects.toMatchObject({
      details: { status: 502, requestId: "req_x" },
    });
  });
});

describe("parseCheckoutUrl", () => {
  it("reads hosted and embedded URLs; the API is same-origin under /api", () => {
    expect(parseCheckoutUrl(url)).toStrictEqual({
      sessionId: SESSION,
      clientSecret: SECRET,
      apiBase: "https://pay.nearpay.localhost/api",
    });
    expect(parseCheckoutUrl(url.replace("/c/", "/embed/"), "https://api.x").apiBase).toBe("https://api.x");
  });

  it.each([
    "not a url",
    `https://pay.x/c/${SESSION}`,
    `https://pay.x/c/${SESSION}#cs_01jbz9k3m4n5p6q7r8s9t0v1w9_secret_${"a".repeat(32)}`,
    `https://pay.x/l/${SESSION}#${SECRET}`,
  ])("rejects %s", (u) => {
    expect(() => parseCheckoutUrl(u)).toThrow();
  });

  it("checks explicit coordinates", async () => {
    const api = fakeCheckoutApi({ now: NOW });
    const target = { sessionId: "cs_01jbz9k3m4n5p6q7r8s9t0v1w9", clientSecret: SECRET, apiBase: "https://api.x" };
    expect(await failure(payCheckoutSession(target, signer, opts(api.fetch)))).toBe("invalid_requirements");
  });
});

describe("submitCheckoutPayment / waitForCheckoutOutcome", () => {
  it("submits a prepared payment and refuses one prepared for another session", async () => {
    const { submitCheckoutPayment } = await import("../src/index.js");
    const api = fakeCheckoutApi({ now: NOW });
    const prepared = await prepareCheckoutPayment({ url }, signer, opts(api.fetch));
    expect(api.submitted).toHaveLength(0);
    const other = `cs_01jbz9k3m4n5p6q7r8s9t0v1w9`;
    await expect(
      submitCheckoutPayment(
        { sessionId: other, clientSecret: `${other}_secret_${"a".repeat(32)}`, apiBase: "https://x/api" },
        prepared,
      ),
    ).rejects.toThrow(/another session/);
    const s = await submitCheckoutPayment({ url }, prepared, { fetch: api.fetch, timeoutMs: 5000 });
    expect(s.status).toBe("submitted");
  });
  it("reports agent_pay refusals with their HTTP status", async () => {
    const api = fakeCheckoutApi({ now: NOW, agentPayStatus: 400 });
    const e = await payCheckoutSession({ url }, signer, opts(api.fetch)).catch((x) => x);
    expect(e).toMatchObject({ code: "api_error", details: { status: 400, apiCode: "intent_invalid" } });
  });
  it("polls the public session until the payment is final", async () => {
    const { waitForCheckoutOutcome } = await import("../src/index.js");
    const api = fakeCheckoutApi({ now: NOW, intentStatuses: ["processing", "processing", "succeeded"] });
    const slept: number[] = [];
    const r = await waitForCheckoutOutcome(
      { url },
      { fetch: api.fetch, pollMs: 10, sleep: async (ms) => void slept.push(ms) },
    );
    expect(r.final).toBe(true);
    expect(r.session).toMatchObject({ intent_status: "succeeded", status: "complete" });
    expect(slept).toStrictEqual([10, 10]);
  });
  it("returns the last state when the wait runs out", async () => {
    const { waitForCheckoutOutcome, isCheckoutOutcomeFinal } = await import("../src/index.js");
    const api = fakeCheckoutApi({ now: NOW });
    let t = 0;
    const r = await waitForCheckoutOutcome(
      { url },
      {
        fetch: api.fetch,
        waitMs: 5,
        pollMs: 2,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );
    expect(r.final).toBe(false);
    expect(r.session.intent_status).toBe("processing");
    expect(
      isCheckoutOutcomeFinal({
        ...r.session,
        attempt: { status: "refunded" } as never,
      }),
    ).toBe(true);
  });
});
