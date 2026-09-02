require('dotenv').config();
const axios = require('axios');
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { arbitrum } = require('viem/chains');
const { Agent, Exchange, estimateTickForRate, getRateAtTick } = require('@pendle/boros-sdk-public');
const { FixedX18 } = require('@pendle/boros-offchain-math');

const API = 'https://api-boros.pendle.finance';

function computeEdgeTick(m, side, lr, sr, edgeSafety) {
  const ts = m.imData.tickStep;
  const mid = m.data.midApr;
  const edgeApr = side === 'LONG' ? (mid - lr) : (mid + sr);
  let tick = Number(estimateTickForRate(FixedX18.fromNumber(edgeApr), BigInt(ts), false));
  if (side === 'LONG') tick = Math.ceil(tick/ts)*ts + edgeSafety*ts;
  else tick = Math.floor(tick/ts)*ts - edgeSafety*ts;
  return tick;
}

async function reachCost(ex, m, side, myTick) {
  try {
    const ob = await ex.getOrderBook({ marketId: m.marketId, tickSize: 0.0001 });
    const book = side === 'LONG' ? ob.long : ob.short;
    if (!book || !book.ia) return 0;
    let cost = 0;
    for (let i = 0; i < book.ia.length; i++) {
      const tick = book.ia[i], sz = parseFloat(book.sz[i])/1e18;
      if (side === 'LONG' ? tick > myTick : tick < myTick) cost += sz;
    }
    return cost;
  } catch { return 0; }
}

async function main() {
  const root = privateKeyToAccount(process.env.PRIVATE_KEY);
  const agent = Agent.createFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  const wc = createWalletClient({ account: root, transport: http(process.env.RPC_URL), chain: arbitrum });
  const ex = new Exchange(wc, root.address, 0, [process.env.RPC_URL], agent);
  const now = Math.floor(Date.now()/1000);

  const all = await ex.getAllMarkets({ isUiWhitelisted: true });
  const btc = all.filter(m => m.tokenId === 1 && m.config.status === 2 &&
    m.imData.maturity > now + 3*86400 && m.data.bestBid != null && !m.imData.isIsolatedOnly);

  console.log(`\n========== BTC本位市场(tokenId=1) 共${btc.length}个活跃 ==========\n`);
  for (const m of btc) {
    const days = Math.floor((m.imData.maturity-now)/86400);
    let inc = null;
    try { const {data} = await axios.get(`${API}/apis/v1/incentives/maker-incentives/campaigns/${m.marketId}`); inc = data.addLiquidityIncentive; } catch {}
    if (!inc || (!inc.long?.budgetPerHour && !inc.short?.budgetPerHour)) continue;
    const lr = inc.long?.incentiveRange || 0.005;
    const sr = inc.short?.incentiveRange || 0.005;
    const tickL = computeEdgeTick(m, 'LONG', lr, sr, 1);
    const tickS = computeEdgeTick(m, 'SHORT', lr, sr, 1);
    const rcL = await reachCost(ex, m, 'LONG', tickL);
    const rcS = await reachCost(ex, m, 'SHORT', tickS);
    console.log(`--- ${m.metadata?.fundingRateSymbol} (id${m.marketId}, ${days}天) mid${(m.data.midApr*100).toFixed(2)}% ---`);
    for (const side of ['long','short']) {
      const s = inc[side]; if(!s||!s.budgetPerHour) continue;
      const liq = parseFloat(s.currentInRangeLiquidity||0)/1e18;
      console.log(`   ${side}: 日预算${(s.budgetPerHour*24).toFixed(3)}P 流动性${liq.toFixed(3)}BTC 区间${((s.incentiveRange||0)*100).toFixed(2)}%`);
    }
    console.log(`   贴外缘肉盾: 多${rcL.toFixed(3)}BTC / 空${rcS.toFixed(3)}BTC`);
  }
  console.log('\n说明:流动性和肉盾单位是BTC。对比你ETH本位:0.5ETH能铺满几个厚池。');
  console.log('BTC数量级更小,据此定BTC机器人的minOrder/reachCost门槛。');
}
main().catch(e => console.log('错误:', e.response?.data || e.message));