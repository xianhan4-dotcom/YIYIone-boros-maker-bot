require('dotenv').config();
const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http } = require('viem');
const { arbitrum } = require('viem/chains');
const { Agent, Exchange } = require('@pendle/boros-sdk-public');

async function main() {
  const root = privateKeyToAccount(process.env.PRIVATE_KEY);
  const agent = Agent.createFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  const wc = createWalletClient({ account: root, transport: http(process.env.RPC_URL), chain: arbitrum });
  const ex = new Exchange(wc, root.address, 0, [process.env.RPC_URL], agent);

  const all = await ex.getAllMarkets({ isUiWhitelisted: true });
  // 找 XRPUSDT 市场(标的-16.8%那个)
  const m = all.find(x => x.metadata?.fundingRateSymbol?.includes('xrp') || x.marketId === 143)
            || all.find(x => x.tokenId === 3 && x.data.bestBid != null);

  console.log('市场:', m.metadata?.fundingRateSymbol, 'marketId:', m.marketId);
  console.log('\n===== data 部分全部字段(找标的利率:网页显示-16.80%) =====');
  for (const k of Object.keys(m.data)) {
    console.log(`  data.${k} = ${JSON.stringify(m.data[k])}`);
  }
  console.log('\n===== 搜索利率相关字段(apr/rate/funding/underlying/mark/target) =====');
  const search = (obj, path='') => {
    for (const k in obj) {
      if (/apr|rate|funding|underlying|mark|target|index/i.test(k)) {
        const v = obj[k];
        if (typeof v !== 'object') console.log(`  ${path}${k} = ${v}  ${typeof v==='number'?'('+(v*100).toFixed(2)+'%)':''}`);
      }
      if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) search(obj[k], path+k+'.');
    }
  };
  search(m);
  console.log('\n网页显示: 隐含(midApr)=2.23%, 标的=-16.80%');
  console.log('请找出哪个字段=−0.168 左右,那就是标的利率');
}
main().catch(e => console.log('错误:', e.response?.data || e.message));