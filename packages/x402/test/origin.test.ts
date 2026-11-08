/** EVM origin deposits (ERC-20 calldata, native coins, refusals) and the operation store. */
import fc from "fast-check";
import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  DepositNotSentError,
  erc20TransferData,
  evmDepositor,
  isOperationOpen,
  memoryOperationStore,
  type X402Operation,
} from "../src/index.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEPOSIT = "0x76b4c56085ED136a8744D52bE956396624a730E8";

describe("erc20TransferData (property)", () => {
  it("encodes transfer(to, amount) exactly for every address and amount", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        fc.bigInt({ min: 1n, max: (1n << 256n) - 1n }),
        (to, amount) => {
          const d = decodeFunctionData({ abi: erc20Abi, data: erc20TransferData(to, amount) });
          expect(d.functionName).toBe("transfer");
          const [dest, value] = d.args as readonly [string, bigint];
          expect(dest.toLowerCase()).toBe(to.toLowerCase());
          expect(value).toBe(amount);
        },
      ),
      { numRuns: 300 },
    );
  });
  it("refuses out-of-range amounts and non-EVM addresses", () => {
    expect(() => erc20TransferData(DEPOSIT, 0n)).toThrow(DepositNotSentError);
    expect(() => erc20TransferData(DEPOSIT, 1n << 256n)).toThrow(DepositNotSentError);
    expect(() => erc20TransferData("merchant.near", 1n)).toThrow(DepositNotSentError);
  });
});

describe("evmDepositor", () => {
  const wallet = (chainId = 8453) => {
    const sendTransaction = vi.fn(async (_tx: unknown) => `0x${"cd".repeat(32)}` as const);
    return {
      account: { address: "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317" },
      chain: { id: chainId },
      sendTransaction,
    };
  };
  it("sends an ERC-20 transfer to the token contract", async () => {
    const w = wallet();
    const d = evmDepositor({ "eip155:8453": w });
    expect(d.canPay("eip155:8453", USDC_BASE)).toBe(true);
    expect(d.canPay("eip155:1", USDC_BASE)).toBe(false);
    expect(d.canPay("eip155:8453", "nep141:base.omft.near")).toBe(false);
    expect(d.refundTo("eip155:8453")).toBe(w.account.address);
    const r = await d.deposit({ network: "eip155:8453", asset: USDC_BASE, amount: "1012000", payTo: DEPOSIT });
    expect(r.txHash).toMatch(/^0xcd/);
    const tx = w.sendTransaction.mock.calls[0]?.[0] as unknown as { to: string; data: `0x${string}` };
    expect(tx.to).toBe(USDC_BASE);
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data }).args).toStrictEqual([DEPOSIT, 1012000n]);
  });
  it("sends configured native coins as value transfers", async () => {
    const w = wallet();
    const d = evmDepositor({ "eip155:8453": w }, { nativeAssets: { "eip155:8453": "nep141:base.omft.near" } });
    expect(d.canPay("eip155:8453", "nep141:base.omft.near")).toBe(true);
    await d.deposit({ network: "eip155:8453", asset: "nep141:base.omft.near", amount: "5", payTo: DEPOSIT });
    expect(w.sendTransaction.mock.calls[0]?.[0]).toMatchObject({ to: DEPOSIT, value: 5n });
    await expect(
      d.deposit({ network: "eip155:8453", asset: "nep141:base.omft.near", amount: "5", payTo: "bad" }),
    ).rejects.toThrow(DepositNotSentError);
  });
  it.each([
    [{ network: "eip155:1", asset: USDC_BASE, amount: "1", payTo: DEPOSIT }, /no wallet/],
    [{ network: "eip155:8453", asset: USDC_BASE, amount: "1", payTo: DEPOSIT, memo: "x" }, /memo/],
    [{ network: "eip155:8453", asset: USDC_BASE, amount: "0", payTo: DEPOSIT }, /positive/],
    [{ network: "eip155:8453", asset: "nep141:x.near", amount: "1", payTo: DEPOSIT }, /neither/],
  ])("refuses before signing: %o", async (req, why) => {
    const w = wallet();
    await expect(evmDepositor({ "eip155:8453": w }).deposit(req)).rejects.toThrow(why);
    expect(w.sendTransaction).not.toHaveBeenCalled();
  });
  it("refuses a wallet on another chain", async () => {
    const w = wallet(1);
    await expect(
      evmDepositor({ "eip155:8453": w }).deposit({
        network: "eip155:8453",
        asset: USDC_BASE,
        amount: "1",
        payTo: DEPOSIT,
      }),
    ).rejects.toThrow(/on chain 1/);
    expect(() => evmDepositor({}).refundTo("eip155:8453")).toThrow(DepositNotSentError);
  });
});

describe("memoryOperationStore", () => {
  it("stores copies and lists operations", async () => {
    const s = memoryOperationStore();
    const op = { id: "np1:a", state: "deposited", resourceUrl: "https://x" } as X402Operation;
    await s.put(op);
    op.state = "settled";
    expect((await s.get("np1:a"))?.state).toBe("deposited");
    expect(await s.get("np1:b")).toBeUndefined();
    expect(await s.list()).toHaveLength(1);
    expect(isOperationOpen({ ...op, state: "deposit_unknown" })).toBe(true);
    expect(isOperationOpen({ ...op, state: "failed" })).toBe(false);
  });
});
