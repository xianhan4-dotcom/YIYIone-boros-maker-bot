"""
Part 3: maker-only auto trader.

The trader never intentionally crosses the book. In live mode it submits
post-only orders (ALO/SOFT_ALO) and keeps orders inside the maker incentive
range while staying close to the safer outer edge.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from typing import Any, Optional

from ..config import AGENT_KEY, ROOT_ADDRESS, TIF_SOFT_ALO, trading
from ..mcp_client import BorosMCPClient
from ..scanner.market_scanner import CampaignInfo, SimResult

logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).parent.parent.parent


@dataclass
class ActiveOrder:
    market_id: int
    side: str
    tick: int
    rate: float
    size_yu: float
    tif: int
    order_id: Optional[str] = None
    placed_at: float = 0.0


@dataclass
class MarketState:
    campaign: CampaignInfo
    sim: SimResult
    active_orders: list[ActiveOrder] = field(default_factory=list)
    last_mid: float = 0.0
    last_update: float = 0.0


class AutoTrader:
    """Calculate, refresh, and optionally execute Boros maker-only orders."""

    def __init__(self):
        self.states: dict[int, MarketState] = {}
        self.ts_script = ROOT_DIR / "scripts" / "place-orders.ts"
        self._mcp: Optional[BorosMCPClient] = None

    async def close(self):
        if self._mcp:
            await self._mcp.stop()
            self._mcp = None

    def _rate_to_tick(self, rate: float, tick_step: int = 2) -> int:
        if rate >= 0:
            return int(round(math.log(1 + rate) / (tick_step * math.log(1.00005))))
        return int(round(-math.log(1 - rate) / (tick_step * math.log(1.00005))))

    def _tick_to_rate(self, tick: int, tick_step: int = 2) -> float:
        if tick >= 0:
            return 1.00005 ** (tick * tick_step) - 1
        return -(1.00005 ** (-tick * tick_step) - 1)

    def _format_decimal_size(self, value: float, places: int = 12) -> str:
        dec = Decimal(str(max(value, 0.0))).quantize(
            Decimal(10) ** -places,
            rounding=ROUND_DOWN,
        )
        text = format(dec.normalize(), "f")
        return text if text != "0" else "0"

    def _in_snapshot_freeze(self, now: Optional[float] = None) -> bool:
        """Avoid unnecessary cancels around the hourly incentive snapshot."""
        now = now or time.time()
        seconds_into_hour = int(now % 3600)
        return (
            seconds_into_hour >= 3600 - trading.snapshot_freeze_before_sec
            or seconds_into_hour <= trading.snapshot_freeze_after_sec
        )

    def _rate_inside_range(self, campaign: CampaignInfo, side: str, rate: float) -> bool:
        side_info = campaign.side_info(side)
        lower = campaign.mid_apr - side_info.incentive_range
        upper = campaign.mid_apr + side_info.incentive_range
        return lower <= rate <= upper

    def _clamp_rate_inside_range(self, campaign: CampaignInfo, side: str, rate: float) -> float:
        side_info = campaign.side_info(side)
        epsilon = max(side_info.incentive_range * 0.002, 1e-7)
        lower = campaign.mid_apr - side_info.incentive_range + epsilon
        upper = campaign.mid_apr + side_info.incentive_range - epsilon
        return max(lower, min(upper, rate))

    def calculate_safe_quotes(
        self,
        campaign: CampaignInfo,
        sim: SimResult,
        order_book_depth: Optional[dict[str, Any]] = None,
    ) -> list[dict[str, Any]]:
        """
        Build a ladder inside incentiveRange.

        For maker rewards the marginal reward is the in-range YU share, not
        spread capture, so the default ladder sits close to the outer range
        boundary to reduce fill probability.
        """
        side = sim.side
        side_info = campaign.side_info(side)
        levels = max(trading.min_levels_per_market, min(sim.levels, trading.n_levels))
        if levels <= 0 or side_info.incentive_range <= 0:
            return []

        total_yu = max(sim.yu_provided, sim.min_order_yu)
        size_each = max(sim.min_order_yu, total_yu / levels)
        if size_each * levels > total_yu:
            levels = max(1, math.floor(total_yu / size_each))

        if levels <= 1:
            fractions = [trading.outer_edge_fraction]
        else:
            outer = min(0.99, max(0.01, trading.outer_edge_fraction))
            inner = min(outer, max(0.01, trading.inner_edge_fraction))
            step = (outer - inner) / (levels - 1)
            fractions = [outer - i * step for i in range(levels)]

        quotes: list[dict[str, Any]] = []
        for fraction in fractions:
            offset = side_info.incentive_range * fraction
            rate = campaign.mid_apr - offset if side == "LONG" else campaign.mid_apr + offset
            rate = self._clamp_rate_inside_range(campaign, side, rate)
            tick = self._rate_to_tick(rate, campaign.tick_step)
            rounded_rate = self._tick_to_rate(tick, campaign.tick_step)
            if not self._rate_inside_range(campaign, side, rounded_rate):
                rounded_rate = self._clamp_rate_inside_range(campaign, side, rounded_rate)
                tick = self._rate_to_tick(rounded_rate, campaign.tick_step)

            quotes.append({
                "marketId": campaign.market_id,
                "tokenId": campaign.token_id,
                "side": side,
                "tick": tick,
                "limitTick": tick,
                "rate": rounded_rate,
                "size": self._format_decimal_size(size_each),
                "sizeFloat": size_each,
                "tif": trading.maker_tif,
            })

        return self._anti_fill_adjust(quotes, order_book_depth, campaign, side)

    def _anti_fill_adjust(
        self,
        quotes: list[dict[str, Any]],
        order_book: Optional[dict[str, Any]],
        campaign: CampaignInfo,
        side: str,
    ) -> list[dict[str, Any]]:
        if not order_book:
            return quotes

        # Boros order book shapes can differ between endpoints/MCP versions.
        bids = order_book.get("bids") or order_book.get("longs") or []
        asks = order_book.get("asks") or order_book.get("shorts") or []

        def best_tick(rows: list[Any]) -> Optional[int]:
            for row in rows:
                if isinstance(row, dict):
                    value = row.get("tick") or row.get("limitTick")
                elif isinstance(row, (list, tuple)) and row:
                    value = row[0]
                else:
                    value = None
                try:
                    return int(value)
                except (TypeError, ValueError):
                    continue
            return None

        best_bid = best_tick(bids)
        best_ask = best_tick(asks)
        adjusted: list[dict[str, Any]] = []
        for quote in quotes:
            q = dict(quote)
            if side == "LONG" and best_ask is not None and q["tick"] >= best_ask:
                q["tick"] = best_ask - 1
                q["rate"] = self._tick_to_rate(q["tick"], campaign.tick_step)
            elif side == "SHORT" and best_bid is not None and q["tick"] <= best_bid:
                q["tick"] = best_bid + 1
                q["rate"] = self._tick_to_rate(q["tick"], campaign.tick_step)

            q["rate"] = self._clamp_rate_inside_range(campaign, side, q["rate"])
            q["tick"] = self._rate_to_tick(q["rate"], campaign.tick_step)
            adjusted.append(q)
        return adjusted

    def _should_refresh(self, campaign: CampaignInfo, state: Optional[MarketState]) -> tuple[bool, str]:
        if not state or not state.active_orders:
            return True, "no_active_orders"
        mid_shift_bps = abs(campaign.mid_apr - state.last_mid) * 10000
        if mid_shift_bps < trading.requote_mid_shift_bps:
            return False, f"mid_shift_{mid_shift_bps:.2f}bps"
        if self._in_snapshot_freeze():
            return False, "snapshot_freeze"
        return True, f"mid_shift_{mid_shift_bps:.2f}bps"

    async def refresh_orders(
        self,
        campaign: CampaignInfo,
        sim: SimResult,
        order_book: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        market_id = campaign.market_id
        state = self.states.get(market_id)
        should_refresh, reason = self._should_refresh(campaign, state)
        if not should_refresh:
            return {"status": "skip", "market_id": market_id, "reason": reason}

        quotes = self.calculate_safe_quotes(campaign, sim, order_book)
        if not quotes:
            return {"status": "skip", "market_id": market_id, "reason": "no_valid_quotes"}

        payload_orders = [{
            "marketId": q["marketId"],
            "tokenId": q["tokenId"],
            "side": q["side"],
            "tick": q["tick"],
            "limitTick": q["limitTick"],
            "size": q["size"],
            "tif": q["tif"],
        } for q in quotes]

        if not trading.live_trading:
            result = {
                "status": "dry_run",
                "market_id": market_id,
                "reason": "BOROS_LIVE_TRADING is disabled",
                "orders": payload_orders,
            }
        elif trading.use_mcp_execution:
            result = await self._execute_with_mcp(payload_orders, cancel_all=True)
        else:
            result = await self._execute_with_ts(campaign.token_id, market_id, payload_orders)

        if result.get("status") in {"placed", "dry_run", "executed"}:
            active = [
                ActiveOrder(
                    market_id=market_id,
                    side=q["side"],
                    tick=q["tick"],
                    rate=q["rate"],
                    size_yu=q["sizeFloat"],
                    tif=q["tif"],
                    placed_at=time.time(),
                )
                for q in quotes
            ]
            self.states[market_id] = MarketState(
                campaign=campaign,
                sim=sim,
                active_orders=active,
                last_mid=campaign.mid_apr,
                last_update=time.time(),
            )
        return result

    async def _mcp_client(self) -> BorosMCPClient:
        if self._mcp is None:
            self._mcp = BorosMCPClient()
            await self._mcp.start()
        return self._mcp

    async def _execute_with_mcp(self, orders: list[dict[str, Any]], cancel_all: bool) -> dict[str, Any]:
        client = await self._mcp_client()
        if trading.simulate_before_execute:
            sim = await client.place_orders(orders, cancel_all=cancel_all, simulate=True)
            logger.info("MCP simulate result: %s", str(sim)[:400])
        result = await client.place_orders(orders, cancel_all=cancel_all, simulate=False)
        return {"status": "placed", "executor": "mcp", "result": result}

    async def _execute_with_ts(
        self,
        token_id: int,
        market_id: int,
        orders: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if not AGENT_KEY or not ROOT_ADDRESS:
            raise RuntimeError("AGENT_PRIVATE_KEY and BOROS_ROOT_ADDRESS are required for TS execution")

        payload = json.dumps({
            "marketId": market_id,
            "tokenId": token_id,
            "orders": orders,
            "cancelAllBeforePlace": True,
        })
        proc = await asyncio.create_subprocess_exec(
            "npx",
            "ts-node",
            str(self.ts_script),
            "--payload",
            payload,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(ROOT_DIR),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=90)
        if proc.returncode != 0:
            raise RuntimeError((stderr or stdout).decode(errors="ignore")[:800])
        try:
            parsed = json.loads(stdout.decode())
        except json.JSONDecodeError:
            parsed = {"raw": stdout.decode(errors="ignore")[:800]}
        parsed.setdefault("status", "placed")
        parsed.setdefault("executor", "ts")
        return parsed

    async def cancel_all_orders(self, market_id: int, token_id: Optional[int] = None) -> dict[str, Any]:
        if not trading.live_trading:
            self.states.pop(market_id, None)
            return {"status": "dry_run_cancelled", "market_id": market_id}
        if trading.use_mcp_execution:
            client = await self._mcp_client()
            result = await client.cancel_orders(market_id, cancel_all=True)
            self.states.pop(market_id, None)
            return {"status": "cancelled", "executor": "mcp", "result": result}
        payload = json.dumps({"marketId": market_id, "tokenId": token_id, "action": "cancelAll"})
        proc = await asyncio.create_subprocess_exec(
            "npx",
            "ts-node",
            str(self.ts_script),
            "--payload",
            payload,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(ROOT_DIR),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=45)
        self.states.pop(market_id, None)
        if proc.returncode != 0:
            raise RuntimeError((stderr or stdout).decode(errors="ignore")[:800])
        return {"status": "cancelled", "executor": "ts"}

    async def emergency_close_positions(self, positions: list[Any]) -> list[dict[str, Any]]:
        """
        Critical-only taker exception.

        Normal strategy execution remains maker-only. This path exists only for
        risk lock handling after active maker orders have been cancelled.
        """
        if not positions:
            return []
        if not trading.allow_emergency_taker:
            return [{
                "status": "skipped",
                "reason": "BOROS_ALLOW_EMERGENCY_TAKER is disabled",
                "count": len(positions),
            }]
        if not trading.live_trading:
            return [{
                "status": "dry_run_close",
                "reason": "BOROS_LIVE_TRADING is disabled",
                "count": len(positions),
            }]
        if not trading.use_mcp_execution:
            return [{
                "status": "unsupported",
                "reason": "emergency close requires MCP execution",
                "count": len(positions),
            }]

        client = await self._mcp_client()
        results: list[dict[str, Any]] = []
        for pos in positions:
            market_id = int(getattr(pos, "market_id", 0) or 0)
            side = str(getattr(pos, "side", "") or "").upper()
            size = float(getattr(pos, "size", 0.0) or 0.0)
            if market_id <= 0 or side not in {"LONG", "SHORT"} or size <= 0:
                results.append({
                    "status": "skipped",
                    "reason": "invalid_position",
                    "market_id": market_id,
                    "side": side,
                    "size": size,
                })
                continue

            size_text = self._format_decimal_size(size)
            try:
                if trading.simulate_before_execute:
                    sim = await client.close_position(
                        market_id=market_id,
                        side=side,
                        size=size_text,
                        simulate=True,
                    )
                    logger.critical("Emergency close simulate M%s %s %s: %s", market_id, side, size_text, str(sim)[:400])
                executed = await client.close_position(
                    market_id=market_id,
                    side=side,
                    size=size_text,
                    simulate=False,
                )
                results.append({
                    "status": "executed",
                    "market_id": market_id,
                    "side": side,
                    "size": size_text,
                    "result": executed,
                })
            except Exception as exc:
                logger.critical("Emergency close failed M%s %s %s: %s", market_id, side, size_text, exc)
                results.append({
                    "status": "error",
                    "market_id": market_id,
                    "side": side,
                    "size": size_text,
                    "reason": str(exc),
                })
        return results

    async def run_cycle(
        self,
        selected_markets: list[SimResult],
        order_books: Optional[dict[int, dict[str, Any]]] = None,
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        order_books = order_books or {}
        selected_ids = {sim.campaign.market_id for sim in selected_markets}

        for market_id in list(self.states):
            if market_id not in selected_ids and not self._in_snapshot_freeze():
                try:
                    results.append(await self.cancel_all_orders(market_id))
                except Exception as exc:
                    results.append({"status": "error", "market_id": market_id, "reason": str(exc)})

        for sim in selected_markets:
            try:
                result = await self.refresh_orders(
                    sim.campaign,
                    sim,
                    order_books.get(sim.campaign.market_id),
                )
                results.append(result)
            except Exception as exc:
                logger.error("Trader cycle failed for market %s: %s", sim.campaign.market_id, exc)
                results.append({
                    "status": "error",
                    "market_id": sim.campaign.market_id,
                    "reason": str(exc),
                })
        return results

    def get_active_markets(self) -> list[int]:
        return list(self.states.keys())
