require('dotenv').config();
const { privateKeyToAccount } = require('viem/accounts');
const { getOpenApiSdk } = require('@pendle/boros-sdk-public');

function tid(acc){ return acc&&acc.length>=8 ? parseInt(acc.slice(-8).slice(0,2),16) : null; }

async function main() {
  const root = privateKeyToAccount(process.env.PRIVATE_KEY);
  const sdk = getOpenApiSdk();
  const { data } = await sdk.accounts.accountsV2ControllerGetMarketAccInfosByRoot({ root: root.address, accountId: 0 });
  for (const info of (data.results || [])) {
    if (tid(info.marketAcc) !== 3) continue;
    for (const pos of (info.positions || [])) {
      const sz = parseFloat(pos.signedSize||'0')/1e18;
      if (Math.abs(sz) < 0.5) continue;
      console.log(`市场${pos.marketId} 持仓${sz.toFixed(1)}YU 全部字段:`);
      console.log(JSON.stringify(pos, null, 2));
      console.log('---');
    }
  }
  console.log('(若无输出=USDT账户当前无持仓)');
}
main().catch(e => console.log('错误:', e.response?.data || e.message));