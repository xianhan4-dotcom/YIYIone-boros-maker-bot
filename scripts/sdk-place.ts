/**
 * Boros SDK 下单 — 使用 @pendle/boros-sdk-public 签名+提交
 * 用法: npx ts-node scripts/sdk-place.ts enter 130
 *       npx ts-node scripts/sdk-place.ts place 130 SHORT 371 12000000000000000000
 */

import * as dotenv from "dotenv";
dotenv.config();

// Fix BigInt serialization for JSON
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

async function main() {
  const sdk: any = await import("@pendle/boros-sdk-public");
  const agentKey = process.env.AGENT_PRIVATE_KEY;
  const rootAddr = process.env.BOROS_ROOT_ADDRESS;
  if (!agentKey || !rootAddr) { console.error("Missing keys"); process.exit(1); }

  // Initialize agent in SDK
  sdk.setInternalAgent(sdk.Agent.createFromPrivateKey(agentKey as `0x${string}`));

  const action = process.argv[2];
  const marketId = parseInt(process.argv[3]);
  const tokenId = 1; // WBTC
  const marketAcc = `0x${rootAddr!.slice(2).toLowerCase()}00000${tokenId.toString(16)}ffffff`;
  const API_BASE = "https://api-boros.pendle.finance/apis";

  const api = sdk.createOpenApiSdk(API_BASE);

  async function execute(calldatas: { calldata: string; accountId: number }[]) {
    const signed = await sdk.bulkSignWithAgentV2({
      root: rootAddr,
      executeParams: calldatas.map((c: any) => ({ accountId: c.accountId, calldata: c.calldata })),
    });
    const result = await api.sendTxs.sendTxsControllerDedicatedBulkCalls({
      datas: signed.map((s: any) => ({
        agent: s.agent, message: s.message, signature: s.signature, calldata: s.calldata,
      })),
      requireSuccess: false,
    });
    return result.data;
  }

  if (action === "enter") {
    console.log(`Entering market ${marketId}...`);
    const resp = await fetch(`${API_BASE}/v1/calldata-builder/agent/enter-markets`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: rootAddr, accountId: 0, marketAcc, marketIds: [marketId] }),
    });
    const data: any = await resp.json();
    if (!data.calls?.length) { console.log("Already entered or empty"); return; }
    const result = await execute(data.calls);
    console.log("Entered:", JSON.stringify(result));
  }
  else if (action === "place") {
    const side = process.argv[4] === "SHORT" ? 1 : 0;
    const tick = parseInt(process.argv[5]);
    const size = process.argv[6];
    console.log(`Placing ${process.argv[4]} @ tick=${tick} size=${size}...`);
    const resp = await fetch(`${API_BASE}/v1/calldata-builder/agent/place-orders`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        root: rootAddr, accountId: 0, isCross: true, marketAcc,
        orderRequests: [{ singleOrder: { marketAcc, marketId, side, tick, limitTick: tick, size, tif: 0, slippage: "0" }}],
      }),
    });
    const data: any = await resp.json();
    if (!data.calls?.length) { console.log("No calldata"); return; }
    const result = await execute(data.calls);
    console.log("Placed:", JSON.stringify(result));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
