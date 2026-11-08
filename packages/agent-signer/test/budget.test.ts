/** Session budget: per-call and per-session limits, reserve → commit / release (bigint money). */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type AgentSignerError, type Reservation, SpendingBudget } from "../src/index.js";

const A = "nep141:usdc.near";
const B = "nep141:usdt.near";
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as AgentSignerError).code;
  }
  return "no error";
};

describe("SpendingBudget", () => {
  it("enforces the per-call limit, a lower per-call cap and unknown assets", () => {
    const b = new SpendingBudget({ perCall: { [A]: 100n }, perSession: { [A]: 1000n } });
    expect(code(() => b.reserve(A, 101n))).toBe("spend_limit_exceeded");
    expect(code(() => b.reserve(A, 60n, { maxAmount: 50 }))).toBe("spend_limit_exceeded");
    expect(code(() => b.reserve(A, 60n, { maxAmount: "500" }))).toBe("no error"); // cap never raises
    expect(code(() => b.reserve(A, 101n, { maxAmount: 500 }))).toBe("spend_limit_exceeded");
    expect(code(() => b.reserve(B, 1n))).toBe("spend_limit_exceeded");
    expect(() => b.reserve(A, 1n, { label: "x" }) && b.reserve(B, 1n, { label: "tool" })).toThrow(/^tool: /);
  });
  it("counts reservations and commits against the session limit; release gives back", () => {
    const b = new SpendingBudget({ perCall: 100n, perSession: 250n });
    const r1 = b.reserve(A, 100n);
    const r2 = b.reserve(A, 100n);
    expect(code(() => b.reserve(A, 51n))).toBe("spend_limit_exceeded");
    expect(b.usage(A)).toMatchObject({ committed: 0n, reserved: 200n, remaining: 50n });
    r1.commit();
    r2.release();
    expect(r1.state).toBe("committed");
    expect(r2.state).toBe("released");
    r1.release(); // first call wins
    r2.commit();
    expect(b.usage(A)).toMatchObject({ committed: 100n, reserved: 0n, remaining: 100n });
    expect(code(() => b.reserve(A, 100n))).toBe("no error");
    expect(b.usage(A).remaining).toBe(50n);
    expect(b.usage(B)).toMatchObject({ committed: 0n, remaining: 100n }); // one value for any asset
  });
  it("reports a snapshot of configured and used assets", () => {
    const b = new SpendingBudget({ perCall: { [A]: 10n, [B]: 5n }, perSession: { [A]: 20n } });
    b.reserve(A, 10n).commit();
    expect(b.snapshot()).toStrictEqual([
      { asset: A, committed: 10n, reserved: 0n, perCall: 10n, perSession: 20n, remaining: 10n },
      { asset: B, committed: 0n, reserved: 0n, perCall: 5n, perSession: null, remaining: null },
    ]);
  });
  it("validates limits and amounts", () => {
    expect(() => new SpendingBudget({ perCall: "1.5", perSession: 1n })).toThrow(RangeError);
    expect(() => new SpendingBudget({ perCall: { [A]: -1 }, perSession: 1n })).toThrow(RangeError);
    const b = new SpendingBudget({ perCall: 10n, perSession: 10n });
    expect(() => b.reserve(A, "01")).toThrow(RangeError);
    expect(() => b.reserve(A, 1.5)).toThrow(RangeError);
  });
});

type Op = { kind: "reserve"; asset: 0 | 1; amount: bigint; cap?: bigint } | { kind: "commit" | "release"; i: number };

describe("SpendingBudget (property)", () => {
  it("never lets committed + reserved exceed the session limit, nor one payment the per-call limit", () => {
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({
        kind: fc.constant("reserve" as const),
        asset: fc.constantFrom(0 as const, 1 as const),
        amount: fc.bigInt({ min: 0n, max: 10n ** 24n }),
        cap: fc.option(fc.bigInt({ min: 0n, max: 10n ** 24n }), { nil: undefined }),
      }),
      fc.record({ kind: fc.constantFrom("commit" as const, "release" as const), i: fc.nat(40) }),
    );
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.bigInt({ min: 0n, max: 10n ** 25n }),
        fc.array(op, { maxLength: 60 }),
        (perCall, perSession, ops) => {
          const assets = [A, B];
          const b = new SpendingBudget({ perCall, perSession });
          const live: Reservation[] = [];
          const model = assets.map(() => ({ committed: 0n, reserved: 0n }));
          for (const o of ops) {
            if (o.kind === "reserve") {
              const m = model[o.asset] as { committed: bigint; reserved: bigint };
              const cap = o.cap === undefined ? perCall : o.cap < perCall ? o.cap : perCall;
              const ok = o.amount <= cap && m.committed + m.reserved + o.amount <= perSession;
              let got = true;
              try {
                live.push(
                  b.reserve(assets[o.asset] as string, o.amount, o.cap === undefined ? {} : { maxAmount: o.cap }),
                );
              } catch {
                got = false;
              }
              expect(got).toBe(ok);
              if (ok) m.reserved += o.amount;
            } else {
              const r = live[o.i];
              if (!r) continue;
              const m = model[assets.indexOf(r.asset)] as { committed: bigint; reserved: bigint };
              if (r.state === "reserved") {
                m.reserved -= r.amount;
                if (o.kind === "commit") m.committed += r.amount;
              }
              o.kind === "commit" ? r.commit() : r.release();
            }
            for (const [i, a] of assets.entries()) {
              const u = b.usage(a);
              const m = model[i] as { committed: bigint; reserved: bigint };
              expect(u.committed).toBe(m.committed);
              expect(u.reserved).toBe(m.reserved);
              expect(u.committed + u.reserved <= perSession).toBe(true);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
