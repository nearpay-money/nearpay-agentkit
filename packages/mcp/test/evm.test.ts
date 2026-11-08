/** The binary's viem origin signer: signs locally and broadcasts through the configured RPC (fake JSON-RPC). */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, erc20Abi, parseTransaction } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { viemOriginSigner } from "../src/evm.js";

const KEY = `0x${"11".repeat(32)}`;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEPOSIT = "0x76b4c56085ED136a8744D52bE956396624a730E8";
let close: (() => void) | null = null;
afterEach(() => close?.());

async function fakeRpc(chainId: number) {
  const raw: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const msgs = JSON.parse(body);
      const answer = (m: { id: number; method: string; params: unknown[] }) => {
        const result = (() => {
          switch (m.method) {
            case "eth_chainId":
              return `0x${chainId.toString(16)}`;
            case "eth_getTransactionCount":
              return "0x0";
            case "eth_getBlockByNumber":
              return {
                baseFeePerGas: "0x3b9aca00",
                number: "0x1",
                timestamp: "0x1",
                hash: `0x${"00".repeat(32)}`,
                transactions: [],
              };
            case "eth_maxPriorityFeePerGas":
              return "0x3b9aca00";
            case "eth_gasPrice":
              return "0x3b9aca00";
            case "eth_estimateGas":
              return "0x10000";
            case "eth_sendRawTransaction":
              raw.push(m.params[0] as string);
              return `0x${"ef".repeat(32)}`;
            default:
              return null;
          }
        })();
        return { jsonrpc: "2.0", id: m.id, result };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(msgs) ? msgs.map(answer) : answer(msgs)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  close = () => server.close();
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, raw };
}

describe("viemOriginSigner", () => {
  it("signs an ERC-20 deposit locally and broadcasts it", async () => {
    const rpc = await fakeRpc(8453);
    const signer = await viemOriginSigner({ privateKey: KEY, rpcUrls: { "eip155:8453": rpc.url } });
    expect(signer.canPay("eip155:8453", USDC_BASE)).toBe(true);
    expect(signer.refundTo("eip155:8453")).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const r = await signer.deposit({ network: "eip155:8453", asset: USDC_BASE, amount: "1012000", payTo: DEPOSIT });
    expect(r.txHash).toBe(`0x${"ef".repeat(32)}`);
    const tx = parseTransaction(rpc.raw[0] as `0x${string}`);
    expect(tx.chainId).toBe(8453);
    expect(tx.to?.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` }).args).toStrictEqual([
      DEPOSIT,
      1012000n,
    ]);
  });
  it("refuses bad configuration", async () => {
    await expect(viemOriginSigner({ privateKey: "0x12", rpcUrls: { "eip155:8453": "http://x" } })).rejects.toThrow(
      /64 hex/,
    );
    await expect(viemOriginSigner({ privateKey: KEY, rpcUrls: { "solana:x": "http://x" } })).rejects.toThrow(/eip155/);
    await expect(viemOriginSigner({ privateKey: KEY, rpcUrls: { "eip155:987654321": "http://x" } })).rejects.toThrow(
      /unknown EVM chain/,
    );
    await expect(viemOriginSigner({ privateKey: KEY, rpcUrls: {} })).rejects.toThrow(/no network/);
    const s = await viemOriginSigner({
      privateKey: KEY,
      rpcUrls: { "eip155:1": "http://x" },
      nativeAssets: { "eip155:1": "nep141:eth.omft.near" },
    });
    expect(s.canPay("eip155:1", "nep141:eth.omft.near")).toBe(true);
  });
});
