"""
Part 1: Boros maker incentive scanner, simulator, and pool filter.

The scanner is built for the user's actual objective:
- scan all markets and maker incentive campaigns;
- rank opportunities after our own liquidity dilution;
- concentrate capital into the highest ROI markets instead of spreading thinly;
- reject expired markets, markets without incentives, unsafe ranges, and orders
  that cannot satisfy the API/MCP minimum notional.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import aiohttp

from ..config import BOROS_API_KEY, BOROS_OPEN_API, rate_limit, trading

logger = logging.getLogger(__name__)


def _f(value: Any, default: float = 0.0) -> float:
    """Parse Boros numeric values defensively."""
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _fixed18(value: Any) -> float:
    """Convert 18-decimal integer strings to float YU."""
    raw = _f(value, 0.0)
    if abs(raw) > 1e12:
        return raw / 1e18
    return raw


def _token_symbol(token_id: int) -> str:
    return trading.token_symbols.get(token_id, f"TOKEN{token_id}")


@dataclass
class SideIncentive:
    side: str
    budget_per_hour: float = 0.0
    capped_distribution_per_hour: float = 0.0
    current_inrange_yu: float = 0.0
    incentive_range: float = 0.0
    accumulated_reward: float = 0.0

    @property
    def active(self) -> bool:
        return self.capped_distribution_per_hour > 0 and self.incentive_range > 0

    @property
    def pendle_per_yu_day(self) -> float:
        if self.current_inrange_yu <= 0:
            return 0.0
        return self.capped_distribution_per_hour * 24 / self.current_inrange_yu


@dataclass
class CampaignInfo:
    market_id: int
    token_id: int
    token_symbol: str
    underlying: str
    platform: str
    maturity: int
    days_to_maturity: float
    tick_step: int
    mid_apr: float
    mark_apr: float
    volume_24h: float
    long: SideIncentive
    short: SideIncentive
    raw_market: dict[str, Any] = field(default_factory=dict)
    raw_campaign: dict[str, Any] = field(default_factory=dict)
    is_active: bool = True
    death_reason: str = ""

    def side_info(self, side: str) -> SideIncentive:
        return self.long if side.upper() == "LONG" else self.short

    @property
    def active_sides(self) -> list[SideIncentive]:
        return [s for s in (self.long, self.short) if s.active]

    @property
    def best_side(self) -> str:
        sides = self.active_sides
        if not sides:
            return "NONE"
        return max(sides, key=lambda s: s.pendle_per_yu_day).side

    @property
    def best_reward_per_yu_day(self) -> float:
        sides = self.active_sides
        return max((s.pendle_per_yu_day for s in sides), default=0.0)

    @property
    def best_incentive_range(self) -> float:
        side = self.side_info(self.best_side)
        return side.incentive_range


@dataclass
class SimResult:
    campaign: CampaignInfo
    side: str
    token_id: int
    token_symbol: str
    capital_available_usd: float
    capital_allocated_usd: float
    collateral_price_usd: float
    estimated_initial_margin_usd: float
    order_notional_usd: float
    yu_provided: float
    min_order_yu: float
    current_inrange_yu: float
    new_inrange_yu: float
    our_share_pct: float
    estimated_pendle_per_day: float
    estimated_usd_per_day: float
    estimated_apr_pct: float
    safe_rate: float
    safe_tick: int
    levels: int
    roi_rank: int = 0


@dataclass
class ScannerReport:
    timestamp: float
    total_markets: int
    campaigns_found: int
    alive_count: int
    dead_count: int
    dead_pools: list[CampaignInfo]
    simulations: list[SimResult]
    selected: list[SimResult]


class MarketScanner:
    """Discover and rank Boros maker incentive opportunities."""

    def __init__(self, api_url: str = BOROS_OPEN_API):
        self.api_url = api_url.rstrip("/")
        self._campaign_cache: list[CampaignInfo] = []
        self._cache_time = 0.0
        self._cache_ttl = 180.0

    async def _get_json(
        self,
        session: aiohttp.ClientSession,
        path: str,
        params: Optional[dict[str, Any]] = None,
    ) -> tuple[Optional[dict[str, Any]], int]:
        headers = {}
        if BOROS_API_KEY:
            headers["Authorization"] = f"Bearer {BOROS_API_KEY}"
        try:
            async with session.get(
                f"{self.api_url}{path}",
                params=params,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=rate_limit.timeout_sec),
            ) as resp:
                cu = int(resp.headers.get("x-computing-unit", "0") or "0")
                if resp.status != 200:
                    logger.debug("GET %s failed: %s %s", path, resp.status, await resp.text())
                    return None, cu
                return await resp.json(), cu
        except Exception as exc:
            logger.debug("GET %s failed: %s", path, exc)
            return None, 0

    async def fetch_markets(self) -> list[dict[str, Any]]:
        """Fetch all Boros markets with pagination."""
        all_markets: list[dict[str, Any]] = []
        resume = None
        async with aiohttp.ClientSession() as session:
            while True:
                params: dict[str, Any] = {"limit": 100}
                if resume:
                    params["resumeToken"] = resume
                data, _ = await self._get_json(session, "/v1/markets", params)
                if not data:
                    break
                all_markets.extend(data.get("results", []))
                resume = data.get("resumeToken")
                if not resume:
                    break
        return all_markets

    async def scan_campaigns(self, force_refresh: bool = False) -> list[CampaignInfo]:
        now = time.time()
        if (
            not force_refresh
            and self._campaign_cache
            and now - self._cache_time < self._cache_ttl
        ):
            return list(self._campaign_cache)

        markets = await self.fetch_markets()
        logger.info("Fetched %d Boros markets", len(markets))

        campaigns: list[CampaignInfo] = []
        semaphore = asyncio.Semaphore(rate_limit.max_concurrent)

        async with aiohttp.ClientSession() as session:
            async def parse_one(market: dict[str, Any]) -> Optional[CampaignInfo]:
                async with semaphore:
                    return await self._parse_campaign(session, market)

            results = await asyncio.gather(*(parse_one(m) for m in markets), return_exceptions=True)

        for item in results:
            if isinstance(item, CampaignInfo):
                campaigns.append(item)
            elif isinstance(item, Exception):
                logger.debug("Campaign parse failed: %s", item)

        self._campaign_cache = campaigns
        self._cache_time = now
        logger.info("Found %d markets with maker incentives", len(campaigns))
        return campaigns

    async def _parse_campaign(
        self,
        session: aiohttp.ClientSession,
        market: dict[str, Any],
    ) -> Optional[CampaignInfo]:
        market_id = int(market.get("marketId") or market.get("id") or 0)
        if market_id <= 0:
            return None

        data, _ = await self._get_json(
            session,
            f"/v1/incentives/maker-incentives/campaigns/{market_id}",
        )
        if not data:
            return None

        add_liq = data.get("addLiquidityIncentive") or {}
        long_raw = add_liq.get("long") or {}
        short_raw = add_liq.get("short") or {}

        def side(name: str, raw: dict[str, Any]) -> SideIncentive:
            return SideIncentive(
                side=name,
                budget_per_hour=_f(raw.get("budgetPerHour")),
                capped_distribution_per_hour=_f(
                    raw.get("currentCappedDistributionPerHour", raw.get("cappedDistributionPerHour"))
                ),
                current_inrange_yu=_fixed18(
                    raw.get("currentInRangeLiquidity", raw.get("currentInRangeYU"))
                ),
                incentive_range=_f(raw.get("incentiveRange")),
                accumulated_reward=_f(raw.get("accumulatedReward")),
            )

        long = side("LONG", long_raw)
        short = side("SHORT", short_raw)
        if not long.active and not short.active:
            return None

        meta = market.get("metadata") or {}
        mdata = market.get("data") or {}
        im = market.get("imData") or {}
        platform = market.get("platform") or {}
        maturity = int(im.get("maturity") or 0)
        days_left = max(0.0, (maturity - time.time()) / 86400) if maturity else 0.0
        token_id = int(market.get("tokenId") or im.get("tokenId") or 0)

        return CampaignInfo(
            market_id=market_id,
            token_id=token_id,
            token_symbol=_token_symbol(token_id),
            underlying=str(meta.get("underlyingSymbol") or meta.get("assetSymbol") or "?"),
            platform=str(platform.get("name") or "?"),
            maturity=maturity,
            days_to_maturity=days_left,
            tick_step=int(im.get("tickStep") or market.get("tickStep") or 2),
            mid_apr=_f(mdata.get("midApr", market.get("midApr"))),
            mark_apr=_f(mdata.get("markApr", market.get("markApr"))),
            volume_24h=_f(mdata.get("volume24h", market.get("volume24h"))),
            long=long,
            short=short,
            raw_market=market,
            raw_campaign=data,
        )

    def filter_dead_pools(
        self,
        campaigns: list[CampaignInfo],
    ) -> tuple[list[CampaignInfo], list[CampaignInfo]]:
        alive: list[CampaignInfo] = []
        dead: list[CampaignInfo] = []

        for campaign in campaigns:
            reasons: list[str] = []
            if campaign.days_to_maturity <= 0:
                reasons.append("expired")
            if campaign.token_id not in trading.capital_by_token_usd:
                reasons.append(f"unsupported tokenId={campaign.token_id}")
            if not campaign.active_sides:
                reasons.append("no active maker incentive")
            if campaign.best_incentive_range <= 0:
                reasons.append("missing incentiveRange")
            if campaign.best_incentive_range and campaign.best_incentive_range < 0.0005:
                reasons.append(f"range too narrow ({campaign.best_incentive_range * 100:.3f}%)")
            if campaign.best_reward_per_yu_day <= 0:
                reasons.append("zero reward per YU")

            if reasons:
                campaign.is_active = False
                campaign.death_reason = "; ".join(reasons)
                dead.append(campaign)
            else:
                campaign.is_active = True
                campaign.death_reason = ""
                alive.append(campaign)

        return alive, dead

    def _rate_to_tick(self, rate: float, tick_step: int) -> int:
        if rate >= 0:
            return int(round(math.log(1 + rate) / (tick_step * math.log(1.00005))))
        return int(round(-math.log(1 - rate) / (tick_step * math.log(1.00005))))

    def _safe_rate(self, campaign: CampaignInfo, side: str, fraction: Optional[float] = None) -> float:
        side_info = campaign.side_info(side)
        if fraction is None:
            fraction = min(
                trading.outer_edge_fraction,
                1 - trading.safety_margin_bps / 10000,
            )
        offset = side_info.incentive_range * max(0.01, min(0.99, fraction))
        if side.upper() == "LONG":
            return campaign.mid_apr - offset
        return campaign.mid_apr + offset

    def simulate_capital_deployment(
        self,
        campaigns: list[CampaignInfo],
        pendle_price_usd: float,
        capital_by_token_usd: Optional[dict[int, float]] = None,
        collateral_prices_usd: Optional[dict[int, float]] = None,
    ) -> list[SimResult]:
        """Simulate reward APR after our own liquidity dilutes each campaign."""
        capital_by_token = capital_by_token_usd or trading.capital_by_token_usd
        collateral_prices = collateral_prices_usd or trading.default_collateral_prices
        results: list[SimResult] = []

        for campaign in campaigns:
            capital_available = capital_by_token.get(campaign.token_id, 0.0)
            collateral_price = collateral_prices.get(campaign.token_id, 0.0)
            if capital_available <= 0 or collateral_price <= 0:
                continue

            capital_alloc = min(
                capital_available * trading.capital_utilization_pct,
                capital_available * trading.max_allocation_per_market_pct,
            )
            min_order_yu = trading.min_order_notional_usd / collateral_price
            max_yu_by_margin = capital_alloc / (
                collateral_price * trading.estimated_initial_margin_rate
            )
            if max_yu_by_margin < min_order_yu:
                continue

            for side in campaign.active_sides:
                yu_provided = max_yu_by_margin
                order_notional = yu_provided * collateral_price
                margin_est = order_notional * trading.estimated_initial_margin_rate
                current_yu = max(side.current_inrange_yu, 0.0)
                new_total = current_yu + yu_provided
                share = yu_provided / new_total if new_total > 0 else 1.0
                pendle_day = side.capped_distribution_per_hour * 24 * share
                usd_day = pendle_day * pendle_price_usd
                apr = usd_day * 365 / margin_est if margin_est > 0 else 0.0
                safe_rate = self._safe_rate(campaign, side.side)

                max_levels = int(max(
                    trading.min_levels_per_market,
                    min(trading.n_levels, math.floor(yu_provided / min_order_yu)),
                ))

                results.append(SimResult(
                    campaign=campaign,
                    side=side.side,
                    token_id=campaign.token_id,
                    token_symbol=campaign.token_symbol,
                    capital_available_usd=capital_available,
                    capital_allocated_usd=capital_alloc,
                    collateral_price_usd=collateral_price,
                    estimated_initial_margin_usd=margin_est,
                    order_notional_usd=order_notional,
                    yu_provided=yu_provided,
                    min_order_yu=min_order_yu,
                    current_inrange_yu=current_yu,
                    new_inrange_yu=new_total,
                    our_share_pct=share * 100,
                    estimated_pendle_per_day=pendle_day,
                    estimated_usd_per_day=usd_day,
                    estimated_apr_pct=apr * 100,
                    safe_rate=safe_rate,
                    safe_tick=self._rate_to_tick(safe_rate, campaign.tick_step),
                    levels=max_levels,
                ))

        results.sort(key=lambda r: r.estimated_apr_pct, reverse=True)
        for rank, result in enumerate(results, start=1):
            result.roi_rank = rank
        return results

    def select_best_markets(self, simulations: list[SimResult]) -> list[SimResult]:
        """Concentrate on top markets while limiting per-token scatter."""
        selected: list[SimResult] = []
        per_token: dict[int, int] = {}
        per_market_side: set[tuple[int, str]] = set()

        for sim in simulations:
            if sim.estimated_apr_pct < trading.min_roi_annual_pct:
                continue
            token_count = per_token.get(sim.token_id, 0)
            key = (sim.campaign.market_id, sim.side)
            if token_count >= trading.max_markets_per_token:
                continue
            if key in per_market_side:
                continue
            selected.append(sim)
            per_token[sim.token_id] = token_count + 1
            per_market_side.add(key)
            if len(selected) >= trading.max_markets:
                break

        return selected

    async def generate_report(
        self,
        pendle_price_usd: float,
        capital_by_token_usd: Optional[dict[int, float]] = None,
        collateral_prices_usd: Optional[dict[int, float]] = None,
        force_refresh: bool = False,
    ) -> ScannerReport:
        campaigns = await self.scan_campaigns(force_refresh=force_refresh)
        alive, dead = self.filter_dead_pools(campaigns)
        simulations = self.simulate_capital_deployment(
            alive,
            pendle_price_usd=pendle_price_usd,
            capital_by_token_usd=capital_by_token_usd,
            collateral_prices_usd=collateral_prices_usd,
        )
        selected = self.select_best_markets(simulations)

        return ScannerReport(
            timestamp=time.time(),
            total_markets=len(campaigns),
            campaigns_found=len(campaigns),
            alive_count=len(alive),
            dead_count=len(dead),
            dead_pools=dead,
            simulations=simulations,
            selected=selected,
        )
