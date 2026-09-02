"""
Boros Market Data Fetcher / 市场数据获取
通过 REST API 拉取 Boros 市场数据、订单簿、资金费率等
"""

import asyncio
import os
from dataclasses import dataclass, field
from typing import Optional

import aiohttp
from dotenv import load_dotenv

load_dotenv()

# Base URL: https://api-boros.pendle.finance/apis (NOT /apis/v1)
# All endpoints prefixed with /v1/...
OPEN_API = os.getenv("BOROS_OPEN_API", "https://api-boros.pendle.finance/apis")


@dataclass
class MarketInfo:
    """市场基本信息"""
    market_id: int
    underlying: str          # e.g. "ETH"
    platform: str            # e.g. "Hyperliquid"
    collateral: str          # e.g. "ETH"
    maturity: int            # unix timestamp
    mark_rate: float         # 当前标记利率 (APR)
    mid_rate: float          # 中间利率 (best bid+ask / 2)
    best_bid: float          # 最佳买价 (APR)
    best_ask: float          # 最佳卖价 (APR)
    open_interest_long: float
    open_interest_short: float
    volume_24h: float
    tvl: float

    @property
    def spread_bps(self) -> float:
        """价差 (bps)"""
        return (self.best_ask - self.best_bid) * 10000

    @property
    def days_to_maturity(self) -> float:
        """距到期天数"""
        import time
        return max(0, (self.maturity - time.time()) / 86400)

    @property
    def long_short_ratio(self) -> float:
        """多空比"""
        if self.open_interest_short == 0:
            return float("inf")
        return self.open_interest_long / self.open_interest_short


@dataclass
class AccountInfo:
    """账户信息"""
    total_cash: float
    net_balance: float
    initial_margin: float
    available_margin: float
    positions: list = field(default_factory=list)


class BorosDataFetcher:
    """Boros 数据获取器"""

    def __init__(self, api_url: str = OPEN_API):
        self.api_url = api_url.rstrip("/")
        self._session: Optional[aiohttp.ClientSession] = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = aiohttp.ClientSession()
        return self._session

    async def _get(self, path: str) -> dict:
        session = await self._get_session()
        url = f"{self.api_url}{path}"
        async with session.get(url) as resp:
            resp.raise_for_status()
            return await resp.json()

    async def _post(self, path: str, body: dict) -> dict:
        session = await self._get_session()
        url = f"{self.api_url}{path}"
        async with session.post(url, json=body) as resp:
            resp.raise_for_status()
            return await resp.json()

    # ═══════════════════════════════════════════════════
    # Market Data
    # ═══════════════════════════════════════════════════

    async def get_all_markets(self) -> list[dict]:
        """获取所有市场列表 (自动分页)"""
        all_markets = []
        resume_token = None
        while True:
            params = {"limit": 100}
            if resume_token:
                params["resumeToken"] = resume_token
            qs = "&".join(f"{k}={v}" for k, v in params.items())
            data = await self._get(f"/v1/markets?{qs}")
            results = data.get("results", [])
            all_markets.extend(results)
            resume_token = data.get("resumeToken")
            if not resume_token:
                break
        return all_markets

    async def get_market(self, market_id: int) -> dict:
        """获取单个市场详情"""
        data = await self._get(f"/v1/markets/by-ids?ids={market_id}")
        results = data.get("results", [])
        if results:
            return results[0]
        raise ValueError(f"Market {market_id} not found")

    async def get_order_book(self, market_id: int) -> dict:
        """获取订单簿"""
        return await self._get(f"/v1/markets/order-book?marketId={market_id}")

    async def get_recent_trades(self, market_id: int, limit: int = 50) -> list[dict]:
        """获取最近成交"""
        data = await self._get(f"/v1/markets/trades?marketId={market_id}&limit={limit}")
        return data.get("results", [])

    async def get_indicators(
        self, market_id: int, codes: list[str] = None
    ) -> dict:
        """获取指标 (u=underlying APR, fp=future premium, fgi=fear&greed, ap=asset price)"""
        if codes is None:
            codes = ["u", "fp", "ap"]
        code_str = ",".join(codes)
        return await self._get(f"/v1/indicators?marketId={market_id}&codes={code_str}")

    # ═══════════════════════════════════════════════════
    # Account Data
    # ═══════════════════════════════════════════════════

    async def encode_market_acc(
        self, root_address: str, account_id: int = 0, token_id: int = 3, market_id: int = 16777215
    ) -> str:
        """编码 Boros marketAcc。Cross account 使用 marketId=16777215。"""
        data = await self._get(
            f"/v1/market-acc/encode?root={root_address}&accountId={account_id}"
            f"&tokenId={token_id}&marketId={market_id}"
        )
        return data["marketAcc"]

    async def get_market_acc_info(
        self, root_address: str, account_id: int = 0, token_id: int = 3
    ) -> list[dict]:
        """获取账户保证金/持仓信息"""
        market_acc = await self.encode_market_acc(root_address, account_id, token_id)
        body = {
            "marketAccs": [market_acc]
        }
        data = await self._post("/v1/accounts/market-acc-infos", body)
        return data.get("results", [])

    async def get_active_positions(
        self, root_address: str, account_id: int = 0
    ) -> list[dict]:
        """获取活跃持仓"""
        data = await self._get(f"/v1/accounts/active-positions?root={root_address}&accountId={account_id}")
        return data.get("results", [])

    async def get_gas_balance(self, root_address: str) -> dict:
        """获取 Gas 余额"""
        return await self._get(f"/v1/accounts/gas-balance?root={root_address}")

    # ═══════════════════════════════════════════════════
    # Convenience Methods
    # ═══════════════════════════════════════════════════

    async def get_scannable_markets(self) -> list[MarketInfo]:
        """获取可扫描的市场列表（解析后的格式）"""
        raw = await self.get_all_markets()
        markets = []
        for m in raw:
            try:
                data = m.get("data", {})
                im = m.get("imData", {})
                meta = m.get("metadata", {})
                plat = m.get("platform", {})
                cfg = m.get("config", {})

                mid = float(data.get("midApr", 0))
                mark = float(data.get("markApr", 0))

                # 从配置推导 best_bid / best_ask (无直接API时用 mid ± spread)
                # 后续可从 order-book API 获取精确值
                best_bid = float(data.get("lastTradedApr", mid)) or mid
                best_ask = mid + (mid - best_bid) if best_bid != mid else mid

                markets.append(MarketInfo(
                    market_id=m.get("marketId", 0),
                    underlying=meta.get("underlyingSymbol", "?"),
                    platform=plat.get("name", "?"),
                    collateral=meta.get("underlyingSymbol", "?"),  # 通常抵押品=标的
                    maturity=im.get("maturity", 0),
                    mark_rate=mark,
                    mid_rate=mid,
                    best_bid=best_bid,
                    best_ask=best_ask,
                    open_interest_long=0.0,  # 需从其他API获取
                    open_interest_short=0.0,
                    volume_24h=float(data.get("volume24h", 0)),
                    tvl=float(data.get("notionalOI", 0)),
                ))
            except (KeyError, ValueError, TypeError) as e:
                continue
        return markets

    async def close(self):
        if self._session:
            await self._session.close()
            self._session = None


# ═══════════════════════════════════════════════════
# Quick Test
# ═══════════════════════════════════════════════════

async def main():
    fetcher = BorosDataFetcher()
    try:
        print("📡 获取市场数据...")
        markets = await fetcher.get_scannable_markets()
        print(f"   找到 {len(markets)} 个市场\n")

        # 按成交量排序，展示 Top 5
        markets.sort(key=lambda m: m.volume_24h, reverse=True)
        print("🏆 Top 5 市场 (按24h成交量):")
        print(f"{'ID':<5} {'标的':<8} {'平台':<14} {'标记利率':>8} {'买价':>8} {'卖价':>8} {'价差':>6} {'24h量':>10}")
        print("-" * 80)
        for m in markets[:5]:
            print(
                f"{m.market_id:<5} {m.underlying:<8} {m.platform:<14} "
                f"{m.mark_rate*100:>7.2f}% {m.best_bid*100:>7.2f}% {m.best_ask*100:>7.2f}% "
                f"{m.spread_bps:>5.0f}bp ${m.volume_24h:>9,.0f}"
            )

        # 价差最大的市场（做市机会）
        print("\n🎯 最大价差市场 (做市机会):")
        markets_by_spread = sorted(markets, key=lambda m: m.spread_bps, reverse=True)
        for m in markets_by_spread[:5]:
            print(
                f"   {m.underlying}-{m.platform}: {m.spread_bps:.0f}bp | "
                f"Bid {m.best_bid*100:.2f}% / Ask {m.best_ask*100:.2f}% | "
                f"到期 {m.days_to_maturity:.0f}d"
            )

    finally:
        await fetcher.close()


if __name__ == "__main__":
    asyncio.run(main())
