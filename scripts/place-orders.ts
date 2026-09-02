/**
 * Boros maker-only order executor.
 *
 * Preferred production path is @pendle/boros-mcp from Python. This script is a
 * fallback that uses the public SDK signer and Open API calldata builder.
 *
 * Usage:
 *   npx ts-node scripts/place-orders.ts --payload '{"marketId":130,"tokenId":1,"orders":[...]}'
 */

import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { Agent, bulkSignWithAgentV2 } from "@pendle/boros-sdk-public";

dotenv.config();

const OPEN_API = (process.env.BOROS_OPEN_API || "https://api-boros.pendle.finance/apis").replace(/\/$/, "");
const CROSS_MARKET_ID = 16777215;

type Side = "LONG" | "SHORT";

interface OrderRequest {
  marketId: number;
  tokenId?: number;
  side: Side;
  tick: number;
  limitTick?: number;
  size: string;
  tif?: number;
}

interface Payload {
  marketId: number;
  tokenId?: number;
  marketAcc?: string;
  orders?: OrderRequest[];
  cancelAll?: boolean;
  cancelAllBeforePlace?: boolean;
  action?: "cancelAll" | "enterMarket";
}

function argPayload(): Payload {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--payload" && args[i + 1]) {
      return JSON.parse(args[i + 1]);
    }
  }
  throw new Error("Missing --payload");
}

async function apiGet(path: string): Promise<any> {
  const resp = await fetch(`${OPEN_API}${path}`);
  if (!resp.ok) {
    throw new Error(`GET ${path} ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  return resp.json();
}

async function apiPost(path: string, body: any): Promise<any> {
  const resp = await fetch(`${OPEN_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`POST ${path} ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  return resp.json();
}

function decimalToFixed18(value: string): string {
  if (/^\d+$/.test(value) && value.length > 12) {
    return value;
  }
  return ethers.parseUnits(value, 18).toString();
}

async function encodeMarketAcc(root: string, tokenId: number, marketId = CROSS_MARKET_ID): Promise<string> {
  const encoded = await apiGet(
    `/v1/market-acc/encode?root=${root}&accountId=0&tokenId=${tokenId}&marketId=${marketId}`,
  );
  return encoded.marketAcc;
}

async function buildCancelAll(marketAcc: string, marketId: number): Promise<any[]> {
  const data = await apiPost("/v1/calldata-builder/agent/cancel-orders", {
    markets: [{
      marketAcc,
      marketId,
      cancelAll: true,
    }],
  });
  return data.calls || [];
}

async function buildEnterMarkets(marketIds: number[]): Promise<any[]> {
  const data = await apiPost("/v1/calldata-builder/agent/enter-markets", {
    accountId: 0,
    isCross: true,
    marketIds,
  });
  return data.calls || [];
}

async function buildPlaceOrders(marketAcc: string, orders: OrderRequest[]): Promise<any[]> {
  const orderRequests = orders.map((order) => ({
    singleOrder: {
      marketAcc,
      marketId: order.marketId,
      side: order.side === "LONG" ? 0 : 1,
      size: decimalToFixed18(order.size),
      tif: order.tif ?? 4,
      limitTick: order.limitTick ?? order.tick,
      slippage: 0,
    },
  }));
  const data = await apiPost("/v1/calldata-builder/agent/place-orders", { orderRequests });
  return data.calls || [];
}

async function submitSignedCalls(root: string, agentKey: string, calls: any[]): Promise<any> {
  if (!calls.length) {
    return { status: "no_calls" };
  }
  const agent = Agent.createFromPrivateKey(agentKey as `0x${string}`);
  const signed = await bulkSignWithAgentV2({
    root: root as `0x${string}`,
    agent,
    executeParams: calls.map((call: any) => ({
      accountId: Number(call.accountId ?? 0),
      calldata: call.calldata as `0x${string}`,
    })),
  });

  const resp = await apiPost("/v1/send-txs/dedicated/bulk-calls", {
    datas: signed,
    requireSuccess: false,
  });
  return resp;
}

async function main() {
  const payload = argPayload();
  const root = process.env.BOROS_ROOT_ADDRESS;
  const agentKey = process.env.AGENT_PRIVATE_KEY;
  if (!root || !agentKey) {
    throw new Error("BOROS_ROOT_ADDRESS and AGENT_PRIVATE_KEY are required");
  }

  const tokenId = payload.tokenId || payload.orders?.[0]?.tokenId || 1;
  const marketAcc = payload.marketAcc || await encodeMarketAcc(root, tokenId);
  let calls: any[] = [];

  if (payload.action === "enterMarket") {
    calls = await buildEnterMarkets([payload.marketId]);
  } else if (payload.action === "cancelAll" || payload.cancelAll) {
    calls = await buildCancelAll(marketAcc, payload.marketId);
  } else {
    if (!payload.orders?.length) {
      throw new Error("No orders supplied");
    }
    if (payload.cancelAllBeforePlace) {
      calls.push(...await buildCancelAll(marketAcc, payload.marketId));
    }
    calls.push(...await buildPlaceOrders(marketAcc, payload.orders));
  }

  const result = await submitSignedCalls(root, agentKey, calls);
  console.log(JSON.stringify({
    status: "placed",
    marketId: payload.marketId,
    tokenId,
    nCalls: calls.length,
    result,
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "error", error: error.message }));
  process.exit(1);
});
