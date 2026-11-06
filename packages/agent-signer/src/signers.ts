/**
 * Signers for NEAR Intents Verifier messages (lld/sdks-and-tools.md §2, foundations §14):
 * `nearSigner` (NEP-413, or raw Ed25519 for agents) and `evmSigner` (ERC-191 `personal_sign`).
 * The agent's key never leaves this process; NearPay only relays what was signed (INV-1).
 */
import { INTENTS_CONTRACT, type IntentMessage, type MultiPayload, NearAccountId } from "@nearpay/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import { fromBase64, fromHex, hex, nep413Hash, utf8 } from "./encoding.js";
import { AgentSignerError } from "./errors.js";

export type SignatureStandard = MultiPayload["standard"];

/** Signs Verifier messages for one Intents account. */
export interface IntentSigner {
  readonly standard: SignatureStandard;
  /** The Intents account that signs (`signer_id`, the payer). */
  readonly signerId: string;
  /** Signs a complete Verifier message and returns the envelope for `simulate_intents`/`execute_intents`. */
  sign(message: IntentMessage): Promise<MultiPayload>;
}

/**
 * A NEAR key pair: a secret key string `ed25519:<base58>` (64-byte secret or 32-byte seed), a
 * 32-byte seed, or a near-api-js style `KeyPair` (`getPublicKey()`, `sign(bytes)`).
 */
export type NearKeyPair =
  | string
  | Uint8Array
  | {
      getPublicKey(): { toString(): string };
      sign(message: Uint8Array): { signature: Uint8Array } | Promise<{ signature: Uint8Array }>;
    };

export interface NearSignerOptions {
  /** Named or implicit account; default: the implicit account of the key (hex of the public key). */
  accountId?: string;
  keyPair: NearKeyPair;
  /** `nep413` (default; what NEAR wallets sign) or `raw_ed25519` (Ed25519 over the payload bytes). */
  standard?: "nep413" | "raw_ed25519";
}

interface Ed25519Key {
  publicKey: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

function curveBytes(s: string, curve: "ed25519" | "secp256k1"): Uint8Array {
  const prefix = `${curve}:`;
  if (!s.startsWith(prefix)) throw new AgentSignerError("signer_error", `expected a ${curve} key`);
  return bs58.decode(s.slice(prefix.length));
}

function ed25519Key(kp: NearKeyPair): Ed25519Key {
  if (typeof kp === "string" || kp instanceof Uint8Array) {
    const raw = typeof kp === "string" ? curveBytes(kp, "ed25519") : kp;
    if (raw.length !== 32 && raw.length !== 64) {
      throw new AgentSignerError("signer_error", "ed25519 secret key must be a 32-byte seed or 64-byte secret key");
    }
    const seed = raw.slice(0, 32);
    const publicKey = ed25519.getPublicKey(seed);
    if (raw.length === 64 && hex(raw.slice(32)) !== hex(publicKey)) {
      throw new AgentSignerError("signer_error", "secret key does not match its embedded public key");
    }
    return { publicKey, sign: async (bytes) => ed25519.sign(bytes, seed) };
  }
  const publicKey = curveBytes(kp.getPublicKey().toString(), "ed25519");
  if (publicKey.length !== 32) throw new AgentSignerError("signer_error", "ed25519 public key must be 32 bytes");
  return { publicKey, sign: async (bytes) => (await kp.sign(bytes)).signature };
}

function checkAccount(accountId: string): string {
  if (!NearAccountId.safeParse(accountId).success) {
    throw new AgentSignerError("signer_error", `"${accountId}" is not a NEAR account id`);
  }
  return accountId;
}

function checkMessage(m: IntentMessage, signerId: string): void {
  if (m.signer_id !== signerId) {
    throw new AgentSignerError("signer_error", `message signer_id ${m.signer_id} is not this signer (${signerId})`);
  }
  if (m.verifying_contract !== INTENTS_CONTRACT) {
    throw new AgentSignerError("signer_error", `verifying_contract must be ${INTENTS_CONTRACT}`);
  }
}

/** The message with its keys in the Verifier's order (the signed bytes are this exact JSON). */
function ordered(m: IntentMessage): IntentMessage {
  return {
    signer_id: m.signer_id,
    verifying_contract: m.verifying_contract,
    deadline: m.deadline,
    nonce: m.nonce,
    intents: m.intents,
  };
}

/** NEP-413 (or raw Ed25519) signer for a NEAR account. */
export function nearSigner(opts: NearSignerOptions): IntentSigner {
  const key = ed25519Key(opts.keyPair);
  const signerId = checkAccount(opts.accountId ?? hex(key.publicKey));
  const standard = opts.standard ?? "nep413";
  const publicKey = `ed25519:${bs58.encode(key.publicKey)}`;

  async function signed(bytes: Uint8Array): Promise<string> {
    const sig = await key.sign(bytes);
    // A KeyPair object may hold another key than it reports: never hand out a signature the Verifier rejects.
    if (sig.length !== 64 || !ed25519.verify(sig, bytes, key.publicKey)) {
      throw new AgentSignerError("signer_error", "the key pair produced a signature that does not verify");
    }
    return `ed25519:${bs58.encode(sig)}`;
  }

  return {
    standard,
    signerId,
    async sign(m: IntentMessage): Promise<MultiPayload> {
      checkMessage(m, signerId);
      if (standard === "raw_ed25519") {
        const payload = JSON.stringify(ordered(m));
        return { standard, payload, public_key: publicKey, signature: await signed(utf8(payload)) };
      }
      // NEP-413: nonce and recipient live in the NEP-413 payload, the rest in `message`.
      const message = JSON.stringify({ signer_id: m.signer_id, deadline: m.deadline, intents: m.intents });
      const hash = nep413Hash(message, fromBase64(m.nonce), INTENTS_CONTRACT);
      return {
        standard: "nep413",
        payload: { recipient: INTENTS_CONTRACT, nonce: m.nonce, message },
        public_key: publicKey,
        signature: await signed(hash),
      };
    },
  };
}

/** A viem-style account (`privateKeyToAccount`, `toAccount`, …): ERC-191 `personal_sign` of a string. */
export interface EvmAccount {
  readonly address: string;
  signMessage(args: { message: string }): Promise<string>;
}

const enc = new TextEncoder();

function erc191Hash(payload: string): Uint8Array {
  const bytes = enc.encode(payload);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const buf = new Uint8Array(prefix.length + bytes.length);
  buf.set(prefix, 0);
  buf.set(bytes, prefix.length);
  return keccak_256(buf);
}

const N = secp256k1.Point.CURVE().n;

/**
 * ERC-191 signer for an EVM account; `signer_id` is its eth-implicit Intents account (lower-case
 * `0x…`). The signature is normalised to r ‖ s ‖ v with v ∈ {0, 1} and low s, and checked to recover
 * to the account before it is returned.
 */
export function evmSigner(account: EvmAccount): IntentSigner {
  const signerId = account.address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(signerId)) throw new AgentSignerError("signer_error", "not an EVM address");
  return {
    standard: "erc191",
    signerId,
    async sign(m: IntentMessage): Promise<MultiPayload> {
      checkMessage(m, signerId);
      const payload = JSON.stringify(ordered(m));
      let raw: Uint8Array;
      try {
        raw = fromHex(await account.signMessage({ message: payload }));
      } catch (e) {
        if (e instanceof AgentSignerError) throw e;
        throw new AgentSignerError("signer_error", `signMessage failed: ${(e as Error).message}`);
      }
      if (raw.length !== 65) throw new AgentSignerError("signer_error", "signature must be 65 bytes r‖s‖v");
      let v = raw[64] as number;
      if (v >= 27) v -= 27;
      if (v !== 0 && v !== 1) throw new AgentSignerError("signer_error", "signature recovery id must be 0/1 or 27/28");
      let sig = secp256k1.Signature.fromBytes(raw.slice(0, 64), "compact");
      if (sig.hasHighS()) {
        sig = new secp256k1.Signature(sig.r, N - sig.s);
        v ^= 1;
      }
      const recovered = sig.addRecoveryBit(v).recoverPublicKey(erc191Hash(payload)).toBytes(false);
      const address = `0x${hex(keccak_256(recovered.slice(1)).slice(-20))}`;
      if (address !== signerId) {
        throw new AgentSignerError("signer_error", `signature recovers to ${address}, not ${signerId}`);
      }
      const rsv = new Uint8Array(65);
      rsv.set(sig.toBytes("compact"), 0);
      rsv[64] = v;
      return { standard: "erc191", payload, signature: `secp256k1:${bs58.encode(rsv)}` };
    },
  };
}
