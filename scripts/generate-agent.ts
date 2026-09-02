/**
 * Agent 密钥对生成脚本
 * 用法: npx ts-node scripts/generate-agent.ts
 * 
 * 生成后会输出:
 *   1. Agent 地址 (用于批准)
 *   2. Agent 私钥 (请存入 .env 的 AGENT_PRIVATE_KEY)
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("🔑 正在生成 Boros Agent 密钥对...\n");

  // 生成随机钱包
  const wallet = ethers.Wallet.createRandom();

  console.log("═══════════════════════════════════════════");
  console.log("  Agent 钱包已生成");
  console.log("═══════════════════════════════════════════");
  console.log(`  地址 (Address):  ${wallet.address}`);
  console.log(`  私钥 (Private Key): ${wallet.privateKey}`);
  console.log("═══════════════════════════════════════════\n");

  console.log("⚠️  请立即执行以下操作:");
  console.log("  1. 将私钥存入 .env 文件的 AGENT_PRIVATE_KEY");
  console.log("  2. 运行 npx ts-node scripts/approve-agent.ts 批准 Agent");
  console.log("  3. 切勿将私钥提交到 Git 或分享给任何人\n");

  // 可选: 保存到 .env 文件
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    if (!envContent.includes("AGENT_PRIVATE_KEY=")) {
      fs.appendFileSync(envPath, `\nAGENT_PRIVATE_KEY=${wallet.privateKey}\n`);
      console.log("✅ 私钥已自动追加到 .env 文件");
    } else {
      console.log("⚠️  .env 中已存在 AGENT_PRIVATE_KEY，请手动替换");
    }
  } else {
    fs.writeFileSync(envPath, `AGENT_PRIVATE_KEY=${wallet.privateKey}\n`);
    console.log("✅ 已创建 .env 文件并写入私钥");
  }

  return wallet;
}

main().catch(console.error);
