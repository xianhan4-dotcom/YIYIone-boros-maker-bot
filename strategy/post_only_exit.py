"""
Boros Post-Only Market Making + Optimal Exit Strategy
=====================================================
纯挂单做市 + 被吃后最小损失平仓

核心问题: 当被动挂单被对手方吃掉时, 通常意味着市场方向已对你不利
         (逆向选择 adverse selection)。如何以最小代价平仓?

Boros 关键机制:
  - ALO (Add Liquidity Only): 严格 post-only, 拒绝任何 taker 成交
  - SOFT_ALO: 宽松 post-only, 跳过 taker 部分, 剩余挂单
  - Stop Loss (Market): 链下条件单, APR 触及阈值 → IOC 市价平仓
  - AMM 路由: includeAmm=true 可走 AMM 获取即时流动性
  - bulkOrders: 一条交易完成撤单+重挂 (原子性)
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Callable
import math
import time
import logging

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════
# 核心数据结构
# ═══════════════════════════════════════════════════════════════

class ExitStrategy(Enum):
    """平仓策略类型"""
    MARKET_IMMEDIATE = "market_immediate"     # 立即市价平仓 (IOC)
    STOP_LOSS = "stop_loss"                   # 预设止损条件单
    LIMIT_ESCALATOR = "limit_escalator"       # 限价阶梯平仓
    AMM_ROUTE = "amm_route"                   # 走 AMM 即时退出
    HYBRID = "hybrid"                         # 混合策略 (默认推荐)


class FillReason(Enum):
    """被吃原因分类 (影响平仓策略选择)"""
    ADVERSARIAL = "adversarial"       # 对手方有信息优势, 方向性突破
    VOLATILITY_SPIKE = "vol_spike"    # 波动率突增, 随机 hit
    SPREAD_CAPTURE = "spread_capture" # 正常的 spread 捕获, 市场中性
    LIQUIDITY_VACUUM = "liq_vacuum"   # 流动性枯竭, 你的挂单成为唯一流动性


@dataclass
class FillEvent:
    """被吃事件"""
    market_id: int
    side: str               # "LONG" | "SHORT" — 被吃的方向
    fill_tick: int          # 成交 tick
    fill_rate: float        # 成交利率 (APR)
    fill_size: float        # 成交数量 (YU)
    fill_time: float        # 成交时间 (unix)
    mark_rate: float        # 当时标记利率
    mid_rate: float         # 当时中间利率
    position_before: float  # 吃单前持仓
    position_after: float   # 吃单后持仓

    def side_sign(self) -> int:
        """持仓方向符号: +1=LONG被吃(变LONG), -1=SHORT被吃(变SHORT)"""
        return 1 if self.position_after > 0 else -1


@dataclass
class ExitPlan:
    """平仓计划"""
    strategy: ExitStrategy
    orders: list[dict]       # [{side, tick, size, tif, includeAmm, ...}]
    stop_loss: Optional[dict] = None  # 止损条件单参数
    expected_cost_bps: float = 0.0    # 预估平仓成本 (bps)
    max_loss_bps: float = 0.0         # 最坏情况损失 (bps)
    reasoning: str = ""


# ═══════════════════════════════════════════════════════════════
# 策略引擎
# ═══════════════════════════════════════════════════════════════

class PostOnlyExitEngine:
    """
    Post-Only 做市 + 被吃后最优平仓引擎

    理论基础:
      1. Avellaneda-Stoikov 库存管理: reservation price 随库存偏移
      2. Almgren-Chriss 最优执行: 平衡市场冲击 vs. 时间风险
      3. Boros 特有: ALO/Soft-ALO + Stop Loss + AMM 路由

    参数:
      gamma: 风险厌恶系数 (越大越急于平仓)
      sigma: 年化波动率估计
      max_tolerable_loss_bps: 最大可接受亏损 (bps)
      use_stop_loss: 是否预设止损条件单
      stop_loss_trigger_bps: 止损触发偏离 (bps)
    """

    def __init__(
        self,
        gamma: float = 0.5,                  # 风险厌恶
        sigma_annual: float = 1.0,           # 年化波动率 (资金费率波动大)
        max_tolerable_loss_bps: float = 50.0, # 最大可接受亏损 50 bps
        use_stop_loss: bool = True,
        stop_loss_trigger_bps: float = 30.0,  # 偏离 30 bps 触发止损
        min_spread_bps: float = 1.0,
        n_exit_levels: int = 3,
    ):
        self.gamma = gamma
        self.sigma = sigma_annual
        self.max_loss_bps = max_tolerable_loss_bps
        self.use_stop_loss = use_stop_loss
        self.sl_trigger_bps = stop_loss_trigger_bps
        self.min_spread_bps = min_spread_bps
        self.n_exit_levels = n_exit_levels

    # ═══════════════════════════════════════════════════════════
    # 1. 被吃事件分析
    # ═══════════════════════════════════════════════════════════

    def classify_fill(
        self,
        fill: FillEvent,
        recent_vol: float = 0.0,      # 近期波动率 (bps/min)
        avg_vol: float = 1.0,         # 平均波动率 (bps/min)
        spread_bps: float = 5.0,      # 当前价差 (bps)
    ) -> FillReason:
        """
        分类被吃原因 — 不同原因选择不同平仓策略

        判断逻辑:
          1. 如果波动率飙升 > 3x 均值 → VOLATILITY_SPIKE
          2. 如果成交价偏离 mid > 2x spread → ADVERSARIAL
          3. 如果价差 > 50 bps (流动性枯竭) → LIQ_VACUUM
          4. 否则 → SPREAD_CAPTURE (正常)
        """
        deviation_from_mid = abs(fill.fill_rate - fill.mid_rate) * 10000  # bps

        if recent_vol > avg_vol * 3:
            return FillReason.VOLATILITY_SPIKE

        if deviation_from_mid > spread_bps * 2:
            return FillReason.ADVERSARIAL

        if spread_bps > 50:
            return FillReason.LIQUIDITY_VACUUM

        return FillReason.SPREAD_CAPTURE

    # ═══════════════════════════════════════════════════════════
    # 2. 期望损失估计
    # ═══════════════════════════════════════════════════════════

    def estimate_adverse_selection_cost(
        self,
        fill: FillEvent,
        fill_reason: FillReason,
    ) -> float:
        """
        估计逆向选择造成的期望损失 (bps)

        模型: E[loss] = P(informed) * E[price_move | informed] + spread_cost

        不同被吃原因的参数:
          - ADVERSARIAL:     P(informed) ≈ 0.7, move ≈ 20-50 bps
          - VOL_SPIKE:       P(informed) ≈ 0.3, move ≈ 10-30 bps (可能均值回复)
          - SPREAD_CAPTURE:  P(informed) ≈ 0.1, move ≈ 2-5 bps
          - LIQ_VACUUM:      P(informed) ≈ 0.5, move ≈ 15-40 bps
        """
        # 按被吃原因设定参数
        params = {
            FillReason.ADVERSARIAL:     (0.7, 35.0, 5.0),
            FillReason.VOLATILITY_SPIKE: (0.3, 20.0, 8.0),
            FillReason.SPREAD_CAPTURE:   (0.1, 3.0,  2.0),
            FillReason.LIQUIDITY_VACUUM: (0.5, 25.0, 10.0),
        }
        p_informed, expected_move_bps, half_spread_bps = params.get(
            fill_reason, (0.3, 15.0, 5.0)
        )

        # 期望损失 = 信息交易概率 * 期望价格移动 + 价差成本
        expected_loss = p_informed * expected_move_bps + half_spread_bps

        # 波动率尖峰时考虑均值回复
        if fill_reason == FillReason.VOLATILITY_SPIKE:
            # 50% 概率回复 50% 的移动
            mean_reversion_relief = 0.5 * 0.5 * expected_move_bps
            expected_loss -= mean_reversion_relief

        return max(0, expected_loss)

    # ═══════════════════════════════════════════════════════════
    # 3. 最优平仓策略选择
    # ═══════════════════════════════════════════════════════════

    def select_exit_strategy(
        self,
        fill: FillEvent,
        fill_reason: FillReason,
        current_mid: float,
        current_spread_bps: float,
        amm_available: bool = True,
    ) -> ExitStrategy:
        """
        根据被吃原因和市场状态选择最优平仓策略

        决策树:
          ADVERSARIAL     → MARKET_IMMEDIATE (越快越好, 方向已确定)
          VOL_SPIKE       → LIMIT_ESCALATOR (可能均值回复, 挂限价等)
          SPREAD_CAPTURE  → HYBRID (不急, 用小限价慢慢出)
          LIQ_VACUUM      → AMM_ROUTE (订单簿没流动性, 走AMM)
        """
        if fill_reason == FillReason.ADVERSARIAL:
            return ExitStrategy.MARKET_IMMEDIATE

        if fill_reason == FillReason.VOLATILITY_SPIKE:
            return ExitStrategy.LIMIT_ESCALATOR

        if fill_reason == FillReason.LIQUIDITY_VACUUM:
            if amm_available:
                return ExitStrategy.AMM_ROUTE
            return ExitStrategy.MARKET_IMMEDIATE

        # SPREAD_CAPTURE: 正常情况, 混合策略
        return ExitStrategy.HYBRID

    # ═══════════════════════════════════════════════════════════
    # 4. 最优平仓价格计算
    # ═══════════════════════════════════════════════════════════

    def optimal_exit_rate(
        self,
        fill: FillEvent,
        fill_reason: FillReason,
        current_mid: float,
        current_spread_bps: float,
        urgency: float = 0.5,  # 0=不急, 1=非常紧急
    ) -> float:
        """
        计算最优平仓利率

        理论: 基于库存修正的 reservation price
          r_exit = r_mid + sign(position) * [delta_urgency + inventory_penalty]

        其中:
          delta_urgency = 紧迫性价差让步
            - MARKET_IMMEDIATE:  delta = spread * 0.5 (给对手方让利快速成交)
            - LIMIT_ESCALATOR:   delta = spread * 0.1 (小让利, 期望均值回复)
            - HYBRID:            delta = spread * 0.3

          inventory_penalty = gamma * sigma^2 * position * tau
            持仓越大、波动越高、剩余时间越短 → 越急于平仓
        """
        # 持仓符号: 被吃 LONG → 你现在是 LONG (正), 需要 SHORT 平仓
        # 被吃 SHORT → 你现在是 SHORT (负), 需要 LONG 平仓
        position = fill.position_after
        position_sign = 1 if position > 0 else -1

        # ═══ 紧迫性让步 ═══
        urgency_delta_map = {
            ExitStrategy.MARKET_IMMEDIATE: current_spread_bps * 0.5 / 10000,
            ExitStrategy.AMM_ROUTE:        current_spread_bps * 0.4 / 10000,
            ExitStrategy.HYBRID:           current_spread_bps * 0.3 / 10000,
            ExitStrategy.LIMIT_ESCALATOR:  current_spread_bps * 0.1 / 10000,
            ExitStrategy.STOP_LOSS:        current_spread_bps * 0.6 / 10000,
        }

        strategy = self.select_exit_strategy(
            fill, fill_reason, current_mid, current_spread_bps
        )
        delta = urgency_delta_map.get(strategy, current_spread_bps * 0.3 / 10000)

        # ═══ 库存惩罚 (Avellaneda-Stoikov, 缩放适配利率市场) ═══
        # 利率市场的仓位单位是 YU, sigma 是利率的年化波动率
        # penalty = gamma * sigma^2 * |q| * T / scaling_factor
        # scaling_factor ≈ 10000 → 输出在 bps 级别
        T = 20 / 365  # 剩余 ~20 天
        raw_penalty = self.gamma * (self.sigma ** 2) * abs(position) * T
        inventory_penalty_rate = raw_penalty * 1e-4  # 缩放到利率调整量级

        # ═══ 最优平仓价 ═══
        # 如果你是 LONG (要平仓 = SHORT = 卖出): 卖价应该高于 mid (更激进)
        # 如果你是 SHORT (要平仓 = LONG = 买入): 买价应该低于 mid
        exit_rate = current_mid - position_sign * (delta + inventory_penalty_rate)

        return exit_rate

    # ═══════════════════════════════════════════════════════════
    # 5. 生成平仓计划
    # ═══════════════════════════════════════════════════════════

    def generate_exit_plan(
        self,
        fill: FillEvent,
        current_mid: float,
        current_spread_bps: float,
        amm_available: bool = True,
        fill_reason: Optional[FillReason] = None,  # 手动指定原因
    ) -> ExitPlan:
        """
        生成完整平仓计划

        返回: ExitPlan 包含具体的订单列表和止损设置
        """

        # Step 1: 分类被吃原因 (允许手动指定)
        if fill_reason is None:
            fill_reason = self.classify_fill(fill, spread_bps=current_spread_bps)

        # Step 2: 选择策略
        strategy = self.select_exit_strategy(
            fill, fill_reason, current_mid, current_spread_bps, amm_available
        )

        # Step 3: 计算最优平仓价
        exit_rate = self.optimal_exit_rate(
            fill, fill_reason, current_mid, current_spread_bps
        )

        # Step 4: 估计成本
        expected_cost = self.estimate_adverse_selection_cost(fill, fill_reason)

        # ═══ 生成具体订单 ═══
        position = abs(fill.position_after)
        close_side = "SHORT" if fill.position_after > 0 else "LONG"

        orders = []
        stop_loss = None

        if strategy == ExitStrategy.MARKET_IMMEDIATE:
            # 立即 IOC 市价平仓 (全部)
            orders.append({
                "side": close_side,
                "tick": 0,  # market order — tick 会被 SDK 忽略
                "size": position,
                "tif": "IOC",
                "includeAmm": True,
            })

        elif strategy == ExitStrategy.LIMIT_ESCALATOR:
            # 阶梯限价: 逐步更激进
            # 第一档: 有利价格 (宽松)
            # 第二档: 中间价格
            # 第三档: 激进价格 (接近 market)
            exit_ticks = self._rate_to_ticks_escalator(exit_rate, current_mid, current_spread_bps, close_side, self.n_exit_levels)
            for i, tick in enumerate(exit_ticks):
                size_fraction = position / self.n_exit_levels
                orders.append({
                    "side": close_side,
                    "tick": tick,
                    "size": size_fraction,
                    "tif": "GTC" if i < self.n_exit_levels - 1 else "IOC",
                    "includeAmm": False,
                })

        elif strategy == ExitStrategy.AMM_ROUTE:
            # 全部走 AMM 即时流动性
            orders.append({
                "side": close_side,
                "tick": 0,
                "size": position,
                "tif": "IOC",
                "includeAmm": True,
            })

        elif strategy == ExitStrategy.HYBRID:
            # 混合: 50% 限价 + 50% 预设止损
            half = position / 2
            exit_tick = self._rate_to_tick_approx(exit_rate)

            # 一半挂限价
            orders.append({
                "side": close_side,
                "tick": exit_tick,
                "size": half,
                "tif": "GTC",
                "includeAmm": False,
            })

            # 另一半设止损
            if self.use_stop_loss:
                sl_trigger_rate = (
                    fill.fill_rate - fill.side_sign() * self.sl_trigger_bps / 10000
                )
                sl_tick = self._rate_to_tick_approx(sl_trigger_rate)
                stop_loss = {
                    "stopAprOrderType": 3,  # Stop Loss (Market)
                    "tick": sl_tick,
                    "size": str(int(half * 1e18)),  # 18 位精度
                    "timeInForce": 1,  # IOC
                }

        # ═══ 构建平仓计划 ═══
        max_loss = expected_cost * 1.5  # 最坏情况: 1.5x 期望损失

        reasoning = (
            f"Fill原因={fill_reason.value}, "
            f"策略={strategy.value}, "
            f"最优平仓利率={exit_rate*100:.3f}% (mid={current_mid*100:.3f}%), "
            f"预估成本={expected_cost:.1f}bps, "
            f"最坏损失={max_loss:.1f}bps"
        )

        return ExitPlan(
            strategy=strategy,
            orders=orders,
            stop_loss=stop_loss,
            expected_cost_bps=expected_cost,
            max_loss_bps=max_loss,
            reasoning=reasoning,
        )

    # ═══════════════════════════════════════════════════════════
    # 6. Post-Only 挂单生成 (ALO)
    # ═══════════════════════════════════════════════════════════

    def generate_post_only_quotes(
        self,
        market_id: int,
        fair_rate: float,
        mid_rate: float,
        spread_bps: float,
        position: float = 0.0,
        n_levels: int = 3,
        size_per_level: float = 500.0,
    ) -> list[dict]:
        """
        生成纯 Post-Only 报价 (ALO — 绝不主动吃单)

        参数:
          fair_rate: 你估计的合理利率
          mid_rate: 当前市场中间利率
          spread_bps: 当前价差 (bps)

        报价逻辑:
          - bid (做多利率): rate_bid = fair_rate - spread_bps/20000 - inventory_skew
          - ask (做空利率): rate_ask = fair_rate + spread_bps/20000 + inventory_skew
          - 全部使用 ALO (Add Liquidity Only)
          - 如果挂单会立即成交 → 交易自动回滚 (ALO 特性)
        """
        quotes = []

        # 库存偏斜修正
        max_pos = size_per_level * n_levels * 2
        skew = position / max_pos if max_pos > 0 else 0

        for i in range(n_levels):
            level_factor = 1.0 + 0.5 * i  # 档位间距

            # Bid (做多利率): 你愿意支付的固定利率
            bid_rate = fair_rate - (spread_bps / 10000) * level_factor * 0.5
            bid_rate -= skew * (spread_bps / 10000) * 0.3  # 库存修正
            bid_tick = self._rate_to_tick_approx(bid_rate)

            quotes.append({
                "side": "LONG",
                "tick": bid_tick,
                "size": size_per_level / (i + 1),
                "tif": "ALO",  # 严格 Post-Only
                "includeAmm": False,
            })

            # Ask (做空利率): 你愿意收到的固定利率
            ask_rate = fair_rate + (spread_bps / 10000) * level_factor * 0.5
            ask_rate += skew * (spread_bps / 10000) * 0.3  # 库存修正
            ask_tick = self._rate_to_tick_approx(ask_rate)

            quotes.append({
                "side": "SHORT",
                "tick": ask_tick,
                "size": size_per_level / (i + 1),
                "tif": "ALO",
                "includeAmm": False,
            })

        return quotes

    # ═══════════════════════════════════════════════════════════
    # 7. 动态Spread调宽 (市场波动增大时)
    # ═══════════════════════════════════════════════════════════

    def adaptive_spread(
        self,
        base_spread_bps: float,
        recent_vol_bps_per_min: float,
        avg_vol_bps_per_min: float,
        position_ratio: float,  # |position| / max_position
    ) -> float:
        """
        自适应价差调宽

        当波动率飙升或持仓偏离时扩大价差以减少被吃概率:
          spread = base_spread * vol_multiplier * inventory_multiplier

        vol_multiplier: 波动率是均值的 N 倍时, 价差扩大 sqrt(N) 倍
        inventory_multiplier: 仓位偏离中性时, 价差扩大 (1 + 2*|ratio|)
        """
        avg_vol = max(avg_vol_bps_per_min, 0.01)
        vol_ratio = recent_vol_bps_per_min / avg_vol
        vol_mult = math.sqrt(max(vol_ratio, 1.0))  # sqrt 避免过度反应

        inv_mult = 1.0 + 2.0 * abs(position_ratio)

        adjusted = base_spread_bps * vol_mult * inv_mult
        return max(self.min_spread_bps, min(adjusted, 200.0))  # 钳制

    # ═══════════════════════════════════════════════════════════
    # 辅助函数
    # ═══════════════════════════════════════════════════════════

    @staticmethod
    def _rate_to_tick_approx(rate: float) -> int:
        """APR利率 → Boros tick (近似)"""
        tick_step = 2
        if rate >= 0:
            tick = math.log(1 + rate) / (tick_step * math.log(1.00005))
        else:
            tick = -math.log(1 - rate) / (tick_step * math.log(1.00005))
        return int(round(tick))

    def _rate_to_ticks_escalator(
        self, exit_rate: float, mid: float, spread_bps: float, side: str, n: int
    ) -> list[int]:
        """生成阶梯平仓的 tick 序列 (从宽松到激进)"""
        ticks = []
        side_sign = 1 if side == "LONG" else -1
        for i in range(n):
            # 每档越来越激进 (越接近/越过 mid)
            aggressiveness = 0.1 + 0.3 * i / (n - 1) if n > 1 else 0.4
            rate = exit_rate * (1 - aggressiveness) + mid * aggressiveness
            # 激进意味着让利: 买入时出更高价, 卖出时出更低价
            rate += side_sign * spread_bps / 10000 * aggressiveness * 0.5
            ticks.append(self._rate_to_tick_approx(rate))
        return ticks


# ═══════════════════════════════════════════════════════════════
# 8. 策略对比 — 各方法的优劣
# ═══════════════════════════════════════════════════════════════

STRATEGY_COMPARISON = """
╔══════════════════════╦══════════╦══════════╦══════════════════════════════════╗
║ 策略                  ║ 平仓速度  ║ 滑点成本  ║ 适用场景                          ║
╠══════════════════════╬══════════╬══════════╬══════════════════════════════════╣
║ MARKET_IMMEDIATE     ║ ⚡ 即刻   ║ 较高     ║ 逆向选择确定, 越快越好              ║
║ (IOC 市价单)          ║          ║ (全价差)  ║ 被专业做市商/知情交易者吃掉         ║
╠══════════════════════╬══════════╬══════════╬══════════════════════════════════╣
║ LIMIT_ESCALATOR      ║ 🐢 较慢   ║ 较低     ║ 波动率尖峰, 可能是噪声              ║
║ (阶梯限价)            ║          ║ (部分价差) ║ 有均值回复预期的随机 hit             ║
╠══════════════════════╬══════════╬══════════╬══════════════════════════════════╣
║ STOP_LOSS            ║ ⚡ 自动   ║ 中等     ║ 无法持续监控时                     ║
║ (条件止损单)          ║          ║ (触发时价差)║ 预设最大亏损线, 睡觉也安心           ║
╠══════════════════════╬══════════╬══════════╬══════════════════════════════════╣
║ AMM_ROUTE            ║ ⚡ 即刻   ║ 中等     ║ 订单簿流动性枯竭                   ║
║ (走AMM流动性)         ║          ║ (AMM价差) ║ 订单簿几乎没有对手方挂单             ║
╠══════════════════════╬══════════╬══════════╬══════════════════════════════════╣
║ HYBRID               ║ 🕐 平衡   ║ 平衡     ║ 一般情况 (推荐默认)                ║
║ (限价+止损混合)       ║          ║ (优化后)  ║ 一半限价等好价格, 一半止损保底       ║
╚══════════════════════╩══════════╩══════════╩══════════════════════════════════╝
"""


# ═══════════════════════════════════════════════════════════════
# Demo: 模拟被吃 → 平仓
# ═══════════════════════════════════════════════════════════════

def demo():
    """演示完整流程: 挂单 → 被吃 → 分析 → 平仓"""
    engine = PostOnlyExitEngine()

    print("=" * 70)
    print("  Boros Post-Only 做市 + 最优平仓 演示")
    print("=" * 70)

    # ── Step 1: 展示 Post-Only 挂单 ──
    print("\n📋 Step 1: 生成 Post-Only 挂单 (ALO)")
    print("-" * 50)
    quotes = engine.generate_post_only_quotes(
        market_id=36,       # HYPE-OKX (高流动性)
        fair_rate=0.1047,   # 你估计的合理利率 10.47%
        mid_rate=0.1047,
        spread_bps=12.0,    # 当前 12 bps 价差
        position=0.0,       # 中性持仓
        n_levels=3,
        size_per_level=500.0,
    )
    for q in quotes:
        rate = (1.00005 ** (q["tick"] * 2) - 1) if q["tick"] >= 0 else -(1.00005 ** (-q["tick"] * 2) - 1)
        print(f"  {q['side']:>6} @ tick={q['tick']:>5} (≈{rate*100:.3f}%) "
              f"size={q['size']:.0f} YU | TIF={q['tif']}")

    # ── Step 2: 模拟被吃 ──
    print("\n📋 Step 2: 模拟被吃事件")
    print("-" * 50)

    # 场景 A: 你的 Ask 被吃 (有人买你的做空利率单 → 你变 SHORT)
    fill_a = FillEvent(
        market_id=36,
        side="SHORT",
        fill_tick=engine._rate_to_tick_approx(0.1047 + 0.0012),  # 被吃了 Ask
        fill_rate=0.1059,
        fill_size=500.0,
        fill_time=time.time(),
        mark_rate=0.1047,
        mid_rate=0.1047,
        position_before=0.0,
        position_after=-500.0,  # 变 SHORT
    )

    # 场景 B: 你的 Bid 被吃 (有人卖给你做多利率单 → 你变 LONG)
    # (取场景A演示)

    # ── Step 3: 分类和策略 ──
    print(f"  被吃方向: {fill_a.side}, 持仓变为: {fill_a.position_after:.0f} YU")
    print(f"  成交利率: {fill_a.fill_rate*100:.3f}% vs Mid: {fill_a.mid_rate*100:.3f}%")

    # 不同被吃原因下的策略对比
    print("\n📋 Step 3: 不同被吃原因 → 不同平仓策略")
    print("-" * 50)

    for reason in FillReason:
        plan = engine.generate_exit_plan(
            fill=fill_a,
            current_mid=fill_a.mid_rate,
            current_spread_bps=12.0,
            amm_available=True,
            fill_reason=reason,  # 手动指定原因做对比
        )
        expected_cost = engine.estimate_adverse_selection_cost(fill_a, reason)
        exit_rate = engine.optimal_exit_rate(fill_a, reason, fill_a.mid_rate, 12.0,
                                              urgency=0.5 if reason != FillReason.ADVERSARIAL else 1.0)

        print(f"\n  🔴 {reason.value}:")
        print(f"     策略: {plan.strategy.value}")
        print(f"     预估被吃损失: {expected_cost:.1f} bps")
        print(f"     最优平仓利率: {exit_rate*100:.3f}%")
        print(f"     平仓订单数: {len(plan.orders)}")
        if plan.stop_loss:
            print(f"     止损单: tick={plan.stop_loss['tick']}")

    # ── Step 4: 自适应Spread ──
    print("\n\n📋 Step 4: 自适应Spread (波动增大时)")
    print("-" * 50)
    base = 12.0
    scenarios = [
        ("正常市场", 1.0, 1.0, 0.0),
        ("波动率 3x", 3.0, 1.0, 0.0),
        ("波动率 5x + 满仓", 5.0, 1.0, 0.8),
        ("波动率 10x + 满仓", 10.0, 1.0, 1.0),
    ]
    for label, vol, avg, pos in scenarios:
        spread = engine.adaptive_spread(base, vol, avg, pos)
        print(f"  {label:<20}: spread {base:.0f} → {spread:.1f} bps")

    # ── 策略对比表 ──
    print("\n" + STRATEGY_COMPARISON)

    print("\n✅ 演示完成")


if __name__ == "__main__":
    demo()
