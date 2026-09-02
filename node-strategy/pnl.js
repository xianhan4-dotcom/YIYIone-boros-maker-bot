require('dotenv').config();
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { arbitrum } = require('viem/chains');
const { Agent, Exchange, getOpenApiSdk } = require('@pendle/boros-sdk-public');

const INITIAL = { 3: 2280, 2: 0.5, 1: 0.0094 };
const TOKEN_NAME = { 1: 'BTC', 2: 'ETH', 3: 'USDT' };
const DECIMALS = { 1: 6, 2: 5, 3: 2 };

function tokenIdFromMarketAcc(acc) {
  if (!acc || acc.length < 8) return null;
  return parseInt(acc.slice(-8).slice(0, 2), 16);
}

async function main() {
  const root = privateKeyToAccount(process.env.PRIVATE_KEY);
  const agent = Agent.createFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  const wc = createWalletClient({ account: root, transport: http(process.env.RPC_URL), chain: arbitrum });
  const ex = new Exchange(wc, root.address, 0, [process.env.RPC_URL], agent);
  const sdk = getOpenApiSdk();

  const { data } = await sdk.accounts.accountsV2ControllerGetMarketAccInfosByRoot({ root: root.address, accountId: 0 });

  console.log('\n══════════ 三账户真实盈亏 ══════════');
  for (const info of (data.results || [])) {
    const tid = tokenIdFromMarketAcc(info.marketAcc);
    if (!TOKEN_NAME[tid]) continue;
    const name = TOKEN_NAME[tid];
    const dec = DECIMALS[tid];

    // 打印所有可用字段,确保看到真实数据
    const cash = parseFloat(info.totalCash || '0') / 1e18;
    const net = parseFloat(info.netBalance || '0') / 1e18;
    const im = parseFloat(info.initialMargin || '0') / 1e18;

    // 净值优先用 netBalance,若为0则用 totalCash
    const equity = net > 0 ? net : cash;
    const init = INITIAL[tid] || 0;
    const pnl = equity - init;
    const pnlPct = init > 0 ? (pnl / init * 100) : 0;

    console.log(`\n【${name}本位】`);
    console.log(`  总现金 totalCash: ${cash.toFixed(dec)} ${name}`);
    console.log(`  净值   netBalance: ${net.toFixed(dec)} ${name}`);
    console.log(`  已用保证金:        ${im.toFixed(dec)} ${name}`);
    console.log(`  ─────────────`);
    console.log(`  初始投入: ${init} ${name}`);
    console.log(`  当前净值: ${equity.toFixed(dec)} ${name}`);
    console.log(`  盈亏:    ${pnl >= 0 ? '+' : ''}${pnl.toFixed(dec)} ${name}  (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)  ${pnl >= 0 ? '✅赚' : '❌亏'}`);

    // 持仓
    const poss = (info.positions || []).filter(p => Math.abs(parseFloat(p.signedSize || '0')/1e18) > 0.5);
    if (poss.length > 0) {
      console.log(`  当前持仓 ${poss.length} 个:`);
      for (const p of poss) {
        const sz = parseFloat(p.signedSize || '0')/1e18;
        const pv = parseFloat(p.positionValue || '0')/1e18;
        console.log(`    市场${p.marketId}: ${sz.toFixed(1)}YU 价值${pv.toFixed(dec)}${name}`);
      }
    }
  }

  console.log('\n\n══════════ 怎么读 ══════════');
  console.log('  上面每个账户的"盈亏"行 = 真实总盈亏(已含全部成交损失)');
  console.log('  USDT若中途充值过,把INITIAL的2280改成你的真实总投入');
  console.log('  PENDLE激励另算:需到boros网页"Rewards/Claim"看实际已分配数量');
  console.log('  (激励是链下记账,不在这个净值里,要网页单独查)');
}

main().catch(e => console.log('错误:', e.response?.data || e.message, '\n', e.stack));