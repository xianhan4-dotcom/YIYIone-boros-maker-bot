require('dotenv').config();
const { getOpenApiSdk } = require('@pendle/boros-sdk-public');

async function main() {
  const sdk = getOpenApiSdk();
  const root = process.env.PRIVATE_KEY 
    ? require('viem/accounts').privateKeyToAccount(process.env.PRIVATE_KEY).address 
    : '0xfB7B5d0EaB7a5a5d8a0b06D1955E2DafA32c18F4';

  console.log('Root:', root);
  console.log();

  // 1. 检查账户信息
  console.log('=== 1. 账户信息 ===');
  try {
    const acc = await sdk.accounts.accountsV2ControllerGetMarketAccInfosByRoot({ root, accountId: 0 });
    for (const info of (acc.data.results || [])) {
      const cash = parseFloat(info.totalCash || '0') / 1e18;
      const marketId = info.marketId;
      console.log(`  市场${marketId}: 现金=$${cash.toFixed(2)}`);
    }
    if (!acc.data.results?.length) {
      console.log('  ⚠️ 无任何市场账户信息！可能需要先存入资金');
    }
  } catch(e) {
    console.log('  错误:', e.message);
  }

  // 2. 检查市场进入状态
  console.log('\n=== 2. 市场130进入状态 ===');
  try {
    const { MarketAccLib, CROSS_MARKET_ID } = require('@pendle/boros-sdk-public');
    const market = await sdk.markets.marketsControllerListMarkets({ marketIds: [130], limit: 1 });
    if (market.data.results[0]) {
      const m = market.data.results[0];
      const crossAcc = MarketAccLib.pack(root, 0, m.tokenId, CROSS_MARKET_ID);
      const entered = await sdk.accounts.accountsV2ControllerGetEnteredMarkets({ marketAcc: crossAcc });
      console.log('  市场130 tokenId:', m.tokenId);
      console.log('  已进入:', entered.data.results.map(r => r.marketId));
    }
  } catch(e) {
    console.log('  错误:', e.message);
  }

  // 3. 检查agent状态
  console.log('\n=== 3. Agent状态 ===');
  const agentAddr = '0xea0E6371579AcAeA5780f7Fa3AD91Ea8bbd34491';
  try {
    const agents = await sdk.accounts.accountsV2ControllerGetApprovedAgents({ root, accountId: 0 });
    console.log('  已授权Agent:', agents.data.results?.map(a => a.agentAddress) || '无');
  } catch(e) {
    console.log('  错误:', e.message);
  }
}

main().catch(console.error);
