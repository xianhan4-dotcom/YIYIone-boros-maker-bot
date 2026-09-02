# YIYIone Boros Maker Bot

YIYIone is an experimental Boros maker-only market-making toolkit. It combines
two complementary implementations:

- `bot/`: Python orchestration for incentive scanning, ROI simulation, account
  monitoring, SQLite history, MCP execution, Telegram alerts, preflight checks,
  and persistent risk locking.
- `node-strategy/`: the current Node.js execution strategy recovered from
  `Agent.rar`, including volatility filters, direction confirmation, order-book
  safety checks, allocation, ALO maker orders, and staged ALO/IOC exits.

This repository is trading software, not financial advice. Review every risk
threshold and start in dry-run mode. Never commit a real `.env`, private key,
agent key, Telegram bot token, runtime log, or account state file.

## Repository Layout

```text
bot/                 Python scanner, monitor, trader, risk, alerts, preflight
strategy/            Supporting Python strategy modules
scripts/             Boros SDK utilities and Windows scheduled-task helpers
node-strategy/       Current Node.js live strategy and diagnostics
docs/                Architecture, reward model, and migration notes
.github/agents/       YIYIone agent profile
```

## Python Setup

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm install
Copy-Item .env.example .env
```

Fill only `.env`. Keep `BOROS_LIVE_TRADING=0` until all checks pass.

Run the one-shot dry-run:

```powershell
.\.venv\Scripts\python.exe -m bot.run_once
```

Run preflight without placing orders:

```powershell
.\.venv\Scripts\python.exe -m bot.preflight
```

Run the live loop only after reviewing generated orders, MCP agent status, gas,
health ratio, alert delivery, and the Critical lock behavior:

```powershell
.\.venv\Scripts\python.exe -m bot
```

## Node Strategy

See the README inside the Node strategy directory. It is an independent,
high-frequency implementation and should not run at the same time as the Python
live trader on the same account.

## Safety Model

- Normal quoting is maker-only (`SOFT_ALO`, TIF 4).
- Startup fails closed when MCP, account, gas, health, market, quote, or alert
  checks fail.
- Critical risk stops new quotes, cancels maker orders, optionally closes risk
  through the explicitly enabled emergency taker path, and writes
  `bot/data/trading.lock.json`.
- Trading remains locked until the operator reviews the incident and removes the
  lock file manually.

## Packaging

Build a clean GitHub upload package from the workspace:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-github-package.ps1
```

The script creates a sanitized source directory and ZIP under `release/`. It
excludes secrets, dependencies, conversations, logs, databases, runtime state,
old strategy versions, and the original RAR archive.
