const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { arbitrum } = require("viem/chains");
const axios = require("axios");
require("dotenv").config();

const ROOT_KEY = process.env.PRIVATE_KEY;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const API = process.env.API_BASE_URL;
const RPC = process.env.RPC_URL;

async function main() {
  const rootAccount = privateKeyToAccount(ROOT_KEY);
  const agentAccount = privateKeyToAccount(AGENT_KEY);

  const walletClient = createWalletClient({
    account: rootAccount,
    chain: arbitrum,
    transport: http(RPC),
  });

  console.log("✅ 主钱包地址：", rootAccount.address);
  console.log("✅ Agent地址：", agentAccount.address);
  console.log("🔄 正在获取授权calldata...");

const expiryTime = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

  let calldataResp;
  try {
    const resp = await axios.get(
      `${API}/open-api/v1/calldata/approve-agent`,
      {
        params: {
          userAddress: rootAccount.address,
          accountId: 0,
          agentAddress: agentAccount.address,
          expiryTime: expiryTime,
        },
      }
    );
    calldataResp = resp.data;
    console.log("✅ 获取calldata成功");
  } catch (e) {
    console.log("❌ API错误详情：", JSON.stringify(e.response?.data, null, 2));
    return;
  }

  console.log("🔄 正在提交链上授权交易...");
  try {
    const txHash = await walletClient.sendTransaction({
      to: calldataResp.to,
      data: calldataResp.data,
      gas: BigInt(calldataResp.gas),
    });
    console.log("🎉 Agent授权成功！TxHash:", txHash);
    console.log("🔍 Arbiscan查看:", `https://arbiscan.io/tx/${txHash}`);
  } catch (e) {
    console.log("❌ 发送交易失败：", e.message);
  }
}

main().catch(console.error);