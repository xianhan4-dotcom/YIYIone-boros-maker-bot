require('dotenv').config();
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { arbitrum } = require('viem/chains');
const { Agent, Exchange, MarketAccLib, CROSS_MARKET_ID, getOpenApiSdk } = require('@pendle/boros-sdk-public');

async function main() {
  const root  = privateKeyToAccount(process.env.PRIVATE_KEY);
  const agent = Agent.createFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  const wc    = createWalletClient({ account: root, transport: http(process.env.RPC_URL), chain: arbitrum });
  const ex    = new Exchange(wc, root.address, 0, [process.env.RPC_URL], agent);
  const sdk   = getOpenApiSdk();

  const orders = [];
  let resumeToken;
  do {
    const { data } = await sdk.accounts.accountsV2ControllerGetOrders({
      root: root.address, accountId: 0, isActive: true, orderType: '0', limit: 200, resumeToken,
    });
    orders.push(...data.results);
    resumeToken = data.resumeToken ?? undefined;
  } while (resumeToken);

  if (orders.length === 0) { console.log('✅ 当前没有任何挂单'); return; }

  const marketIds = [...new Set(orders.map(o => o.marketId))];
  console.log(`发现 ${orders.length} 笔挂单，分布在 ${marketIds.length} 个市场: ${marketIds.join(', ')}`);

  const allMarkets = await ex.getAllMarkets({ isUiWhitelisted: true });

  for (const mid of marketIds) {
    const m = allMarkets.find(x => x.marketId === mid);
    if (!m) { console.log(`⚠️ 市场${mid}信息缺失，跳过`); continue; }
    const acc = MarketAccLib.pack(root.address, 0, m.tokenId, CROSS_MARKET_ID);
    try {
      await ex.cancelOrders({ marketAcc: acc, marketId: mid, cancelAll: true, orderIds: [] });
      console.log(`✅ 市场${mid}(${m.metadata?.fundingRateSymbol || m.imData.symbol}) 已撤销`);
    } catch (e) {
      console.log(`❌ 市场${mid} 失败: ${e.response?.data?.message || e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  await new Promise(r => setTimeout(r, 2000));
  const { data: check } = await sdk.accounts.accountsV2ControllerGetOrders({
    root: root.address, accountId: 0, isActive: true, orderType: '0', limit: 200 });
  console.log(`\n复验：剩余挂单 ${check.results.length} 笔`);
}

main().catch(e => console.log('错误:', e.message));