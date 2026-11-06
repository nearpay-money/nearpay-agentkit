import { describe, expect, it } from "vitest";
import { enforceSpendPolicy, limitFor, type TransferTerms } from "../src/index.js";

const terms: TransferTerms = {
  kind: "x402",
  payTo: "merchant.near",
  asset: "nep141:usdc.near",
  amount: "10000",
  feeTo: "treasury.nearpay.near",
  feeAmount: "25",
  binding: "np1:x",
  latestDeadline: "2026-11-06T12:00:00Z",
};

describe("spend policy", () => {
  it("limits amount + fee in base units", () => {
    expect(enforceSpendPolicy(terms, { maxAmount: 10_025 })).toBe(10_025n);
    expect(() => enforceSpendPolicy(terms, { maxAmount: "10024" })).toThrow(/exceeds/);
    expect(enforceSpendPolicy(terms, { maxAmount: 10_025n })).toBe(10_025n);
  });

  it("supports per-asset limits; unlisted assets are refused", () => {
    expect(enforceSpendPolicy(terms, { maxAmount: { "nep141:usdc.near": "20000" } })).toBe(10_025n);
    expect(() => enforceSpendPolicy(terms, { maxAmount: { "nep141:wrap.near": "1" } })).toThrow(/not in this agent/);
    expect(limitFor({ toString: "5" }, "toString")).toBe(5n);
    expect(limitFor({}, "constructor")).toBeNull();
  });

  it("restricts recipients", () => {
    expect(() => enforceSpendPolicy(terms, { maxAmount: 1e6, allowedPayTo: ["shop.near"] })).toThrow(/not allowed/);
    expect(enforceSpendPolicy(terms, { maxAmount: 1e6, allowedPayTo: ["merchant.near"] })).toBe(10_025n);
  });

  it("validates limits", () => {
    expect(() => limitFor(1.5, "a")).toThrow(RangeError);
    expect(() => limitFor("-1", "a")).toThrow(RangeError);
    expect(() => limitFor(-1, "a")).toThrow(RangeError);
  });
});
