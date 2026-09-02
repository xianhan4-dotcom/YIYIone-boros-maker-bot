require('dotenv').config();
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { arbitrum } = require('viem/chains');
const { Agent, Exchange, getOpenApiSdk } = require('@pendle/boros-sdk-public');

const TOKEN_NAME = { 1: 'BTC', 2: 'ETH', 3: 'USDT' };
const DECIMALS = { 1: 6, 2: 5, 3: 2 };

function tokenIdFromMarketAcc(acc) {
  if (!acc || acc.length < 8) return null;
  return parseInt(acc.slice(-8).slice(0, 2), 16);
}

async function main() {
  const root = privateKeyToAccount(process.env.PRIVATE_KEY);
  const sdk = getOpenApiSdk();
  const rootAddr = root.address;

  console.log('\n══════════ 充提记录 (TransferLogs) ══════════');
  let logs = [];
  try {
    let resumeToken;
    do {
      const { data } = await sdk.accounts.accountsV2ControllerGetTransferLogs({
        root: rootAddr, accountId: 0, limit: 200, resumeToken,
      });
      logs.push(...(data.results || []));
      resumeToken = data.resumeToken ?? undefined;
    } while (resumeToken);
  } catch (e) {
    console.log('拉取失败,打印一条样本看字段结构...');
    try {
      const { data } = await sdk.accounts.accountsV2ControllerGetTransferLogs({ root: rootAddr, accountId: 0, limit: 5 });
      console.log(JSON.stringify(data, null, 2));
    } catch (e2) { console.log('错误:', e2.response?.data || e2.message); }
    return;
  }

  console.log(`共 ${logs.length} 条充提记录\n`);
  if (logs.length > 0) {
    console.log('第一条样本字段:', JSON.stringify(logs[0], null, 2));
    console.log('\n');
  }

  // 按 tokenId 汇总净流入(充值为正,提现为负)
  const netFlow = { 1: 0, 2: 0, 3: 0 };
  for (const l of logs) {
    const tid = tokenIdFromMarketAcc(l.marketAcc) || tokenIdFromMarketAcc(l.account) || l.tokenId;
    if (!TOKEN_NAME[tid]) continue;
    // amount 可能正负,或有 isDeposit 标志
    let amt = parseFloat(l.amount || l.value || '0') / 1e18;
    if (l.isDeposit === false || l.direction === 'withdraw' || l.type === 'WITHDRAW') amt = -Math.abs(amt);
    netFlow[tid] = (netFlow[tid] || 0) + amt;
  }

  console.log('══════════ 各账户净投入(充值-提现) ══════════');
  for (const tid of [3, 2, 1]) {
    const name = TOKEN_NAME[tid];
    console.log(`  ${name}: 净投入 ${netFlow[tid].toFixed(DECIMALS[tid])} ${name}`);
  }

  // 拉当前净值对比
  console.log('\n══════════ 真实盈亏 = 当前净值 - 净投入 ══════════');
  const { data: accData } = await sdk.accounts.accountsV2ControllerGetMarketAccInfosByRoot({ root: rootAddr, accountId: 0 });
  for (const info of (accData.results || [])) {
    const tid = tokenIdFromMarketAcc(info.marketAcc);
    if (!TOKEN_NAME[tid]) continue;
    const name = TOKEN_NAME[tid];
    const dec = DECIMALS[tid];
    const net = parseFloat(info.netBalance || info.totalCash || '0') / 1e18;
    const invested = netFlow[tid] || 0;
    const pnl = net - invested;
    console.log(`\n【${name}】`);
    console.log(`  净投入: ${invested.toFixed(dec)} ${name}`);
    console.log(`  当前净值: ${net.toFixed(dec)} ${name}`);
    console.log(`  真实盈亏: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(dec)} ${name} ${pnl >= 0 ? '✅' : '❌'}`);
  }
}

main().catch(e => console.log('错误:', e.response?.data || e.message));