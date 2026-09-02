# Boros Maker Reward Bot Model

This project is optimized for Boros maker incentives, not classic spread capture.
The bot should keep post-only limit orders inside the incentive range and focus
capital on the highest diluted APR opportunities.

## 1. Reward Scanner

File: `bot/scanner/market_scanner.py`

Responsibilities:
- Fetch all markets from `GET /v1/markets`.
- Fetch each market's maker campaign from `/v1/incentives/maker-incentives/campaigns/{marketId}`.
- Parse long/short add-liquidity budgets, capped distribution, current in-range YU, and incentive range.
- Filter dead pools:
  - expired maturity;
  - no active maker incentive;
  - missing or too narrow `incentiveRange`;
  - unsupported collateral token;
  - zero reward per YU.
- Simulate our capital after dilution:

```text
min_order_yu = min_order_notional_usd / collateral_price_usd
max_yu_by_margin = allocated_margin_usd / (collateral_price_usd * estimated_initial_margin_rate)
our_share = our_yu / (current_inrange_yu + our_yu)
pendle_day = capped_distribution_per_hour * 24 * our_share
usd_day = pendle_day * pendle_price_usd
apr = usd_day * 365 / estimated_initial_margin_usd
```

Selection policy:
- Sort by simulated APR after dilution.
- Select at most `BOROS_MAX_MARKETS`.
- Select at most `BOROS_MAX_MARKETS_PER_TOKEN` per collateral token.
- Default behavior concentrates on one best BTC market and one best ETH market instead of scattering small orders.

## 2. Account Monitor

File: `bot/monitor/account_monitor.py`

Responsibilities:
- Encode cross-account `marketAcc` per token with `/v1/market-acc/encode`.
- Read account state with `/v1/accounts/market-acc-infos`.
- Read positions with `/v1/accounts/active-positions?root=...&accountId=0`.
- Read gas balance from `balanceInUSD`.
- Fetch PENDLE/BTC/ETH/USDT prices from CoinGecko and fallback to Boros `/v1/assets/all`.
- Store snapshots in SQLite:
  - `market_snapshots`;
  - `account_snapshots`;
  - `price_snapshots`;
  - `reward_log`;
  - `event_log`;
  - `order_actions`.

The database is stored at `bot/data/boros_bot.db`.

## 3. Maker-Only Trader

File: `bot/trader/auto_trader.py`

Responsibilities:
- Generate a ladder inside `mid +/- incentiveRange`.
- Quote near the outer boundary by default to reduce fill probability.
- Use post-only TIF only:
  - default `BOROS_MAKER_TIF=4` (`SOFT_ALO`);
  - strict post-only `ALO` can be set with `BOROS_MAKER_TIF=3`.
- Avoid requoting during hourly snapshot freeze windows.
- Requote only when mid moves more than `BOROS_REQUOTE_MID_SHIFT_BPS`.
- Use official MCP execution by default.
- Keep live trading disabled unless `BOROS_LIVE_TRADING=1`.

Fallback file: `scripts/place-orders.ts`

The TS fallback uses SDK `bulkSignWithAgentV2`, calldata-builder, and dedicated
bulk calls. MCP remains the preferred execution path because it has already
worked for agent setup, gas payment, simulation, and the first successful order.

## 4. Risk Control

Files:
- `bot/risk/risk_manager.py`
- `bot/alert/email_alert.py`

Controls:
- CU budget:
  - default free-tier model: `200 CU/min` and `400000 CU/week`;
  - weekly soft cap defaults to `85%`.
- Request pacing and exponential backoff after repeated API failures.
- Gas estimate for order refreshes and daily gas budget alerts.
- Position notional cap.
- Stop-loss threshold.
- Health ratio threshold.
- Low gas balance threshold.
- Telegram alerts to `@Jiucai_professor` by default.
- Optional email fallback when `ALERT_CHANNEL=both`.
- Persistent live-trading lock at `bot/data/trading.lock.json`.

Critical flow:
1. Stop new maker order refreshes.
2. Cancel all active maker orders on active, selected, and positioned markets.
3. If position risk remains and `BOROS_ALLOW_EMERGENCY_TAKER=1`, use MCP
   `close_position` with simulate first, then execute as an emergency exception.
4. Send a Critical alert.
5. Write `bot/data/trading.lock.json`; trading will not resume until the file is
   manually deleted after review.

`BOROS_ALLOW_EMERGENCY_TAKER=1` does not change the normal strategy. It is only
used inside the Critical lock handler.

## 5. Live Preflight

File: `bot/preflight.py`

`python -m bot` is now a live-loop entry and fails closed before trading unless:
- `BOROS_LIVE_TRADING=1`;
- `BOROS_USE_MCP=1`;
- MCP `agent_status` reports ready/active/authorized;
- alert channel is configured when `BOROS_REQUIRE_ALERT_FOR_LIVE=1`;
  Telegram requires `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID`;
- Gas balance is at least `BOROS_MIN_GAS_BALANCE_USD`;
- account health ratio is at least `BOROS_MIN_HEALTH_RATIO`;
- Boros maker campaigns are reachable;
- at least `BOROS_PREFLIGHT_MIN_ORDER_COUNT` maker orders can be generated;
- every generated order uses `BOROS_MAKER_TIF=4` and remains inside
  `mid +/- incentiveRange`.

CoinGecko failure is tolerated by the oracle fallback:
`PENDLE_DEFAULT_USD=1.85`.

## Operating Modes

Dry-run mode:

```powershell
python -m bot.run_once
```

Live mode:

```powershell
python -m bot
```

Preflight only, no trading:

```powershell
python -m bot.preflight
```

Alert test, no trading:

```powershell
python -m bot.alert.email_alert
```

Before live mode:
- Confirm `agent_status` is ready in MCP.
- Confirm gas balance is above `BOROS_MIN_GAS_BALANCE_USD`.
- Review top selected markets in logs.
- Verify generated orders are inside the incentive range.
- Create a Telegram bot with BotFather and set `ALERT_TELEGRAM_BOT_TOKEN`.
- Start a chat with that bot, then set `ALERT_TELEGRAM_CHAT_ID`.
  `@Jiucai_professor` may work for a public channel/group; for a personal user
  chat, use the numeric chat id from Bot API `getUpdates`.

Windows scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-yiyione-task.ps1
```

Remove the task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\unregister-yiyione-task.ps1
```

Recommended first live smoke:
- Temporarily set `BOROS_MAX_MARKETS=1` and `BOROS_N_LEVELS=1`.
- Start `python -m bot`.
- Confirm the order is post-only TIF 4 and in incentive range.
- Confirm cancel path works.
- Restore normal multi-market settings only after the smoke test succeeds.
