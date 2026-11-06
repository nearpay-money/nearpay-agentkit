#!/usr/bin/env node
/**
 * Publishes @nearpay/agent-signer and @nearpay/x402 to the local registry (Verdaccio in the
 * nearpay-deploy Compose stack, system audit S-11), in dependency order, as reproducible tarballs
 * (see `stage`; same procedure as nearpay-kit's release script). Idempotent: a version already
 * published with identical contents is skipped; different contents under the same version fail (bump it).
 * Only a loopback registry is accepted: publishing anywhere else is a human decision.
 *
 * Env: NP_REGISTRY_URL (default http://127.0.0.1:4873), NP_REGISTRY_USER (default nearpay-local),
 *      NP_REGISTRY_PASSWORD (required; `nearpay-deploy/scripts/seed.sh keys` generates it).
 * Flags: --skip-verify   skip `pnpm verify` (callers that already verified; still builds)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = (process.env.NP_REGISTRY_URL ?? "http://127.0.0.1:4873").replace(/\/$/, "");
// Publishing anywhere but this machine's registry is a human decision: refuse non-loopback registries.
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(registry)) {
  console.error(`refusing to publish to ${registry}: only a local registry (127.0.0.1/localhost) is allowed`);
  process.exit(1);
}
/** npm must use exactly the local registry: drop inherited npm_config_* overrides from the caller. */
const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)));
const user = process.env.NP_REGISTRY_USER ?? "nearpay-local";
const password = process.env.NP_REGISTRY_PASSWORD;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

/** Workspace packages sorted so every package follows its workspace dependencies. */
function publishOrder() {
  const pkgs = new Map();
  for (const dir of readdirSync(join(root, "packages"))) {
    if (!existsSync(join(root, "packages", dir, "package.json"))) continue; // placeholders (mcp: Stage 3)
    const json = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
    if (json.private) continue;
    pkgs.set(json.name, { dir, json });
  }
  const order = [];
  const seen = new Set();
  const visit = (name, path = []) => {
    if (seen.has(name)) return;
    if (path.includes(name)) throw new Error(`dependency cycle: ${[...path, name].join(" → ")}`);
    const p = pkgs.get(name);
    for (const dep of Object.keys({ ...p.json.dependencies, ...p.json.peerDependencies })) {
      if (pkgs.has(dep)) visit(dep, [...path, name]);
    }
    seen.add(name);
    order.push(p);
  };
  for (const name of [...pkgs.keys()].sort()) visit(name);
  return order;
}

async function token() {
  if (!password) throw new Error("NP_REGISTRY_PASSWORD is not set (see nearpay-deploy/.secrets/registry_password)");
  const url = `${registry}/-/user/org.couchdb.user:${encodeURIComponent(user)}`;
  const body = JSON.stringify({ name: user, password });
  const headers = { "content-type": "application/json" };
  let res = await fetch(url, { method: "PUT", headers, body });
  if (res.status === 409) {
    const basic = Buffer.from(`${user}:${password}`).toString("base64");
    res = await fetch(url, { method: "PUT", headers: { ...headers, authorization: `Basic ${basic}` }, body });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) throw new Error(`registry login failed (${res.status}): ${JSON.stringify(json)}`);
  return json.token;
}

function unpack(tgz, dir) {
  run("tar", ["-xzf", tgz, "-C", dir], { stdio: "pipe" });
  const files = {};
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else files[r] = readFileSync(p);
    }
  };
  walk(dir, "");
  return files;
}

/** Canonical JSON (sorted keys): `pnpm pack` does not keep dependency order stable across runs. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function sameFile(name, x, y) {
  if (name.endsWith("package.json"))
    return canonical(JSON.parse(x.toString("utf8"))) === canonical(JSON.parse(y.toString("utf8")));
  return x.equals(y);
}

function sameContents(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameFile(k, a[k], b[k]));
}

/**
 * Copies a package to `dest` with a publishable manifest: `workspace:` ranges become the sibling's
 * exact version, key order is kept, and dev-only fields are dropped. `npm pack` of the result is
 * byte-for-byte reproducible, so consumers' lockfile integrity hashes stay valid when a fresh
 * local registry is re-seeded from source (`pnpm pack` reorders rewritten dependencies at random).
 */
function stage(pkgDir, dest) {
  cpSync(pkgDir, dest, {
    recursive: true,
    filter: (src) => !src.slice(pkgDir.length).split("/").includes("node_modules"),
  });
  const manifestPath = join(dest, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (!String(range).startsWith("workspace:")) continue;
      const version = versions.get(dep);
      if (!version) throw new Error(`${manifest.name}: ${dep} is not a workspace package`);
      const spec = String(range).slice("workspace:".length);
      manifest[field][dep] =
        spec === "*" || spec === "" ? version : spec === "^" || spec === "~" ? `${spec}${version}` : spec;
    }
  }
  delete manifest.devDependencies;
  delete manifest.scripts;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return dest;
}

const versions = new Map();

async function main() {
  if (!process.argv.includes("--skip-verify")) run("pnpm", ["verify"]);
  else run("pnpm", ["build"]);
  const auth = await token();
  const work = mkdtempSync(join(tmpdir(), "nearpay-agentkit-release-"));
  const npmrc = join(work, ".npmrc");
  const host = registry.replace(/^https?:/, "");
  writeFileSync(npmrc, `registry=${registry}/\n${host}/:_authToken=${auth}\n`);
  try {
    const order = publishOrder();
    for (const { json } of order) versions.set(json.name, json.version);
    for (const { dir, json } of order) {
      const { name, version } = json;
      const out = join(work, dir);
      mkdirSync(out, { recursive: true });
      const staged = stage(join(root, "packages", dir), join(work, `${dir}-stage`));
      run("npm", ["pack", "--pack-destination", out], { cwd: staged, stdio: "pipe" });
      const tgz = join(
        out,
        readdirSync(out).find((f) => f.endsWith(".tgz")),
      );
      const packed = unpack(tgz, mkdtempSync(join(work, "a-")));
      const manifest = JSON.parse(packed["package/package.json"].toString("utf8"));
      const loose = Object.entries({ ...manifest.dependencies }).filter(([, v]) => String(v).startsWith("workspace:"));
      if (loose.length) throw new Error(`${name}: unresolved workspace ranges ${loose.map(([k]) => k).join(", ")}`);
      const view = spawnSync(
        "npm",
        ["view", `${name}@${version}`, "version", "--userconfig", npmrc, "--registry", `${registry}/`],
        {
          env: npmEnv,
          encoding: "utf8",
        },
      );
      if (view.status === 0 && view.stdout.trim() === version) {
        const existing = join(work, `${dir}-published`);
        mkdirSync(existing, { recursive: true });
        run(
          "npm",
          [
            "pack",
            `${name}@${version}`,
            "--pack-destination",
            existing,
            "--userconfig",
            npmrc,
            "--registry",
            `${registry}/`,
          ],
          {
            env: npmEnv,
            stdio: "pipe",
          },
        );
        const pub = join(
          existing,
          readdirSync(existing).find((f) => f.endsWith(".tgz")),
        );
        if (!sameContents(packed, unpack(pub, mkdtempSync(join(work, "b-"))))) {
          throw new Error(`${name}@${version} is already published with different contents; bump the version`);
        }
        console.log(`= ${name}@${version} already published (identical)`);
        continue;
      }
      run("npm", ["publish", tgz, "--userconfig", npmrc, "--registry", `${registry}/`, "--access", "public"], {
        env: npmEnv,
      });
      console.log(`+ ${name}@${version} published to ${registry}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
