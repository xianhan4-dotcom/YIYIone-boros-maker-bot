"""
Boros Maker Reward Bot - Unified Configuration.

This bot is intentionally optimized for maker incentives, not spread capture.
The defaults are conservative and dry-run first; set BOROS_LIVE_TRADING=1 only
after checking scan output, order sizes, gas budget, and alert settings.
"""

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError:
        return default


# Paths
ROOT_DIR = Path(__file__).parent.parent
DATA_DIR = ROOT_DIR / "bot" / "data"
DB_PATH = DATA_DIR / "boros_bot.db"
LOCK_PATH = DATA_DIR / "trading.lock.json"
LOG_DIR = ROOT_DIR / "bot" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Boros API
BOROS_OPEN_API = os.getenv("BOROS_OPEN_API", "https://api-boros.pendle.finance/apis").rstrip("/")
BOROS_SEND_TX_API = os.getenv("BOROS_SEND_TX_API", "https://api.boros.finance/send-txs-bot/v2").rstrip("/")
BOROS_API_KEY = os.getenv("BOROS_API_KEY", "")

# Wallet. Do not print private keys in logs.
ROOT_ADDRESS = os.getenv("BOROS_ROOT_ADDRESS", "")
ROOT_KEY = os.getenv("BOROS_ROOT_KEY", "")
AGENT_KEY = os.getenv("AGENT_PRIVATE_KEY", "")

# Boros constants.
CROSS_MARKET_ID = 16777215
TIF_GTC = 0
TIF_IOC = 1
TIF_FOK = 2
TIF_ALO = 3
TIF_SOFT_ALO = 4


@dataclass
class TradingConfig:
    """Maker reward strategy parameters."""

    # Execution safety.
    live_trading: bool = _env_bool("BOROS_LIVE_TRADING", False)
    use_mcp_execution: bool = _env_bool("BOROS_USE_MCP", True)
    simulate_before_execute: bool = _env_bool("BOROS_SIMULATE_BEFORE_EXECUTE", True)
    maker_tif: int = _env_int("BOROS_MAKER_TIF", TIF_SOFT_ALO)
    allow_emergency_taker: bool = _env_bool("BOROS_ALLOW_EMERGENCY_TAKER", False)
    real_python_path: str = os.getenv(
        "BOROS_REAL_PYTHON_PATH",
        sys.executable,
    )

    # Capital. Defaults match the conversation snapshot and are only used when
    # live account balances cannot be read yet.
    capital_by_token_usd: dict[int, float] = field(default_factory=lambda: {
        1: _env_float("BOROS_CAPITAL_TOKEN_1_USD", 40.0),   # WBTC
        2: _env_float("BOROS_CAPITAL_TOKEN_2_USD", 51.0),   # WETH
        3: _env_float("BOROS_CAPITAL_TOKEN_3_USD", 14.0),   # USDT
    })
    token_symbols: dict[int, str] = field(default_factory=lambda: {
        1: "WBTC",
        2: "WETH",
        3: "USDT",
    })
    default_collateral_prices: dict[int, float] = field(default_factory=lambda: {
        1: _env_float("BOROS_WBTC_USD", 60000.0),
        2: _env_float("BOROS_WETH_USD", 1600.0),
        3: _env_float("BOROS_USDT_USD", 1.0),
    })

    # Portfolio selection: concentrate instead of scattering small orders.
    max_markets: int = _env_int("BOROS_MAX_MARKETS", 3)
    max_markets_per_token: int = _env_int("BOROS_MAX_MARKETS_PER_TOKEN", 1)
    min_roi_annual_pct: float = _env_float("BOROS_MIN_ROI_ANNUAL_PCT", 50.0)
    capital_utilization_pct: float = _env_float("BOROS_CAPITAL_UTILIZATION_PCT", 0.75)
    max_allocation_per_market_pct: float = _env_float("BOROS_MAX_ALLOC_PER_MARKET_PCT", 0.90)

    # Order sizing. The public docs say there is no protocol minimum order size,
    # but the current API/MCP path can enforce a roughly $10 order value.
    min_order_notional_usd: float = _env_float("BOROS_MIN_ORDER_NOTIONAL_USD", 10.0)
    estimated_initial_margin_rate: float = _env_float("BOROS_EST_IM_RATE", 0.06)
    n_levels: int = _env_int("BOROS_N_LEVELS", 6)
    min_levels_per_market: int = _env_int("BOROS_MIN_LEVELS_PER_MARKET", 1)

    # Quote placement. Fractions are measured from mid to incentive boundary:
    # 0.95 means very close to the outer edge, therefore safer from fills.
    outer_edge_fraction: float = _env_float("BOROS_OUTER_EDGE_FRACTION", 0.95)
    inner_edge_fraction: float = _env_float("BOROS_INNER_EDGE_FRACTION", 0.70)
    safety_margin_bps: float = _env_float("BOROS_SAFETY_MARGIN_BPS", 5.0)
    requote_mid_shift_bps: float = _env_float("BOROS_REQUOTE_MID_SHIFT_BPS", 3.0)
    snapshot_freeze_before_sec: int = _env_int("BOROS_SNAPSHOT_FREEZE_BEFORE_SEC", 180)
    snapshot_freeze_after_sec: int = _env_int("BOROS_SNAPSHOT_FREEZE_AFTER_SEC", 120)

    # Risk controls.
    max_position_usd: float = _env_float("BOROS_MAX_POSITION_USD", 50.0)
    stop_loss_pct: float = _env_float("BOROS_STOP_LOSS_PCT", 0.02)
    min_health_ratio: float = _env_float("BOROS_MIN_HEALTH_RATIO", 1.5)
    min_gas_balance_usd: float = _env_float("BOROS_MIN_GAS_BALANCE_USD", 1.0)
    preflight_required_order_count: int = _env_int("BOROS_PREFLIGHT_MIN_ORDER_COUNT", 1)
    require_alert_for_live: bool = _env_bool(
        "BOROS_REQUIRE_ALERT_FOR_LIVE",
        _env_bool("BOROS_REQUIRE_SMTP_FOR_LIVE", True),
    )
    require_smtp_for_live: bool = _env_bool("BOROS_REQUIRE_SMTP_FOR_LIVE", False)

    # Refresh cadence.
    scan_interval_sec: int = _env_int("BOROS_SCAN_INTERVAL_SEC", 300)
    order_refresh_sec: int = _env_int("BOROS_ORDER_REFRESH_SEC", 300)
    monitor_interval_sec: int = _env_int("BOROS_MONITOR_INTERVAL_SEC", 60)

    # Gas model.
    max_gas_per_tx_usd: float = _env_float("BOROS_MAX_GAS_PER_TX_USD", 0.10)
    daily_gas_budget_usd: float = _env_float("BOROS_DAILY_GAS_BUDGET_USD", 2.0)


@dataclass
class RateLimitConfig:
    """Boros Open API CU budget and request controls."""

    # Published free tier: fixed windows per IP.
    max_cu_per_minute: int = _env_int("BOROS_MAX_CU_PER_MINUTE", 200)
    max_cu_per_week: int = _env_int("BOROS_MAX_CU_PER_WEEK", 400_000)
    weekly_soft_cap_pct: float = _env_float("BOROS_WEEKLY_SOFT_CAP_PCT", 0.85)

    # Static/common endpoint costs from docs. Dynamic endpoints are updated from
    # the x-computing-unit response header when available.
    cu_assets: int = 1
    cu_market_list: int = 2
    cu_market_detail: int = 1
    cu_order_book: int = 2
    cu_account_info: int = 1
    cu_campaign: int = 1
    cu_campaign_with_maker: int = 2
    cu_place_orders_base: int = 1
    cu_gas_balance: int = 1

    request_delay_ms: int = _env_int("BOROS_REQUEST_DELAY_MS", 250)
    max_concurrent: int = _env_int("BOROS_MAX_CONCURRENT", 3)
    timeout_sec: int = _env_int("BOROS_HTTP_TIMEOUT_SEC", 20)


@dataclass
class AlertConfig:
    channel: str = os.getenv("ALERT_CHANNEL", "telegram").strip().lower()

    telegram_bot_username: str = os.getenv("ALERT_TELEGRAM_BOT_USERNAME", "YiyioneBot")
    telegram_bot_token: str = os.getenv("ALERT_TELEGRAM_BOT_TOKEN", "")
    telegram_chat_id: str = os.getenv("ALERT_TELEGRAM_CHAT_ID", "@Jiucai_professor")
    telegram_api_base: str = os.getenv("ALERT_TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
    telegram_timeout_sec: int = _env_int("ALERT_TELEGRAM_TIMEOUT_SEC", 30)

    smtp_host: str = os.getenv("ALERT_SMTP_HOST", "smtp.163.com")
    smtp_port: int = _env_int("ALERT_SMTP_PORT", 465)
    smtp_user: str = os.getenv("ALERT_SMTP_USER", "")
    smtp_pass: str = os.getenv("ALERT_SMTP_PASS", "")
    alert_email: str = os.getenv("ALERT_EMAIL", "xianhan4@gmail.com")

    loss_threshold_usd: float = _env_float("ALERT_LOSS_THRESHOLD_USD", 20.0)
    position_exceed_threshold_usd: float = _env_float("ALERT_POSITION_THRESHOLD_USD", 50.0)
    api_error_threshold: int = _env_int("ALERT_API_ERROR_THRESHOLD", 10)
    gas_overrun_threshold: float = _env_float("ALERT_GAS_OVERRUN_USD", 2.0)

    @property
    def telegram_configured(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_chat_id)

    @property
    def email_configured(self) -> bool:
        return bool(self.smtp_user and self.smtp_pass and self.alert_email)

    @property
    def configured(self) -> bool:
        if self.channel == "telegram":
            return self.telegram_configured
        if self.channel == "email":
            return self.email_configured
        if self.channel == "both":
            return self.telegram_configured or self.email_configured
        return False


@dataclass
class OracleConfig:
    coingecko_api: str = os.getenv("COINGECKO_API", "https://api.coingecko.com/api/v3")
    pendle_coingecko_id: str = "pendle"
    default_pendle_usd: float = _env_float("PENDLE_DEFAULT_USD", 1.85)
    cache_ttl_sec: int = _env_int("ORACLE_CACHE_TTL_SEC", 300)
    assets_cache_ttl_sec: int = _env_int("BOROS_ASSETS_CACHE_TTL_SEC", 3600)


trading = TradingConfig()
rate_limit = RateLimitConfig()
alert = AlertConfig()
oracle = OracleConfig()
