/**
 * Durable store for cross-chain x402 operations (one JSON file per operation, directory 0700, files
 * 0600, atomic replace). Operations hold the quote's operation token — a bearer credential — so the
 * directory must stay private to the operator.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationStore, X402Operation } from "@nearpay-money/x402";

const fileOf = (dir: string, id: string) => join(dir, `${createHash("sha256").update(id).digest("hex")}.json`);

export function fileOperationStore(dir: string): OperationStore {
  let ready: Promise<void> | null = null;
  const ensure = () => {
    ready ??= (async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    })();
    return ready;
  };
  const read = async (file: string): Promise<X402Operation | undefined> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as X402Operation;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };
  return {
    async get(id) {
      await ensure();
      return read(fileOf(dir, id));
    },
    async put(op) {
      await ensure();
      const file = fileOf(dir, op.id);
      const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify(op), { mode: 0o600 });
      await rename(tmp, file);
    },
    async list() {
      await ensure();
      const names = (await readdir(dir)).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
      const ops = await Promise.all(names.map((n) => read(join(dir, n))));
      return ops.filter((o): o is X402Operation => o !== undefined).sort((a, b) => a.createdAt - b.createdAt);
    },
  };
}
