/**
 * Boros 存款脚本 — 存入 USDC 到全仓账户
 * 
 * 用法: npx ts-node scripts/deposit.ts [amount]
 * 默认存入 $100 USDC (100 * 10^18)
 * 
 * 流程:
 *   1. 获取存款 calldata (API)
 *   2. Root 钱包签名并发送上链
 *   3. 验证存款结果
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const OPEN_API = process.env.BOROS_OPEN_API || "https://api-boros.pendle.finance/apis";
const RPC_URL = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";

// USD₮0 (USDT on Arbitrum) — Boros 抵押代币
const TOKEN_ADDRESS = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9";
const TOKEN_ID = 3;
const TOKEN_DECIMALS = 6;
const TOKEN_NAME = "USD₮0 (USDT)";
// Minimal ERC20 ABI for approve
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const rootKey = process.env.BOROS_ROOT_KEY;
  if (!rootKey) {
    console.error("❌ 未找到 BOROS_ROOT_KEY");
    process.exit(1);
  }

  const rootAddress = process.env.BOROS_ROOT_ADDRESS || "";
  const args = process.argv.slice(2);
  const amountStr = args[0] || "100";
  const amount = parseFloat(amountStr);

  console.log("💰 Boros 存款");
  console.log("═══════════════════════════════════════════\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL, 42161);
  const rootWallet = new ethers.Wallet(rootKey, provider);

  console.log(`👤 Root: ${rootWallet.address}`);
  console.log(`💵 存款金额: $${amount} ${TOKEN_NAME}\n`);

  // ── Step 1: Get marketAcc then deposit calldata ─────
  console.log("📡 Step 1: 获取 marketAcc 和存款 calldata...");

  const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, provider);
  const amountWei = ethers.parseUnits(amountStr, TOKEN_DECIMALS);

  // First encode the marketAcc
  const encodeUrl = `${OPEN_API}/v1/market-acc/encode?root=${rootWallet.address}&accountId=0&tokenId=${TOKEN_ID}&marketId=16777215`;
  const encodeResp = await fetch(encodeUrl);
  if (!encodeResp.ok) {
    const err = await encodeResp.text();
    console.error(`❌ Encode 失败: ${err}`);
    process.exit(1);
  }
  const { marketAcc } = await encodeResp.json() as { marketAcc: string };
  console.log(`   marketAcc: ${marketAcc}`);

  // Then get deposit calldata
  const depositResp = await fetch(
    `${OPEN_API}/v1/calldata-builder/user/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketAcc: marketAcc,
        amount: amountWei.toString(),
      }),
    }
  );

  if (!depositResp.ok) {
    const err = await depositResp.text();
    console.error(`❌ API 失败: ${depositResp.status} — ${err.substring(0, 300)}`);
    process.exit(1);
  }

  const { calldata, to } = await depositResp.json() as { calldata: string; to: string };
  console.log(`   Target: ${to}`);
  console.log(`   Amount: ${ethers.formatUnits(amountWei, TOKEN_DECIMALS)} tokens\n`);

  // ── Step 2: Check token balance & allowance ────────
  console.log("📡 Step 2: 检查余额和授权...");

  const balance: bigint = await (token as any).balanceOf(rootWallet.address);
  console.log(`   余额: ${ethers.formatUnits(balance, TOKEN_DECIMALS)} ${TOKEN_NAME}`);

  if (balance < amountWei) {
    console.error(`❌ 余额不足! 需要 ${amount} ${TOKEN_NAME}，当前 ${ethers.formatUnits(balance, TOKEN_DECIMALS)}`);
    console.log("");
    console.log("💡 请先在 Arbitrum 上获取 USDT (USD₮0):");
    console.log("   - 从 CEX 提现 USDT 到 Arbitrum 网络");
    process.exit(1);
  }

  // Check allowance
  const allowance: bigint = await (token as any).allowance(rootWallet.address, to);
  console.log(`   授权额度: ${ethers.formatUnits(allowance, TOKEN_DECIMALS)}`);

  // ── Step 3: Approve if needed ────────────────────
  if (allowance < amountWei) {
    console.log("\n✍️  Step 3: 授权 TOKEN...");
    const approveTx = await (token.connect(rootWallet) as any).approve(to, amountWei);
    console.log(`   TxHash: ${approveTx.hash}`);
    await approveTx.wait();
    console.log("   ✅ 授权完成\n");
  } else {
    console.log("   ✅ 已授权，跳过\n");
  }

  // ── Step 4: Send deposit tx ──────────────────────
  console.log("✍️  Step 4: 发送存款交易...");
  const tx = await rootWallet.sendTransaction({
    to,
    data: calldata,
    gasLimit: 500000,
  });
  console.log(`   TxHash: ${tx.hash}`);

  console.log("⏳ 等待确认...");
  const receipt = await tx.wait();
  console.log(`   ✅ 已确认! 区块: ${receipt?.blockNumber}`);
  console.log(`   Gas: ${receipt?.gasUsed?.toString()}\n`);

  // ── Step 5: Verify ───────────────────────────────
  console.log("📡 Step 5: 验证存款...");
  try {
    const marketAccResp = await fetch(
      `${OPEN_API}/v1/market-acc/encode?root=${rootWallet.address}&accountId=0&tokenId=${TOKEN_ID}&marketId=16777215`
    );
    const { marketAcc } = await marketAccResp.json() as { marketAcc: string };

    const accInfoResp = await fetch(`${OPEN_API}/v1/accounts/market-acc-infos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketAccs: [marketAcc] }),
    });
    const accInfos = await accInfoResp.json() as any[];

    if (Array.isArray(accInfos) && accInfos.length > 0) {
      const acc = accInfos[0];
      console.log(`💰 全仓账户`);
      console.log(`   总现金: ${ethers.formatEther(String(acc.totalCash || "0"))}`);
      console.log(`   净资产: ${ethers.formatEther(String(acc.netBalance || "0"))}`);
    } else {
      console.log("   ⚠️  暂未查到余额(可能有延迟)");
    }
  } catch (e: any) {
    console.log(`   ⚠️  验证失败: ${e.message}`);
  }

  console.log("\n🎉 存款完成!");
  console.log("   下一步: npx ts-node scripts/topup-gas.ts 5  (充值 Gas)");
}

main().catch(console.error);
