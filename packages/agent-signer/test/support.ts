/** Test helpers: spec test vectors (the files producers and verifiers share, foundations §3). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// biome-ignore lint/suspicious/noExplicitAny: vector files are plain JSON
export function vector(name: string): any {
  return JSON.parse(readFileSync(require.resolve(`@nearpay/spec/test-vectors/${name}`), "utf8"));
}

export const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
