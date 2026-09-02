# Node Strategy

This directory contains the current strategy extracted from `Agent.rar`.
`lo-bot-safe.js` is the active version described by the archive notes.

Core behavior:

- scans whitelisted USDT-collateral Boros markets;
- ranks maker incentives after liquidity dilution;
- confirms funding direction across multiple rounds;
- rejects high volatility/range ratios and weak order-book protection;
- places `ADD_LIQUIDITY_ONLY` maker orders near incentive boundaries;
- detects real fills after cancelling and rechecking ambiguous positions;
- uses ALO exits first and escalating IOC only for stop-loss or circuit-breaker
  handling;
- persists margin calibration and records key events locally.

## Setup

```powershell
npm install
Copy-Item .env.example .env
node lo-bot-safe.js
```

Do not run this strategy simultaneously with another live trader on the same
Boros account. Start with a low balance and inspect all constants in the
`CONFIG` block before live use.

Runtime files such as `.env`, `bot-state.json`, `anomalies.jsonl`, and
`key-events.csv` are intentionally excluded from Git.

