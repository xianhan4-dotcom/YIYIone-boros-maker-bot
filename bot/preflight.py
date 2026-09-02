"""
Live-trading preflight checks for YIYIone.

The checks are deliberately fail-closed. If the bot cannot prove that MCP,
account risk, Boros market data, and maker-only order generation are healthy,
it must not enter the live loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from dataclasses import dataclass, field
from typing import Any

from .alert.email_alert import AlertManager
from .config import ROOT_ADDRESS, TIF_SOFT_ALO, alert, trading
from .mcp_client import BorosMCPClient
from .monitor.account_monitor import AccountMonitor, PriceOracle
from .scanner.market_scanner import MarketScanner, ScannerReport, SimResult
from .trader.auto_trader import AutoTrader

logger = logging.getLogger(__name__)


@dataclass
class PreflightResult:
    ok: bool
    checks: list[dict[str, Any]] = field(default_factory=list)
    report: ScannerReport | None = None
    selected: list[SimResult] = field(default_factory=list)

    @property
    def failures(self) -> list[dict[str, Any]]:
        return [item for item in self.checks if not item.get("ok")]

    def add(self, name: str, ok: bool, message: str, data: dict[str, Any] | None = None):
        self.checks.append({
            "name": name,
            "ok": ok,
            "message": message,
            "data": data or {},
        })

    def summary(self) -> str:
        lines = []
        for item in self.checks:
            prefix = "OK" if item.get("ok") else "FAIL"
            lines.append(f"[{prefix}] {item['name']}: {item['message']}")
        return "\n".join(lines)


def _stringify(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except Exception:
        return str(value)


def _mcp_ready(status: dict[str, Any]) -> bool:
    text = _stringify(status).lower()
    if '"ready": true' in text or '"isready": true' in text:
        return True
    if '"authorized": true' in text or '"enabled": true' in text:
        return True
    return any(word in text for word in ("ready", "active", "authorized"))


class PreflightChecker:
    """Run live-mode readiness checks before autonomous trading."""

    def __init__(
        self,
        scanner: MarketScanner,
        oracle: PriceOracle,
        monitor: AccountMonitor,
        trader: AutoTrader,
        alerts: AlertManager,
    ):
        self.scanner = scanner
        self.oracle = oracle
        self.monitor = monitor
        self.trader = trader
        self.alerts = alerts

    async def run(self) -> PreflightResult:
        result = PreflightResult(ok=False)

        self._check_static_config(result)
        if result.failures:
            result.ok = False
            return result

        await self._check_mcp(result)
        price = await self.oracle.get_prices(force_refresh=True)
        result.add(
            "price_oracle",
            price.pendle_usd > 0 and price.eth_usd > 0,
            f"PENDLE=${price.pendle_usd:.4f}, ETH=${price.eth_usd:.2f}",
            {"pendle_usd": price.pendle_usd, "eth_usd": price.eth_usd},
        )

        snap = await self.monitor.get_account_snapshot()
        if snap is None:
            result.add("account_snapshot", False, "account snapshot unavailable")
        else:
            result.add(
                "gas_balance",
                snap.gas_balance_usd >= trading.min_gas_balance_usd,
                f"${snap.gas_balance_usd:.2f} >= ${trading.min_gas_balance_usd:.2f}",
                {"gas_balance_usd": snap.gas_balance_usd},
            )
            result.add(
                "health_ratio",
                snap.health_ratio >= trading.min_health_ratio,
                f"{snap.health_ratio:.2f} >= {trading.min_health_ratio:.2f}",
                {"health_ratio": snap.health_ratio, "net_balance": snap.net_balance},
            )

        report = await self.scanner.generate_report(
            pendle_price_usd=price.pendle_usd,
            collateral_prices_usd=price.token_prices_usd,
            force_refresh=True,
        )
        result.report = report
        result.selected = report.selected
        result.add(
            "boros_api",
            report.campaigns_found > 0,
            f"{report.campaigns_found} campaigns, {report.alive_count} alive",
            {"campaigns": report.campaigns_found, "alive": report.alive_count},
        )
        result.add(
            "selected_markets",
            len(report.selected) > 0,
            f"{len(report.selected)} selected markets",
            {"selected": [sim.campaign.market_id for sim in report.selected]},
        )
        self._check_quotes(result, report.selected)

        result.ok = not result.failures
        if result.ok:
            logger.info("Preflight passed\n%s", result.summary())
        else:
            logger.critical("Preflight failed\n%s", result.summary())
        return result

    def _check_static_config(self, result: PreflightResult):
        result.add(
            "execution_mode",
            trading.live_trading and trading.use_mcp_execution,
            f"live={trading.live_trading}, mcp={trading.use_mcp_execution}",
        )
        result.add(
            "maker_tif",
            trading.maker_tif == TIF_SOFT_ALO,
            f"tif={trading.maker_tif}, expected={TIF_SOFT_ALO}",
        )
        result.add(
            "root_address",
            bool(ROOT_ADDRESS),
            "configured" if ROOT_ADDRESS else "BOROS_ROOT_ADDRESS missing",
        )
        if trading.require_alert_for_live:
            result.add(
                "alert_channel",
                alert.configured,
                (
                    f"{alert.channel} configured"
                    if alert.configured
                    else f"{alert.channel} alert missing required credentials"
                ),
                {
                    "channel": alert.channel,
                    "telegram_chat_id_set": bool(alert.telegram_chat_id),
                    "telegram_bot_token_set": bool(alert.telegram_bot_token),
                    "email_user_set": bool(alert.smtp_user),
                    "email_pass_set": bool(alert.smtp_pass),
                },
            )

    async def _check_mcp(self, result: PreflightResult):
        if not trading.use_mcp_execution:
            result.add("mcp_agent", False, "BOROS_USE_MCP is disabled")
            return
        client = BorosMCPClient()
        try:
            await client.start()
            status = await client.agent_status()
            ok = _mcp_ready(status)
            result.add(
                "mcp_agent",
                ok,
                "ready" if ok else "agent_status did not report ready",
                {"status": status},
            )
        except Exception as exc:
            result.add("mcp_agent", False, f"MCP unavailable: {exc}")
        finally:
            await client.stop()

    def _check_quotes(self, result: PreflightResult, selected: list[SimResult]):
        order_count = 0
        bad: list[dict[str, Any]] = []
        for sim in selected:
            quotes = self.trader.calculate_safe_quotes(sim.campaign, sim)
            order_count += len(quotes)
            side_info = sim.campaign.side_info(sim.side)
            lower = sim.campaign.mid_apr - side_info.incentive_range
            upper = sim.campaign.mid_apr + side_info.incentive_range
            for quote in quotes:
                rate = float(quote["rate"])
                if quote.get("tif") != TIF_SOFT_ALO or rate < lower or rate > upper:
                    bad.append({
                        "market_id": sim.campaign.market_id,
                        "rate": rate,
                        "lower": lower,
                        "upper": upper,
                        "tif": quote.get("tif"),
                    })

        result.add(
            "maker_order_plan",
            order_count >= trading.preflight_required_order_count and not bad,
            f"{order_count} orders, bad={len(bad)}, required={trading.preflight_required_order_count}",
            {"bad": bad[:5]},
        )


async def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    from .monitor.account_monitor import LocalDB

    db = LocalDB()
    db.init_schema()
    oracle_client = PriceOracle()
    trader = AutoTrader()
    try:
        checker = PreflightChecker(
            scanner=MarketScanner(),
            oracle=oracle_client,
            monitor=AccountMonitor(db),
            trader=trader,
            alerts=AlertManager(),
        )
        result = await checker.run()
        print(result.summary())
        return 0 if result.ok else 2
    finally:
        await trader.close()
        db.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
