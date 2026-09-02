/**
 * Agent 批准脚本
 * 用法: npx ts-node scripts/approve-agent.ts
 * 
 * 用 Root 钱包签名批准 Agent，使其可以代表你交易。
 * 敏感操作 — 需要 Root 钱包私钥 (从系统环境变量 BOROS_ROOT_KEY 读取)。
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const OPEN_API = process.env.BOROS_OPEN_API || "https://api-boros.pendle.finance/apis";
const RPC_URL = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "42161");

async function main() {
  // ── 读取密钥 ──────────────────────────────────────
  const rootKey = process.env.BOROS_ROOT_KEY || process.env.ROOT_PRIVATE_KEY;
  if (!rootKey) {
    console.error("❌ 未找到 Root 钱包私钥!");
    console.error("   请设置环境变量 BOROS_ROOT_KEY 或在 .env 中设置 ROOT_PRIVATE_KEY");
    process.exit(1);
  }

  const agentKey = process.env.AGENT_PRIVATE_KEY;
  if (!agentKey) {
    console.error("❌ 未找到 Agent 私钥!");
    console.error("   请先运行 npx ts-node scripts/generate-agent.ts 生成 Agent");
    process.exit(1);
  }

  // ── 初始化 ────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const rootWallet = new ethers.Wallet(rootKey, provider);
  const agentWallet = new ethers.Wallet(agentKey);

  console.log("🔐 Root 钱包:", rootWallet.address);
  console.log("🤖 Agent 钱包:", agentWallet.address);
  console.log("");

  // ── Step 1: 获取批准 calldata ─────────────────────
  console.log("📡 Step 1: 从 Boros API 获取批准 calldata...");
  const approveUrl = `${OPEN_API}/v1/calldata-builder/user/approve-agent`;

  const response = await fetch(approveUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root: rootWallet.address,
      agentAddress: agentWallet.address,
      accountId: 0,
      expiry: Math.floor(Date.now() / 1000) + 365 * 86400,  // 1 year from now
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    console.error(`❌ API 请求失败: ${response.status} — ${err}`);
    process.exit(1);
  }

  const respJson = await response.json() as { calldata: string; to: string; from: string; gas: string };
  const { to, calldata } = respJson;
  console.log(`   Target: ${to}`);
  console.log(`   Gas est: ${respJson.gas}`);
  console.log("");

  // ── Step 2: Root 钱包签名并发送交易 ────────────────
  console.log("✍️  Step 2: 用 Root 钱包签名并发送交易...");
  console.log("   (请在 MetaMask 或你的钱包中确认 — 如果使用硬件钱包)");

  try {
    const tx = await rootWallet.sendTransaction({
      to: to,
      data: calldata,
      gasLimit: 300000,
    });

    console.log(`   ✅ 交易已发送! TxHash: ${tx.hash}`);
    console.log("");

    // ── Step 3: 等待确认 ────────────────────────────
    console.log("⏳ Step 3: 等待交易确认...");
    const receipt = await tx.wait();
    console.log(`   ✅ 已确认! 区块: ${receipt?.blockNumber}`);
    console.log(`   Gas 使用: ${receipt?.gasUsed.toString()}`);
    console.log("");

    // ── Step 4: 验证 Agent 状态 ─────────────────────
    console.log("🔍 Step 4: 验证 Agent 状态...");
    const expiryUrl = `${OPEN_API}/v1/agents/expiry-time?root=${rootWallet.address}&agentAddress=${agentWallet.address}`;
    const expiryResp = await fetch(expiryUrl);

    if (expiryResp.ok) {
      const expiryData = await expiryResp.json() as { expiryTime: number };
      console.log(`   ✅ Agent 已批准!`);
      console.log(`   过期时间: ${new Date(expiryData.expiryTime * 1000).toISOString()}`);
    } else {
      console.log("   ⚠️  无法验证 Agent 状态，请手动检查");
    }

    console.log("\n🎉 Agent 批准完成! 现在可以开始交易了。");
    console.log("   下一步: 运行 npx ts-node scripts/check-status.ts 检查账户状态");

  } catch (error: any) {
    console.error(`❌ 交易失败: ${error.message}`);
    if (error.message.includes("insufficient funds")) {
      console.error("   可能原因: Arbitrum 上 ETH 余额不足支付 Gas");
    }
    process.exit(1);
  }
}

main().catch(console.error);
