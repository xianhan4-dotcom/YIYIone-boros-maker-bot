require('dotenv').config();
const axios = require('axios');
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { arbitrum } = require('viem/chains');
const { Agent, Exchange, estimateTickForRate, getRateAtTick } = require('@pendle/boros-sdk-public');
const { FixedX18 } = require('@pendle/boros-offchain-math');

const API = 'https://api-boros.pendle.finance';
const EDGE_SAFETY_TICKS = 1;      // 与机器人一致:贴外缘
const SAMPLE_INTERVAL_MS = 180_000; // 每3分钟采样一次
const TOTAL_SAMPLES = 20;          // 共采20次(约1小时)

function rateAt(tick, ts) { return getRateAtTick(BigInt(tick), BigInt(ts)).toNumber(); }

function computeEdgeTick(m, side, lr, sr) {
  const ts = m.imData.tickStep;
  const mid = m.data.midApr;
  const edgeApr = side === 'LONG' ? (mid - lr) : (mid + sr);
  let tick = Number(estimateTickForRate(FixedX18.fromNumber(edgeApr), BigInt(ts), false));
  if (side === 'LONG') { tick = Math.ceil(tick/ts)*ts + EDGE_SAFETY_TICKS*ts; }
  else { tick = Math.floor(tick/ts)*ts - EDGE_SAFETY_TICKS*ts; }
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

  // 收集ETH市场基础信息
  const all = await ex.getAllMarkets({ isUiWhitelisted: true });
  const now = Math.floor(Date.now()/1000);
  const eth = all.filter(m => m.tokenId === 2 && m.config.status === 2 &&
    m.imData.maturity > now + 3*86400 && m.data.bestBid != null && !m.imData.isIsolatedOnly);

  console.log(`\n开始采样 ${eth.length} 个ETH市场,每${SAMPLE_INTERVAL_MS/60000}分钟一次,共${TOTAL_SAMPLES}次(约${TOTAL_SAMPLES*SAMPLE_INTERVAL_MS/3600000}小时)`);
  console.log('纯观察,不挂单不花钱。可随时Ctrl+C停止看已有结果。\n');

  // 每个市场的采样历史: {midAprs:[], reachL:[], reachS:[]}
  const hist = {};
  for (const m of eth) hist[m.marketId] = { sym: m.metadata?.fundingRateSymbol, midAprs: [], reachL: [], reachS: [], days: Math.floor((m.imData.maturity-now)/86400) };

  for (let s = 0; s < TOTAL_SAMPLES; s++) {
    const t = new Date().toLocaleTimeString();
    console.log(`\n----- 采样 ${s+1}/${TOTAL_SAMPLES} @${t} -----`);
    const fresh = await ex.getAllMarkets({ isUiWhitelisted: true });
    for (const m of eth) {
      const fm = fresh.find(x => x.marketId === m.marketId);
      if (!fm) continue;
      let inc = null;
      try { const {data} = await axios.get(`${API}/apis/v1/incentives/maker-incentives/campaigns/${m.marketId}`); inc = data.addLiquidityIncentive; } catch {}
      const lr = inc?.long?.incentiveRange || 0.005;
      const sr = inc?.short?.incentiveRange || 0.005;
      const tickL = computeEdgeTick(fm, 'LONG', lr, sr);
      const tickS = computeEdgeTick(fm, 'SHORT', lr, sr);
      const rcL = await reachCost(ex, fm, 'LONG', tickL);
      const rcS = await reachCost(ex, fm, 'SHORT', tickS);
      const h = hist[m.marketId];
      h.midAprs.push(fm.data.midApr);
      h.reachL.push(rcL);
      h.reachS.push(rcS);
      console.log(`  ${h.sym.padEnd(18)} mid${(fm.data.midApr*100).toFixed(2)}% 穿透 多${rcL.toFixed(0)}/空${rcS.toFixed(0)} ETH`);
    }
    if (s < TOTAL_SAMPLES - 1) await new Promise(r => setTimeout(r, SAMPLE_INTERVAL_MS));
  }

  // 汇总分析
  console.log(`\n\n========== ETH市场安全度排名 ==========`);
  const rows = [];
  for (const mid in hist) {
    const h = hist[mid];
    if (h.midAprs.length < 2) continue;
    const maxMid = Math.max(...h.midAprs), minMid = Math.min(...h.midAprs);
    const midSwing = (maxMid - minMid) * 100;  // 利率波动幅度(%)
    const avgReachL = h.reachL.reduce((a,b)=>a+b,0)/h.reachL.length;
    const avgReachS = h.reachS.reduce((a,b)=>a+b,0)/h.reachS.length;
    const minReach = Math.min(avgReachL, avgReachS);  // 取多空较薄的一侧
    // 安全分:穿透越厚越好,波动越小越好
    const safetyScore = minReach / (1 + midSwing * 10);
    rows.push({ sym: h.sym, days: h.days, midSwing, avgReachL, avgReachS, minReach, safetyScore });
  }
  rows.sort((a,b) => b.safetyScore - a.safetyScore);
  console.log('\n按安全分排序(穿透厚+利率稳=高分):\n');
  console.log('市场'.padEnd(18), '利率波动', '穿透多', '穿透空', '安全分', '评级');
  for (const r of rows) {
    let grade;
    if (r.minReach > 30 && r.midSwing < 0.5) grade = '✅可做(厚且稳)';
    else if (r.minReach > 15 && r.midSwing < 1.0) grade = '🟡谨慎';
    else grade = '❌拉黑(薄或跳)';
    console.log(
      r.sym.padEnd(18),
      `${r.midSwing.toFixed(2)}%`.padEnd(8),
      `${r.avgReachL.toFixed(0)}`.padEnd(6),
      `${r.avgReachS.toFixed(0)}`.padEnd(6),
      `${r.safetyScore.toFixed(1)}`.padEnd(6),
      grade
    );
  }
  console.log('\n说明:');
  console.log('  利率波动 = 采样期间midApr最大-最小,越小越稳');
  console.log('  穿透多/空 = 你挂区间外缘时,外侧别人挂单总量(肉盾厚度,ETH),越大越安全');
  console.log('  ✅可做 = 穿透>30ETH 且 利率波动<0.5%(又厚又稳,可躲在后面)');
  console.log('  据此设ETH机器人白名单:只做✅评级的市场');
}

main().catch(e => console.log('错误:', e.response?.data || e.message));