/**
 * An agent paying an x402 resource from its NEAR Intents balance.
 *   AGENT_ACCOUNT=agent.near AGENT_KEY=ed25519:… node --experimental-strip-types agent.ts https://merchant.example/premium
 */
import { nearSigner } from "@nearpay/agent-signer";
import { decodePaymentResponse, withX402 } from "@nearpay/x402";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const signer = nearSigner({ accountId: process.env.AGENT_ACCOUNT, keyPair: process.env.AGENT_KEY ?? "" });
const pay = withX402(fetch, signer, { maxAmountPerRequest: { [USDC]: "50000" } });

const res = await pay(process.argv[2] ?? "http://localhost:3000/premium");
console.log(res.status, await res.text(), decodePaymentResponse(res));
