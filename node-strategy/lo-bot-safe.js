const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { arbitrum } = require("viem/chains");
const {
  Agent, Exchange, MarketAccLib, Side, TimeInForce,
  CROSS_MARKET_ID, estimateTickForRate, getRateAtTick, getOpenApiSdk,
} = require("@pendle/boros-sdk-public");
const { FixedX18 } = require("@pendle/boros-offchain-math");
const axios = require("axios");
require("dotenv").config();

const ROOT_KEY  = process.env.PRIVATE_KEY;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const RPC_URL   = process.env.RPC_URL;
const API       = "https://api-boros.pendle.finance";
const SECONDS_PER_YEAR = 31536000;

const CONFIG = {
  refreshMs:        4_000,
  marginUsage:      0.90,   // 保证金使用率(调高:资金利用↑但波动缓冲↓)
  edgeSafetyTicks:  1,
  collateralTokenId: 3,
  maxMarkets:       4,
  poolCapPct:       0.30,
  allocSlices:      60,
  candidateN:       12,
  maxVolRangeRatio: 0.60,   // 波动比<0.6无条件放行(免检)
  volRangeRatioHigh: 2.50,  // 波动比≥2.5无条件拉黑（进场/持仓/复检/重评统一上限）
  volTrendOnlyZone: 1.60,   // 波动比≥1.6进入"仅顺势"区间(1.6~2.5)：需方向确认+肉盾加倍
  // 肉盾：只看绝对量（覆盖天数已弃用——volume24h实测不稳定，同日志内0.4天~11501天）
  shieldMinAbs:     100_000, // 波动比0.6~1.6：肉盾需≥此值(YU)
  shieldMinAbsHigh: 300_000, // 波动比1.6~2.5：肉盾需≥此值(YU)
  marketCapPct:     0.50,    // 单个市场(多空合计)保证金上限
  minPoolPendle:    3,       // 池子每日总发放<3 PENDLE直接排除(不值得挂)
  bigPoolPendle:    10,      // 池子每日总发放>10 PENDLE时，限制我的占比
  maxShareBigPool:  0.30,    // 大池子(>10P/天)我的占比上限30%，控制仓位风险
  dirConfirmRounds: 5,       // 方向需连续N轮确认才算数(去除floatingApr瞬时尖峰的假信号)
  // pendlePrice 已改为自动获取，见 fetchPendlePrice()
  marginSafetyFactor: 0.93,  // 挂单YU量打折，应对yuPerUsd估算与链上slippage保证金的误差
  volExitRatio:     2.50,   // 持仓中波动比超2.5才撤离（必须和进场上限一致，否则刚挂就被撤）
  trendWaitMs:      2 * 3600_000, // 趋势平仓：有利持仓最多等待2小时
  trendDiffThresh:  0.04,   // 趋势判断：floatingApr-midApr绝对值>4%才认为方向有利
  dangerTicks:      3,
  fleeCoolMs:       180_000,
  reachCostBase:    300,
  reachCostScale:   0.5,
  reachBonusWeight: 0.3,
  cushionBase:      150,
  cushionScale:     0.2,
  cushionDepth:     3,
  maxRangeWidth:    0.15,
  edgeTolerance:    2,
  dirThreshold:     0.03,   // 中位区(0.6~1.6)：差值>3%只做顺势单边，≤3%双向都挂
  dirThreshHighVol: 0.03,   // 高波动区间(0.9~1.2)：差值>3%才允许进场(仅顺势)
  slBalPct:         0.015,
  slPrinPct:        0.12,
  meltBalPct:       0.025,
  meltPrinPct:      0.20,
  healthDanger:     0.80,
  closeChaseTicks:  3,
  iocBaseTicks:     20,
  iocMaxTicks:      400,
  iocStepTicks:     40,     // 每轮加深40tick(原20太慢,大仓位平不动)
  aloRetry:         5,
  coolDownMs:       3_600_000,
  failCoolMs:       300_000,
  volCoolMs:        1_800_000,
  depositThreshold: 10,
  minOrderUsd:      15,
  rebalanceMinPct:  0.08,
  rebalanceCooldownMs: 600_000,
  minIncentiveApr:  0.50,    // 激励APR门槛：优先选>50%的池
  aprFallbackRounds: 450,    // 等待450轮（约30分钟）找不到高APR池才降级
  addPositionMinIdle: 50,    // 闲置>$50才触发加仓（节省gas）
  addPositionCoolMs: 6 * 3600_000, // 加仓后6小时内不重复加仓同一个池
  healthCheckPerRound: 4,
  maturityExitDays: 3,
  gasWarnEth:       0.002,
  agentWarnHours:   24,
  // 定时重评：每8小时主动扫描，日收益提升能覆盖切换成本($0.02)才切
  reviewIntervalMs: 8 * 3600_000,   // 8小时
  switchCostUsd:    0.02,            // 每次切换gas成本
};

let MARGIN_CALIB = 1.61;
const MARGIN_CALIB_MAX = 6.0;

// ===== 校准持久化：避免每次重启都从1.61重新收敛，浪费gas =====
const fs = require('fs');
const STATE_FILE = './bot-state.json';

// ===== 关键事件CSV记录器 =====
// 只记重要事件（成交/平仓/开仓/切换/异常），永久累加，Excel可直接打开统计
// 普通扫描噪音(拉黑/方向/稳态)不记录
const EVENT_CSV = './key-events.csv';
const EVENT_HEADER = '时间,事件,市场,方向,金额USD,盈亏USD,波动比,差值%,备注\n';
function initEventCsv() {
  try {
    if (!fs.existsSync(EVENT_CSV)) fs.writeFileSync(EVENT_CSV, '\uFEFF' + EVENT_HEADER); // BOM让Excel正确识别UTF-8
  } catch (e) { /* 静默 */ }
}
// 记一条事件。字段可选，缺的留空
function logEvent(fields) {
  try {
    const ts = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS
    const row = [
      ts,
      fields.event || '',
      fields.market || '',
      fields.side || '',
      fields.usd != null ? fields.usd.toFixed(2) : '',
      fields.pnl != null ? fields.pnl.toFixed(2) : '',
      fields.vrr != null ? fields.vrr.toFixed(2) : '',
      fields.diff != null ? (fields.diff * 100).toFixed(1) : '',
      (fields.note || '').replace(/,/g, '；'), // 逗号替换,避免破坏CSV
    ].join(',');
    fs.appendFileSync(EVENT_CSV, row + '\n');
  } catch (e) { /* 静默,不影响主流程 */ }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.marginCalib && s.marginCalib >= 0.5 && s.marginCalib <= MARGIN_CALIB_MAX) {
      MARGIN_CALIB = s.marginCalib;
      const ageMin = s.savedAt ? Math.round((Date.now() - s.savedAt) / 60000) : -1;
      log(`💾 校准恢复: ${MARGIN_CALIB.toFixed(2)} (${ageMin >= 0 ? ageMin + '分钟前保存' : '无时间戳'})`);
    }
  } catch (e) { log(`💾 状态读取失败,使用默认校准: ${e.message}`); }
}
let lastSavedCalib = null;
function saveState() {
  try {
    // 只在校准变化超过1%时写盘，避免频繁IO
    if (lastSavedCalib !== null && Math.abs(MARGIN_CALIB - lastSavedCalib) / lastSavedCalib < 0.01) return;
    fs.writeFileSync(STATE_FILE, JSON.stringify({ marginCalib: MARGIN_CALIB, savedAt: Date.now() }, null, 2));
    lastSavedCalib = MARGIN_CALIB;
  } catch (e) { /* 静默失败，不影响运行 */ }
}

// PENDLE 价格动态获取，每小时刷新一次
let PENDLE_PRICE = 1.26; // 初始值，启动后立即更新
let lastPriceFetchTs = 0;
async function fetchPendlePrice() {
  try {
    const r = await axios.get('https://api-v2.pendle.finance/core/v1/1/assets/prices?addresses=0x808507121b80c02388fad14726482e061b8da827', { timeout: 5000 });
    const price = r.data?.prices?.['0x808507121b80c02388fad14726482e061b8da827'];
    if (price && price > 0) {
      PENDLE_PRICE = price;
      log(`  💎 PENDLE价格更新: $${PENDLE_PRICE.toFixed(3)}`);
    }
  } catch (e) {
    // 静默失败，保持上次价格
  }
}
async function getPendlePrice() {
  const now = Date.now();
  if (now - lastPriceFetchTs > 3600_000) { // 超过1小时就刷新
    lastPriceFetchTs = now;
    await fetchPendlePrice();
  }
  return PENDLE_PRICE;
}  // 硬上限，超出即重置

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[SAFE ${new Date().toLocaleTimeString()}] ${msg}`); }
function alert(msg){ console.log(`\n${"!".repeat(60)}\n[SAFE ${new Date().toLocaleTimeString()}] ${msg}\n${"!".repeat(60)}\n`); }
function poolKey(marketId, side) { return `${marketId}:${side}`; }

function tokenIdFromMarketAcc(acc) {
  if (!acc || acc.length < 8) return null;
  return parseInt(acc.slice(-8).slice(0, 2), 16);
}

async function getIncentive(marketId) {
  try {
    const { data } = await axios.get(`${API}/apis/v1/incentives/maker-incentives/campaigns/${marketId}`);
    return data.addLiquidityIncentive;
  } catch { return null; }
}

async function getAccInfo(root) {
  const sdk = getOpenApiSdk();
  try {
    const { data } = await sdk.accounts.accountsV2ControllerGetMarketAccInfosByRoot({ root, accountId: 0 });
    for (const info of (data.results || [])) {
      if (tokenIdFromMarketAcc(info.marketAcc) === CONFIG.collateralTokenId) return info;
    }
    return null;
  } catch { return null; }
}

async function getBalance(root) {
  const info = await getAccInfo(root);
  return info ? parseFloat(info.totalCash || "0") / 1e18 : 0;
}

async function getUsedMargin(root) {
  const info = await getAccInfo(root);
  return info ? parseFloat(info.initialMargin || "0") / 1e18 : 0;
}

async function getHealthRatio(root) {
  const info = await getAccInfo(root);
  if (!info) return 0;
  const net = parseFloat(info.netBalance || info.totalCash || "0") / 1e18;
  const maint = parseFloat(info.maintMargin || "0") / 1e18;
  if (net <= 0) return 0;
  return maint / net;
}

async function getPositionDetail(root, marketId) {
  const sdk = getOpenApiSdk();
  try {
    const { data } = await sdk.accounts.accountsV2ControllerGetMarketAccInfosByRoot({ root, accountId: 0 });
    for (const info of (data.results || [])) {
      if (tokenIdFromMarketAcc(info.marketAcc) !== CONFIG.collateralTokenId) continue;
      for (const pos of (info.positions || [])) {
        if (pos.marketId === marketId) {
          return { size: parseFloat(pos.signedSize || "0") / 1e18, valueUsd: parseFloat(pos.positionValue || "0") / 1e18 };
        }
      }
    }
  } catch {}
  return { size: 0, valueUsd: 0 };
}

// 读取账户下所有真实持仓（一次API调用），用于发现held里没有的"孤儿持仓"
// 返回 [{marketId, size, valueUsd}]，size绝对值>0.5才算真持仓
async function getAllPositions(root) {
  const sdk = getOpenApiSdk();
  const out = [];
  try {
    const { data } = await sdk.accounts.accountsV2ControllerGetMarketAccInfosByRoot({ root, accountId: 0 });
    for (const info of (data.results || [])) {
      if (tokenIdFromMarketAcc(info.marketAcc) !== CONFIG.collateralTokenId) continue;
      for (const pos of (info.positions || [])) {
        const size = parseFloat(pos.signedSize || "0") / 1e18;
        if (Math.abs(size) > 0.5) {
          out.push({ marketId: pos.marketId, size, valueUsd: parseFloat(pos.positionValue || "0") / 1e18 });
        }
      }
    }
  } catch {}
  return out;
}

function volRangeRatio(market, inc) {
  const vol = market.data.dailyVolatility;
  if (vol == null) return null;
  const lr = inc.long?.incentiveRange || 0;
  const sr = inc.short?.incentiveRange || 0;
  const avgRange = (lr + sr) / 2;
  if (avgRange <= 0) return null;
  return vol / avgRange;
}

// ===== 方向确认：连续N轮同向才算数 =====
// 原因：floatingApr 是瞬时值且尖峰剧烈(实测打到+50%/+70%/-20%)，
// 单轮采样会把尖峰误判为"强顺势"，而隐含利率跟的是未来平均值，不会跟随尖峰。
// 要求连续 dirConfirmRounds 轮(约20秒)差值都超门槛，尖峰撑不住20秒就不会误触发。
const diffHist = new Map(); // marketId -> [最近N轮的 floatingApr-midApr]
function recordDiffHistory(all) {
  for (const m of all) {
    const f = m.data?.floatingApr, mid = m.data?.midApr;
    if (f == null || mid == null) continue;
    const arr = diffHist.get(m.marketId) || [];
    arr.push(f - mid);
    if (arr.length > CONFIG.dirConfirmRounds) arr.shift();
    diffHist.set(m.marketId, arr);
  }
}
// 连续N轮都超门槛且同向才给方向
// 返回值区分三种：'INSUFFICIENT'样本不足(不该进场) / 'LONG' / 'SHORT' / 'BOTH'方向不明确
function dirBiasConfirmed(market, thresh) {
  const arr = diffHist.get(market.marketId) || [];
  if (arr.length < CONFIG.dirConfirmRounds) return 'INSUFFICIENT'; // 样本不足,还没看清方向
  if (arr.every(d => d > thresh)) return 'LONG';
  if (arr.every(d => d < -thresh)) return 'SHORT';
  return 'BOTH'; // 攒够样本但方向不明确(差值没持续同向)
}

// ===== 盯差值转向：方案A（跌破对侧门槛才撤单）=====
// 核心：进场看差值(标的-隐含)>+3%做多、<-3%做空。持仓中方向指标就是这个差值。
//   LONG持仓：差值连续N轮 < -dirThreshold(-3%) → 方向已翻转 → 撤单
//   SHORT持仓：差值连续N轮 > +dirThreshold(+3%) → 撤单
//   中间地带(-3%~+3%)：继续持有原仓，不动(有利方向不会成交,吃挂单奖励)
// 撤单后不冷却,下轮走完整进场逻辑重新扫描(方向/肉盾/池子/APR全部重审)。
//   反手不是必然的——若新方向池子/肉盾/APR不达标则空仓等待,不硬挂对侧。
// 复用 diffHist（已记录每轮差值），无需额外数据
function dirTurnedOpposite(marketId, posSide) {
  const arr = diffHist.get(marketId) || [];
  if (arr.length < CONFIG.dirConfirmRounds) return false; // 样本不足
  const t = CONFIG.dirThreshold; // 3%
  // LONG怕差值跌破 -3%（标的大幅低于隐含，反转做空信号）
  if (posSide === 'LONG') return arr.every(d => d < -t);
  // SHORT怕差值涨破 +3%（标的大幅高于隐含，反转做多信号）
  if (posSide === 'SHORT') return arr.every(d => d > t);
  return false;
}

// 方向判断(瞬时,仅用于平仓趋势判断):标的(floatingApr) vs 隐含(midApr)
// thresh 可选：常规区间用 dirThreshold(4%)，高波动区间用 dirThreshHighVol(3%)
function dirBias(market, thresh) {
  const t = thresh ?? CONFIG.dirThreshold;
  const f = market.data.floatingApr;
  const mid = market.data.midApr;
  if (f == null || mid == null) return 'BOTH';
  const diff = f - mid;
  if (diff < -t) return 'SHORT';   // 标的<<隐含,下行压力,只做空
  if (diff > t) return 'LONG';     // 标的>>隐含,上行压力,只做多
  return 'BOTH';
}

function yuPerUsd(market, orderRateNum) {
  const ts = market.imData.tickStep;
  const now = Math.floor(Date.now() / 1000);
  const ttm = market.imData.maturity - now;
  if (ttm <= 0) return 0;
  const iThreshRate = Math.abs(getRateAtTick(BigInt(market.imData.iTickThresh), BigInt(ts)).toNumber());
  const leverage = market.metadata?.maxLeverage || 2;
  const kIM = Number(market.config.kIM) / 1e18;
  const tThresh = market.config.tThresh;
  const ttmY = ttm / SECONDS_PER_YEAR;
  const minTimeY = tThresh / SECONDS_PER_YEAR;
  const timeY = Math.max(ttmY, minTimeY);
  const absOrderRate = Math.abs(orderRateNum);
  const offchainRate = absOrderRate > iThreshRate ? absOrderRate : iThreshRate;
  const contractSuf = offchainRate * timeY * kIM;
  const offchainSuf = offchainRate * timeY / leverage;
  const imSuf = Math.max(contractSuf, offchainSuf);
  if (imSuf <= 0) return 0;
  return MARGIN_CALIB / imSuf;
}

function computeEdgeTick(market, side, inc) {
  const ts = market.imData.tickStep;
  const mid = market.data.midApr;
  const lr = inc.long?.incentiveRange || 0.0075;
  const sr = inc.short?.incentiveRange || 0.0075;
  const edgeApr = side === "LONG" ? (mid - lr) : (mid + sr);
  let tick = Number(estimateTickForRate(FixedX18.fromNumber(edgeApr), BigInt(ts), false));
  if (side === "LONG") { tick = Math.ceil(tick / ts) * ts; tick += CONFIG.edgeSafetyTicks * ts; }
  else { tick = Math.floor(tick / ts) * ts; tick -= CONFIG.edgeSafetyTicks * ts; }
  return tick;
}

function midTick(market) {
  const ts = market.imData.tickStep;
  return Number(estimateTickForRate(FixedX18.fromNumber(market.data.midApr), BigInt(ts), false));
}

function estimateDailyReward(opt, myYu) {
  const share = myYu / (opt.baseLiq + myYu);
  return opt.budgetDay * share;
}

async function analyzeOrderBookSafety(exchange, market, side, myTick) {
  try {
    const ob = await exchange.getOrderBook({ marketId: market.marketId, tickSize: 0.0001 });
    const book = side === "LONG" ? ob.long : ob.short;
    if (!book || !book.ia || !book.sz) return { reachCost: 0, cushion: 0 };
    let reachCost = 0, cushion = 0, cushionCount = 0;
    for (let i = 0; i < book.ia.length; i++) {
      const tick = book.ia[i];
      const szYu = parseFloat(book.sz[i]) / 1e18;
      if (side === "LONG") {
        if (tick > myTick) reachCost += szYu;
        else if (tick <= myTick && cushionCount < CONFIG.cushionDepth) { cushion += szYu; cushionCount++; }
      } else {
        if (tick < myTick) reachCost += szYu;
        else if (tick >= myTick && cushionCount < CONFIG.cushionDepth) { cushion += szYu; cushionCount++; }
      }
    }
    return { reachCost, cushion };
  } catch { return { reachCost: 0, cushion: 0 }; }
}

function safetyThresholds(balance) {
  return {
    minReach: Math.max(CONFIG.reachCostBase, balance * CONFIG.reachCostScale),
    minCushion: Math.max(CONFIG.cushionBase, balance * CONFIG.cushionScale),
  };
}

// 肉盾强度判断：只看绝对量
// 覆盖天数(reachCost/volume24h)已弃用——volume24h实测极不稳定，
// 同一份日志内btc算出11501天、gate-hype算出0.4天，相差2.8万倍，指标不可信
function shieldCheck(market, reachCost, isHighVol) {
  const absMin = isHighVol ? CONFIG.shieldMinAbsHigh : CONFIG.shieldMinAbs;
  const ok = reachCost >= absMin;
  return { ok, desc: `肉盾${Math.round(reachCost)}YU${ok ? '≥' : '<'}${absMin}` };
}

async function computeAllocation(exchange, availBudget, balance, slotsLeft, excludeMarketIds, existingAlloc, pendlePrice, fallback = false, coolingMarketIds = new Set()) {
  const markets = await exchange.getAllMarkets({ isUiWhitelisted: true });
  const now = Math.floor(Date.now() / 1000);
  const { minReach, minCushion } = safetyThresholds(balance);

  let valid = markets.filter(m =>
    m.config.status === 2 && m.imData.maturity > now + 3 * 86400 &&
    m.data.bestBid != null && m.data.bestAsk != null &&
    !m.imData.isIsolatedOnly && !excludeMarketIds.has(m.marketId)
  );
  valid = valid.filter(m => m.tokenId === CONFIG.collateralTokenId);
  valid.sort((a, b) => (b.data.volume24h || 0) - (a.data.volume24h || 0));
  const candidates = valid.slice(0, CONFIG.candidateN);

  const options = [];
  for (const m of candidates) {
    const inc = await getIncentive(m.marketId);
    if (!inc) continue;
    const lr = inc.long?.incentiveRange || 999;
    const sr = inc.short?.incentiveRange || 999;
    if (lr > CONFIG.maxRangeWidth || sr > CONFIG.maxRangeWidth) continue;
    const vrr = volRangeRatio(m, inc);
    if (vrr == null) { log(`  ⏭️ ${m.metadata?.fundingRateSymbol} 无波动率,跳过`); continue; }
    if (vrr >= CONFIG.volRangeRatioHigh) { log(`  🚫 ${m.metadata?.fundingRateSymbol} 波动比${vrr.toFixed(2)}过高拉黑`); continue; }
    // ===== 方向规则：所有区(免检/中位/高位)都判方向,统一3%门槛+5轮确认 =====
    // 差>3% → 单边顺势；差≤3%(BOTH) → 免检区/中位区双向、高位区拒绝；样本不足 → 不进场
    // 区间差异仅在肉盾：免检区(<0.6)免检、中位区(0.6~1.6)≥10万、高位区(1.6~2.5)≥30万
    const highVolZone = vrr >= CONFIG.volTrendOnlyZone;
    const needsShieldCheck = vrr > CONFIG.maxVolRangeRatio && !highVolZone; // 中位区才查肉盾(免检区跳过)
    const mid = m.data.midApr;
    const dirT = highVolZone ? CONFIG.dirThreshHighVol : CONFIG.dirThreshold; // 都是3%
    const bias = dirBiasConfirmed(m, dirT);
    // 样本不足：还没攒够5轮，看不清方向，一律不进场（不分区间）
    if (bias === 'INSUFFICIENT') {
      const arr = diffHist.get(m.marketId) || [];
      log(`  🚫 ${m.metadata?.fundingRateSymbol} 波动比${vrr.toFixed(2)} 方向样本不足(${arr.length}/${CONFIG.dirConfirmRounds}轮)→拉黑`);
      continue;
    }
    // 方向不明确(BOTH)：高波动区拒绝；中位区才允许双向
    if (highVolZone && bias === 'BOTH') {
      const cur = ((m.data.floatingApr - m.data.midApr) * 100).toFixed(1);
      log(`  🚫 ${m.metadata?.fundingRateSymbol} 波动比${vrr.toFixed(2)}高位 方向未连续${CONFIG.dirConfirmRounds}轮确认(当前差${cur}%,需持续>${(dirT*100).toFixed(0)}%)→拉黑`);
      continue;
    }
    let sides;
    if (bias === 'SHORT') { sides = ["SHORT"]; log(`  🧭 ${m.metadata?.fundingRateSymbol} 标的${(m.data.floatingApr*100).toFixed(1)}%<<隐含${(mid*100).toFixed(1)}%→只做空(${CONFIG.dirConfirmRounds}轮确认)`); }
    else if (bias === 'LONG') { sides = ["LONG"]; log(`  🧭 ${m.metadata?.fundingRateSymbol} 标的${(m.data.floatingApr*100).toFixed(1)}%>>隐含${(mid*100).toFixed(1)}%→只做多(${CONFIG.dirConfirmRounds}轮确认)`); }
    else { sides = ["LONG", "SHORT"]; log(`  🧭 ${m.metadata?.fundingRateSymbol} 方向不明确(差<${(dirT*100).toFixed(0)}%)→中位区双向`); }
    for (const side of sides) {
      const incSide = side === "LONG" ? inc.long : inc.short;
      if (!incSide || !incSide.budgetPerHour) continue;
      // 池子每日总发放太少直接排除（不值得占用仓位和gas）
      const budgetDay = incSide.budgetPerHour * 24;
      if (budgetDay < CONFIG.minPoolPendle) {
        log(`  🚫 ${m.metadata?.fundingRateSymbol} ${side} 池子仅${budgetDay.toFixed(2)}P/天<${CONFIG.minPoolPendle}P→排除`);
        continue;
      }
      const edgeApr = side === "LONG" ? mid - lr : mid + sr;
      const tick = computeEdgeTick(m, side, inc);
      const { reachCost, cushion } = await analyzeOrderBookSafety(exchange, m, side, tick);
      if (reachCost < minReach || cushion < minCushion) continue;
      // 肉盾判断：只看绝对量（高波动区要求翻倍）
      if (highVolZone || needsShieldCheck) {
        const sc = shieldCheck(m, reachCost, highVolZone);
        const zone = highVolZone ? '高位顺势' : '偏高';
        if (!sc.ok) {
          log(`  🚫 ${m.metadata?.fundingRateSymbol} ${side} 波动比${vrr.toFixed(2)}${zone} ${sc.desc}→拉黑`);
          continue;
        }
        log(`  ✅ ${m.metadata?.fundingRateSymbol} ${side} 波动比${vrr.toFixed(2)}${zone}放行(${sc.desc} 池${budgetDay.toFixed(1)}P/天)`);
      }
      const k = poolKey(m.marketId, side);
      options.push({
        market: m, inc, side, tick, vrr,
        budgetDay: incSide.budgetPerHour * 24,
        baseLiq: parseFloat(incSide.currentInRangeLiquidity || "0") / 1e18,
        yuPerUsd: yuPerUsd(m, edgeApr),
        reachCost, cushion,
        baseUsd: existingAlloc?.get(k) || 0, allocUsd: 0,
      });
    }
  }
  if (options.length === 0 || availBudget < CONFIG.minOrderUsd) {
    if (options.length === 0) log(`  ⚠️ 无符合安全标准的池`);
    return [];
  }

  // 激励APR过滤：非降级模式只选APR>50%的池
  // incentiveAPR = (dailyReward_per_usd × pendlePrice × 365)
  // 用minOrderUsd作为标准化投入计算单位APR
  const testUsd = 100;
  for (const o of options) {
    const testYu = testUsd * o.yuPerUsd;
    const dailyP = estimateDailyReward(o, testYu);
    o.incentiveApr = (dailyP * pendlePrice / testUsd) * 365;
  }

  let filteredOptions = options;
  if (!fallback) {
    const highAprOptions = options.filter(o => o.incentiveApr >= CONFIG.minIncentiveApr);
    if (highAprOptions.length > 0) {
      filteredOptions = highAprOptions;
      log(`  📈 APR过滤: ${options.length}个候选池→${highAprOptions.length}个高APR池(>${(CONFIG.minIncentiveApr*100).toFixed(0)}%)`);
    } else {
      log(`  ⏳ 无高APR池(>${(CONFIG.minIncentiveApr*100).toFixed(0)}%)，等待降级...`);
      return []; // 返回空，让主循环继续等待
    }
  } else {
    log(`  📉 降级模式：接受全部安全池(${options.length}个)`);
  }

  // 单池硬上限：无论新开还是加仓，统一45%，防集中风险（安全第一）
  const totalBudget = balance * CONFIG.marginUsage;
  const hardCapPct = 0.50;  // 单个(市场,方向)保证金上限
  const hardCap = totalBudget * hardCapPct;

  const slice = availBudget / CONFIG.allocSlices;
  const maxReach = Math.max(...filteredOptions.map(o => o.reachCost));

  function marginalGain(opt) {
    const total = opt.baseUsd + opt.allocUsd;
    const base = estimateDailyReward(opt, (total + slice) * opt.yuPerUsd) - estimateDailyReward(opt, total * opt.yuPerUsd);
    const reachBonus = 1 + CONFIG.reachBonusWeight * (opt.reachCost / maxReach);
    return base * reachBonus;
  }

  // 已分配的市场ID集合（用于判断是否开新池）
  const allocatedMarketIds = new Set(
    [...(existingAlloc?.keys() || [])].map(k => k.split(':')[0])
  );

  const marketCap = totalBudget * CONFIG.marketCapPct;
  // 计算某市场当前多空合计（含已有持仓和本轮已分配）
  function marketTotal(marketId) {
    let sum = 0;
    for (const o of filteredOptions) {
      if (o.market.marketId === marketId) sum += o.baseUsd + o.allocUsd;
    }
    // 已有持仓中不在候选列表里的方向也要算进来
    for (const [k, v] of (existingAlloc || [])) {
      const [mid, side] = k.split(':');
      if (mid !== marketId) continue;
      if (filteredOptions.some(o => o.market.marketId === mid && o.side === side)) continue;
      sum += v;
    }
    return sum;
  }

  for (let i = 0; i < CONFIG.allocSlices; i++) {
    const newMarketIds = new Set(filteredOptions.filter(o => o.allocUsd > 0 && o.baseUsd === 0).map(o => o.market.marketId));
    let bestOpt = null, bestGain = -Infinity;
    for (const opt of filteredOptions) {
      // 上限1：单个(市场,方向)不超过hardCap
      const newTotal = opt.baseUsd + opt.allocUsd + slice;
      if (newTotal > hardCap) continue;
      // 上限2：单个市场多空合计不超过marketCap（防同市场双边绕过单边限制）
      if (marketTotal(opt.market.marketId) + slice > marketCap) continue;
      // 上限3：大池子(每日发放>10P)我的占比不超过30%，控制仓位风险
      if (opt.budgetDay > CONFIG.bigPoolPendle) {
        const yuAfter = newTotal * opt.yuPerUsd;
        const shareAfter = yuAfter / (opt.baseLiq + yuAfter);
        if (shareAfter > CONFIG.maxShareBigPool) continue;
      }
      // 判断是否为新开池
      const isExisting = opt.baseUsd > 0 || allocatedMarketIds.has(opt.market.marketId) || newMarketIds.has(opt.market.marketId);
      const opensNew = !isExisting && opt.allocUsd === 0;
      if (opensNew) {
        // 新开池：预估这个池在minOrderUsd投入下的日收，必须覆盖gas成本才值得开
        const minYu = CONFIG.minOrderUsd * opt.yuPerUsd;
        const minDailyP = estimateDailyReward(opt, minYu);
        const minDailyUsd = minDailyP * pendlePrice;
        if (minDailyUsd < CONFIG.switchCostUsd) continue; // 日收覆盖不了gas，不开
      }
      // slotsLeft=0时只允许加仓（不开新池）
      if (opensNew && slotsLeft === 0) continue;
      // 冷却中的市场可以被评估但不能新开仓（加仓已有持仓则允许）
      if (opensNew && coolingMarketIds && coolingMarketIds.has(opt.market.marketId)) continue;
      const g = marginalGain(opt);
      if (g > bestGain) { bestGain = g; bestOpt = opt; }
    }
    if (bestOpt) {
      bestOpt.allocUsd += slice;
      // 新开池时记录到allocatedMarketIds
      if (!allocatedMarketIds.has(bestOpt.market.marketId) && bestOpt.baseUsd === 0) {
        allocatedMarketIds.add(bestOpt.market.marketId);
      }
    } else break;
  }

  const final = filteredOptions.filter(o => o.allocUsd >= CONFIG.minOrderUsd);
  const newPoolCount = final.filter(o => o.baseUsd === 0).length;
  log(`  📐 动态分配: ${final.length}个池(${newPoolCount}新开) 单边上限$${hardCap.toFixed(0)}(${(hardCapPct*100).toFixed(0)}%) 单市场上限$${marketCap.toFixed(0)}`);
  for (const o of final) o.yu = o.allocUsd * o.yuPerUsd * 0.95;
  if (final.length > 0) {
    log(`  📊 安全分配(奖励优先·动态池数):`);
    for (const o of final) {
      const totalYu = (o.baseUsd + o.allocUsd) * o.yuPerUsd;
      const share = (totalYu / (o.baseLiq + totalYu) * 100).toFixed(2);
      const tag = o.baseUsd > 0 ? "加仓" : "新开";
      const dailyP = estimateDailyReward(o, totalYu).toFixed(3);
      const v24 = parseFloat(o.market.data?.volume24h ?? 0) || 0;
      const shieldTxt = v24 > 0 ? `肉盾${(o.reachCost/v24).toFixed(1)}天` : `肉盾${Math.round(o.reachCost)}YU`;
      log(`     [${tag}]${o.market.metadata?.fundingRateSymbol} ${o.side}: +$${o.allocUsd.toFixed(0)}→${o.yu.toFixed(0)}YU 占比${share}% 波动比${o.vrr.toFixed(2)} ${shieldTxt} 预估日收${dailyP}P`);
    }
  }
  return final;
}


async function ensureEntered(exchange, root, market) {
  const sdk = getOpenApiSdk();
  const crossAcc = MarketAccLib.pack(root, 0, market.tokenId, CROSS_MARKET_ID);
  const { data } = await sdk.accounts.accountsV2ControllerGetEnteredMarkets({ marketAcc: crossAcc });
  if (data.results.some(r => r.marketId === market.marketId)) return;
  log(`  ⏎ 进入市场 ${market.marketId}...`);
  await exchange.enterMarkets(true, [market.marketId]);
  await sleep(2000);
}

async function getActiveOrders(root, marketId) {
  const sdk = getOpenApiSdk();
  const orders = [];
  let resumeToken;
  do {
    const { data } = await sdk.accounts.accountsV2ControllerGetOrders({ root, accountId: 0, marketId, isActive: true, orderType: "0", limit: 200, resumeToken });
    orders.push(...data.results);
    resumeToken = data.resumeToken ?? undefined;
  } while (resumeToken);
  return orders;
}

async function getAllActiveOrdersForToken(root, all) {
  const sdk = getOpenApiSdk();
  const orders = [];
  let resumeToken;
  do {
    const { data } = await sdk.accounts.accountsV2ControllerGetOrders({ root, accountId: 0, isActive: true, orderType: "0", limit: 200, resumeToken });
    orders.push(...data.results);
    resumeToken = data.resumeToken ?? undefined;
  } while (resumeToken);
  const tokMarketIds = new Set(all.filter(m => m.tokenId === CONFIG.collateralTokenId).map(m => m.marketId));
  return orders.filter(o => tokMarketIds.has(o.marketId));
}

async function cancelMarket(exchange, root, market) {
  const marketAcc = MarketAccLib.pack(root, 0, market.tokenId, CROSS_MARKET_ID);
  try {
    await exchange.cancelOrders({ marketAcc, marketId: market.marketId, cancelAll: true, orderIds: [] });
    log(`  ↩️ 撤单 ${market.metadata?.fundingRateSymbol}`);
  } catch (e) { log(`  ⚠️ 撤单: ${e.response?.data?.message || e.message}`); }
}

async function placeOrderFor(exchange, root, opt) {
  const market = opt.market;
  const ts = market.imData.tickStep;
  const ammId = market.extConfig?.ammId ?? 0;
  const marketAcc = MarketAccLib.pack(root, 0, market.tokenId, CROSS_MARKET_ID);
  // 根因修复：链上bulkPlaceOrders内部按slippage(0.5)预留保证金缓冲，
  // 而我们的yuPerUsd是近似估算，未计入这个缓冲，导致小额新仓常因margin不足失败。
  // 这里对挂单YU量打CONFIG.marginSafetyFactor折扣，留出安全边际。
  const safeYu = opt.yu * CONFIG.marginSafetyFactor;
  const size = BigInt(Math.floor(safeYu * 1e18));
  const rate = getRateAtTick(BigInt(opt.tick), BigInt(ts)).toNumber();
  log(`  📌 ${market.metadata?.fundingRateSymbol} ${opt.side} @${(rate*100).toFixed(2)}% | ${safeYu.toFixed(0)}YU($${(opt.allocUsd*CONFIG.marginSafetyFactor).toFixed(0)})`);
  try {
    const res = await exchange.bulkPlaceOrders({
      orderRequests: [{ marketAcc, marketId: market.marketId, side: opt.side === "LONG" ? Side.LONG : Side.SHORT, size, limitTick: opt.tick, tif: TimeInForce.ADD_LIQUIDITY_ONLY, ammId, slippage: 0.5 }],
    });
    let ok = true;
    res.forEach(r => { if ("error" in r) { log(`  ❌ ${JSON.stringify(r.error)}`); ok = false; } });
    if (ok) log(`  ✅ 挂单成功`);
    return ok;
  } catch (e) { log(`  ❌ 挂单失败: ${e.response?.data?.message || e.message}`); return false; }
}

async function placeCloseALO(exchange, root, market, posSide, sizeYu) {
  const ts = market.imData.tickStep;
  const ammId = market.extConfig?.ammId ?? 0;
  const marketAcc = MarketAccLib.pack(root, 0, market.tokenId, CROSS_MARKET_ID);
  const closeSide = posSide === "LONG" ? "SHORT" : "LONG";
  const bidTick = Number(estimateTickForRate(FixedX18.fromNumber(market.data.bestBid), BigInt(ts), false));
  const askTick = Number(estimateTickForRate(FixedX18.fromNumber(market.data.bestAsk), BigInt(ts), false));
  let tick = closeSide === "SHORT" ? Math.floor(bidTick / ts) * ts + ts : Math.ceil(askTick / ts) * ts - ts;
  const step = closeSide === "SHORT" ? ts : -ts;
  const size = BigInt(Math.floor(sizeYu * 1e18));
  for (let attempt = 0; attempt < CONFIG.aloRetry; attempt++) {
    try {
      const res = await exchange.bulkPlaceOrders({
        orderRequests: [{ marketAcc, marketId: market.marketId, side: closeSide === "LONG" ? Side.LONG : Side.SHORT, size, limitTick: tick, tif: TimeInForce.ADD_LIQUIDITY_ONLY, ammId, slippage: 0.5 }],
      });
      const r = res[0];
      if (r && "error" in r) {
        if (String(JSON.stringify(r.error)).includes("ALOFilled")) { tick += step; continue; }
        return null;
      }
      log(`  🛡️ ${market.metadata?.fundingRateSymbol} ${closeSide}平仓 ${sizeYu.toFixed(0)}YU`);
      return tick;
    } catch (e) { return null; }
  }
  return null;
}

async function placeCloseIOC(exchange, root, market, posSide, sizeYu) {
  const ts = market.imData.tickStep;
  const ammId = market.extConfig?.ammId ?? 0;
  const marketAcc = MarketAccLib.pack(root, 0, market.tokenId, CROSS_MARKET_ID);
  const closeSide = posSide === "LONG" ? "SHORT" : "LONG";
  let remainYu = sizeYu;
  for (let depth = CONFIG.iocBaseTicks; depth <= CONFIG.iocMaxTicks; depth += CONFIG.iocStepTicks) {
    // 每轮重新读取剩余持仓，只下剩余量（避免重复下全量）
    const pdNow = await getPositionDetail(root, market.marketId);
    remainYu = Math.abs(pdNow.size);
    if (remainYu < 0.5) { log(`  ✅ IOC平仓成功`); return true; }
    // 每轮重新取盘口价（利率在动）
    const refApr = closeSide === "SHORT" ? market.data.bestBid : market.data.bestAsk;
    const baseTick = Number(estimateTickForRate(FixedX18.fromNumber(refApr), BigInt(ts), false));
    const size = BigInt(Math.floor(remainYu * 1e18));
    // 穿透方向：平LONG需向下吃买盘，平SHORT需向上吃卖盘
    const tick = baseTick + (closeSide === "SHORT" ? -depth : depth) * ts;
    try {
      const res = await exchange.bulkPlaceOrders({
        orderRequests: [{ marketAcc, marketId: market.marketId, side: closeSide === "LONG" ? Side.LONG : Side.SHORT, size, limitTick: tick, tif: TimeInForce.IMMEDIATE_OR_CANCEL, ammId, slippage: 1.0 }],
      });
      const r = res[0];
      if (r && "error" in r) { log(`  ⏳ IOC穿透${depth}报错,加深`); continue; }
      log(`  🔥 IOC ${market.metadata?.fundingRateSymbol} ${closeSide} ${remainYu.toFixed(0)}YU(穿透${depth}tick)`);
      await sleep(1500);
    } catch (e) { log(`  ⏳ IOC穿透${depth}异常,加深`); }
  }
  const pdFinal = await getPositionDetail(root, market.marketId);
  if (Math.abs(pdFinal.size) < 0.5) { log(`  ✅ IOC平仓成功`); return true; }
  log(`  ⚠️ IOC加深到${CONFIG.iocMaxTicks}仍剩${Math.abs(pdFinal.size).toFixed(0)}YU,请人工检查!`);
  return false;
}

function closeTouchTick(market, posSide) {
  const ts = market.imData.tickStep;
  const closeSide = posSide === "LONG" ? "SHORT" : "LONG";
  const bidTick = Number(estimateTickForRate(FixedX18.fromNumber(market.data.bestBid), BigInt(ts), false));
  const askTick = Number(estimateTickForRate(FixedX18.fromNumber(market.data.bestAsk), BigInt(ts), false));
  return closeSide === "SHORT" ? Math.floor(bidTick / ts) * ts + ts : Math.ceil(askTick / ts) * ts - ts;
}

function approachDistance(market, side, myTick) {
  const ts = market.imData.tickStep;
  const mt = midTick(market);
  return Math.abs(myTick - mt) / ts;
}

async function checkSlotHealth(exchange, root, all, marketId, side, tick) {
  const m = all.find(x => x.marketId === marketId);
  if (!m) return { ok: false, reason: "市场消失", market: null };
  const now = Math.floor(Date.now() / 1000);
  if (m.imData.maturity - now < CONFIG.maturityExitDays * 86400)
    return { ok: false, reason: `剩余<${CONFIG.maturityExitDays}天`, market: m };
  const inc = await getIncentive(marketId);
  if (!inc) return { ok: false, reason: "无激励", market: m };
  const vrr = volRangeRatio(m, inc);
  if (vrr != null && vrr > CONFIG.volExitRatio)
    return { ok: false, reason: `波动比升至${vrr.toFixed(2)}(避险撤离)`, market: m, flee: true };
  const dist = approachDistance(m, side, tick);
  if (dist <= CONFIG.dangerTicks)
    return { ok: false, reason: `利率逼近!距挂单仅${dist.toFixed(1)}tick(逃离)`, market: m, flee: true };
  const ts = m.imData.tickStep;
  const midApr = m.data.midApr;
  const lr = inc.long?.incentiveRange || 0;
  const sr = inc.short?.incentiveRange || 0;
  const myRate = getRateAtTick(BigInt(tick), BigInt(ts)).toNumber();
  const inRange = side === "LONG" ? (myRate >= midApr - lr && myRate <= midApr) : (myRate >= midApr && myRate <= midApr + sr);
  const idealTick = computeEdgeTick(m, side, inc);
  const offEdge = Math.abs(tick - idealTick) > ts * CONFIG.edgeTolerance;
  const orders = await getActiveOrders(root, marketId);
  const stillOpen = orders.length >= 1;
  if (!stillOpen) return { ok: false, reason: `挂单消失`, market: m };
  // 区分利率移动方向：
  //   inRange=false → 利率往远离挂单的方向跑(LONG:mid上涨) → 顺势/安全，只是掉出激励区不再赚
  //                   → 应该重挂到新边缘，而不是撤单冷却
  //   inRange=true 且 offEdge → 利率往逼近挂单的方向跑(LONG:mid下跌) → 劣势/危险
  //                   → 撤单冷却
  if (!inRange)
    return { ok: false, reason: `掉出激励区(利率远离,顺势)`, market: m, rehang: true, newTick: idealTick };
  if (offEdge)
    return { ok: false, reason: `利率逼近致偏离外缘(劣势)`, market: m };
  return { ok: true, market: m };
}

async function revivalSafetyCheck(exchange, balance, marketId, all) {
  const m = all.find(x => x.marketId === marketId);
  if (!m) return false;
  const inc = await getIncentive(marketId);
  if (!inc) return false;
  const vrr = volRangeRatio(m, inc);
  if (vrr == null || vrr >= CONFIG.volRangeRatioHigh) return false; // ≥2.5无条件拒
  const nowS = Math.floor(Date.now() / 1000);
  if (m.imData.maturity < nowS + 86400) return false;
  // 与进场完全一致的判断标准（不一致会导致"进场放行但复检拦住"，市场永久卡在冷却）
  const highVolZone = vrr >= CONFIG.volTrendOnlyZone;
  if (highVolZone) {
    const bias = dirBiasConfirmed(m, CONFIG.dirThreshHighVol); // 连续N轮确认
    if (bias === 'BOTH' || bias === 'INSUFFICIENT') return false; // 方向不明确或样本不足，不放行
    const { minReach, minCushion } = safetyThresholds(balance);
    const tick = computeEdgeTick(m, bias, inc);
    const { reachCost, cushion } = await analyzeOrderBookSafety(exchange, m, bias, tick);
    if (reachCost < minReach || cushion < minCushion) return false;
    return shieldCheck(m, reachCost, true).ok;
  }
  // 波动比0.6~1.6：需5轮方向确认(BOTH双向)+肉盾≥10万，与进场一致
  if (vrr > CONFIG.maxVolRangeRatio) {
    const bias = dirBiasConfirmed(m, CONFIG.dirThreshold);
    if (bias === 'INSUFFICIENT') return false; // 样本不足不放行
    const sides = bias === 'BOTH' ? ['LONG', 'SHORT'] : [bias];
    const { minReach, minCushion } = safetyThresholds(balance);
    for (const side of sides) {
      const tick = computeEdgeTick(m, side, inc);
      const { reachCost, cushion } = await analyzeOrderBookSafety(exchange, m, side, tick);
      if (reachCost < minReach || cushion < minCushion) continue;
      if (shieldCheck(m, reachCost, false).ok) return true;
    }
    return false;
  }
  // 波动比<0.6免检区：肉盾免检,但方向仍需确认(与进场一致)
  const bias0 = dirBiasConfirmed(m, CONFIG.dirThreshold);
  if (bias0 === 'INSUFFICIENT') return false; // 样本不足不放行
  return true; // 方向明确(单边)或BOTH(双向)都放行,肉盾免检
}

// ===== 链上对账（保证金同步 + 孤儿单认领 + 幽灵条目清理）=====
// reconcile=false 时只同步保证金，不做增删。
//   原因：刚挂完单时链上索引可能未跟上(>2s)，此时做"幽灵清理"会把刚挂成功的单误删，
//        进而被 hadFailThisRound 判成挂单失败 → 校准被错误下调 → 一路跌到地板
async function syncMarginFromChain(root, all, held, closing, reconcile = true) {
  const orders = await getAllActiveOrdersForToken(root, all);
  const realByKey = new Map();
  const tickByKey = new Map();
  const yuByKey = new Map();
  for (const o of orders) {
    const side = o.side === 0 ? 'LONG' : 'SHORT';
    const k = poolKey(o.marketId, side);
    let real = parseFloat(o.marginRequired ?? '0') || 0;
    if (real > 1e12) real /= 1e18;
    let yu = parseFloat(o.unfilledSize ?? o.placedSize ?? '0') || 0;
    if (yu > 1e12) yu /= 1e18;
    if (real > 0) realByKey.set(k, (realByKey.get(k) || 0) + real);
    if (yu > 0) yuByKey.set(k, (yuByKey.get(k) || 0) + yu);
    if (!tickByKey.has(k)) tickByKey.set(k, o.tick);
  }

  if (reconcile) {
    // 1) 清理幽灵条目：held里有但链上已无挂单（且不在平仓流程中）
    for (const [k, h] of [...held]) {
      if (!realByKey.has(k) && !(closing && closing.has(h.marketId))) {
        held.delete(k);
        log(`  🧹 对账清理: ${k} 链上已无挂单,移出held`);
      }
    }
    // 2) 认领孤儿单：链上有挂单但held不认识（状态漂移导致资金卡死的根因）
    for (const [k, real] of realByKey) {
      if (held.has(k)) continue;
      const [mid, side] = k.split(':');
      if (closing && closing.has(mid)) continue;
      const m = all.find(x => x.marketId === mid);
      held.set(k, { marketId: mid, side, tick: tickByKey.get(k), yu: yuByKey.get(k) || 0, allocUsd: real });
      log(`  🔗 对账认领孤儿单: ${m?.metadata?.fundingRateSymbol || mid} ${side} $${real.toFixed(0)}`);
    }
  }

  if (held.size === 0) return;

  // 3) 同步保证金为链上真实值，并反推校准
  let estSum = 0, realSum = 0;
  for (const [k, h] of held) {
    const real = realByKey.get(k);
    if (real == null || real <= 0) continue;
    estSum += h.allocUsd;
    realSum += real;
    h.allocUsd = real;
  }
  if (estSum <= 1 || realSum <= 1) return;
  const ratio = realSum / estSum;
  if (ratio > 1.05 || ratio < 0.95) {
    // 真实>估算 → 挂的YU太多 → 降低校准让下次挂更少
    const newCalib = Math.max(0.5, Math.min(MARGIN_CALIB_MAX, MARGIN_CALIB / ratio));
    log(`  🔧 链上校准: 估算$${estSum.toFixed(0)}→真实$${realSum.toFixed(0)}(${ratio.toFixed(2)}x) 校准${MARGIN_CALIB.toFixed(2)}→${newCalib.toFixed(2)}`);
    MARGIN_CALIB = newCalib;
    saveState();
  }
}

async function rebuildState(exchange, root, all, held) {
  log(`🔁 启动状态重建...`);
  const orders = await getAllActiveOrdersForToken(root, all);
  if (orders.length === 0) { log(`   无挂单,全新启动`); return; }
  log(`   发现${orders.length}笔挂单,重建held`);
  for (const o of orders) {
    const m = all.find(x => x.marketId === o.marketId);
    if (!m) continue;
    const side = o.side === 0 ? "LONG" : "SHORT";
    // 真实字段：unfilledSize=未成交量(挂单剩余)，marginRequired=链上真实保证金
    let sizeYu = parseFloat(o.unfilledSize ?? o.placedSize ?? "0") || 0;
    if (sizeYu > 1e12) sizeYu = sizeYu / 1e18; // wei单位转换
    if (sizeYu <= 0) { log(`   ⚠️ ${m.metadata?.fundingRateSymbol} ${side} 挂单量为0,跳过`); continue; }
    // allocUsd 直接用链上 marginRequired，无需yuPerUsd估算（更准确）
    let allocUsd = parseFloat(o.marginRequired ?? "0") || 0;
    if (allocUsd > 1e12) allocUsd = allocUsd / 1e18;
    if (allocUsd <= 0) {
      // 兜底：marginRequired读不到才用估算
      const ts = m.imData.tickStep;
      const rate = getRateAtTick(BigInt(o.tick), BigInt(ts)).toNumber();
      const ypu = yuPerUsd(m, rate);
      allocUsd = ypu > 0 ? sizeYu / ypu : 0;
    }
    const k = poolKey(o.marketId, side);
    if (held.has(k)) { const h = held.get(k); h.yu += sizeYu; h.allocUsd += allocUsd; }
    else held.set(k, { marketId: o.marketId, side, tick: o.tick, yu: sizeYu, allocUsd });
    log(`   恢复: ${m.metadata?.fundingRateSymbol} ${side} ${sizeYu.toFixed(0)}YU ($${allocUsd.toFixed(0)})`);
  }
  log(`   ✅ 重建完成: ${held.size}个池, 合计$${[...held.values()].reduce((s,h)=>s+h.allocUsd,0).toFixed(0)}`);
}

async function systemMonitor(exchange) {
  try {
    const gasRaw = await exchange.getGasBalance();
    let gasEth = parseFloat(gasRaw);
    if (gasEth > 1e6) gasEth = gasEth / 1e18;
    log(`  ⛽ gas余额: ${gasEth.toFixed(5)} ETH`);
    if (gasEth < CONFIG.gasWarnEth) alert(`⛽ GAS不足: ${gasEth.toFixed(5)} ETH`);
  } catch { log(`  ⛽ gas查询失败`); }
  try {
    const expiry = await exchange.getAgentExpiryTime();
    const hoursLeft = (Number(expiry) * 1000 - Date.now()) / 3_600_000;
    if (hoursLeft < CONFIG.agentWarnHours) { alert(`🔑 Agent剩余${hoursLeft.toFixed(1)}h,运行 node agent.js`); logEvent({ event: 'Agent授权预警', note: `剩余${hoursLeft.toFixed(1)}小时` }); }
  } catch {}
}

async function main() {
  const rootAccount  = privateKeyToAccount(ROOT_KEY);
  const agent        = Agent.createFromPrivateKey(AGENT_KEY);
  const walletClient = createWalletClient({ account: rootAccount, transport: http(RPC_URL), chain: arbitrum });
  const exchange     = new Exchange(walletClient, rootAccount.address, 0, [RPC_URL], agent);
  const root = rootAccount.address;

  log(`主钱包: ${root}`);
  log(`Agent:  ${await agent.getAddress()}`);
  log(`策略: USDT安全·方向弹性单边(差>${(CONFIG.dirThreshold*100)}%顺势)·波动率筛选·肉盾优先·利率逼近预警·IOC递进 | 每${CONFIG.refreshMs/1000}s`);
  loadState(); // 恢复上次的校准系数，必须在rebuildState前（重建allocUsd依赖校准）
  initEventCsv(); // 初始化关键事件CSV
  logEvent({ event: '启动', note: `余额恢复,校准${MARGIN_CALIB.toFixed(2)}` });

  const held = new Map(), closing = new Map(), cooling = new Map(), placeFailCount = new Map(), addPosCooling = new Map();
  let lastBalance = 0, lastRebalanceTs = 0, lastReviewTs = Date.now(), round = 0, healthCheckCursor = 0;
  let noHighAprRounds = 0; // 连续找不到高APR池的轮数，达到aprFallbackRounds才降级

  const allInit = await exchange.getAllMarkets({ isUiWhitelisted: true });
  await rebuildState(exchange, root, allInit, held);

  while (true) {
    round++;
    // 校准越界保护：超出合理范围说明已失控，重置回安全初值
    if (MARGIN_CALIB > MARGIN_CALIB_MAX) {
      log(`  ⚠️ 校准${MARGIN_CALIB.toFixed(2)}超出上限${MARGIN_CALIB_MAX}，重置→1.61`);
      MARGIN_CALIB = 1.61;
    }
    log(`\n===== SAFE第${round}轮 =====`);
    try {
      const balance = await getBalance(root);
      const now = Date.now();
      const deposited = lastBalance > 0 && (balance - lastBalance) >= CONFIG.depositThreshold;
      if (deposited) {
        log(`  💰 充值 +$${(balance-lastBalance).toFixed(2)}`);
        logEvent({ event: '充值', usd: balance - lastBalance, note: `余额→$${balance.toFixed(0)}` });
        lastRebalanceTs = 0; // 充值后强制解除冷却，立即重新分配
        addPosCooling.clear(); // 清空加仓冷却，让已有池能吃到变大后的45%上限
      }
      lastBalance = balance;

      log(`💳 余额:$${balance.toFixed(2)} | 池${held.size} 平仓${closing.size} 冷却${cooling.size} | 校准${MARGIN_CALIB.toFixed(2)}`);
      if (balance < 1) { await sleep(CONFIG.refreshMs); continue; }
      if (round % 12 === 1) await systemMonitor(exchange);

      const all = await exchange.getAllMarkets({ isUiWhitelisted: true });
      recordDiffHistory(all); // 每轮记录标的-隐含差值,供连续N轮方向确认使用(无额外API开销)
      if (round % 12 === 5) await syncMarginFromChain(root, all, held, closing, true); // 完整对账

      for (const [mid, until] of [...cooling]) {
        if (now <= until) continue;
        const safe = await revivalSafetyCheck(exchange, balance, mid, all);
        if (safe) { cooling.delete(mid); log(`  🔓 市场${mid} 复检安全恢复`); }
        else { cooling.set(mid, now + 5 * 60_000); } // 5分钟后再复检，不再30分钟
      }

      // 遍历范围 = held记录的市场 ∪ 链上真实持仓的市场（后者能发现"孤儿持仓"）
      // 用 marketId 为准，避免同名不同到期日的市场(如两个HYPEUSDC)错配
      const chainPositions = await getAllPositions(root);
      const heldMarketIds = new Set([...held.values()].map(h => h.marketId));
      for (const p of chainPositions) {
        if (heldMarketIds.has(p.marketId)) continue;
        if (closing.has(p.marketId)) continue; // 已在平仓监控中
        // 孤儿持仓：链上有持仓但held不认识（重启丢失/历史遗留/同名错配）
        // 纳入 closing 止损监控——但标记为 holdMode，不主动平仓，只在亏损超阈值时兜底强平
        const m = all.find(x => x.marketId === p.marketId);
        const sym = m?.metadata?.fundingRateSymbol || p.marketId;
        const posSide = p.size > 0 ? 'LONG' : 'SHORT';
        log(`  🔗 认领孤儿持仓 ${sym} ${posSide} ${Math.abs(p.size).toFixed(0)}YU→止损兜底监控(不主动平,亏超线才强平)`);
        logEvent({ event: '认领孤儿持仓', market: sym, side: posSide, usd: Math.abs(p.valueUsd), note: '纳入止损兜底监控' });
        closing.set(p.marketId, { posSide, entryValue: Math.abs(p.valueUsd), principalUsd: Math.abs(p.valueUsd), placedClose: false, closeTick: null, lastPnl: 0, trendFavor: false, trendStartMs: Date.now(), holdMode: true });
        heldMarketIds.add(p.marketId);
      }
      for (const mid of heldMarketIds) {
        if (closing.has(mid)) continue;
        const pd = await getPositionDetail(root, mid);
        if (Math.abs(pd.size) > 0.5) {
          // 真实成交判断：持仓存在但挂单也在时，可能是①部分成交②signedSize把挂单记成持仓
          // 不能直接跳过（否则部分成交的真实持仓会被永久无视，无止损无平仓）
          // 正确做法：先撤掉该市场所有挂单，再复核持仓——撤完仍在的才是真持仓
          const m = all.find(x => x.marketId === mid);
          const activeOrders = await getActiveOrders(root, mid);
          if (activeOrders.length > 0) {
            log(`  ❓ ${m?.metadata?.fundingRateSymbol || mid} 持仓${pd.size.toFixed(0)}YU但挂单仍在,撤单复核...`);
            if (m) await cancelMarket(exchange, root, m);
            await sleep(1500);
            const pd2 = await getPositionDetail(root, mid);
            if (Math.abs(pd2.size) <= 0.5) {
              log(`  ✓ 撤单后持仓归零,确认为假成交`);
              continue; // 确实是假成交
            }
            log(`  ⚠️ 撤单后仍有持仓${pd2.size.toFixed(0)}YU→确认真实成交(部分成交)`);
            pd.size = pd2.size; pd.valueUsd = pd2.valueUsd; // 用复核后的真实值
          }
          const posSide = pd.size > 0 ? "LONG" : "SHORT";
          let principalUsd = 0;
          for (const [k, h] of held) if (h.marketId === mid) principalUsd += h.allocUsd;
          const sym = m?.metadata?.fundingRateSymbol || mid;
          log(`  🚨 ${sym} 被成交${pd.size.toFixed(1)}YU(${posSide})→平仓`);
          if (m) await cancelMarket(exchange, root, m);
          for (const key of [...held.keys()]) if (held.get(key).marketId === mid) held.delete(key);
          // 趋势判断：方向有利则进入等待回归模式
          let trendFavor = false;
          let diffVal = null;
          if (m) {
            const diff = m.data.floatingApr - m.data.midApr;
            diffVal = diff;
            const vrrNow = volRangeRatio(m, await getIncentive(mid).catch(() => null) || {});
            trendFavor = posSide === 'LONG' ? diff > CONFIG.trendDiffThresh : diff < -CONFIG.trendDiffThresh;
            if (trendFavor) log(`  📈 ${sym} 方向有利(diff${(diff*100).toFixed(1)}%)→等待回归平仓`);
            else log(`  📉 ${sym} 方向不利(diff${(diff*100).toFixed(1)}%)→直接追价平仓`);
            // 记录成交事件（验证"标的领先隐含"模型的核心数据）
            logEvent({ event: '被成交', market: sym, side: posSide, diff, vrr: vrrNow,
              note: trendFavor ? '方向有利-等待回归' : '方向不利-追价平仓' });
          }
          closing.set(mid, { posSide, entryValue: pd.valueUsd, principalUsd, placedClose: false, closeTick: null, lastPnl: 0, trendFavor, trendStartMs: Date.now() });
        }
      }

      for (const [mid, c] of [...closing]) {
        const m = all.find(x => x.marketId === mid);
        if (!m) { closing.delete(mid); continue; }
        const pd = await getPositionDetail(root, mid);
        if (Math.abs(pd.size) < 0.5) {
          await cancelMarket(exchange, root, m);
          // 真实成交才进长冷却；盈利或小亏进短冷却
          const coolMs = c.lastPnl >= 0 ? CONFIG.failCoolMs : CONFIG.coolDownMs;
          cooling.set(mid, Date.now() + coolMs);
          log(`  ✅ ${m.metadata?.fundingRateSymbol} 平仓完成(${c.lastPnl>=0?'盈$'+c.lastPnl.toFixed(2):'亏$'+(-c.lastPnl).toFixed(2)}) 冷却${Math.round(coolMs/60000)}分钟`);
          logEvent({ event: '平仓完成', market: m.metadata?.fundingRateSymbol, side: c.posSide, pnl: c.lastPnl, note: c.lastPnl>=0?'盈利':'亏损' });
          closing.delete(mid);
          continue;
        }
        const sizeYu = Math.abs(pd.size);
        const pnl = pd.valueUsd - c.entryValue;
        c.lastPnl = pnl;
        const lossUsd = Math.max(0, -pnl);
        const lossPctBal = lossUsd / balance;
        const lossPctPrin = c.principalUsd > 0 ? lossUsd / c.principalUsd : 0;
        const health = await getHealthRatio(root);
        // 熔断：无论趋势如何，立即市价强平
        if (lossPctBal >= CONFIG.meltBalPct || lossPctPrin >= CONFIG.meltPrinPct || health >= CONFIG.healthDanger) {
          log(`  🔥 ${m.metadata?.fundingRateSymbol} 熔断(亏${(lossPctBal*100).toFixed(2)}%)`);
          logEvent({ event: '熔断强平', market: m.metadata?.fundingRateSymbol, side: c.posSide, pnl: pnl, note: `亏${(lossPctBal*100).toFixed(1)}%余额` });
          await cancelMarket(exchange, root, m);
          await placeCloseIOC(exchange, root, m, c.posSide, sizeYu);
          continue;
        }
        // 止损：无论趋势如何，限价追价
        if (lossPctBal >= CONFIG.slBalPct || lossPctPrin >= CONFIG.slPrinPct) {
          if (c.trendFavor) log(`  🛡️ ${m.metadata?.fundingRateSymbol} 触及止损线，放弃趋势等待`);
          c.trendFavor = false; // 触及止损线，关闭趋势等待
          log(`  🛡️②追价 ${m.metadata?.fundingRateSymbol} 亏$${lossUsd.toFixed(2)}`);
          logEvent({ event: '止损追价', market: m.metadata?.fundingRateSymbol, side: c.posSide, pnl: pnl, note: c.holdMode?'孤儿持仓触及止损线':'触及止损线' });
          await cancelMarket(exchange, root, m);
          await sleep(800);
          const t = await placeCloseALO(exchange, root, m, c.posSide, sizeYu);
          c.placedClose = true; c.closeTick = t;
          continue;
        }
        // 孤儿持仓holdMode：未触及熔断/止损线 → 持有不平仓，只做兜底监控
        if (c.holdMode) {
          if (round % 30 === 0) log(`  🤝 ${m.metadata?.fundingRateSymbol} ${c.posSide} 孤儿持仓持有中(盈亏$${pnl.toFixed(2)},未触止损线)`);
          continue;
        }
        // 趋势等待回归模式
        if (c.trendFavor) {
          const waitedMs = Date.now() - c.trendStartMs;
          const diff = m.data.floatingApr - m.data.midApr;
          // 检查利率是否已回归到盈利区间（pnl >= 0 且方向仍有利）
          const diffFavor = c.posSide === 'LONG' ? diff > 0 : diff < 0;
          if (pnl >= 0 && diffFavor) {
            // 利率回归，盈利，立即挂限价平仓
            log(`  🎯 ${m.metadata?.fundingRateSymbol} 利率回归盈利$${pnl.toFixed(2)}→挂单平仓`);
            logEvent({ event: '趋势回归', market: m.metadata?.fundingRateSymbol, side: c.posSide, pnl: pnl, note: '利率回归盈利-模型生效' });
            await cancelMarket(exchange, root, m);
            await sleep(800);
            const t = await placeCloseALO(exchange, root, m, c.posSide, sizeYu);
            c.placedClose = true; c.closeTick = t;
            c.trendFavor = false;
          } else if (waitedMs >= CONFIG.trendWaitMs) {
            // 等待超时（2小时），降级到正常平仓
            log(`  ⏰ ${m.metadata?.fundingRateSymbol} 趋势等待超时(${Math.round(waitedMs/60000)}分钟)→正常平仓`);
            logEvent({ event: '趋势超时', market: m.metadata?.fundingRateSymbol, side: c.posSide, pnl: pnl, note: `等待${Math.round(waitedMs/60000)}分钟未回归` });
            c.trendFavor = false;
          } else {
            // 继续等待
            log(`  ⏳ ${m.metadata?.fundingRateSymbol} 趋势等待中 pnl$${pnl.toFixed(2)} diff${(diff*100).toFixed(1)}% 已等${Math.round(waitedMs/60000)}分钟`);
          }
          continue;
        }
        const idealTouch = closeTouchTick(m, c.posSide);
        const drifted = c.closeTick == null || Math.abs(idealTouch - c.closeTick) > CONFIG.closeChaseTicks * m.imData.tickStep;
        if (!c.placedClose || drifted) {
          if (c.placedClose) { await cancelMarket(exchange, root, m); await sleep(800); }
          const t = await placeCloseALO(exchange, root, m, c.posSide, sizeYu);
          c.placedClose = true; c.closeTick = t;
        } else {
          log(`  🟢持有观察 ${m.metadata?.fundingRateSymbol} ${pnl>=0?'盈利$'+pnl.toFixed(2):'小亏$'+lossUsd.toFixed(2)}`);
        }
      }

      const heldKeys = [...held.keys()].filter(k => { const h = held.get(k); return !cooling.has(h.marketId) && !closing.has(h.marketId); });
      if (heldKeys.length > 0) {
        const checkN = Math.min(CONFIG.healthCheckPerRound, heldKeys.length);
        for (let i = 0; i < checkN; i++) {
          const key = heldKeys[(healthCheckCursor + i) % heldKeys.length];
          const h = held.get(key);
          if (!h) continue;
          // ===== 优先级最高：盯差值方向翻转(方案A) =====
          // 差值(标的-隐含)跌破对侧3%门槛→方向已翻转→撤单,不冷却,下轮进场逻辑自然反手挂对侧
          // 中间地带(-3%~+3%)继续持有原仓(有利方向不会成交,吃挂单奖励)
          if (dirTurnedOpposite(h.marketId, h.side)) {
            const m = all.find(x => x.marketId === h.marketId);
            const sym = m?.metadata?.fundingRateSymbol || h.marketId;
            const dArr = diffHist.get(h.marketId) || [];
            const curDiff = (dArr[dArr.length-1] * 100).toFixed(1);
            log(`  🔄 ${sym} ${h.side} 差值翻转至${curDiff}%(连续${CONFIG.dirConfirmRounds}轮跌破对侧${(CONFIG.dirThreshold*100).toFixed(0)}%)→撤单,下轮按进场逻辑重新扫描评估`);
            logEvent({ event: '差值翻转撤单', market: sym, side: h.side, diff: dArr[dArr.length-1], note: `方向翻转撤${h.side},重新扫描(需过完整进场审核才反手)` });
            if (m) await cancelMarket(exchange, root, m);
            held.delete(key);
            lastRebalanceTs = 0; // 解除分配冷却,下轮重新走完整进场逻辑(方向/肉盾/池子/APR全部重审,通过才挂)
            continue;
          }
          const hc = await checkSlotHealth(exchange, root, all, h.marketId, h.side, h.tick);
          if (!hc.ok && hc.rehang) {
            // 顺势：利率往远离挂单的方向跑，掉出激励区 → 撤单后立刻重挂到新边缘
            // (不冷却，因为这是安全方向，冷却只会白丢激励)
            const sym = hc.market?.metadata?.fundingRateSymbol || h.marketId;
            log(`  ➡️ ${sym} ${h.side} (${hc.reason})→重挂新边缘`);
            logEvent({ event: '重挂边缘', market: sym, side: h.side, note: '利率远离-顺势重挂' });
            await cancelMarket(exchange, root, hc.market);
            await sleep(800);
            const inc = await getIncentive(h.marketId);
            const lr = inc?.long?.incentiveRange || 0.0075;
            const sr = inc?.short?.incentiveRange || 0.0075;
            const edgeApr = h.side === 'LONG' ? hc.market.data.midApr - lr : hc.market.data.midApr + sr;
            const ypu = yuPerUsd(hc.market, edgeApr);
            const newYu = h.allocUsd * ypu * 0.95;
            const ok = await placeOrderFor(exchange, root, { market: hc.market, side: h.side, tick: hc.newTick, yu: newYu, allocUsd: h.allocUsd });
            if (ok) held.set(key, { ...h, tick: hc.newTick, yu: newYu });
            else { held.delete(key); cooling.set(h.marketId, Date.now() + CONFIG.failCoolMs); log(`  ⛔ ${sym} 重挂失败→冷却`); }
          } else if (!hc.ok) {
            const cool = hc.flee ? CONFIG.fleeCoolMs : CONFIG.failCoolMs;
            log(`  ⚠️ ${hc.market?.metadata?.fundingRateSymbol || h.marketId} ${h.side} (${hc.reason})→撤+冷却`);
            if (hc.market) await cancelMarket(exchange, root, hc.market);
            held.delete(key);
            cooling.set(h.marketId, Date.now() + cool);
          }
        }
        healthCheckCursor = (healthCheckCursor + checkN) % Math.max(1, heldKeys.length);
      }

      const occupiedMarkets = new Set([...[...held.values()].map(h => h.marketId), ...closing.keys()]);
      // slotsLeft：动态池数模式下不再硬限制，用999表示无限制；平仓中的市场不占槽
      const slotsLeft = held.size === 0 ? 999 : 999 - occupiedMarkets.size;
      const usedIM = await getUsedMargin(root);
      const availBudget = Math.max(0, balance * CONFIG.marginUsage - usedIM);
      const coldStart = held.size === 0 && slotsLeft > 0 && closing.size === 0;
      const bigIdle = availBudget >= balance * CONFIG.rebalanceMinPct;
      const cooledDown = (now - lastRebalanceTs) >= CONFIG.rebalanceCooldownMs;
      const shouldAllocate = coldStart || (bigIdle && slotsLeft > 0 && cooledDown) || (deposited && cooledDown);

      // 定时重评：每8小时主动扫全市场，有更优池且切换当天能回本才切
      const reviewDue = held.size > 0 && closing.size === 0 && (now - lastReviewTs) >= CONFIG.reviewIntervalMs;
      if (reviewDue) {
        log(`  🔄 8小时定时重评...`);
        lastReviewTs = now;
        const exclude = new Set([...closing.keys()]); // cooling不排除扫描
        const markets2 = await exchange.getAllMarkets({ isUiWhitelisted: true });
        const nowS = Math.floor(now / 1000);
        // 扫全市场，收集安全池的基础参数（不在这里算效益，等拿到实际allocUsd再算）
        const reviewOpts = [];
        for (const m of markets2.filter(m2 =>
          m2.config.status === 2 &&
          m2.imData.maturity > nowS + 3*86400 &&
          m2.tokenId === CONFIG.collateralTokenId &&
          !m2.imData.isIsolatedOnly &&                // 排除隔离保证金市场
          m2.data.bestBid != null && m2.data.bestAsk != null &&
          !exclude.has(m2.marketId)
        )) {
          const inc2 = await getIncentive(m.marketId);
          if (!inc2) continue;
          const vrr2 = volRangeRatio(m, inc2);
          if (vrr2 == null || vrr2 >= CONFIG.volRangeRatioHigh) continue; // 统一用2.5上限
          // 波动比1.6~2.5只做顺势；常规区双向；均需连续N轮确认
          const highVol2 = vrr2 >= CONFIG.volTrendOnlyZone;
          const bias2 = dirBiasConfirmed(m, highVol2 ? CONFIG.dirThreshHighVol : CONFIG.dirThreshold);
          if (bias2 === 'INSUFFICIENT') continue; // 样本不足不参与重评
          if (highVol2 && bias2 === 'BOTH') continue;
          const sides2 = highVol2 ? [bias2] : (bias2 === 'BOTH' ? ['LONG','SHORT'] : [bias2]);
          for (const side2 of sides2) {
            const incS = side2 === 'LONG' ? inc2.long : inc2.short;
            if (!incS?.budgetPerHour) continue;
            if (incS.budgetPerHour * 24 < CONFIG.minPoolPendle) continue; // 池子太小不参与重评
            const lr2 = inc2.long?.incentiveRange || 0.0075;
            const sr2 = inc2.short?.incentiveRange || 0.0075;
            const edgeApr2 = side2 === 'LONG' ? m.data.midApr - lr2 : m.data.midApr + sr2;
            reviewOpts.push({
              market: m, side: side2, inc: inc2,
              ypu: yuPerUsd(m, edgeApr2),
              budDay: incS.budgetPerHour * 24,
              baseLiq: parseFloat(incS.currentInRangeLiquidity || '0') / 1e18,
            });
          }
        }
        // 对比当前每个held池的效益，用实际allocUsd计算真实日收益
        let switched = false;
        for (const [k, h] of held) {
          const allocUsd = h.allocUsd; // 该池实际投入金额
          const curM = markets2.find(x => x.marketId === h.marketId);
          if (!curM) continue;
          const curInc = await getIncentive(h.marketId);
          if (!curInc) continue;
          const curIncS = h.side === 'LONG' ? curInc.long : curInc.short;
          if (!curIncS?.budgetPerHour) continue;
          const lr = curInc.long?.incentiveRange || 0.0075;
          const sr = curInc.short?.incentiveRange || 0.0075;
          const curEdgeApr = h.side === 'LONG' ? curM.data.midApr - lr : curM.data.midApr + sr;
          const curYpu = yuPerUsd(curM, curEdgeApr);
          const curBudDay = curIncS.budgetPerHour * 24;
          const curBaseLiq = parseFloat(curIncS.currentInRangeLiquidity || '0') / 1e18;
          // 用实际allocUsd计算当前池真实日收益
          const curYu = allocUsd * curYpu;
          const curDailyReward = estimateDailyReward({ budgetDay: curBudDay, baseLiq: curBaseLiq }, curYu);
          // 候选池：用同等allocUsd投入，算各自日收益，找最优
          const best = reviewOpts
            .filter(o => !(o.market.marketId === h.marketId && o.side === h.side))
            .map(o => {
              const newYu = allocUsd * o.ypu;
              const newDaily = estimateDailyReward({ budgetDay: o.budDay, baseLiq: o.baseLiq }, newYu);
              return { ...o, newDaily };
            })
            .sort((a, b) => b.newDaily - a.newDaily)[0];
          if (!best) continue;
          // 日收益提升能否覆盖切换成本？（用实际金额算出真实提升幅度）
          const dailyGainImprove = best.newDaily - curDailyReward;
          const worthSwitch = dailyGainImprove * PENDLE_PRICE > CONFIG.switchCostUsd;
          if (worthSwitch) {
            log(`  🔀 重评切换: ${curM.metadata?.fundingRateSymbol} ${h.side}(日${curDailyReward.toFixed(3)}P) → ${best.market.metadata?.fundingRateSymbol} ${best.side}(日${best.newDaily.toFixed(3)}P) 提升${dailyGainImprove.toFixed(3)}P/天(>${CONFIG.switchCostUsd}$)`);
            logEvent({ event: '重评切换', market: `${curM.metadata?.fundingRateSymbol}→${best.market.metadata?.fundingRateSymbol}`, side: best.side, note: `日收+${dailyGainImprove.toFixed(3)}P` });
            await cancelMarket(exchange, root, curM);
            held.delete(k);
            // 新池挂单
            const tick2 = computeEdgeTick(best.market, best.side, best.inc);
            const lr2 = best.inc.long?.incentiveRange || 0.0075;
            const sr2 = best.inc.short?.incentiveRange || 0.0075;
            const edgeApr2 = best.side === 'LONG' ? best.market.data.midApr - lr2 : best.market.data.midApr + sr2;
            const ypu2 = yuPerUsd(best.market, edgeApr2);
            const yu2 = h.allocUsd * ypu2 * 0.95;
            await ensureEntered(exchange, root, best.market);
            const ok2 = await placeOrderFor(exchange, root, { market: best.market, side: best.side, tick: tick2, yu: yu2, allocUsd: h.allocUsd });
            if (ok2) {
              held.set(poolKey(best.market.marketId, best.side), { marketId: best.market.marketId, side: best.side, tick: tick2, yu: yu2, allocUsd: h.allocUsd });
              switched = true;
            } else {
              // 新池挂单失败，回滚：重新挂回原来的池
              log(`  ↩️ 新池挂单失败，回滚挂回 ${curM.metadata?.fundingRateSymbol} ${h.side}`);
              const rollbackTick = computeEdgeTick(curM, h.side, curInc);
              const rollbackYu = h.allocUsd * curYpu * 0.95;
              await ensureEntered(exchange, root, curM);
              const rollbackOk = await placeOrderFor(exchange, root, { market: curM, side: h.side, tick: rollbackTick, yu: rollbackYu, allocUsd: h.allocUsd });
              if (rollbackOk) held.set(k, { ...h, tick: rollbackTick, yu: rollbackYu });
            }
            await sleep(1500);
          } else {
            log(`  ✓ 重评保持: ${curM.metadata?.fundingRateSymbol} ${h.side} 日${curDailyReward.toFixed(3)}P → 最优替代日${best.newDaily.toFixed(3)}P 提升${dailyGainImprove.toFixed(3)}P不值切`);
          }
        }
        if (!switched) log(`  ✓ 重评完成，当前配置已最优`);
      }

      if (shouldAllocate && availBudget >= CONFIG.minOrderUsd) {
        log(`  🔍 触发分配 可用$${availBudget.toFixed(0)}`);
        const existingAlloc = new Map();
        for (const [k, h] of held) existingAlloc.set(k, h.allocUsd);
        // cooling市场可以被扫描评估，只在下单时阻止新开仓；closing才是绝对排除
        const exclude = new Set([...closing.keys()]);
        const coolingMarketIds = new Set([...cooling.keys()]);
        const pendlePrice = await getPendlePrice();
        const fallback = noHighAprRounds >= CONFIG.aprFallbackRounds;
        if (fallback) log(`  ⬇️ 已等待${noHighAprRounds}轮，启用降级模式`);
        const allocs = await computeAllocation(exchange, availBudget, balance, slotsLeft, exclude, existingAlloc, pendlePrice, fallback, coolingMarketIds);
        if (allocs.length === 0 && !fallback) {
          noHighAprRounds++;
          lastRebalanceTs = Date.now();
        } else if (allocs.length === 0 && fallback) {
          // 降级模式也分配不出去，等一个rebalanceCooldown再重试
          lastRebalanceTs = Date.now();
          noHighAprRounds = 0;
        } else {
          noHighAprRounds = 0;
        }
        const allocByMarket = new Map();
        for (const a of allocs) {
          if (!allocByMarket.has(a.market.marketId)) allocByMarket.set(a.market.marketId, []);
          allocByMarket.get(a.market.marketId).push(a);
        }
        for (const [mid, mAllocs] of allocByMarket) {
          const market = mAllocs[0].market;
          await ensureEntered(exchange, root, market);
          const hadHeld = [...held.keys()].some(k => held.get(k).marketId === mid);
          if (hadHeld) { await cancelMarket(exchange, root, market); await sleep(800); }
          for (const a of mAllocs) {
            const k = poolKey(mid, a.side);
            const old = held.get(k);
            const mergedYu = (old ? old.yu : 0) + a.yu;
            const mergedUsd = (old ? old.allocUsd : 0) + a.allocUsd;
            let ok = await placeOrderFor(exchange, root, { ...a, yu: mergedYu, allocUsd: mergedUsd });
            let finalYu = mergedYu, finalUsd = mergedUsd;
            if (!ok) {
              // margin不足时立即重试：YU砍半，比等下轮慢校准快得多
              const retryYu = mergedYu * 0.5;
              const retryUsd = mergedUsd * 0.5;
              log(`  🔁 margin不足,YU砍半重试: ${retryYu.toFixed(0)}YU`);
              await sleep(800);
              ok = await placeOrderFor(exchange, root, { ...a, yu: retryYu, allocUsd: retryUsd });
              if (ok) { finalYu = retryYu; finalUsd = retryUsd; }
            }
            if (ok) {
              const wasHeld = held.has(k);
              held.set(k, { marketId: mid, side: a.side, tick: a.tick, yu: finalYu, allocUsd: finalUsd });
              placeFailCount.delete(k);
              logEvent({ event: wasHeld ? '加仓' : '开新仓', market: a.market.metadata?.fundingRateSymbol, side: a.side, usd: finalUsd, vrr: a.vrr, note: `池${(a.budgetDay||0).toFixed(1)}P/天` });
            } else {
              held.delete(k);
              // 连续失败计数：同一池连续失败3次，临时拉黑冷却，避免死循环重试
              const failN = (placeFailCount.get(k) || 0) + 1;
              placeFailCount.set(k, failN);
              if (failN >= 3) {
                cooling.set(mid, Date.now() + CONFIG.failCoolMs);
                placeFailCount.delete(k);
                log(`  ⛔ ${market.metadata?.fundingRateSymbol} ${a.side} 连续失败${failN}次,临时冷却${Math.round(CONFIG.failCoolMs/60000)}分钟`);
              }
            }
            await sleep(1200);
          }
          for (const k of [...held.keys()]) {
            const h = held.get(k);
            if (h.marketId === mid && !mAllocs.some(a => a.side === h.side) && hadHeld) { held.delete(k); log(`  🧹 清理失配held: ${k}`); }
          }
        }
        await sleep(2000);
        // 链上真实保证金同步 + 校准（直接测量，比用总用量反推准确）
        await syncMarginFromChain(root, all, held, closing, false); // 不做增删,链上索引可能未跟上
        const finalIM = await getUsedMargin(root);
        const hadFailThisRound = allocs.some(a => !held.has(poolKey(a.market.marketId, a.side)));
        if (finalIM > 1) {
          if (hadFailThisRound) {
            // 挂单失败：额外下调校准，让下次挂更小的量
            MARGIN_CALIB = Math.max(0.5, MARGIN_CALIB * 0.90);
            log(`  📐 已用$${finalIM.toFixed(0)}(${(finalIM/balance*100).toFixed(0)}%) 有挂单失败,校准下调→${MARGIN_CALIB.toFixed(2)}`);
          } else {
            log(`  📐 已用$${finalIM.toFixed(0)}(${(finalIM/balance*100).toFixed(0)}%) 校准${MARGIN_CALIB.toFixed(2)}`);
          }
          saveState();
        }
        lastRebalanceTs = Date.now();
        // 分配完成后检查是否还有剩余资金可加仓
        const remainIM = await getUsedMargin(root);
        const remainBudget = Math.max(0, balance * CONFIG.marginUsage - remainIM);
        if (remainBudget >= CONFIG.addPositionMinIdle && held.size > 0) {
          log(`  💰 分配后剩余$${remainBudget.toFixed(0)}，加仓给现有池...`);
          const addExistingAlloc = new Map([...held.values()].map(h => [poolKey(h.marketId, h.side), h.allocUsd]));
          const addPendlePrice = await getPendlePrice();
          const addCoolExclude2 = new Set([...closing.keys(),
            ...[...addPosCooling.entries()].filter(([,t]) => Date.now() < t).map(([k]) => k.split(':')[0])
          ]);
          const addAllocs2 = await computeAllocation(exchange, remainBudget, balance, 0, addCoolExclude2, addExistingAlloc, addPendlePrice, true, new Set([...cooling.keys()]));
          if (addAllocs2.length === 0) {
            // 加仓分配不出去，给所有持仓池设10分钟冷却，避免每轮重复扫描浪费API
            for (const k of held.keys()) addPosCooling.set(k, Date.now() + 10 * 60_000);
          }
          for (const a of addAllocs2) {
            const k = poolKey(a.market.marketId, a.side);
            if (!held.has(k)) continue;
            const h = held.get(k);
            const mergedYu = h.yu + a.yu;
            const mergedUsd = h.allocUsd + a.allocUsd;
            await cancelMarket(exchange, root, a.market);
            const ok = await placeOrderFor(exchange, root, { ...a, yu: mergedYu, allocUsd: mergedUsd });
            if (ok) {
              held.set(k, { ...h, yu: mergedYu, allocUsd: mergedUsd });
              addPosCooling.set(k, Date.now() + CONFIG.addPositionCoolMs);
            }
            await sleep(1200);
          }
        }
      } else if (held.size > 0 && closing.size === 0) {
        // 稳态但有足够闲置资金，尝试加仓（不开新池，只给现有池追加）
        // 所有持仓池都在加仓冷却中 → 跳过整个加仓流程（避免每轮空跑全市场扫描）
        const allPoolsCooling = held.size > 0 &&
          [...held.keys()].every(k => (addPosCooling.get(k) || 0) > Date.now());
        if (availBudget >= CONFIG.addPositionMinIdle && !allPoolsCooling) {
          log(`  ✓ ${held.size}个池稳态(闲置$${availBudget.toFixed(0)}) 尝试加仓...`);
          const existingAlloc = new Map([...held.values()].map(h => [poolKey(h.marketId, h.side), h.allocUsd]));
          const pendlePrice = await getPendlePrice();
          // 加仓冷却：过滤掉6小时内刚加过仓的池
          const addCoolExclude = new Set([
            ...closing.keys(), ...cooling.keys(),
            ...[...addPosCooling.entries()].filter(([,t]) => Date.now() < t).map(([k]) => k.split(':')[0])
          ]);
          const addAllocs = await computeAllocation(exchange, availBudget, balance, 0, addCoolExclude, existingAlloc, pendlePrice, true, new Set([...cooling.keys()]));
          if (addAllocs.length === 0) {
            // 加不进去（多半是已到45%上限），10分钟内不再重复扫描
            for (const k of held.keys()) addPosCooling.set(k, Date.now() + 10 * 60_000);
            log(`  ⏸️ 无可加仓池(多为已达上限),暂停加仓10分钟`);
          }
          for (const a of addAllocs) {
            const mid = a.market.marketId;
            const k = poolKey(mid, a.side);
            if (!held.has(k)) continue; // 只加仓，不开新池
            const h = held.get(k);
            const mergedYu = h.yu + a.yu;
            const mergedUsd = h.allocUsd + a.allocUsd;
            await cancelMarket(exchange, root, a.market);
            const ok = await placeOrderFor(exchange, root, { ...a, yu: mergedYu, allocUsd: mergedUsd });
            if (ok) {
              held.set(k, { ...h, yu: mergedYu, allocUsd: mergedUsd });
              addPosCooling.set(k, Date.now() + CONFIG.addPositionCoolMs); // 记录加仓冷却
            }
          }
        } else {
          log(`  ✓ ${held.size}个池稳态(闲置$${Math.max(0,availBudget).toFixed(0)})`);
        }
      }
    } catch (e) { log(`❌ ${e.message}`); }
    log(`⏳ ${CONFIG.refreshMs/1000}s后...`);
    await sleep(CONFIG.refreshMs);
  }
}

main().catch(console.error);
