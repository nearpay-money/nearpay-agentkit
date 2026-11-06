/** Property: whatever the (valid) requirement, the signed payload pays exactly what it asks, verifiably. */
import { verifySigned } from "@nearpay-internal/intents";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildTransferPayment, nearSigner, staticSaltProvider } from "../src/index.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const account = fc.stringMatching(/^[a-z][a-z0-9]{1,20}\.near$/);
const amount = fc.bigInt({ min: 1n, max: 10n ** 30n }).map(String);
const fee = fc.bigInt({ min: 0n, max: 10n ** 12n }).map(String);
const binding = fc.stringMatching(/^np1:[1-9A-HJ-NP-Za-km-z]{44}$/);

describe("buildTransferPayment (property)", () => {
  it("signs exactly [merchant transfer, fee transfer] with memo = binding for every requirement", async () => {
    const signer = nearSigner({ keyPair: new Uint8Array(32).fill(1) });
    await fc.assert(
      fc.asyncProperty(
        account,
        amount,
        fee,
        binding,
        fc.integer({ min: 31, max: 3600 }),
        async (payTo, amt, f, b, secs) => {
          const req = {
            pay_to: payTo,
            token: "nep141:usdc.near",
            amount: amt,
            fee_to: "treasury.nearpay.near",
            fee_amount: f,
            binding: b,
            deadline: new Date(NOW + secs * 1000).toISOString(),
          };
          const r = verifySigned(
            await buildTransferPayment(req, signer, {
              nonceSaltProvider: staticSaltProvider("00000000"),
              now: () => NOW,
            }),
          );
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.message.intents).toStrictEqual([
            { intent: "transfer", receiver_id: payTo, tokens: { "nep141:usdc.near": amt }, memo: b },
            { intent: "transfer", receiver_id: "treasury.nearpay.near", tokens: { "nep141:usdc.near": f }, memo: b },
          ]);
          expect(Date.parse(r.message.deadline)).toBe(Date.parse(req.deadline));
        },
      ),
      { numRuns: 60 },
    );
  });
});
