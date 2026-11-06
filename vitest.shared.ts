import { fileURLToPath } from "node:url";

/** Tests import sibling packages from source (like nearpay-kit). Order matters: subpaths first. */
export const alias = [
  { find: "@nearpay/x402/hono", replacement: fileURLToPath(new URL("./packages/x402/src/hono.ts", import.meta.url)) },
  { find: "@nearpay/x402", replacement: fileURLToPath(new URL("./packages/x402/src/index.ts", import.meta.url)) },
  {
    find: "@nearpay/agent-signer",
    replacement: fileURLToPath(new URL("./packages/agent-signer/src/index.ts", import.meta.url)),
  },
];
