/**
 * Session spending budget (lld/sdks-and-tools.md §2, MCP payer tools): a per-call limit and a cumulative
 * per-session limit, both per asset in base units (bigint arithmetic only, INV-5).
 *
 * A payment first **reserves** its total debit; the reservation is checked against both limits, counting
 * everything already committed or still reserved, so concurrent payments cannot overshoot the session
 * limit together. After the payment the caller **commits** (money moved, or may have moved) or
 * **releases** (refused before anything was signed or sent). Commit and release are idempotent and
 * mutually exclusive: the first call wins. When in doubt, commit — an unknown outcome counts as spent.
 */
import { AgentSignerError } from "./errors.js";
import { type Amount, limitFor, type SpendLimit, toBaseUnits } from "./limits.js";

export interface BudgetLimits {
  /** Largest single payment (amount + fee), per asset or one value for any asset. */
  perCall: SpendLimit;
  /** Largest sum of payments over the budget's lifetime, per asset or one value for any asset. */
  perSession: SpendLimit;
}

export interface Reservation {
  readonly asset: string;
  readonly amount: bigint;
  /** The payment moved (or may have moved) money: keep it counted. */
  commit(): void;
  /** The payment was refused before anything was signed or sent: give the amount back. */
  release(): void;
  readonly state: "reserved" | "committed" | "released";
}

export interface BudgetUsage {
  asset: string;
  committed: bigint;
  reserved: bigint;
  perCall: bigint | null;
  perSession: bigint | null;
  /** What a further payment may still use (null: the asset is not allowed). */
  remaining: bigint | null;
}

export interface ReserveOptions {
  /** A lower per-call cap for this payment (e.g. a tool argument); never raises the configured one. */
  maxAmount?: Amount;
  /** Shown in refusal messages. */
  label?: string;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export class SpendingBudget {
  readonly #limits: BudgetLimits;
  readonly #committed = new Map<string, bigint>();
  readonly #reserved = new Map<string, bigint>();

  constructor(limits: BudgetLimits) {
    // Validate eagerly: a malformed limit fails at configuration time, not at the first payment.
    for (const which of ["perCall", "perSession"] as const) {
      const l = limits[which];
      if (typeof l === "object") for (const a of Object.keys(l)) limitFor(l, a);
      else limitFor(l, "");
    }
    this.#limits = limits;
  }

  /** Reserves `amount` of `asset`; throws `spend_limit_exceeded` when either limit would be passed. */
  reserve(asset: string, amount: Amount, opts: ReserveOptions = {}): Reservation {
    const value = toBaseUnits(amount, "amount");
    const what = opts.label ? `${opts.label}: ` : "";
    const perCall = limitFor(this.#limits.perCall, asset);
    const perSession = limitFor(this.#limits.perSession, asset);
    if (perCall === null || perSession === null) {
      throw new AgentSignerError("spend_limit_exceeded", `${what}asset ${asset} is not in this agent's spend limits`);
    }
    const callCap = opts.maxAmount === undefined ? perCall : min(perCall, toBaseUnits(opts.maxAmount, "maxAmount"));
    if (value > callCap) {
      throw new AgentSignerError(
        "spend_limit_exceeded",
        `${what}payment of ${value} exceeds the per-call limit ${callCap} of ${asset}`,
      );
    }
    const used = (this.#committed.get(asset) ?? 0n) + (this.#reserved.get(asset) ?? 0n);
    if (used + value > perSession) {
      throw new AgentSignerError(
        "spend_limit_exceeded",
        `${what}payment of ${value} exceeds the session limit of ${asset}: ${used} of ${perSession} already used`,
      );
    }
    this.#reserved.set(asset, (this.#reserved.get(asset) ?? 0n) + value);
    let state: Reservation["state"] = "reserved";
    const settle = (to: "committed" | "released") => {
      if (state !== "reserved") return;
      state = to;
      this.#reserved.set(asset, (this.#reserved.get(asset) ?? 0n) - value);
      if (to === "committed") this.#committed.set(asset, (this.#committed.get(asset) ?? 0n) + value);
    };
    return {
      asset,
      amount: value,
      commit: () => settle("committed"),
      release: () => settle("released"),
      get state() {
        return state;
      },
    };
  }

  usage(asset: string): BudgetUsage {
    const perCall = limitFor(this.#limits.perCall, asset);
    const perSession = limitFor(this.#limits.perSession, asset);
    const committed = this.#committed.get(asset) ?? 0n;
    const reserved = this.#reserved.get(asset) ?? 0n;
    const left = perSession === null ? null : perSession - committed - reserved;
    return {
      asset,
      committed,
      reserved,
      perCall,
      perSession,
      remaining: perCall === null || left === null ? null : min(perCall, left < 0n ? 0n : left),
    };
  }

  /** Usage of every asset with a configured limit or any spending. */
  snapshot(): BudgetUsage[] {
    const assets = new Set<string>([...this.#committed.keys(), ...this.#reserved.keys()]);
    for (const l of [this.#limits.perCall, this.#limits.perSession]) {
      if (typeof l === "object") for (const a of Object.keys(l)) assets.add(a);
    }
    return [...assets].sort().map((a) => this.usage(a));
  }
}
