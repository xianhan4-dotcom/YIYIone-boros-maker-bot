"""
Part 4: risk controls.

Includes CU budgeting, request pacing, gas-cost estimation, inventory/margin
checks, and loss-threshold signals for email alerts.
"""

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from ..config import LOCK_PATH, rate_limit, trading

logger = logging.getLogger(__name__)


class TradingLock:
    """Persistent manual-unlock state for live trading."""

    def __init__(self, path: Path = LOCK_PATH):
        self.path = path

    def read(self) -> dict | None:
        if not self.path.exists():
            return None
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
        except Exception as exc:
            logger.error("Failed to read trading lock %s: %s", self.path, exc)
            return {
                "locked": True,
                "reason": "lock_file_unreadable",
                "path": str(self.path),
                "error": str(exc),
            }

    def is_locked(self) -> bool:
        data = self.read()
        return bool(data and data.get("locked", True))

    def lock(self, reason: str, alerts: list[dict] | None = None, data: dict | None = None) -> dict:
        payload = {
            "locked": True,
            "timestamp": time.time(),
            "reason": reason,
            "alerts": alerts or [],
            "data": data or {},
            "manual_unlock": "Delete this file only after reviewing risk: bot/data/trading.lock.json",
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        logger.critical("Trading locked: %s", reason)
        return payload

    def clear(self):
        if self.path.exists():
            self.path.unlink()


@dataclass
class CUBudget:
    """CU 预算追踪器"""
    minute_used: float = 0.0
    week_used: float = 0.0
    minute_start: float = field(default_factory=time.time)
    week_start: float = field(default_factory=time.time)
    history: deque = field(default_factory=lambda: deque(maxlen=1000))

    def consume(self, cu: float) -> bool:
        """消耗 CU，返回是否超预算"""
        now = time.time()

        # 重置计数
        if now - self.minute_start > 60:
            self.minute_used = 0
            self.minute_start = now
        if now - self.week_start > 7 * 86400:
            self.week_used = 0
            self.week_start = now

        self.minute_used += cu
        self.week_used += cu
        self.history.append((now, cu))

        if self.minute_used > rate_limit.max_cu_per_minute:
            return False
        if self.week_used > rate_limit.max_cu_per_week * rate_limit.weekly_soft_cap_pct:
            return False
        return True

    def can_afford(self, cu: float) -> bool:
        """检查是否有足够 CU"""
        return (
            self.minute_used + cu <= rate_limit.max_cu_per_minute
            and self.week_used + cu <= rate_limit.max_cu_per_week * rate_limit.weekly_soft_cap_pct
        )

    @property
    def minute_remaining(self) -> float:
        return max(0, rate_limit.max_cu_per_minute - self.minute_used)

    @property
    def week_remaining(self) -> float:
        soft_cap = rate_limit.max_cu_per_week * rate_limit.weekly_soft_cap_pct
        return max(0, soft_cap - self.week_used)


class RateLimiter:
    """API 频率限制器"""

    def __init__(self):
        self.budget = CUBudget()
        self._last_call: float = 0
        self._semaphore = asyncio.Semaphore(rate_limit.max_concurrent)
        self._error_count: int = 0
        self._backoff_until: float = 0
        self._total_cu_consumed: float = 0

    async def acquire(self, cu_cost: float) -> bool:
        """
        获取 CU 配额
        - 自动限速
        - 退避策略 (连续错误)
        - 并发控制
        """
        # Check backoff
        if time.time() < self._backoff_until:
            wait = self._backoff_until - time.time()
            logger.warning(f"Rate limiter in backoff, {wait:.1f}s remaining")
            return False

        # Check budget
        if not self.budget.can_afford(cu_cost):
            logger.warning(
                f"CU budget exceeded: need {cu_cost}, "
                f"remaining min={self.budget.minute_remaining:.0f} "
                f"week={self.budget.week_remaining:.0f}"
            )
            return False

        # Rate limiting (min delay between calls)
        now = time.time()
        min_delay = rate_limit.request_delay_ms / 1000
        elapsed = now - self._last_call
        if elapsed < min_delay:
            await asyncio.sleep(min_delay - elapsed)

        # Acquire semaphore
        async with self._semaphore:
            self.budget.consume(cu_cost)
            self._last_call = time.time()
            self._total_cu_consumed += cu_cost

        return True

    def report_error(self):
        """报告 API 错误，触发退避"""
        self._error_count += 1
        if self._error_count >= 5:
            backoff = min(30 * (2 ** (self._error_count - 5)), 300)
            self._backoff_until = time.time() + backoff
            logger.error(f"Too many errors, backing off {backoff}s")

    def report_success(self):
        """报告成功，重置错误计数"""
        self._error_count = 0
        self._backoff_until = 0

    @property
    def stats(self) -> dict:
        return {
            "total_cu_consumed": self._total_cu_consumed,
            "minute_remaining": self.budget.minute_remaining,
            "week_remaining": self.budget.week_remaining,
            "error_count": self._error_count,
            "in_backoff": time.time() < self._backoff_until,
        }


# ═══════════════════════════════════════════════════════
# Gas 估算模型
# ═══════════════════════════════════════════════════════

@dataclass
class GasEstimate:
    """Gas 估算"""
    operation: str
    estimated_gas: int
    eth_price_usd: float = 3000
    arb_gas_price_gwei: float = 0.1  # Arbitrum 通常 <0.1 Gwei

    @property
    def cost_usd(self) -> float:
        """估算 USD 成本"""
        eth_cost = self.estimated_gas * self.arb_gas_price_gwei * 1e-9
        return eth_cost * self.eth_price_usd


class GasModel:
    """Gas 费估算模型"""

    # 基于 Arbitrum 平均 gas 消耗 (实测值)
    GAS_COSTS = {
        "approve_agent": 120_000,
        "deposit": 200_000,
        "place_single_order": 250_000,
        "bulk_orders_2": 350_000,
        "bulk_orders_5": 500_000,
        "cancel_order": 150_000,
        "cancel_all": 200_000,
        "enter_market": 180_000,
        "exit_market": 160_000,
    }

    def __init__(self, eth_price_usd: float = 3000):
        self.eth_price_usd = eth_price_usd

    def estimate(self, operation: str, n_orders: int = 1) -> GasEstimate:
        """估算单次操作 Gas 费"""
        base_gas = self.GAS_COSTS.get(operation, 200_000)
        if operation == "bulk_orders" and n_orders > 1:
            base_gas = min(
                self.GAS_COSTS.get(f"bulk_orders_{n_orders}", 200_000 + 80_000 * n_orders),
                800_000
            )

        return GasEstimate(
            operation=operation,
            estimated_gas=base_gas,
            eth_price_usd=self.eth_price_usd,
        )

    def estimate_daily_gas(
        self,
        n_markets: int,
        refresh_interval_sec: int = None,
    ) -> float:
        """估算每日 Gas 总成本"""
        if refresh_interval_sec is None:
            refresh_interval_sec = trading.order_refresh_sec

        refreshes_per_day = 86400 / refresh_interval_sec
        # 每次刷新: cancel_all + bulk_orders
        cost_per_refresh = (
            self.estimate("cancel_all").cost_usd
            + self.estimate("bulk_orders", n_markets * 2).cost_usd
        )

        daily_cost = refreshes_per_day * cost_per_refresh
        return daily_cost

    def validate_budget(self, daily_gas_estimate: float) -> tuple[bool, str]:
        """验证 Gas 是否在预算内"""
        if daily_gas_estimate > trading.daily_gas_budget_usd:
            return False, (
                f"Gas over budget: ${daily_gas_estimate:.2f}/day > "
                f"${trading.daily_gas_budget_usd:.2f} budget"
            )
        return True, f"Gas OK: ${daily_gas_estimate:.2f}/day"


# ═══════════════════════════════════════════════════════
# 仓位风控
# ═══════════════════════════════════════════════════════

class PositionRiskManager:
    """仓位风险管理器"""

    def __init__(self):
        self._total_realized_pnl: float = 0
        self._max_position_ever: float = 0
        self._liquidation_warnings: int = 0

    def check_thresholds(
        self,
        positions: list,
        total_capital: float,
        accumulated_pnl: float,
        account_snapshot=None,
    ) -> list[dict]:
        """
        风险阈值检查
        
        Returns:
            alerts: 触发的告警列表
        """
        alerts = []

        # 1. 总持仓检查: prefer notional if the API provides it, fallback to size.
        total_position = 0.0
        for p in positions:
            if hasattr(p, "notional_usd") and p.notional_usd:
                total_position += abs(p.notional_usd)
            elif hasattr(p, "size"):
                total_position += abs(p.size)
        if total_position > trading.max_position_usd:
            alerts.append({
                "type": "POSITION_EXCEEDED",
                "severity": "CRITICAL",
                "message": f"Total position ${total_position:.0f} > max ${trading.max_position_usd:.0f}",
                "action": "CLOSE_ALL",
            })

        # 2. 止损检查
        if accumulated_pnl < -trading.stop_loss_pct * total_capital:
            alerts.append({
                "type": "STOP_LOSS",
                "severity": "CRITICAL",
                "message": f"Loss ${-accumulated_pnl:.0f} > stop loss ${trading.stop_loss_pct*total_capital:.0f}",
                "action": "STOP_ALL_TRADING",
            })

        # 3. 保证金/health 检查
        margin_ratio = None
        if account_snapshot is not None:
            if getattr(account_snapshot, "health_ratio", 0) > 0:
                margin_ratio = account_snapshot.health_ratio
            elif getattr(account_snapshot, "initial_margin", 0) > 0:
                margin_ratio = account_snapshot.available_margin / account_snapshot.initial_margin
        if margin_ratio is not None and margin_ratio < trading.min_health_ratio:
            alerts.append({
                "type": "LOW_MARGIN",
                "severity": "HIGH",
                "message": f"Health ratio {margin_ratio:.2f} < {trading.min_health_ratio:.2f}",
                "action": "CANCEL_RISKY_ORDERS",
            })

        # 4. Gas balance check.
        if account_snapshot is not None:
            gas_balance = getattr(account_snapshot, "gas_balance_usd", 0.0)
            if gas_balance < trading.min_gas_balance_usd:
                alerts.append({
                    "type": "LOW_GAS",
                    "severity": "HIGH",
                    "message": f"Gas balance ${gas_balance:.2f} < ${trading.min_gas_balance_usd:.2f}",
                    "action": "TOP_UP_GAS",
                })

        return alerts

    def record_pnl(self, realized_pnl: float):
        """记录已实现盈亏"""
        self._total_realized_pnl += realized_pnl

    @property
    def total_pnl(self) -> float:
        return self._total_realized_pnl
