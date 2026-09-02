"""
Part 2: account monitor, oracle cache, SQLite history, and stability analysis.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import aiohttp

from ..config import (
    BOROS_API_KEY,
    BOROS_OPEN_API,
    CROSS_MARKET_ID,
    DB_PATH,
    ROOT_ADDRESS,
    oracle,
    rate_limit,
    trading,
)

logger = logging.getLogger(__name__)


def _f(value: Any, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _fixed18(value: Any) -> float:
    raw = _f(value, 0.0)
    if abs(raw) > 1e12:
        return raw / 1e18
    return raw


@dataclass
class AccountSnapshot:
    timestamp: float
    total_cash: float
    net_balance: float
    available_margin: float
    initial_margin: float
    maintenance_margin: float
    available_maint_margin: float
    health_ratio: float
    position_count: int
    total_position_value: float
    unrealized_pnl: float
    accumulated_reward_pendle: float
    gas_balance_usd: float
    accounts: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class PositionInfo:
    market_id: int
    side: str
    size: float
    notional_usd: float
    entry_rate: float
    current_mark: float
    unrealized_pnl: float
    settlement_pnl: float


@dataclass
class PriceFeed:
    pendle_usd: float
    pendle_usd_24h_change: float
    eth_usd: float
    btc_usd: float
    token_prices_usd: dict[int, float]
    timestamp: float


class LocalDB:
    """Small SQLite warehouse for local reward and risk analysis."""

    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(str(self.db_path))
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
        return self._conn

    def _ensure_column(self, table: str, column: str, decl: str):
        existing = {
            row["name"]
            for row in self.conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if column not in existing:
            self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")

    def init_schema(self):
        c = self.conn
        c.execute("""
            CREATE TABLE IF NOT EXISTS market_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                market_id INTEGER NOT NULL,
                token_id INTEGER,
                token_symbol TEXT,
                underlying TEXT,
                platform TEXT,
                side TEXT,
                mid_apr REAL,
                mark_apr REAL,
                budget_per_hour REAL,
                capped_distribution_per_hour REAL,
                inrange_yu REAL,
                incentive_range REAL,
                reward_per_yu_day REAL,
                volume_24h REAL,
                days_to_maturity REAL,
                simulated_apr_pct REAL,
                estimated_usd_per_day REAL,
                our_share_pct REAL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS account_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                total_cash REAL,
                net_balance REAL,
                available_margin REAL,
                initial_margin REAL,
                maintenance_margin REAL,
                available_maint_margin REAL,
                health_ratio REAL,
                position_count INTEGER,
                total_position_value REAL,
                unrealized_pnl REAL,
                accumulated_reward_pendle REAL,
                gas_balance_usd REAL,
                raw_json TEXT
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS price_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                pendle_usd REAL,
                eth_usd REAL,
                btc_usd REAL,
                wbtc_usd REAL,
                weth_usd REAL,
                usdt_usd REAL,
                raw_json TEXT
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS reward_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                market_id INTEGER,
                side TEXT,
                pendle_earned REAL,
                usd_value REAL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS event_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                event_type TEXT NOT NULL,
                severity TEXT DEFAULT 'INFO',
                market_id INTEGER,
                message TEXT,
                data TEXT
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS order_actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                action TEXT,
                market_id INTEGER,
                status TEXT,
                tx_hash TEXT,
                data TEXT
            )
        """)
        for table in ("market_snapshots", "account_snapshots", "price_snapshots", "event_log"):
            c.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_ts ON {table}(timestamp)")
        self.conn.commit()

    def insert_market_snapshot(self, simulations: list):
        now = time.time()
        rows = []
        for sim in simulations:
            c = sim.campaign
            side = c.side_info(sim.side)
            rows.append((
                now,
                c.market_id,
                c.token_id,
                c.token_symbol,
                c.underlying,
                c.platform,
                sim.side,
                c.mid_apr,
                c.mark_apr,
                side.budget_per_hour,
                side.capped_distribution_per_hour,
                side.current_inrange_yu,
                side.incentive_range,
                side.pendle_per_yu_day,
                c.volume_24h,
                c.days_to_maturity,
                sim.estimated_apr_pct,
                sim.estimated_usd_per_day,
                sim.our_share_pct,
            ))
        if not rows:
            return
        self.conn.executemany("""
            INSERT INTO market_snapshots
            (timestamp, market_id, token_id, token_symbol, underlying, platform,
             side, mid_apr, mark_apr, budget_per_hour,
             capped_distribution_per_hour, inrange_yu, incentive_range,
             reward_per_yu_day, volume_24h, days_to_maturity,
             simulated_apr_pct, estimated_usd_per_day, our_share_pct)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, rows)
        self.conn.commit()

    def insert_account_snapshot(self, snap: AccountSnapshot):
        self.conn.execute("""
            INSERT INTO account_snapshots
            (timestamp, total_cash, net_balance, available_margin, initial_margin,
             maintenance_margin, available_maint_margin, health_ratio,
             position_count, total_position_value, unrealized_pnl,
             accumulated_reward_pendle, gas_balance_usd, raw_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            snap.timestamp,
            snap.total_cash,
            snap.net_balance,
            snap.available_margin,
            snap.initial_margin,
            snap.maintenance_margin,
            snap.available_maint_margin,
            snap.health_ratio,
            snap.position_count,
            snap.total_position_value,
            snap.unrealized_pnl,
            snap.accumulated_reward_pendle,
            snap.gas_balance_usd,
            json.dumps(snap.accounts, ensure_ascii=False),
        ))
        self.conn.commit()

    def insert_price(self, price: PriceFeed):
        self.conn.execute("""
            INSERT INTO price_snapshots
            (timestamp, pendle_usd, eth_usd, btc_usd, wbtc_usd, weth_usd, usdt_usd, raw_json)
            VALUES (?,?,?,?,?,?,?,?)
        """, (
            price.timestamp,
            price.pendle_usd,
            price.eth_usd,
            price.btc_usd,
            price.token_prices_usd.get(1, price.btc_usd),
            price.token_prices_usd.get(2, price.eth_usd),
            price.token_prices_usd.get(3, 1.0),
            json.dumps(price.token_prices_usd),
        ))
        self.conn.commit()

    def insert_order_action(self, action: str, market_id: int, status: str, tx_hash: str = "", data: dict = None):
        self.conn.execute("""
            INSERT INTO order_actions (timestamp, action, market_id, status, tx_hash, data)
            VALUES (?,?,?,?,?,?)
        """, (
            time.time(),
            action,
            market_id,
            status,
            tx_hash,
            json.dumps(data or {}, ensure_ascii=False),
        ))
        self.conn.commit()

    def log_event(
        self,
        event_type: str,
        message: str,
        severity: str = "INFO",
        market_id: int = None,
        data: dict = None,
    ):
        self.conn.execute("""
            INSERT INTO event_log (timestamp, event_type, severity, market_id, message, data)
            VALUES (?,?,?,?,?,?)
        """, (
            time.time(),
            event_type,
            severity,
            market_id,
            message,
            json.dumps(data or {}, ensure_ascii=False),
        ))
        self.conn.commit()

    def get_stats(self, hours: int = 24) -> dict:
        since = time.time() - hours * 3600
        events = self.conn.execute(
            "SELECT severity, COUNT(*) AS cnt FROM event_log WHERE timestamp > ? GROUP BY severity",
            (since,),
        ).fetchall()
        first = self.conn.execute(
            "SELECT net_balance FROM account_snapshots WHERE timestamp > ? ORDER BY timestamp ASC LIMIT 1",
            (since,),
        ).fetchone()
        last = self.conn.execute(
            "SELECT net_balance FROM account_snapshots WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 1",
            (since,),
        ).fetchone()
        pnl = (last["net_balance"] - first["net_balance"]) if first and last else 0.0
        return {
            "period_hours": hours,
            "pnl_usd": pnl,
            "events": {row["severity"]: row["cnt"] for row in events},
        }

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None


class PriceOracle:
    """CoinGecko primary, Boros /assets/all fallback."""

    def __init__(self):
        self._cache: Optional[PriceFeed] = None
        self._cache_time = 0.0

    async def get_prices(self, force_refresh: bool = False) -> PriceFeed:
        now = time.time()
        if self._cache and not force_refresh and now - self._cache_time < oracle.cache_ttl_sec:
            return self._cache

        token_prices = dict(trading.default_collateral_prices)
        pendle_usd = oracle.default_pendle_usd
        pendle_change = 0.0
        eth_usd = token_prices.get(2, 1600.0)
        btc_usd = token_prices.get(1, 60000.0)

        async with aiohttp.ClientSession() as session:
            try:
                async with session.get(
                    f"{oracle.coingecko_api}/simple/price",
                    params={
                        "ids": "pendle,ethereum,bitcoin,tether",
                        "vs_currencies": "usd",
                        "include_24hr_change": "true",
                    },
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        pendle_usd = _f(data.get("pendle", {}).get("usd"))
                        pendle_change = _f(data.get("pendle", {}).get("usd_24h_change"))
                        eth_usd = _f(data.get("ethereum", {}).get("usd"), eth_usd)
                        btc_usd = _f(data.get("bitcoin", {}).get("usd"), btc_usd)
                        token_prices[1] = btc_usd
                        token_prices[2] = eth_usd
                        token_prices[3] = _f(data.get("tether", {}).get("usd"), 1.0)
            except Exception as exc:
                logger.warning("CoinGecko price fetch failed: %s", exc)

            try:
                headers = {"Authorization": f"Bearer {BOROS_API_KEY}"} if BOROS_API_KEY else {}
                async with session.get(
                    f"{BOROS_OPEN_API}/v1/assets/all",
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=rate_limit.timeout_sec),
                ) as resp:
                    if resp.status == 200:
                        assets = await resp.json()
                        self._apply_boros_asset_prices(assets, token_prices)
            except Exception as exc:
                logger.debug("Boros assets fallback failed: %s", exc)

        if token_prices.get(1, 0) > 0:
            btc_usd = token_prices[1]
        if token_prices.get(2, 0) > 0:
            eth_usd = token_prices[2]

        self._cache = PriceFeed(
            pendle_usd=max(pendle_usd, oracle.default_pendle_usd if oracle.default_pendle_usd > 0 else 0.01),
            pendle_usd_24h_change=pendle_change,
            eth_usd=max(eth_usd, 100.0),
            btc_usd=max(btc_usd, 1000.0),
            token_prices_usd=token_prices,
            timestamp=now,
        )
        self._cache_time = now
        return self._cache

    def _apply_boros_asset_prices(self, assets: dict[str, Any], token_prices: dict[int, float]):
        results = assets.get("results") if isinstance(assets, dict) else assets
        if not isinstance(results, list):
            return
        for item in results:
            token_id = item.get("tokenId") or item.get("id")
            symbol = str(item.get("symbol") or item.get("name") or "").upper()
            price = _f(
                item.get("price")
                or item.get("priceUsd")
                or item.get("usdPrice")
                or item.get("valueInUSD")
            )
            if price <= 0:
                continue
            if token_id is not None:
                try:
                    token_prices[int(token_id)] = price
                    continue
                except (TypeError, ValueError):
                    pass
            if "WBTC" in symbol or symbol == "BTC":
                token_prices[1] = price
            elif "WETH" in symbol or symbol == "ETH":
                token_prices[2] = price
            elif "USDT" in symbol or "USD" in symbol:
                token_prices[3] = price

    def get_cached(self) -> Optional[PriceFeed]:
        if self._cache and time.time() - self._cache_time < oracle.cache_ttl_sec * 2:
            return self._cache
        return None


class AccountMonitor:
    """Boros account state monitor."""

    def __init__(self, db: LocalDB = None):
        self.db = db or LocalDB()
        self.api_url = BOROS_OPEN_API
        self._market_acc_cache: dict[int, str] = {}

    async def _get_json(self, session: aiohttp.ClientSession, path: str, params: dict = None) -> Optional[dict]:
        headers = {"Authorization": f"Bearer {BOROS_API_KEY}"} if BOROS_API_KEY else {}
        try:
            async with session.get(
                f"{self.api_url}{path}",
                params=params,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=rate_limit.timeout_sec),
            ) as resp:
                if resp.status != 200:
                    logger.debug("GET %s failed: %s %s", path, resp.status, await resp.text())
                    return None
                return await resp.json()
        except Exception as exc:
            logger.debug("GET %s failed: %s", path, exc)
            return None

    async def _post_json(self, session: aiohttp.ClientSession, path: str, body: dict) -> Optional[dict]:
        headers = {"Authorization": f"Bearer {BOROS_API_KEY}"} if BOROS_API_KEY else {}
        try:
            async with session.post(
                f"{self.api_url}{path}",
                json=body,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=rate_limit.timeout_sec),
            ) as resp:
                if resp.status != 200:
                    logger.debug("POST %s failed: %s %s", path, resp.status, await resp.text())
                    return None
                return await resp.json()
        except Exception as exc:
            logger.debug("POST %s failed: %s", path, exc)
            return None

    async def encode_market_acc(self, session: aiohttp.ClientSession, token_id: int) -> Optional[str]:
        if token_id in self._market_acc_cache:
            return self._market_acc_cache[token_id]
        if not ROOT_ADDRESS:
            return None
        data = await self._get_json(
            session,
            "/v1/market-acc/encode",
            {
                "root": ROOT_ADDRESS,
                "accountId": 0,
                "tokenId": token_id,
                "marketId": CROSS_MARKET_ID,
            },
        )
        market_acc = data.get("marketAcc") if data else None
        if market_acc:
            self._market_acc_cache[token_id] = market_acc
        return market_acc

    async def get_market_accs(self, session: aiohttp.ClientSession) -> list[str]:
        accs: list[str] = []
        for token_id in trading.capital_by_token_usd:
            market_acc = await self.encode_market_acc(session, token_id)
            if market_acc:
                accs.append(market_acc)
        return accs

    async def get_account_snapshot(self) -> Optional[AccountSnapshot]:
        if not ROOT_ADDRESS:
            logger.error("BOROS_ROOT_ADDRESS is not configured")
            return None

        async with aiohttp.ClientSession() as session:
            market_accs = await self.get_market_accs(session)
            if not market_accs:
                return None
            data = await self._post_json(
                session,
                "/v1/accounts/market-acc-infos",
                {"marketAccs": market_accs},
            )
            results = data.get("results", []) if isinstance(data, dict) else []

            gas_balance = 0.0
            gas_data = await self._get_json(
                session,
                "/v1/accounts/gas-balance",
                {"root": ROOT_ADDRESS},
            )
            if gas_data:
                gas_balance = _f(gas_data.get("balanceInUSD", gas_data.get("balance")))

        total_cash = sum(_fixed18(acc.get("totalCash")) for acc in results)
        net_balance = sum(_fixed18(acc.get("netBalance")) for acc in results)
        available_margin = sum(_fixed18(acc.get("availableInitialMargin")) for acc in results)
        initial_margin = sum(_fixed18(acc.get("initialMargin")) for acc in results)
        maint_margin = sum(_fixed18(acc.get("maintenanceMargin")) for acc in results)
        available_maint = sum(_fixed18(acc.get("availableMaintMargin")) for acc in results)
        positions = []
        for acc in results:
            positions.extend(acc.get("positions") or [])
        total_pos_size = sum(abs(_fixed18(p.get("signedSize"))) for p in positions)
        unrealized = sum(_fixed18(p.get("unrealizedPnl", p.get("cumulativePnl"))) for p in positions)
        health_ratio = (
            available_maint / maint_margin if maint_margin > 0
            else (999.0 if net_balance > 0 else 0.0)
        )

        return AccountSnapshot(
            timestamp=time.time(),
            total_cash=total_cash,
            net_balance=net_balance,
            available_margin=available_margin,
            initial_margin=initial_margin,
            maintenance_margin=maint_margin,
            available_maint_margin=available_maint,
            health_ratio=health_ratio,
            position_count=len(positions),
            total_position_value=total_pos_size,
            unrealized_pnl=unrealized,
            accumulated_reward_pendle=0.0,
            gas_balance_usd=gas_balance,
            accounts=results,
        )

    async def get_positions(self) -> list[PositionInfo]:
        if not ROOT_ADDRESS:
            return []
        async with aiohttp.ClientSession() as session:
            data = await self._get_json(
                session,
                "/v1/accounts/active-positions",
                {"root": ROOT_ADDRESS, "accountId": 0},
            )
        rows = data.get("results", data if isinstance(data, list) else []) if data else []
        positions: list[PositionInfo] = []
        for pos in rows:
            signed = _fixed18(pos.get("signedSize"))
            positions.append(PositionInfo(
                market_id=int(pos.get("marketId") or 0),
                side="SHORT" if signed < 0 or pos.get("side") == 1 else "LONG",
                size=abs(signed),
                notional_usd=_f(pos.get("notionalUsd", pos.get("notional"))),
                entry_rate=_f(pos.get("fixedApr", pos.get("rate"))),
                current_mark=_f(pos.get("markApr")),
                unrealized_pnl=_fixed18(pos.get("unrealizedPnl", pos.get("cumulativePnl"))),
                settlement_pnl=_fixed18(pos.get("settlementPnl")),
            ))
        return positions

    async def get_accumulated_rewards(self, market_ids: list[int]) -> float:
        total = 0.0
        if not ROOT_ADDRESS:
            return total
        async with aiohttp.ClientSession() as session:
            for market_id in market_ids:
                data = await self._get_json(
                    session,
                    f"/v1/incentives/maker-incentives/campaigns/{market_id}",
                    {"maker": ROOT_ADDRESS},
                )
                if not data:
                    continue
                add_liq = data.get("addLiquidityIncentive") or {}
                for side in ("long", "short"):
                    total += _f((add_liq.get(side) or {}).get("accumulatedReward"))
                filled = data.get("filledVolumeIncentive") or {}
                total += _f(filled.get("accumulatedReward"))
        return total


class StabilityAnalyzer:
    """Simple performance stability analyzer from local account snapshots."""

    def __init__(self, db: LocalDB):
        self.db = db

    def analyze(self, hours: int = 168) -> dict:
        since = time.time() - hours * 3600
        rows = self.db.conn.execute(
            "SELECT timestamp, net_balance FROM account_snapshots WHERE timestamp > ? ORDER BY timestamp",
            (since,),
        ).fetchall()
        if len(rows) < 2:
            return {"status": "insufficient_data", "hours": hours}

        try:
            import numpy as np
        except Exception:
            first, last = rows[0]["net_balance"], rows[-1]["net_balance"]
            return {
                "status": "ok",
                "hours": hours,
                "total_pnl_usd": round(last - first, 4),
                "data_points": len(rows),
                "note": "numpy unavailable; limited stats",
            }

        balances = np.array([row["net_balance"] for row in rows], dtype=float)
        total_pnl = float(balances[-1] - balances[0])
        deltas = np.diff(balances)
        mean_delta = float(np.mean(deltas)) if len(deltas) else 0.0
        std_delta = float(np.std(deltas)) if len(deltas) else 0.0
        sharpe = mean_delta / std_delta * np.sqrt(365 * 24 * 60) if std_delta > 0 else 0.0
        peak = float(balances[0])
        max_dd = 0.0
        for balance in balances:
            peak = max(peak, float(balance))
            if peak > 0:
                max_dd = max(max_dd, (peak - float(balance)) / peak)

        return {
            "status": "ok",
            "hours": hours,
            "total_pnl_usd": round(total_pnl, 4),
            "mean_delta_usd": round(mean_delta, 6),
            "std_delta_usd": round(std_delta, 6),
            "annualized_sharpe_like": round(float(sharpe), 2),
            "max_drawdown_pct": round(max_dd * 100, 3),
            "data_points": len(rows),
        }
