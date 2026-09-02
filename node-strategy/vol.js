require('dotenv').config();
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

  const all = await ex.getAllMarkets({ isUiWhitelisted: true });
  const usdt = all.filter(m => m.tokenId === 3 && m.config.status === 2 &&
    m.imData.maturity > now + 3*86400 && m.data.bestBid != null && !m.imData.isIsolatedOnly);

  console.log(`\n===== USDT市场(tokenId=3) 每日波动率排名 共${usdt.length}个 =====\n`);

  const rows = usdt.map(m => ({
    sym: m.metadata?.fundingRateSymbol,
    mid: m.data.midApr,
    vol: m.data.dailyVolatility,
    volState: m.data.dailyVolatilityState,
    vol24h: m.data.volume24h || 0,
  }));

  // 有波动率数值的,按波动率升序(最稳的在前)
  const withVol = rows.filter(r => r.vol != null).sort((a,b) => a.vol - b.vol);
  const noVol = rows.filter(r => r.vol == null);

  console.log('【有波动率数据,按从稳到乱排序】');
  console.log('市场'.padEnd(20), 'midApr', '日波动率', '24h量');
  for (const r of withVol) {
    console.log(
      r.sym.padEnd(20),
      `${(r.mid*100).toFixed(2)}%`.padEnd(8),
      `${(r.vol*100).toFixed(3)}%`.padEnd(10),
      `$${(r.vol24h/1e6).toFixed(1)}M`
    );
  }

  console.log(`\n【无波动率数据(新市场或数据不足) ${noVol.length}个】`);
  for (const r of noVol) {
    console.log(`  ${r.sym.padEnd(20)} mid${(r.mid*100).toFixed(2)}% 状态:${r.volState}`);
  }

  console.log('\n说明:');
  console.log('  日波动率越小=利率越稳=越适合被动做市(不易被成交)');
  console.log('  可据此设白名单:只做日波动率<某阈值的市场');
}
main().catch(e => console.log('错误:', e.response?.data || e.message));