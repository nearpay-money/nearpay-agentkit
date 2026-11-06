#!/usr/bin/env node
// Builds the package in the current directory: tsc (ESM + d.ts) and copies the license.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = process.cwd();
rmSync(join(pkg, "dist"), { recursive: true, force: true });
const tsconfig = join(pkg, "tsconfig.build.json");
writeFileSync(
  tsconfig,
  `${JSON.stringify(
    {
      extends: "../../tsconfig.base.json",
      compilerOptions: {
        rootDir: "src",
        outDir: "dist",
        types: ["node"],
        sourceMap: true,
        inlineSources: true,
        declarationMap: false,
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`,
);
execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", tsconfig], { stdio: "inherit" });
cpSync(join(root, "LICENSE"), join(pkg, "LICENSE"));
console.log(`built ${pkg.split("/").pop()}`);
