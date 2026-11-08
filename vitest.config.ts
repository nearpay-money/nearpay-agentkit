import { defineConfig } from "vitest/config";
import { alias } from "./vitest.shared.js";

// Unit, vector and mock-backed tests (the facilitator and the NearPay API are spec-driven fakes).
// The x402 middleware E2E against the sandbox runs in nearpay-testbed (lld/sdks-and-tools.md §6).
// Coverage gate (foundations §16): the signing, attestation and paywall code is the money path.
export default defineConfig({
  resolve: { alias },
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // Process entry point (argument parsing and wiring only); smoke-tested by running the built binary.
      exclude: ["packages/*/src/bin.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { branches: 90, lines: 90 },
    },
  },
});
