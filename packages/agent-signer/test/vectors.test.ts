/**
 * Cross-repo vectors (nearpay-spec/test-vectors/intents-payloads.json): the signers must produce the
 * exact MultiPayloads agentpay and the sandbox Verifier verify.
 */

import { verifySigned } from "@nearpay-internal/intents";
import { IntentMessage, MultiPayload } from "@nearpay-money/spec";
import { sha256 } from "@noble/hashes/sha2.js";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  buildTransferPayment,
  evmSigner,
  type IntentSigner,
  nearSigner,
  nep413Hash,
  staticSaltProvider,
} from "../src/index.js";
import { hexBytes, vector } from "./support.js";

const v = vector("intents-payloads.json");
const enc = new TextEncoder();
/** The vector nonce: salt ‖ sha256("nonce vector")[0..28]. */
const randomBytes = () => sha256(enc.encode("nonce vector")).slice(0, 28);
const opts = {
  nonceSaltProvider: staticSaltProvider(v.salt_hex),
  randomBytes,
  deadline: "2026-11-05T10:02:00.000Z",
  now: () => Date.parse("2026-11-05T10:00:00.000Z"),
};
/** The checkout requirement the vector payloads pay. */
const requirement = {
  pay_to: "merchant.near",
  token: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  amount: "2000000",
  fee_to: "treasury.nearpay.near",
  fee_amount: "6000",
  binding: v.binding,
  deadline: "2026-11-05T10:02:00.000Z",
};

async function payload(signer: IntentSigner) {
  return buildTransferPayment(requirement, signer, opts);
}

describe("intents-payloads.json vectors", () => {
  it("NEP-413 (implicit account) matches byte for byte", async () => {
    const signer = nearSigner({ keyPair: hexBytes(v.nep413.seed_hex) });
    expect(signer.signerId).toBe(v.nep413.signer_id);
    const mp = await payload(signer);
    expect(mp).toStrictEqual(v.nep413.multipayload);
    expect(MultiPayload.parse(mp)).toStrictEqual(mp);
    const p = v.nep413.multipayload.payload;
    expect(Buffer.from(nep413Hash(p.message, Buffer.from(p.nonce, "base64"), p.recipient)).toString("hex")).toBe(
      v.nep413.hash_hex,
    );
  });

  it("NEP-413 from a NEAR secret key string (64-byte secret) and a near-api-js style KeyPair", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const bs58 = (await import("bs58")).default;
    const seed = hexBytes(v.nep413.seed_hex);
    const pub = ed25519.getPublicKey(seed);
    const secret = `ed25519:${bs58.encode(new Uint8Array([...seed, ...pub]))}`;
    expect(await payload(nearSigner({ keyPair: secret }))).toStrictEqual(v.nep413.multipayload);
    const keyPair = {
      getPublicKey: () => ({ toString: () => `ed25519:${bs58.encode(pub)}` }),
      sign: (m: Uint8Array) => ({ signature: ed25519.sign(m, seed) }),
    };
    expect(await payload(nearSigner({ keyPair }))).toStrictEqual(v.nep413.multipayload);
  });

  it("ERC-191 from a viem account matches byte for byte (v normalised to 0/1)", async () => {
    const signer = evmSigner(privateKeyToAccount(`0x${v.erc191.private_key_hex}`));
    expect(signer.signerId).toBe(v.erc191.address);
    const mp = await payload(signer);
    expect(mp).toStrictEqual(v.erc191.multipayload);
    expect(IntentMessage.parse(JSON.parse((mp as { payload: string }).payload)).signer_id).toBe(v.erc191.address);
  });

  it("raw Ed25519 (agents) matches byte for byte", async () => {
    const signer = nearSigner({ keyPair: hexBytes(v.raw_ed25519.seed_hex), standard: "raw_ed25519" });
    expect(signer.signerId).toBe(v.raw_ed25519.signer_id);
    expect(await payload(signer)).toStrictEqual(v.raw_ed25519.multipayload);
  });

  it("every vector payload verifies with the kit Verifier used by agentpay and the sandbox", async () => {
    for (const s of [
      nearSigner({ keyPair: hexBytes(v.nep413.seed_hex) }),
      evmSigner(privateKeyToAccount(`0x${v.erc191.private_key_hex}`)),
      nearSigner({ keyPair: hexBytes(v.raw_ed25519.seed_hex), standard: "raw_ed25519" }),
    ]) {
      const r = verifySigned(await payload(s));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.implicitMatch).toBe(true);
        expect(r.message.signer_id).toBe(s.signerId);
        expect(r.message.intents).toHaveLength(2);
      }
    }
  });
});
