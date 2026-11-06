/** Sentinel co-signature verification against nearpay-spec/test-vectors/sentinel-attestation.json. */
import { describe, expect, it } from "vitest";
import { type ExpectedAttestation, PINNED_SENTINEL_KEYS, parsePinnedKeys, verifyAttestation } from "../src/index.js";
import { vector } from "./support.js";

const v = vector("sentinel-attestation.json");
const pinnedKeys = [{ kid: v.key.kid, public_key: v.key.public_key_base64url }];
const [routeQuote, intents] = v.valid as { signed: { attestation: Record<string, unknown> } }[];
const NOW = Date.parse("2026-11-05T10:00:30.000Z");

// biome-ignore lint/suspicious/noExplicitAny: vector JSON
const a = (x: any) => x.signed.attestation;
const expectIntents = (over: Record<string, unknown> = {}): ExpectedAttestation => ({
  kind: "intents_transfer",
  attemptId: a(intents).attempt_id,
  livemode: false,
  requirement: { ...a(intents).requirement, ...over },
});
const expectRoute = (over: Record<string, unknown> = {}): ExpectedAttestation => ({
  kind: "route_quote",
  attemptId: a(routeQuote).attempt_id,
  livemode: true,
  deposit: { ...a(routeQuote).deposit, ...over },
});
const verify = (signed: unknown, e: ExpectedAttestation, now = NOW, keys = pinnedKeys) =>
  verifyAttestation(signed, e, { pinnedKeys: keys, now });

describe("verifyAttestation — vectors", () => {
  it("accepts both valid vectors with the pinned key", () => {
    expect(verify(intents?.signed, expectIntents())).toMatchObject({ ok: true, kid: "sent-test-1" });
    expect(verify(routeQuote?.signed, expectRoute())).toMatchObject({ ok: true });
  });

  it("refuses every invalid vector", () => {
    const reasons = (v.invalid as { reason: string; signed: unknown }[]).map((x) => verify(x.signed, expectRoute()));
    expect(reasons.map((r) => (r.ok ? "ok" : r.reason))).toStrictEqual([
      "bad_signature",
      "unknown_kid",
      "bad_signature",
    ]);
  });
});

describe("verifyAttestation — field equality (every displayed/signed field)", () => {
  it.each([
    ["pay_to", "attacker.near"],
    ["token", "nep141:wrap.near"],
    ["amount", "1999999"],
    ["fee_to", "attacker.near"],
    ["fee_amount", "6001"],
    ["binding", "np1:AQDxa2L6a5d8egVC7YP85UgtUCYp3cUotS6S3EsGcF7i"],
    ["deadline", "2026-11-05T10:02:01.000Z"],
  ])("requirement.%s differs → mismatch", (field, value) => {
    expect(verify(intents?.signed, expectIntents({ [field]: value }))).toMatchObject({ ok: false, reason: "mismatch" });
  });

  it("compares deadlines as instants", () => {
    expect(verify(intents?.signed, expectIntents({ deadline: "2026-11-05T10:02:00Z" })).ok).toBe(true);
    expect(verify(routeQuote?.signed, expectRoute({ deadline: "2026-11-05T10:15:00Z" })).ok).toBe(true);
  });

  it.each([
    ["address", "0x0000000000000000000000000000000000000bad"],
    ["memo", "x"],
    ["chain", "eip155:1"],
    ["origin_asset_id", "nep141:wrap.near"],
    ["amount_in", "1"],
    ["deadline", "2026-11-05T10:16:00.000Z"],
  ])("deposit.%s differs → mismatch", (field, value) => {
    expect(verify(routeQuote?.signed, expectRoute({ [field]: value }))).toMatchObject({
      ok: false,
      reason: "mismatch",
    });
  });

  it("checks kind, attempt and mode", () => {
    expect(verify(intents?.signed, expectRoute())).toMatchObject({ reason: "mismatch" });
    expect(verify(intents?.signed, { ...expectIntents(), attemptId: "pa_01jbz9k3m4n5p6q7r8s9t0v1w2" })).toMatchObject({
      reason: "mismatch",
    });
    expect(verify(intents?.signed, { ...expectIntents(), livemode: true })).toMatchObject({ reason: "mismatch" });
  });
});

describe("verifyAttestation — keys and time", () => {
  it("refuses an expired attestation", () => {
    expect(verify(intents?.signed, expectIntents(), Date.parse("2026-11-05T10:02:00.000Z"))).toMatchObject({
      reason: "expired",
    });
  });

  it("refuses retired keys, unknown kids and an empty pin set", () => {
    const retired = [{ kid: v.key.kid, public_key: v.key.public_key_base64url, not_after: "2026-11-05T10:00:00Z" }];
    expect(verify(intents?.signed, expectIntents(), NOW, retired)).toMatchObject({ reason: "key_retired" });
    expect(verify(intents?.signed, expectIntents(), NOW, [])).toMatchObject({ reason: "unknown_kid" });
    expect(PINNED_SENTINEL_KEYS).toStrictEqual([]);
  });

  it("refuses a signature by another key under a pinned kid", () => {
    const wrong = [{ kid: v.key.kid, public_key: "fGYI2Mzd_mP5tqEYEJggL6jJE2SOhX9CvdDBLOxgkiE" }];
    expect(verify(intents?.signed, expectIntents(), NOW, wrong)).toMatchObject({ reason: "bad_signature" });
    const garbage = [{ kid: v.key.kid, public_key: "AAAA" }];
    expect(verify(intents?.signed, expectIntents(), NOW, garbage)).toMatchObject({ reason: "bad_signature" });
  });

  it("covers unknown attestation fields with the signature (no stripping before verifying)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: tamper test
    const s: any = structuredClone(intents?.signed);
    s.attestation.extra = "added after signing";
    expect(verify(s, expectIntents())).toMatchObject({ reason: "bad_signature" });
  });

  it("refuses malformed input", () => {
    expect(verify({ kid: "x" }, expectIntents())).toMatchObject({ reason: "malformed" });
    expect(verify(null, expectIntents())).toMatchObject({ reason: "malformed" });
  });
});

describe("parsePinnedKeys", () => {
  it("reads sentinel_keys.json and {keys: …}", () => {
    const json = JSON.stringify([{ kid: "local-1c10f5a1efb1", public_key: v.key.public_key_base64url }]);
    expect(parsePinnedKeys(json)).toStrictEqual([
      { kid: "local-1c10f5a1efb1", public_key: v.key.public_key_base64url },
    ]);
    expect(
      parsePinnedKeys({
        keys: [{ kid: "k1", public_key: v.key.public_key_base64url, not_after: "2027-01-01T00:00:00Z" }],
      }),
    ).toHaveLength(1);
  });

  it.each([
    [{}],
    [[null]],
    [[{ kid: "UPPER", public_key: "x" }]],
    [[{ kid: "k", public_key: 5 }]],
    [[{ kid: "k", public_key: "!!" }]],
    [[{ kid: "k", public_key: "AAAA" }]],
    [[{ kid: "k", public_key: "LHE3Fv7ETKuSmfJWAEBI9iPLlmY5mnePtHvXygDK9GA", not_after: "soon" }]],
  ])("rejects %j", (input) => {
    expect(() => parsePinnedKeys(input)).toThrow();
  });
});
