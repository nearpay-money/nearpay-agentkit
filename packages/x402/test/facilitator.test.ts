import { describe, expect, it } from "vitest";
import { DEFAULT_API_BASE, FacilitatorError, facilitator } from "../src/index.js";

const SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "near:mainnet", extra: { assetTransferMethod: "intents-transfer" } },
  ],
  extensions: [],
  signers: { "near:*": ["relayer.nearpay.near"] },
};

describe("facilitator client", () => {
  it("calls /x402/* with the secret key and the API version", async () => {
    let seen: Request | null = null;
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = new Request(String(input), init);
      return Response.json(SUPPORTED);
    }) as typeof fetch;
    expect(await facilitator({ secretKey: "sk_test_x", fetch: f }).supported()).toStrictEqual(SUPPORTED);
    const req = seen as unknown as Request;
    expect(req.url).toBe(`${DEFAULT_API_BASE}/x402/supported`);
    expect(req.headers.get("authorization")).toBe("Bearer sk_test_x");
    expect(req.headers.get("nearpay-version")).toBe("2026-11-01");
  });

  it("raises FacilitatorError with status, code and request id", async () => {
    const err = (status: number, body: string, headers: Record<string, string> = {}) =>
      facilitator({
        secretKey: "rk_live_x",
        apiBase: "https://api.x/",
        fetch: (async () => new Response(body, { status, headers })) as typeof fetch,
      }).supported();
    const env = JSON.stringify({
      error: {
        type: "authentication_error",
        code: "authentication_required",
        message: "no",
        doc_url: "https://docs.nearpay.money/errors/a",
        request_id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
      },
    });
    await expect(err(401, env)).rejects.toMatchObject({
      status: 401,
      apiCode: "authentication_required",
      requestId: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
    });
    await expect(err(502, "bad gateway", { "X-Request-Id": "req_gw" })).rejects.toMatchObject({
      status: 502,
      requestId: "req_gw",
    });
    await expect(err(200, "{}")).rejects.toThrow(/unexpected response/);
    const down = facilitator({
      secretKey: "sk_test_x",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    await expect(down.supported()).rejects.toBeInstanceOf(FacilitatorError);
  });

  it("rejects publishable keys", () => {
    expect(() => facilitator({ secretKey: "pk_live_x" })).toThrow(RangeError);
  });
});
