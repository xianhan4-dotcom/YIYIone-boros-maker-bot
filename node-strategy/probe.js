require('dotenv').config();
const axios = require('axios');
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { arbitrum } = require('viem/chains');
const { Agent, Exchange, getRateAtTick } = require('@pendle/boros-sdk-public');

async function main() {
  const root = privateKeyToAccount(process.env.PRIVATE_KEY);
  const agent = Agent.createFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  const wc = createWalletClient({ account: root, transport: http(process.env.RPC_URL), chain: arbitrum });
  const ex = new Exchange(wc, root.address, 0, [process.env.RPC_URL], agent);

  const markets = await ex.getAllMarkets({ isUiWhitelisted: true });
  // 列出所有lighter-sol
  const sols = markets.filter(x => (x.metadata?.fundingRateSymbol||'').includes('lighter-sol') && x.config.status===2);
  for (const m of sols) {
    const { data } = await axios.get(`https://api-boros.pendle.finance/apis/v1/incentives/maker-incentives/campaigns/${m.marketId}`);
    const inc = data.addLiquidityIncentive;
    const mid = m.data.midApr, mark = m.data.markApr;
    const sr = inc.short?.incentiveRange||0, lr = inc.long?.incentiveRange||0;
    const days = Math.floor((m.imData.maturity - Date.now()/1000)/86400);
    console.log(`\n=== id${m.marketId} 剩余${days}天 ===`);
    console.log(`mid:${(mid*100).toFixed(3)}% mark:${(mark*100).toFixed(3)}%`);
    console.log(`基于mid: 空${((mid)*100).toFixed(2)}~${((mid+sr)*100).toFixed(2)}% 多${((mid-lr)*100).toFixed(2)}~${((mid)*100).toFixed(2)}%`);
    console.log(`基于mark: 空${((mark)*100).toFixed(2)}~${((mark+sr)*100).toFixed(2)}% 多${((mark-lr)*100).toFixed(2)}~${((mark)*100).toFixed(2)}%`);
    console.log(`合并区间(mark±): ${((mark-lr)*100).toFixed(2)}% ~ ${((mark+sr)*100).toFixed(2)}%`);
  }
}
main().catch(e=>console.log('错误:', e.response?.data||e.message));