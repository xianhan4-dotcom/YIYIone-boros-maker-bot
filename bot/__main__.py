#!/usr/bin/env python3
"""
Boros Maker Reward Bot — Main Runner
═══════════════════════════════════════════════════════════
自动化做市机器人主入口

运行:
  python -m bot

功能:
  1. Scan campaigns -> rank diluted APR -> filter dead pools
  2. Monitor account -> cache prices -> persist local history
  3. Maker-only quoting -> post-only orders -> follow mid drift
  4. Risk controls -> CU budget -> gas model -> email alerts
"""

import asyncio
import json
import logging
import signal
import sys
import time
from pathlib import Path

# Add project root
sys.path.insert(0, str(Path(__file__).parent.parent))

from bot.config import LOCK_PATH, trading, LOG_DIR
from bot.scanner.market_scanner import MarketScanner
from bot.monitor.account_monitor import (
    AccountMonitor, PriceOracle, LocalDB, StabilityAnalyzer,
)
from bot.trader.auto_trader import AutoTrader
from bot.risk.risk_manager import RateLimiter, GasModel, PositionRiskManager, TradingLock
from bot.alert.email_alert import AlertManager
from bot.preflight import PreflightChecker

# ═══════════════════════════════════════════════════════
# Logging Setup
# ═══════════════════════════════════════════════════════

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "bot.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("bot")


def json_dumps_safe(data) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)


class BorosBot:
    """Boros Maker Reward Bot 主控制器"""

    def __init__(self):
        self.scanner = MarketScanner()
        self.oracle = PriceOracle()
        self.db = LocalDB()
        self.monitor = AccountMonitor(self.db)
        self.trader = AutoTrader()
        self.rate_limiter = RateLimiter()
        self.gas_model = GasModel()
        self.risk_mgr = PositionRiskManager()
        self.lock = TradingLock()
        self.alerts = AlertManager()
        self.analyzer = StabilityAnalyzer(self.db)

        self._running = False
        self._selected_markets: list = []
        self._daily_gas: float = 0
        self._cycle_count: int = 0

    # ═══════════════════════════════════════════════════
    # Lifecycle
    # ═══════════════════════════════════════════════════

    async def start(self):
        """启动机器人"""
        logger.info("=" * 60)
        logger.info("Boros Maker Reward Bot Starting...")
        logger.info("=" * 60)

        # 初始化数据库
        self.db.init_schema()
        logger.info(f"Database initialized: {self.db.db_path}")

        locked = self.lock.read()
        if locked:
            message = f"Trading lock exists at {LOCK_PATH}: {locked.get('reason', 'unknown')}"
            logger.critical(message)
            await self.alerts.send(
                subject="Trading locked - manual review required",
                body=message,
                alert_type="TRADING_LOCKED",
                severity="CRITICAL",
                bypass_cooldown=True,
            )
            return

        preflight = PreflightChecker(
            scanner=self.scanner,
            oracle=self.oracle,
            monitor=self.monitor,
            trader=self.trader,
            alerts=self.alerts,
        )
        preflight_result = await preflight.run()
        if not preflight_result.ok:
            await self.alerts.send(
                subject="Preflight failed - live loop not started",
                body=preflight_result.summary(),
                alert_type="PREFLIGHT_FAILED",
                severity="CRITICAL",
                bypass_cooldown=True,
            )
            self.db.log_event(
                "PREFLIGHT_FAILED",
                preflight_result.summary(),
                severity="CRITICAL",
                data={"checks": preflight_result.checks},
            )
            return

        self._selected_markets = preflight_result.selected
        if preflight_result.report:
            self.db.insert_market_snapshot(preflight_result.report.simulations[:25])

        # 获取初始价格
        price = await self.oracle.get_prices()
        self.db.insert_price(price)
        self.gas_model.eth_price_usd = price.eth_usd
        logger.info(
            f"Price oracle: PENDLE=${price.pendle_usd:.2f} "
            f"ETH=${price.eth_usd:.0f} BTC=${price.btc_usd:.0f}"
        )

        # 信号处理
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, self._handle_signal)

        self._running = True

        # 启动主循环
        await self._main_loop()
        await self.stop()

    async def stop(self):
        """停止机器人"""
        logger.info("Stopping bot...")
        self._running = False

        # 取消所有挂单
        for market_id in self.trader.get_active_markets():
            try:
                await self.trader.cancel_all_orders(market_id)
                logger.info(f"Cancelled orders for market {market_id}")
            except Exception as e:
                logger.error(f"Failed to cancel orders for {market_id}: {e}")

        await self.trader.close()
        self.db.close()
        logger.info("Bot stopped.")

    def _handle_signal(self, signum, frame):
        """信号处理"""
        logger.info(f"Received signal {signum}")
        asyncio.create_task(self.stop())

    # ═══════════════════════════════════════════════════
    # Main Loop
    # ═══════════════════════════════════════════════════

    async def _main_loop(self):
        """主循环"""
        last_scan = 0
        last_monitor = 0
        last_order_refresh = 0
        last_health_report = 0
        last_price_update = 0

        while self._running:
            now = time.time()
            self._cycle_count += 1

            try:
                if self.lock.is_locked():
                    logger.critical("Trading lock detected during runtime; exiting loop")
                    self._running = False
                    break

                # ── Phase 1: 市场扫描 ─────────────────
                if now - last_scan >= trading.scan_interval_sec:
                    await self._phase_scan()
                    last_scan = now

                # ── Phase 2: 价格更新 ─────────────────
                if now - last_price_update >= 300:  # 5 min
                    await self._phase_price_update()
                    last_price_update = now

                # ── Phase 3: 账户监控 ─────────────────
                if now - last_monitor >= trading.monitor_interval_sec:
                    await self._phase_monitor()
                    last_monitor = now

                # ── Phase 4: 自动做市 ─────────────────
                if now - last_order_refresh >= trading.order_refresh_sec:
                    await self._phase_trade()
                    last_order_refresh = now

                # ── Phase 5: 健康报告 ─────────────────
                if now - last_health_report >= 21600:  # 6 hours
                    await self._phase_health_report()
                    last_health_report = now

            except Exception as e:
                logger.error(f"Main loop error: {e}", exc_info=True)
                self.rate_limiter.report_error()
                await self.alerts.alert_api_errors(self.rate_limiter._error_count)

            # 休息
            await asyncio.sleep(1)

    # ═══════════════════════════════════════════════════
    # Phases
    # ═══════════════════════════════════════════════════

    async def _phase_scan(self):
        """Phase 1: 市场扫描 & 模拟 & 过滤"""
        if not await self.rate_limiter.acquire(25):  # paginated markets + selected campaigns
            logger.warning("CU budget exhausted, skipping scan")
            return

        logger.info("─" * 40)
        logger.info("Phase 1: Market Scan")

        price = self.oracle.get_cached()
        if price is None:
            price = await self.oracle.get_prices()
            self.db.insert_price(price)

        report = await self.scanner.generate_report(
            pendle_price_usd=price.pendle_usd,
            collateral_prices_usd=price.token_prices_usd,
        )

        logger.info(
            f"Campaigns: {report.campaigns_found} found, "
            f"{report.alive_count} alive, {report.dead_count} dead"
        )

        for dead in report.dead_pools[:5]:
            logger.info(f"  [DEAD] Market {dead.market_id} {dead.underlying}-{dead.platform}: {dead.death_reason}")

        self.db.insert_market_snapshot(report.simulations[:25])

        self._selected_markets = report.selected

        logger.info(f"\n{'='*80}")
        logger.info(f"{'#':<3} {'Market':<25} {'Tok':<5} {'Side':>6} {'PENDLE/d':>10} {'USD/d':>10} {'APR':>9} {'Share':>7}")
        logger.info(f"{'='*80}")
        for sim in report.simulations[:10]:
            c = sim.campaign
            logger.info(
                f"{sim.roi_rank:<3} {c.underlying}-{c.platform:<19} "
                f"{sim.token_symbol:<5} {sim.side:>6} "
                f"{sim.estimated_pendle_per_day:>9.4f} "
                f"${sim.estimated_usd_per_day:>9.2f} "
                f"{sim.estimated_apr_pct:>8.1f}% "
                f"{sim.our_share_pct:>6.2f}%"
            )
        if self._selected_markets:
            logger.info("Selected maker markets:")
            for sim in self._selected_markets:
                c = sim.campaign
                logger.info(
                    "  M%s %s-%s %s %s: APR %.1f%%, safe tick %s, levels %s, alloc margin ~$%.2f",
                    c.market_id,
                    c.underlying,
                    c.platform,
                    sim.token_symbol,
                    sim.side,
                    sim.estimated_apr_pct,
                    sim.safe_tick,
                    sim.levels,
                    sim.estimated_initial_margin_usd,
                )
        else:
            logger.warning("No markets passed ROI and risk filters")
        logger.info(f"{'='*80}")

        self.rate_limiter.report_success()

    async def _phase_price_update(self):
        """Phase 2: 价格更新"""
        if not await self.rate_limiter.acquire(1):
            return

        price = await self.oracle.get_prices(force_refresh=True)
        self.db.insert_price(price)
        self.gas_model.eth_price_usd = price.eth_usd

        logger.debug(
            f"Prices: PENDLE=${price.pendle_usd:.3f} "
            f"({price.pendle_usd_24h_change:+.1f}%) "
            f"ETH=${price.eth_usd:.0f}"
        )

    async def _phase_monitor(self):
        """Phase 3: 账户监控"""
        if not await self.rate_limiter.acquire(2):
            return

        # 账户快照
        snap = await self.monitor.get_account_snapshot()
        if snap:
            if self._selected_markets:
                market_ids = [sim.campaign.market_id for sim in self._selected_markets]
                snap.accumulated_reward_pendle = await self.monitor.get_accumulated_rewards(market_ids)
            self.db.insert_account_snapshot(snap)
            logger.debug(
                f"Account: balance=${snap.net_balance:.4f} "
                f"positions={snap.position_count} gas=${snap.gas_balance_usd:.2f} "
                f"health={snap.health_ratio:.2f} rewards={snap.accumulated_reward_pendle:.6f} PENDLE"
            )

            # 风控检查
            positions = await self.monitor.get_positions()
            alerts = self.risk_mgr.check_thresholds(
                positions,
                max(snap.net_balance, sum(trading.capital_by_token_usd.values())),
                self.risk_mgr.total_pnl,
                account_snapshot=snap,
            )
            alerts.sort(key=lambda item: 0 if item.get("severity") == "CRITICAL" else 1)
            for a in alerts:
                logger.warning(f"[{a['severity']}] {a['message']}")
                if a["type"] == "STOP_LOSS":
                    await self.alerts.alert_loss_threshold(
                        -self.risk_mgr.total_pnl,
                        max(snap.net_balance, 1),
                    )
                elif a["type"] == "POSITION_EXCEEDED":
                    await self.alerts.alert_position_exceeded(
                        sum(abs(getattr(p, "notional_usd", 0) or getattr(p, "size", 0)) for p in positions),
                        trading.max_position_usd,
                    )
                else:
                    await self.alerts.send(
                        subject=a["type"],
                        body=a["message"],
                        alert_type=a["type"],
                        severity=a["severity"],
                    )
            critical_alerts = [a for a in alerts if a.get("severity") == "CRITICAL"]
            if critical_alerts:
                await self._handle_critical_alerts(critical_alerts, positions, snap)
                return

        # 稳定性分析 (每小时)
        if self._cycle_count % 60 == 0:
            analysis = self.analyzer.analyze(hours=24)
            if analysis["status"] == "ok":
                logger.info(
                    f"Stability: PnL=${analysis['total_pnl_usd']:.2f} "
                    f"Sharpe={analysis['annualized_sharpe']:.2f} "
                    f"WinRate={analysis['win_rate_pct']:.1f}% "
                    f"MaxDD={analysis['max_drawdown_pct']:.2f}%"
                )

    async def _phase_trade(self):
        """Phase 4: 自动做市"""
        if self.lock.is_locked():
            logger.critical("Trading is locked; skipping order refresh")
            self._running = False
            return

        if not self._selected_markets:
            logger.debug("No markets selected for trading")
            return

        # CU 预算检查 (下单很贵)
        cu_needed = len(self._selected_markets) * 15
        if not await self.rate_limiter.acquire(cu_needed):
            logger.warning("CU budget insufficient for trading")
            return

        # Gas 预算检查
        daily_gas = self.gas_model.estimate_daily_gas(
            len(self._selected_markets),
            trading.order_refresh_sec,
        )
        ok, msg = self.gas_model.validate_budget(daily_gas)
        if not ok:
            logger.warning(msg)
            await self.alerts.alert_gas_overrun(daily_gas, trading.daily_gas_budget_usd)

        logger.debug(f"Refreshing orders for {len(self._selected_markets)} markets...")

        results = await self.trader.run_cycle(self._selected_markets)
        placed = sum(1 for r in results if r["status"] in {"placed", "dry_run", "executed"})
        skipped = sum(1 for r in results if r["status"] == "skip")
        errors = sum(1 for r in results if r["status"] == "error")

        if placed > 0:
            logger.info(f"Orders: {placed} placed, {skipped} skipped, {errors} errors")
            for result in results:
                if result["status"] == "dry_run":
                    logger.info("  Dry-run M%s: %s orders", result.get("market_id"), len(result.get("orders", [])))
        if errors > 0:
            for r in results:
                if r["status"] == "error":
                    logger.error(f"  Market {r.get('market_id')}: {r.get('reason')}")

        self._daily_gas += daily_gas / (86400 / trading.order_refresh_sec)

    async def _handle_critical_alerts(self, alerts: list[dict], positions: list, snap):
        """Critical risk flow: stop orders, cancel makers, optional taker close, lock."""
        logger.critical("Critical risk triggered; stopping new maker orders")
        self.db.log_event(
            "CRITICAL_RISK",
            "\n".join(a.get("message", "") for a in alerts),
            severity="CRITICAL",
            data={"alerts": alerts},
        )

        market_ids = set(self.trader.get_active_markets())
        market_ids.update(sim.campaign.market_id for sim in self._selected_markets)
        market_ids.update(int(getattr(pos, "market_id", 0) or 0) for pos in positions)
        cancel_results = []
        for market_id in sorted(mid for mid in market_ids if mid > 0):
            try:
                result = await self.trader.cancel_all_orders(market_id)
                cancel_results.append(result)
                self.db.insert_order_action("cancel_all_critical", market_id, result.get("status", "unknown"), data=result)
                logger.critical("Cancelled active maker orders for market %s", market_id)
            except Exception as exc:
                logger.critical("Failed to cancel maker orders for market %s: %s", market_id, exc)
                cancel_results.append({"status": "error", "market_id": market_id, "reason": str(exc)})

        close_results = []
        position_risk = sum(abs(getattr(p, "notional_usd", 0) or getattr(p, "size", 0)) for p in positions)
        if position_risk > 0 and trading.allow_emergency_taker:
            close_results = await self.trader.emergency_close_positions(positions)
            for item in close_results:
                self.db.insert_order_action(
                    "emergency_close",
                    int(item.get("market_id") or 0),
                    item.get("status", "unknown"),
                    data=item,
                )
        elif position_risk > 0:
            logger.critical("Emergency taker close skipped; BOROS_ALLOW_EMERGENCY_TAKER is disabled")

        lock_payload = self.lock.lock(
            reason="critical_risk_triggered",
            alerts=alerts,
            data={
                "gas_balance_usd": getattr(snap, "gas_balance_usd", None),
                "health_ratio": getattr(snap, "health_ratio", None),
                "position_risk": position_risk,
                "cancel_results": cancel_results,
                "close_results": close_results,
            },
        )
        await self.alerts.send(
            subject="Critical risk lock - trading stopped",
            body=json_dumps_safe(lock_payload),
            alert_type="CRITICAL_RISK_LOCK",
            severity="CRITICAL",
            bypass_cooldown=True,
        )
        self._running = False

    async def _phase_health_report(self):
        """Phase 5: 健康报告 + 邮件通知"""
        stats = self.db.get_stats(hours=24)
        await self.alerts.alert_system_health({
            "pnl": stats.get("pnl_usd", 0),
            "active_markets": len(self._selected_markets),
            "gas_today": self._daily_gas,
            "api_errors": self.rate_limiter._error_count,
            "cu_consumed": self.rate_limiter._total_cu_consumed,
        })


# ═══════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════

async def main():
    bot = BorosBot()
    try:
        await bot.start()
    except KeyboardInterrupt:
        await bot.stop()
    except Exception as e:
        logger.critical(f"Fatal error: {e}", exc_info=True)
        await bot.stop()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
