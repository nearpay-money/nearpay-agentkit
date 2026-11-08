/**
 * Secret hygiene (lld/sdks-and-tools.md §2): keys, client/invoice secrets, operation tokens and bearer
 * credentials never appear in logs or tool results. `redact` masks every known secret shape plus the
 * literal secrets the server was configured with; logs go to stderr only (stdout carries the stdio
 * protocol).
 */

const SHAPES: [RegExp, string][] = [
  [/\b(sk|rk)_(live|test)_[0-9A-Za-z]+/g, "$1_$2_[redacted]"],
  [/\b(cs|in)_([0-9a-z]{26})_secret_[0-9A-Za-z]{32}\b/g, "$1_$2_secret_[redacted]"],
  [/\b(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{43,120}\b/g, "$1:[redacted]"],
  [/\b([a-z0-9-]{1,32})\.([0-9]{1,12})\.[A-Za-z0-9_-]{43}\b/g, "$1.$2.[redacted]"],
  [/\b(Bearer)\s+[^\s"',]+/gi, "$1 [redacted]"],
  [/(\/(?:c|embed|i)\/[a-z]{2}_[0-9a-z]{26})#[^\s"'<>]*/g, "$1#[redacted]"],
  [/\bwhsec_[0-9A-Za-z]+/g, "whsec_[redacted]"],
];

export function redact(text: string, literals: readonly string[] = []): string {
  let out = text;
  for (const lit of literals) if (lit.length >= 8) out = out.split(lit).join("[redacted]");
  for (const [re, to] of SHAPES) out = out.replace(re, to);
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** JSON lines on stderr, redacted. */
export function stderrLogger(literals: readonly string[] = [], minLevel: LogLevel = "info"): Logger {
  const order: LogLevel[] = ["debug", "info", "warn", "error"];
  return (level, msg, fields) => {
    if (order.indexOf(level) < order.indexOf(minLevel)) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    process.stderr.write(`${redact(line, literals)}\n`);
  };
}
