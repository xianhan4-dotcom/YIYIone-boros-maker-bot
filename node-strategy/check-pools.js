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
    if (!book || !book.ia) return { reach: 0, cushion: 0 };
    let reach = 0, cushion = 0, cnt = 0;
    for (let i = 0; i < book.ia.length; i++) {
      const tick = book.ia[i], sz = parseFloat(book.sz[i])/1e18;
      if (side === 'LONG' ? tick > myTick : tick < myTick) reach += sz;
      else if (cnt < 3) { cushion += sz; cnt++; }
    }
    return { reach, cushion };
  } catch { return { reach: 0, cushion: 0 }; }
}

async function main() {
  const root = privateKeyToAccount(process.env.PRIVATE_KEY);
  const agent = Agent.createFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  const wc = createWalletClient({ account: root, transport: http(process.env.RPC_URL), chain: arbitrum });
  const ex = new Exchange(wc, root.address, 0, [process.env.RPC_URL], agent);
  const now = Math.floor(Date.now()/1000);

  const all = await ex.getAllMarkets({ isUiWhitelisted: true });
  const usdt = all.filter(m => m.tokenId === 3 && m.config.status === 2 &&
    m.imData.maturity > now + 3*86400 && m.data.bestBid != null && !m.imData.isIsolatedOnly);

  console.log('\n===== USDT池 安全+激励 综合评估 =====\n');
  const results = [];
  for (const m of usdt) {
    let inc = null;
    try { const {data} = await axios.get(`${API}/apis/v1/incentives/maker-incentives/campaigns/${m.marketId}`); inc = data.addLiquidityIncentive; } catch {}
    if (!inc) continue;
    const vol = m.data.dailyVolatility;
    const lr = inc.long?.incentiveRange || 0;
    const sr = inc.short?.incentiveRange || 0;
    const avgRange = (lr + sr) / 2;
    const volRangeRatio = (vol != null && avgRange > 0) ? vol / avgRange : null;

    for (const side of ['long','short']) {
      const s = inc[side];
      if (!s || !s.budgetPerHour) continue;
      const range = side === 'long' ? lr : sr;
      const tick = computeEdgeTick(m, side.toUpperCase(), lr, sr, 1);
      const { reach, cushion } = await reachCost(ex, m, side.toUpperCase(), tick);
      const liq = parseFloat(s.currentInRangeLiquidity||0)/1e18;
      results.push({
        sym: m.metadata?.fundingRateSymbol, side, mid: m.data.midApr, vol,
        range, volRangeRatio, budgetDay: s.budgetPerHour*24, liq, reach, cushion,
      });
    }
  }

  // 按 波动/区间比 排序(越小越安全)
  results.sort((a,b) => (a.volRangeRatio||9) - (b.volRangeRatio||9));

  console.log('市场'.padEnd(18), '方向'.padEnd(6), '波动率', '区间', '波动/区间', '日预算', '肉盾', '安全垫');
  for (const r of results) {
    const ratio = r.volRangeRatio != null ? r.volRangeRatio.toFixed(2) : 'N/A';
    let flag = '';
    if (r.volRangeRatio != null) {
      if (r.volRangeRatio < 0.4) flag = '✅安全';
      else if (r.volRangeRatio < 0.7) flag = '🟡中等';
      else flag = '❌危险';
    }
    console.log(
      r.sym.padEnd(18),
      r.side.padEnd(6),
      `${(r.vol*100).toFixed(3)}%`.padEnd(7),
      `${(r.range*100).toFixed(2)}%`.padEnd(6),
      ratio.padEnd(10),
      `${r.budgetDay.toFixed(1)}P`.padEnd(8),
      `$${Math.round(r.reach)}`.padEnd(8),
      `$${Math.round(r.cushion)}`.padEnd(8),
      flag
    );
  }
  console.log('\n判断:');
  console.log('  ✅安全(波动/区间<0.4): 利率波动远小于缓冲,不易被成交');
  console.log('  对照"日预算"看安全池激励够不够。理想=既✅安全又日预算高');
}
main().catch(e => console.log('错误:', e.response?.data || e.message));