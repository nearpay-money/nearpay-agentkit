import { verifySigned } from "@nearpay-internal/intents";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentSignerError, evmSigner, nearSigner } from "../src/index.js";
import { hexBytes, vector } from "./support.js";

const v = vector("intents-payloads.json");
const message = (signer_id: string) => ({
  signer_id,
  verifying_contract: "intents.near" as const,
  deadline: "2026-11-05T10:02:00.000Z",
  nonce: v.nonce_base64,
  intents: [{ intent: "transfer" as const, receiver_id: "merchant.near", tokens: { "nep141:usdc.near": "1" } }],
});
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as AgentSignerError).code;
  }
  return "no error";
};

describe("nearSigner", () => {
  const seed = hexBytes(v.nep413.seed_hex);

  it("signs for a named account with the given key", async () => {
    const s = nearSigner({ accountId: "agent.near", keyPair: seed });
    expect(s.signerId).toBe("agent.near");
    const mp = await s.sign(message("agent.near"));
    const r = verifySigned(mp);
    expect(r.ok && r.message.signer_id === "agent.near" && !r.implicitMatch).toBe(true);
  });

  it("accepts a 32-byte seed as an ed25519 secret key string", async () => {
    const s = nearSigner({ keyPair: `ed25519:${bs58.encode(seed)}` });
    expect(s.signerId).toBe(v.nep413.signer_id);
  });

  it("rejects malformed keys and accounts", () => {
    expect(() => nearSigner({ keyPair: new Uint8Array(31) })).toThrow(AgentSignerError);
    expect(() => nearSigner({ keyPair: "secp256k1:abc" })).toThrow(/ed25519/);
    const pub = ed25519.getPublicKey(seed);
    const other = ed25519.getPublicKey(new Uint8Array(32).fill(7));
    expect(() => nearSigner({ keyPair: `ed25519:${bs58.encode(new Uint8Array([...seed, ...other]))}` })).toThrow(
      /does not match/,
    );
    expect(() => nearSigner({ accountId: "Not An Account", keyPair: seed })).toThrow(/NEAR account id/);
    const short = {
      getPublicKey: () => ({ toString: () => `ed25519:${bs58.encode(pub.slice(0, 31))}` }),
      sign: () => ({ signature: new Uint8Array(64) }),
    };
    expect(() => nearSigner({ keyPair: short })).toThrow(/32 bytes/);
  });

  it("refuses a KeyPair whose signature does not verify (wrong key behind the object)", async () => {
    const pub = ed25519.getPublicKey(seed);
    const liar = {
      getPublicKey: () => ({ toString: () => `ed25519:${bs58.encode(pub)}` }),
      sign: async (m: Uint8Array) => ({ signature: ed25519.sign(m, new Uint8Array(32).fill(9)) }),
    };
    const s = nearSigner({ keyPair: liar });
    expect(await code(s.sign(message(s.signerId)))).toBe("signer_error");
  });

  it("refuses messages for another signer or contract", async () => {
    const s = nearSigner({ keyPair: seed });
    expect(await code(s.sign(message("someone.near")))).toBe("signer_error");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong contract
    expect(await code(s.sign({ ...message(s.signerId), verifying_contract: "evil.near" as any }))).toBe("signer_error");
  });
});

describe("evmSigner", () => {
  const pk = `0x${v.erc191.private_key_hex}` as const;
  const account = privateKeyToAccount(pk);
  const sk = hexBytes(v.erc191.private_key_hex);

  it("normalises 27/28 and 0/1 recovery ids and high-s signatures from wallets", async () => {
    const m = message(v.erc191.address);
    const good = await evmSigner(account).sign(m);
    for (const transform of ["v01", "highS"] as const) {
      const wallet = {
        address: account.address,
        async signMessage({ message: msg }: { message: string }) {
          const hex = (await account.signMessage({ message: msg })).slice(2);
          const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
          let v = (bytes[64] as number) - 27;
          let sig = secp256k1.Signature.fromBytes(bytes.slice(0, 64), "compact");
          if (transform === "highS") {
            sig = new secp256k1.Signature(sig.r, secp256k1.Point.CURVE().n - sig.s);
            v ^= 1;
          }
          return `0x${Buffer.from([...sig.toBytes("compact"), v]).toString("hex")}`;
        },
      };
      expect(await evmSigner(wallet).sign(m)).toStrictEqual(good);
    }
    expect(sk.length).toBe(32);
  });

  it("refuses a signature that recovers to another account, bad lengths, bad v and wallet errors", async () => {
    const other = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const m = message(v.erc191.address);
    const impostor = { address: account.address, signMessage: other.signMessage };
    expect(await code(evmSigner(impostor).sign(m))).toBe("signer_error");
    const short = { address: account.address, signMessage: async () => "0x1234" };
    expect(await code(evmSigner(short).sign(m))).toBe("signer_error");
    const badV = { address: account.address, signMessage: async () => `0x${"11".repeat(64)}05` };
    expect(await code(evmSigner(badV).sign(m))).toBe("signer_error");
    const throws = {
      address: account.address,
      signMessage: async () => {
        throw new Error("user rejected");
      },
    };
    expect(await code(evmSigner(throws).sign(m))).toBe("signer_error");
    const notHex = { address: account.address, signMessage: async () => "0xzz" };
    expect(await code(evmSigner(notHex).sign(m))).toBe("signer_error");
  });

  it("rejects non-EVM addresses", () => {
    expect(() => evmSigner({ address: "merchant.near", signMessage: account.signMessage })).toThrow(/EVM/);
  });
});
