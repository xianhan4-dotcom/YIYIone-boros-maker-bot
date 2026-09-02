require('dotenv').config();
const axios = require('axios');
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { arbitrum } = require('viem/chains');
const { Agent, Exchange } = require('@pendle/boros-sdk-public');

async function main() {
  const root = privateKeyToAccount(process.env.PRIVATE_KEY);
  const agent = Agent.createFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  const wc = createWalletClient({ account: root, transport: http(process.env.RPC_URL), chain: arbitrum });
  const ex = new Exchange(wc, root.address, 0, [process.env.RPC_URL], agent);
  const now = Math.floor(Date.now()/1000);

  const markets = await ex.getAllMarkets({ isUiWhitelisted: true });
  // tokenId=2 (ETH系列) 的活跃市场
  const eth = markets.filter(m => m.tokenId===2 && m.config.status===2 &&
    m.imData.maturity > now+3*86400 && m.data.bestBid!=null && !m.imData.isIsolatedOnly);

  console.log(`tokenId=2 活跃市场数: ${eth.length}\n`);
  let withInc = 0;
  for (const m of eth) {
    let inc=null;
    try { const {data}=await axios.get(`https://api-boros.pendle.finance/apis/v1/incentives/maker-incentives/campaigns/${m.marketId}`); inc=data.addLiquidityIncentive; } catch {}
    if (!inc || (!inc.long?.budgetPerHour && !inc.short?.budgetPerHour)) continue;
    withInc++;
    const days = Math.floor((m.imData.maturity-now)/86400);
    console.log(`--- ${m.metadata?.fundingRateSymbol} (id${m.marketId}, ${days}天) mid${(m.data.midApr*100).toFixed(2)}% ---`);
    for (const side of ['long','short']) {
      const s=inc[side]; if(!s||!s.budgetPerHour) continue;
      const liq=parseFloat(s.currentInRangeLiquidity||0)/1e18;
      console.log(`   ${side}: 日预算${(s.budgetPerHour*24).toFixed(3)}P 流动性${liq.toFixed(0)} 区间${((s.incentiveRange||0)*100).toFixed(2)}%`);
    }
  }
  console.log(`\n有激励的ETH市场: ${withInc}个`);
  console.log('对比tokenId=3里你在做的: hyperliquid-sol日预算约37P, bybit-hype约相当');
}
main().catch(e=>console.log('错误:', e.response?.data||e.message));