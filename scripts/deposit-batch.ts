/**
 * Boros 批量存款脚本 — 支持多 Token
 * 用法:
 *   npx ts-node scripts/deposit-batch.ts
 * 
 * 默认存入: WBTC $40 + WETH $50
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const OPEN_API = process.env.BOROS_OPEN_API || "https://api-boros.pendle.finance/apis";
const RPC_URL = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";

const TOKENS = {
  WBTC: { address: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", tokenId: 1, decimals: 8,  amount: "0.00066", desc: "~$40" },
  WETH: { address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", tokenId: 2, decimals: 18, amount: "0.0318", desc: "~$50" },
};

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

async function depositToken(
  rootWallet: ethers.Wallet,
  tokenAddr: string,
  tokenId: number,
  decimals: number,
  amountStr: string,
  label: string
): Promise<boolean> {
  console.log(`\n━━━ ${label} (tokenId=${tokenId}) ━━━`);

  const token = new ethers.Contract(tokenAddr, ERC20_ABI, rootWallet.provider);
  const amountWei = ethers.parseUnits(amountStr, decimals);

  // Check balance
  const balance: bigint = await (token as any).balanceOf(rootWallet.address);
  const balStr = ethers.formatUnits(balance, decimals);
  console.log(`   Wallet balance: ${balStr}`);

  if (balance < amountWei) {
    console.log(`   ⚠️  Insufficient balance, skipping`);
    return false;
  }

  // Get marketAcc
  const encodeUrl = `${OPEN_API}/v1/market-acc/encode?root=${rootWallet.address}&accountId=0&tokenId=${tokenId}&marketId=16777215`;
  const encResp = await fetch(encodeUrl);
  if (!encResp.ok) {
    console.log(`   ❌ marketAcc encode failed: ${await encResp.text()}`);
    return false;
  }
  const { marketAcc } = await encResp.json() as { marketAcc: string };
  console.log(`   marketAcc: ${marketAcc}`);

  // Get deposit calldata
  const depResp = await fetch(`${OPEN_API}/v1/calldata-builder/user/deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketAcc, amount: amountWei.toString() }),
  });

  if (!depResp.ok) {
    console.log(`   ❌ Deposit calldata failed: ${(await depResp.text()).substring(0, 200)}`);
    return false;
  }

  const { calldata, to } = await depResp.json() as { calldata: string; to: string };
  console.log(`   Target: ${to}`);
  console.log(`   Amount: ${amountStr} (${amountWei} wei)`);

  // Check allowance
  const allowance: bigint = await (token as any).allowance(rootWallet.address, to);
  if (allowance < amountWei) {
    console.log(`   Approving token...`);
    const approveTx = await (token.connect(rootWallet) as any).approve(to, amountWei);
    console.log(`   Approve tx: ${approveTx.hash}`);
    await approveTx.wait();
    console.log(`   ✅ Approved`);
  } else {
    console.log(`   Already approved`);
  }

  // Send deposit
  console.log(`   Sending deposit...`);
  const tx = await rootWallet.sendTransaction({ to, data: calldata, gasLimit: 500000 });
  console.log(`   TxHash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`   ✅ Confirmed in block ${receipt?.blockNumber}, gas: ${receipt?.gasUsed}`);
  return true;
}

async function main() {
  const rootKey = process.env.BOROS_ROOT_KEY;
  if (!rootKey) {
    console.error("❌ BOROS_ROOT_KEY not set");
    process.exit(1);
  }

  console.log("💰 Boros 批量存款\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL, 42161);
  const rootWallet = new ethers.Wallet(rootKey, provider);
  console.log(`👤 Root: ${rootWallet.address}\n`);

  let success = 0;
  for (const [name, cfg] of Object.entries(TOKENS)) {
    const ok = await depositToken(rootWallet, cfg.address, cfg.tokenId, cfg.decimals, cfg.amount, name);
    if (ok) success++;
  }

  console.log(`\n🎉 Done: ${success}/${Object.keys(TOKENS).length} tokens deposited`);

  // Check final balances
  console.log("\n📊 Boros Account Summary:");
  for (const [name, cfg] of Object.entries(TOKENS)) {
    try {
      const encUrl = `${OPEN_API}/v1/market-acc/encode?root=${rootWallet.address}&accountId=0&tokenId=${cfg.tokenId}&marketId=16777215`;
      const encR = await fetch(encUrl);
      if (!encR.ok) { console.log(`  ${name}: encode failed`); continue; }
      const { marketAcc } = await encR.json() as { marketAcc: string };

      const infoR = await fetch(`${OPEN_API}/v1/accounts/market-acc-infos`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketAccs: [marketAcc] }),
      });
      const info = await infoR.json() as any;
      const results = info.results || [];
      if (results.length > 0) {
        const a = results[0];
        console.log(`  ${name}: cash=${ethers.formatEther(String(a.totalCash || "0"))} net=${ethers.formatEther(String(a.netBalance || "0"))}`);
      } else {
        console.log(`  ${name}: no data`);
      }
    } catch (e: any) {
      console.log(`  ${name}: error - ${e.message}`);
    }
  }
}

main().catch(console.error);
