/**
 * 账户状态检查脚本
 * 用法: npx ts-node scripts/check-status.ts
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const OPEN_API = process.env.BOROS_OPEN_API || "https://api-boros.pendle.finance/apis";

async function apiGet(path: string): Promise<any> {
  const url = `${OPEN_API}${path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API ${resp.status}: ${err}`);
  }
  return resp.json();
}

async function apiPost(path: string, body: any): Promise<any> {
  const url = `${OPEN_API}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API ${resp.status}: ${err}`);
  }
  return resp.json();
}

async function main() {
  const rootAddress = process.env.BOROS_ROOT_ADDRESS;
  const agentKey = process.env.AGENT_PRIVATE_KEY;

  if (!rootAddress) {
    console.error("❌ 请设置环境变量 BOROS_ROOT_ADDRESS (你的 Root 钱包地址)");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════");
  console.log("  Boros 账户状态检查");
  console.log("═══════════════════════════════════════════\n");
  console.log(`👤 Root: ${rootAddress}`);

  // ── 1. Agent 状态 ────────────────────────────────
  if (agentKey) {
    const agentWallet = new ethers.Wallet(agentKey);
    console.log(`🤖 Agent: ${agentWallet.address}`);

    try {
      const expiry: any = await apiGet(
        `/v1/agents/expiry-time?root=${rootAddress}&agentAddress=${agentWallet.address}`
      );
      const expiryDate = new Date(Number(expiry.expiryTime) * 1000);
      const now = new Date();
      const daysLeft = Math.ceil((expiryDate.getTime() - now.getTime()) / 86400000);
      if (daysLeft > 0) {
        console.log(`   ✅ 已批准 · ${daysLeft} 天后过期 (${expiryDate.toISOString()})`);
      } else {
        console.log(`   ❌ 已过期! 请重新批准`);
      }
    } catch (e: any) {
      console.log(`   ⚠️  无法查询 Agent 状态: ${e.message}`);
    }
  }
  console.log("");

  // ── 2. Gas 余额 ──────────────────────────────────
  try {
    const gasBalance: any = await apiGet(`/v1/accounts/gas-balance?root=${rootAddress}`);
    const bal = gasBalance.balanceInUSD ? parseFloat(gasBalance.balanceInUSD).toFixed(4) : "0";
    console.log(`⛽ Gas 余额: $${bal}`);
  } catch (e: any) {
    console.log(`⛽ Gas 余额: 查询失败 (${e.message})`);
  }
  console.log("");

  // ── 3. 市场账户信息 ──────────────────────────────
  try {
    // Generate proper marketAcc via encode endpoint
    const crossAcc: any = await apiGet(
      `/v1/market-acc/encode?root=${rootAddress}&accountId=0&tokenId=3&marketId=16777215`
    );
    const marketAccHex = crossAcc.marketAcc;
    console.log(`   marketAcc: ${marketAccHex}`);

    const marketAccInfos: any = await apiPost("/v1/accounts/market-acc-infos", {
      marketAccs: [marketAccHex],
    });

    if (marketAccInfos.results && marketAccInfos.results.length > 0) {
      for (const acc of marketAccInfos.results) {
        console.log(`💰 账户 (Cross-Margin)`);
        const totalCash = acc.totalCash ? ethers.formatEther(String(acc.totalCash)) : "0";
        const netBalance = acc.netBalance ? ethers.formatEther(String(acc.netBalance)) : "0";
        console.log(`   总现金:     ${totalCash}`);
        console.log(`   净资产:     ${netBalance}`);

        if (acc.initialMargin)
          console.log(`   初始保证金: ${ethers.formatEther(String(acc.initialMargin))}`);
        if (acc.availableInitialMargin)
          console.log(`   可用保证金: ${ethers.formatEther(String(acc.availableInitialMargin))}`);
        if (acc.availableMaintMargin)
          console.log(`   可用维持保证金: ${ethers.formatEther(String(acc.availableMaintMargin))}`);

        if (acc.positions && acc.positions.length > 0) {
          console.log(`   持仓 (${acc.positions.length}):`);
          for (const pos of acc.positions) {
            const side = pos.signedSize && String(pos.signedSize).startsWith("-") ? "SHORT" : "LONG";
            console.log(`     · ${side} | Size: ${pos.signedSize} | Rate: ${pos.rate || "?"}`);
          }
        } else {
          console.log(`   持仓: 无`);
        }
      }
    } else {
      console.log(`💰 账户: 无数据 (可能还未存款)`);
    }
  } catch (e: any) {
    console.log(`💰 账户信息: ${e.message}`);
  }
  console.log("");

  // ── 4. 活跃持仓 ──────────────────────────────────
  try {
    const positions: any = await apiGet(
      `/v1/accounts/active-positions?root=${rootAddress}&accountId=0`
    );
    if (Array.isArray(positions)) {
      console.log(`📊 活跃持仓: ${positions.length} 个`);
      for (const pos of positions.slice(0, 10)) {
        const side = pos.side === 0 ? "LONG" : "SHORT";
        const fixedApr = pos.fixedApr ? (Number(pos.fixedApr) * 100).toFixed(2) : "?";
        console.log(`   · Market ${pos.marketId} | ${side} | Size: ${pos.signedSize} | Fixed APR: ${fixedApr}%`);
      }
    }
  } catch (e: any) {
    console.log(`📊 持仓: 查询失败 (${e.message})`);
  }
  console.log("");

  // ── 5. 已进入的市场 ──────────────────────────────
  try {
    // entered-markets needs marketAcc (54-char hex)
    const marketAccHex2: any = await apiGet(
      `/v1/market-acc/encode?root=${rootAddress}&accountId=0&tokenId=3&marketId=16777215`
    );
    const entered: any = await apiGet(
      `/v1/accounts/entered-markets?marketAcc=${marketAccHex2.marketAcc}`
    );
    if (Array.isArray(entered)) {
      console.log(`🏪 已进入市场: ${entered.length} 个`);
      for (const mkt of entered.slice(0, 10)) {
        console.log(`   · Market ${mkt}`);
      }
    }
  } catch (e: any) {
    console.log(`🏪 市场: 查询失败 (${e.message})`);
  }

  console.log("\n═══════════════════════════════════════════\n");
}

main().catch(console.error);
