require('dotenv').config();
const { getOpenApiSdk } = require('@pendle/boros-sdk-public');

async function main() {
  const sdk = getOpenApiSdk();
  const ms = await sdk.markets.marketsControllerListMarkets({ isUiWhitelisted: true, limit: 200 });
  const sol = ms.data.results
    .filter(m => m.config.status === 2 && (m.metadata?.fundingRateSymbol || '').toLowerCase().includes('sol'))
    .sort((a,b) => (b.data.volume24h||0)-(a.data.volume24h||0))[0];

  console.log('marketId:', sol.marketId, sol.metadata?.fundingRateSymbol);
  console.log('--- data 全部字段 ---');
  console.log(JSON.stringify(sol.data, null, 2));

  console.log('\n--- 查 underlying APR (u) ---');
  try {
    const now = Math.floor(Date.now()/1000);
    const ind = await sdk.indicators.indicatorsControllerGetIndicators({
      marketId: sol.marketId, timeFrame: '1h', select: 'u',
      startTimestamp: now - 86400, endTimestamp: now,
    });
    console.log(JSON.stringify(ind.data, null, 2).slice(0, 800));
  } catch (e) {
    console.log('indicators 失败:', e.message);
  }
}

main().catch(e => console.log('错误:', e.message));