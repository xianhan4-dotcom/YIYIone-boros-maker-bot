# Agent.rar Integration Record

## Archive Inventory

`Agent.rar` was inspected before extraction and contained 50,885 entries under
`Agent/`. No absolute paths or `..` traversal entries were present.

The archive contained:

- `Agent/boros-bot/`: Node.js Boros strategy and diagnostics;
- `Agent/boros-bot/node_modules/`: installed dependencies;
- `Agent/boros-bot/.env`: live credentials and RPC configuration;
- `Agent/boros-bot/old-versions/`: superseded strategy variants;
- runtime state and telemetry (`bot-state.json`, `anomalies.jsonl`, and
  `key-events.csv`);
- a historical summary document.

There were 37 non-dependency archive entries. The 33 regular files under the
archive's `boros-bot` directory matched the existing workspace `boros-bot`
files byte-for-byte by SHA-256 before integration.

## Current Strategy Identified

The archive note identifies `lo-bot-safe.js` as the current version. Its main
capabilities are:

- USDT-collateral market scanning and incentive allocation;
- volatility-to-incentive-range filtering;
- multi-round funding-direction confirmation;
- order-book reach-cost and liquidity-cushion checks;
- `ADD_LIQUIDITY_ONLY` maker quoting;
- fill confirmation by cancelling ambiguous open orders and re-reading the
  position;
- staged ALO exit, stop-loss chasing, and escalating IOC circuit-breaker exit;
- account health, gas balance, and agent-expiry monitoring;
- persisted margin calibration and local key-event recording.

## Integration Layout

The GitHub package combines the archive strategy and the newer workspace:

- `node-strategy/`: current RAR-derived Node.js strategy and diagnostic tools;
- `bot/`: Python scanning, account monitoring, risk locking, MCP execution,
  Telegram alerting, and preflight orchestration;
- `strategy/`: supporting Python strategy components;
- `scripts/`: SDK utilities, scheduler helpers, and reproducible packaging;
- `docs/`: model, migration, exit-strategy, and archive records.

The Node and Python live traders are alternative execution engines. They must
not run concurrently against the same Boros account.

## Deliberate Exclusions

The following are not included in the GitHub package:

- all real `.env` files and credentials;
- `node_modules` and Python virtual environments;
- the original RAR;
- runtime databases, logs, lock files, bot state, anomaly records, and event
  CSV files;
- conversations and session summaries;
- superseded Node strategy versions and their obsolete launch scripts.

Dependencies are reproducible from `package-lock.json` and
`node-strategy/package-lock.json`.

