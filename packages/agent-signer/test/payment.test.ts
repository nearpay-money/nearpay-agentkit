import type { PaymentRequirements } from "@nearpay/spec";
import { verifySigned } from "@nearpay-internal/intents";
import { describe, expect, it } from "vitest";
import {
  AgentSignerError,
  buildTransferMessage,
  buildTransferPayment,
  makeNonce,
  nearSigner,
  staticSaltProvider,
  transferTerms,
  x402DeadlineSeconds,
} from "../src/index.js";
import { hexBytes, vector } from "./support.js";

const v = vector("intents-payloads.json");
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const x402: PaymentRequirements = {
  scheme: "exact",
  network: "near:mainnet",
  amount: "10000",
  asset: USDC,
  payTo: "merchant.near",
  maxTimeoutSeconds: 120,
  extra: {
    assetTransferMethod: "intents-transfer",
    paymentFlow: "authorization",
    fee: { to: "treasury.nearpay.near", amount: "25" },
    binding: v.binding,
    verifyingContract: "intents.near",
  },
};
const checkout = {
  pay_to: "merchant.near",
  token: USDC,
  amount: "2000000",
  fee_to: "treasury.nearpay.near",
  fee_amount: "6000",
  binding: v.binding,
  deadline: "2026-11-06T12:02:00Z",
};
const signer = nearSigner({ keyPair: hexBytes(v.raw_ed25519.seed_hex) });
const base = { nonceSaltProvider: staticSaltProvider("252812b3"), now: () => NOW };

describe("transferTerms", () => {
  it("reads x402 requirements: deadline is half the settlement window", () => {
    const t = transferTerms(x402, NOW);
    expect(t).toMatchObject({
      kind: "x402",
      payTo: "merchant.near",
      amount: "10000",
      feeTo: "treasury.nearpay.near",
      feeAmount: "25",
    });
    expect(Date.parse(t.latestDeadline) - NOW).toBe(60_000);
    expect(x402DeadlineSeconds(30)).toBe(15);
  });

  it("reads checkout requirements with their own deadline", () => {
    expect(transferTerms(checkout, NOW)).toMatchObject({
      kind: "checkout",
      latestDeadline: "2026-11-06T12:02:00.000Z",
    });
  });

  it("rejects anything else", () => {
    const bad = (r: unknown) => () => transferTerms(r as PaymentRequirements, NOW);
    expect(bad({ ...x402, network: "eip155:8453" })).toThrow(AgentSignerError);
    expect(bad({ ...x402, extra: { ...x402.extra, assetTransferMethod: "permit2" } })).toThrow(/intents-transfer/);
    expect(bad({ ...checkout, binding: "nope" })).toThrow(/IntentsRequirement/);
    expect(bad({ ...checkout, amount: "0" })).toThrow(/positive/);
    expect(bad(null)).toThrow(AgentSignerError);
  });
});

describe("buildTransferMessage / buildTransferPayment", () => {
  it("builds exactly the two transfers with memo = binding, in order", async () => {
    const m = await buildTransferMessage(x402, signer.signerId, base);
    expect(m.verifying_contract).toBe("intents.near");
    expect(m.intents).toStrictEqual([
      { intent: "transfer", receiver_id: "merchant.near", tokens: { [USDC]: "10000" }, memo: v.binding },
      { intent: "transfer", receiver_id: "treasury.nearpay.near", tokens: { [USDC]: "25" }, memo: v.binding },
    ]);
    expect(m.deadline).toBe("2026-11-06T12:01:00.000Z");
    expect(Buffer.from(m.nonce, "base64").subarray(0, 4).toString("hex")).toBe("252812b3");
  });

  it("signs payloads the Verifier accepts", async () => {
    const r = verifySigned(await buildTransferPayment(checkout, signer, base));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.deadline).toBe("2026-11-06T12:02:00.000Z");
  });

  it("uses fresh random nonces", async () => {
    const a = await buildTransferMessage(checkout, signer.signerId, base);
    const b = await buildTransferMessage(checkout, signer.signerId, base);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("accepts an earlier deadline and refuses one outside (now, latest]", async () => {
    const early = await buildTransferMessage(checkout, signer.signerId, { ...base, deadline: new Date(NOW + 30_000) });
    expect(early.deadline).toBe("2026-11-06T12:00:30.000Z");
    for (const deadline of ["2026-11-06T12:03:00Z", "2026-11-06T11:59:00Z", "garbage"]) {
      await expect(buildTransferMessage(checkout, signer.signerId, { ...base, deadline })).rejects.toThrow(/deadline/);
    }
  });

  it("refuses an expired checkout requirement", async () => {
    await expect(
      buildTransferMessage(checkout, signer.signerId, { ...base, now: () => Date.parse("2026-11-06T12:05:00Z") }),
    ).rejects.toThrow(/passed/);
  });

  it("propagates salt errors", async () => {
    await expect(
      buildTransferMessage(checkout, signer.signerId, { ...base, nonceSaltProvider: async () => "XYZ" }),
    ).rejects.toThrow(/salt/);
  });
});

describe("makeNonce", () => {
  it("is salt ‖ 28 bytes, base64", () => {
    const n = makeNonce("00ff00ff", () => new Uint8Array(28).fill(1));
    expect(Buffer.from(n, "base64").toString("hex")).toBe(`00ff00ff${"01".repeat(28)}`);
    expect(() => makeNonce("00ff00ff", () => new Uint8Array(27))).toThrow(/28/);
    expect(() => makeNonce("00FF00FF")).toThrow(AgentSignerError);
  });
});
