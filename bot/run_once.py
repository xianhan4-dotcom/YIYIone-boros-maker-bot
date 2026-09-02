"""
One-shot dry-run for the Boros maker reward model.

Run:
  python -m bot.run_once

It scans rewards, simulates dilution/APR, selects top markets, generates
maker-only orders, and prints the planned actions without live execution. This
entrypoint always overrides BOROS_LIVE_TRADING to dry-run for safety.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from bot.config import LOG_DIR, trading
from bot.monitor.account_monitor import LocalDB, PriceOracle
from bot.scanner.market_scanner import MarketScanner
from bot.trader.auto_trader import AutoTrader


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "run_once.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("bot.run_once")


async def main():
    trading.live_trading = False

    db = LocalDB()
    db.init_schema()
    oracle = PriceOracle()
    scanner = MarketScanner()
    trader = AutoTrader()

    try:
        price = await oracle.get_prices(force_refresh=True)
        db.insert_price(price)
        logger.info(
            "Prices: PENDLE=$%.4f WBTC=$%.2f WETH=$%.2f USDT=$%.4f",
            price.pendle_usd,
            price.token_prices_usd.get(1, 0),
            price.token_prices_usd.get(2, 0),
            price.token_prices_usd.get(3, 0),
        )

        report = await scanner.generate_report(
            pendle_price_usd=price.pendle_usd,
            collateral_prices_usd=price.token_prices_usd,
            force_refresh=True,
        )
        db.insert_market_snapshot(report.simulations[:25])

        print("\n=== Boros Maker Reward Scan ===")
        print(f"Campaigns: {report.campaigns_found}, alive: {report.alive_count}, dead: {report.dead_count}")
        print(f"Live trading: {trading.live_trading}")
        print("\nTop opportunities:")
        for sim in report.simulations[:10]:
            c = sim.campaign
            print(
                f"#{sim.roi_rank:02d} M{c.market_id:<4} {c.underlying}-{c.platform:<14} "
                f"{sim.token_symbol:<5} {sim.side:<5} "
                f"APR {sim.estimated_apr_pct:>9.2f}% "
                f"USD/day {sim.estimated_usd_per_day:>8.4f} "
                f"share {sim.our_share_pct:>6.2f}% "
                f"tick {sim.safe_tick}"
            )

        print("\nSelected markets:")
        for sim in report.selected:
            c = sim.campaign
            print(
                f"M{c.market_id} {c.underlying}-{c.platform} {sim.token_symbol} {sim.side}: "
                f"APR {sim.estimated_apr_pct:.2f}%, levels {sim.levels}, "
                f"est margin ${sim.estimated_initial_margin_usd:.2f}"
            )

        results = await trader.run_cycle(report.selected)
        print("\nGenerated order actions:")
        print(json.dumps(results, ensure_ascii=False, indent=2)[:8000])

    finally:
        await trader.close()
        db.close()


if __name__ == "__main__":
    asyncio.run(main())
