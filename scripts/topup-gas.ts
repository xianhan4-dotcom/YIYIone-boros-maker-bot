/**
 * Gas 余额充值脚本
 * 
 * 首次充值推荐方式: Web UI
 *   → https://boros.pendle.finance/account
 *   → 点击 "Gas balance" → 存入 $5-10 USDT 即可
 * 
 * 程序化充值 (需要 Root 钱包签名):
 *   npx ts-node scripts/topup-gas.ts
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const OPEN_API = process.env.BOROS_OPEN_API || "https://api-boros.pendle.finance/apis";
const RPC_URL = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";

async function main() {
  const rootKey = process.env.BOROS_ROOT_KEY;
  if (!rootKey) {
    console.error("❌ 未找到 BOROS_ROOT_KEY 环境变量");
    console.error("   请设置后重试，或直接访问 https://boros.pendle.finance/account 手动充值");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const amount = args[0] || "5"; // Default $5

  console.log("⛽ Boros Gas 余额充值");
  console.log("═══════════════════════════════════════════\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL, 42161);
  const rootWallet = new ethers.Wallet(rootKey, provider);

  console.log(`👤 Root: ${rootWallet.address}`);
  console.log(`💵 充值金额: $${amount} USDT\n`);

  // Step 1: Check current gas balance
  console.log("📡 Step 1: 查询当前 Gas 余额...");
  try {
    const gasResp = await fetch(`${OPEN_API}/v1/accounts/gas-balance?root=${rootWallet.address}`);
    const gasData: any = await gasResp.json();
    const currentBal = gasData.balanceInUSD ? parseFloat(gasData.balanceInUSD).toFixed(4) : "0";
    console.log(`   当前余额: $${currentBal}`);
  } catch (e: any) {
    console.log(`   ⚠️  无法查询: ${e.message}`);
  }
  console.log("");

  // Step 2: Get deposit calldata for gas treasury
  console.log("📡 Step 2: 获取充值 calldata...");

  try {
    const depositUrl = `${OPEN_API}/v1/calldata-builder/user/vault-pay-treasury`;

    const body = {
      root: rootWallet.address,
      accountId: 0,
      tokenId: 3,                    // USD₮0 (USDT)
      amount: ethers.parseUnits(amount, 18).toString(),  // Boros internal = 18 decimals
    };

    const resp = await fetch(depositUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.log(`   API 返回: ${resp.status} — ${errText.substring(0, 200)}`);
      console.log("");
      console.log("💡 程序化充值可能需要先在 Web UI 完成首次充值。");
      console.log("   请访问: https://boros.pendle.finance/account");
      console.log("   点击 Gas balance → 存入任意金额 → 之后可用脚本追加充值。");
      return;
    }

    const respJson = await resp.json() as { calldata: string; to: string; from: string };
    const { calldata, to } = respJson;

    console.log(`   Target: ${to}`);
    console.log(`   Calldata: ${(calldata as string).substring(0, 30)}...`);
    console.log("");

    // Step 3: Sign and send via root wallet
    console.log("✍️  Step 3: Root 钱包签名并发送交易...");

    const tx = await rootWallet.sendTransaction({
      to,
      data: calldata,
      gasLimit: 300000,
    });

    console.log(`   ✅ TxHash: ${tx.hash}`);

    // Step 4: Wait for confirmation
    console.log("⏳ Step 4: 等待确认...");
    const receipt = await tx.wait();
    console.log(`   ✅ 已确认! 区块: ${receipt?.blockNumber}`);
    console.log(`   Gas 使用: ${receipt?.gasUsed?.toString()}`);

    // Step 5: Verify new balance
    console.log("");
    const gasResp2 = await fetch(`${OPEN_API}/v1/accounts/gas-balance?root=${rootWallet.address}`);
    const gasData2: any = await gasResp2.json();
    const newBal = gasData2.balanceInUSD ? parseFloat(gasData2.balanceInUSD).toFixed(4) : "0";
    console.log(`🎉 充值完成! 新余额: $${newBal}`);

  } catch (e: any) {
    console.error(`❌ 失败: ${e.message}`);
    console.log("");
    console.log("💡 备选方案: 通过 Web UI 手动充值 (推荐)");
    console.log("   https://boros.pendle.finance/account → Gas balance");
  }
}

main().catch(console.error);
