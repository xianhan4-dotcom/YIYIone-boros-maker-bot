require('dotenv').config();
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { arbitrum } = require('viem/chains');
const { Agent, Exchange, getOpenApiSdk, MarketAccLib } = require('@pendle/boros-sdk-public');

async function main() {
  const root = privateKeyToAccount(process.env.PRIVATE_KEY);
  const agent = Agent.createFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  const wc = createWalletClient({ account: root, transport: http(process.env.RPC_URL), chain: arbitrum });
  const ex = new Exchange(wc, root.address, 0, [process.env.RPC_URL], agent);
  const sdk = getOpenApiSdk();

  const { data } = await sdk.accounts.accountsV2ControllerGetMarketAccInfosByRoot({ root: root.address, accountId: 0 });
  for (const info of (data.results || [])) {
    const cash = parseFloat(info.totalCash||0)/1e18;
    console.log(`\n--- 账户 cash=${cash} ---`);
    console.log('  marketAcc:', info.marketAcc);
    // 尝试用 MarketAccLib 解码
    try {
      console.log('  解码 tokenId:', MarketAccLib.getTokenId ? MarketAccLib.getTokenId(info.marketAcc) : 'no getTokenId');
    } catch(e) { console.log('  getTokenId失败:', e.message); }
    try {
      console.log('  MarketAccLib 方法:', Object.getOwnPropertyNames(MarketAccLib).join(', '));
    } catch {}
    // marketAcc 是地址形式,tokenId 通常在倒数某几位十六进制
    const acc = info.marketAcc;
    if (acc && acc.length >= 10) {
      // 末尾结构: ...{tokenId(2位)}{marketId(6位)}
      const last8 = acc.slice(-8);
      const tokenHex = last8.slice(0, 2);
      console.log('  末8位:', last8, '| 推测tokenId(前2位hex):', parseInt(tokenHex, 16));
    }
  }
}
main().catch(e => console.log('错误:', e.response?.data || e.message));