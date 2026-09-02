"""
Boros 做市策略引擎
根据实时市场数据生成做市信号
"""

import asyncio
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np
from dotenv import load_dotenv

from .data_fetcher import BorosDataFetcher, MarketInfo

load_dotenv()


class Signal(Enum):
    """交易信号"""
    PLACE_BID = "PLACE_BID"       # 挂买单 (做多利率)
    PLACE_ASK = "PLACE_ASK"       # 挂卖单 (做空利率)
    CANCEL_BID = "CANCEL_BID"     # 撤买单
    CANCEL_ASK = "CANCEL_ASK"     # 撤卖单
    HOLD = "HOLD"                 # 不操作


@dataclass
class Quote:
    """报价"""
    market_id: int
    side: str               # "LONG" | "SHORT"
    tick: int               # 价格 tick
    size: float             # 仓位大小
    tif: str = "GTC"        # Good Till Cancelled


@dataclass
class StrategyState:
    """策略状态"""
    market_id: int
    position_size: float = 0.0       # 当前持仓 (正=long, 负=short)
    active_bids: list[Quote] = field(default_factory=list)
    active_asks: list[Quote] = field(default_factory=list)
    last_update: float = 0.0


class MarketMakingEngine:
    """
    做市策略引擎

    基于 Avellaneda-Stoikov 框架 + Boros 资金费率特性:
      - 储备价格 (reservation price) = 预测的资金费率
      - 最优价差 = f(波动率, 风险厌恶, 到期时间, 库存)
      - 库存偏斜修正: 当持仓偏离中性时调整报价
    """

    def __init__(
        self,
        gamma: float = 0.1,        # 风险厌恶系数
        sigma_est: float = 0.5,    # 波动率估计 (年化)
        T: float = 20 / 365,       # 到期时间 (年) — 默认20天
        k: float = 1.5,            # 订单流强度
        A: float = 1.0,            # 到达率缩放
        max_position: float = 10000.0,  # 最大仓位
        min_spread_bps: float = 1.0,    # 最小价差
        max_spread_bps: float = 200.0,  # 最大价差
    ):
        self.gamma = gamma
        self.sigma_est = sigma_est
        self.T = T
        self.k = k
        self.A = A
        self.max_position = max_position
        self.min_spread_bps = min_spread_bps
        self.max_spread_bps = max_spread_bps

        self._states: dict[int, StrategyState] = {}

    def get_state(self, market_id: int) -> StrategyState:
        if market_id not in self._states:
            self._states[market_id] = StrategyState(market_id=market_id)
        return self._states[market_id]

    # ═══════════════════════════════════════════════════
    # Avellaneda-Stoikov 核心
    # ═══════════════════════════════════════════════════

    def reservation_price(
        self, fair_rate: float, position: float, sigma: float = None
    ) -> float:
        """
        储备价格 (reservation price):
          r = s - q * gamma * sigma^2 * (T - t)
        
        其中:
          s = fair rate (预测的合理资金费率)
          q = 当前持仓 (正=long, 负=short)
          gamma = 风险厌恶系数
          sigma = 波动率
          T-t = 剩余时间
        
        含义: 如果已经 long 了 (q>0), 储备价格下降, 
              因为愿意以更低的价格卖出以减少库存风险
        """
        if sigma is None:
            sigma = self.sigma_est
        tau = self.T  # 剩余到期时间
        adjustment = position * self.gamma * (sigma ** 2) * tau
        return fair_rate - adjustment

    def optimal_spread(
        self, sigma: float = None, position: float = 0.0
    ) -> float:
        """
        最优买卖价差:
          delta_optimal = gamma * sigma^2 * (T-t) + (2/gamma) * ln(1 + gamma/k)
        
        库存修正: 当持仓偏离时扩大价差以降低风险
        """
        if sigma is None:
            sigma = self.sigma_est
        tau = self.T

        # 基础价差
        term1 = self.gamma * (sigma ** 2) * tau
        term2 = (2 / self.gamma) * np.log(1 + self.gamma / self.k)
        base_spread = term1 + term2

        # 库存修正: 离中性越远, 价差越大
        inventory_ratio = abs(position) / self.max_position if self.max_position > 0 else 0
        inventory_multiplier = 1 + 2 * inventory_ratio  # 最多扩大 3x
        spread = base_spread * inventory_multiplier

        # 钳制在合理范围
        spread_bps = spread * 10000  # 转换为 bps
        spread_bps = np.clip(spread_bps, self.min_spread_bps, self.max_spread_bps)
        return spread_bps / 10000

    # ═══════════════════════════════════════════════════
    # 做市决策
    # ═══════════════════════════════════════════════════

    def generate_quotes(
        self,
        market: MarketInfo,
        fair_rate: float,
        position: float = 0.0,
        n_levels: int = 3,
        size_per_level: float = 1000.0,
    ) -> list[Quote]:
        """
        生成做市报价单
        
        Args:
            market: 市场信息
            fair_rate: 预测的合理资金费率
            position: 当前持仓 (正=long, 负=short)
            n_levels: 档位数量
            size_per_level: 每档仓位大小
        
        Returns:
            报价列表 (bids + asks)
        """
        r = self.reservation_price(fair_rate, position)
        delta = self.optimal_spread(position=position)

        # 考虑库存偏斜: 如果已经 long, bid 应更低 (减少买入)
        skew = position / self.max_position if self.max_position > 0 else 0
        bid_skew = -0.5 * skew * delta  # 负库存偏斜 → bid 更低
        ask_skew = -0.5 * skew * delta  # 正库存偏斜 → ask 更低 (更容易卖出)

        quotes = []

        # 多档报价 (等比间距)
        for i in range(n_levels):
            level_delta = delta * (1 + 0.5 * i)  # 每档间距扩大 50%

            # Bid (做多利率)
            bid_rate = r - level_delta / 2 + bid_skew * (1 + 0.3 * i)
            bid_tick = self._rate_to_tick_approx(bid_rate, market)
            quotes.append(Quote(
                market_id=market.market_id,
                side="LONG",
                tick=bid_tick,
                size=size_per_level / (i + 1),  # 深层挂单量递减
            ))

            # Ask (做空利率)
            ask_rate = r + level_delta / 2 + ask_skew * (1 + 0.3 * i)
            ask_tick = self._rate_to_tick_approx(ask_rate, market)
            quotes.append(Quote(
                market_id=market.market_id,
                side="SHORT",
                tick=ask_tick,
                size=size_per_level / (i + 1),
            ))

        return quotes

    def should_cancel_replace(
        self,
        market: MarketInfo,
        fair_rate: float,
        active_quotes: list[Quote],
        position: float,
        threshold_bps: float = 2.0,
    ) -> tuple[list[Quote], list[Quote]]:
        """
        判断是否需要撤单并重新挂单
        
        Returns:
            (to_cancel, to_place): 需要撤的单, 需要挂的单
        """
        new_quotes = self.generate_quotes(market, fair_rate, position)

        # 简化为: 如果储备价格偏离超过阈值, 全部撤单重挂
        r = self.reservation_price(fair_rate, position)
        mid = (market.best_bid + market.best_ask) / 2 if (market.best_bid + market.best_ask) > 0 else fair_rate

        if abs(r - mid) * 10000 > threshold_bps:
            return active_quotes, new_quotes

        return [], new_quotes

    @staticmethod
    def _rate_to_tick_approx(rate: float, market: MarketInfo) -> int:
        """
        利率 → tick 近似转换
        rate(tick) = 1.00005^(tick * tickStep) - 1  (for positive ticks)
        
        简化: tick = log(1 + rate) / (tickStep * log(1.00005))
        默认 tickStep = 2
        """
        tick_step = 2  # Boros 默认
        if rate >= 0:
            tick = np.log(1 + rate) / (tick_step * np.log(1.00005))
        else:
            tick = -np.log(1 - rate) / (tick_step * np.log(1.00005))
        return int(np.round(tick))

    # ═══════════════════════════════════════════════════
    # 资金费率套利信号
    # ═══════════════════════════════════════════════════

    def funding_rate_arbitrage_signal(
        self,
        boros_rate: float,       # Boros 上的隐含利率
        underlying_rate: float,  # 底层交易所的实际资金费率
        threshold: float = 0.005,  # 0.5% 套利阈值
    ) -> dict:
        """
        资金费率跨平台套利信号
        
        如果 Boros 上的固定利率 > 底层资金费率 + 阈值:
          → 在 Boros 做空利率 (收固定, 付浮动)
          → 在底层做多永续合约 (收资金费率)
        """
        spread = boros_rate - underlying_rate
        abs_spread = abs(spread)

        if abs_spread < threshold:
            return {"action": "HOLD", "spread": spread, "reason": "价差不足"}

        if spread > threshold:
            return {
                "action": "SHORT_BOROS_LONG_PERP",
                "spread": spread,
                "reason": f"Boros利率({boros_rate*100:.2f}%) > 底层({underlying_rate*100:.2f}%), 做空Boros利率",
            }
        else:
            return {
                "action": "LONG_BOROS_SHORT_PERP",
                "spread": abs_spread,
                "reason": f"底层({underlying_rate*100:.2f}%) > Boros利率({boros_rate*100:.2f}%), 做多Boros利率",
            }


# ═══════════════════════════════════════════════════
# Quick Demo
# ═══════════════════════════════════════════════════

async def demo():
    fetcher = BorosDataFetcher()
    engine = MarketMakingEngine()

    try:
        markets = await fetcher.get_scannable_markets()
        if not markets:
            print("❌ 无可用市场")
            return

        # 选一个流动性最好的市场演示
        market = sorted(markets, key=lambda m: m.volume_24h, reverse=True)[0]
        print(f"\n🎯 做市演示: {market.underlying}-{market.platform} (Market {market.market_id})")
        print(f"   标记利率: {market.mark_rate*100:.2f}%")
        print(f"   最佳买卖: {market.best_bid*100:.2f}% / {market.best_ask*100:.2f}%")
        print(f"   价差: {market.spread_bps:.0f} bps\n")

        # 场景1: 中性持仓做市
        print("📊 场景1: 中性持仓 (position=0)")
        quotes = engine.generate_quotes(market, fair_rate=market.mark_rate, position=0)
        for q in quotes:
            rate = (1.00005 ** (q.tick * 2) - 1) if q.tick >= 0 else -(1.00005 ** (-q.tick * 2) - 1)
            print(f"   {q.side:>6} @ tick={q.tick:>5} (≈{rate*100:.3f}%) | size={q.size:.0f}")

        # 场景2: 已持有多头仓位
        print(f"\n📊 场景2: 已持有 LONG {engine.max_position * 0.5:.0f} 仓位")
        quotes_long = engine.generate_quotes(
            market, fair_rate=market.mark_rate, position=engine.max_position * 0.5
        )
        for q in quotes_long:
            rate = (1.00005 ** (q.tick * 2) - 1) if q.tick >= 0 else -(1.00005 ** (-q.tick * 2) - 1)
            print(f"   {q.side:>6} @ tick={q.tick:>5} (≈{rate*100:.3f}%) | size={q.size:.0f}")

        # 场景3: 资金费率套利
        print(f"\n📊 场景3: 资金费率套利信号")
        arb = engine.funding_rate_arbitrage_signal(
            boros_rate=market.mark_rate,
            underlying_rate=market.mark_rate * 0.7,  # 模拟偏离
        )
        print(f"   信号: {arb['action']}")
        print(f"   价差: {arb['spread']*100:.2f}%")
        print(f"   原因: {arb['reason']}")

        print(f"\n   储备价格: {engine.reservation_price(market.mark_rate, 0)*100:.2f}%")
        print(f"   最优价差: {engine.optimal_spread()*10000:.1f} bps")

    finally:
        await fetcher.close()


if __name__ == "__main__":
    asyncio.run(demo())
