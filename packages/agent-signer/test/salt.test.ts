import { describe, expect, it, vi } from "vitest";
import { rpcSaltProvider, staticSaltProvider } from "../src/index.js";

const viewResult = (value: unknown) => ({
  result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("rpcSaltProvider", () => {
  it("reads current_salt from intents.near and caches it for 60 s", async () => {
    let t = 0;
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.params).toMatchObject({ account_id: "intents.near", method_name: "current_salt", finality: "final" });
      return json(viewResult("252812b3"));
    });
    const salt = rpcSaltProvider({ rpcUrls: ["https://rpc.test"], fetch: f as typeof fetch, now: () => t });
    expect(await Promise.all([salt(), salt()])).toStrictEqual(["252812b3", "252812b3"]);
    t = 59_000;
    await salt();
    expect(f).toHaveBeenCalledTimes(1);
    t = 61_000;
    await salt();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("fails over between providers and reports every failure", async () => {
    const seen: string[] = [];
    const f = (async (url: string | URL | Request) => {
      seen.push(String(url));
      if (String(url).includes("a.")) return json({}, 502);
      if (String(url).includes("b.")) return json({ error: { name: "HANDLER_ERROR" } });
      if (String(url).includes("c.")) return json({ result: {} });
      return json(viewResult("0011aabb"));
    }) as typeof fetch;
    const salt = rpcSaltProvider({ rpcUrls: ["https://a.x", "https://b.x", "https://c.x", "https://d.x"], fetch: f });
    expect(await salt()).toBe("0011aabb");
    expect(seen).toHaveLength(4);
    const none = rpcSaltProvider({ rpcUrls: ["https://a.x", "https://c.x"], fetch: f });
    await expect(none()).rejects.toMatchObject({ code: "salt_unavailable" });
    const bad = rpcSaltProvider({
      rpcUrls: ["https://d.x"],
      fetch: (async () => json(viewResult("nothex"))) as typeof fetch,
    });
    await expect(bad()).rejects.toThrow(/salt/);
  });

  it("needs a URL", () => {
    expect(() => rpcSaltProvider({ rpcUrls: [] })).toThrow(RangeError);
  });
});

describe("staticSaltProvider", () => {
  it("validates the salt", async () => {
    expect(await staticSaltProvider("deadbeef")()).toBe("deadbeef");
    expect(() => staticSaltProvider("dead")).toThrow(/salt/);
  });
});
