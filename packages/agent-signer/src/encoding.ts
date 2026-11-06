/**
 * Byte encodings of the NEAR Intents Verifier (lld/00-foundations.md §14), checked against
 * `nearpay-spec/test-vectors/intents-payloads.json`.
 */
import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();

/** NEP-413 tag: 2^31 + 413, borsh u32 little-endian prefix of the signed payload. */
export const NEP413_TAG = 2 ** 31 + 413;

export const utf8 = (s: string): Uint8Array => enc.encode(s);

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new RangeError("invalid hex");
  return Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
}

export function toBase64(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new RangeError("invalid base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * NEP-413 payload hash: sha256(borsh(u32 tag) ‖ borsh({message: string, nonce: [u8; 32],
 * recipient: string, callback_url: None})). NearPay never sets a callback URL.
 */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new RangeError("NEP-413 nonce must be 32 bytes");
  const m = utf8(message);
  const r = utf8(recipient);
  return sha256(concat([u32(NEP413_TAG), u32(m.length), m, nonce, u32(r.length), r, new Uint8Array([0])]));
}
