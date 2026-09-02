# Boros 做市机器人 — MCP 迁移计划

## 架构对比

### 之前（手写）
```
Python scanner → Python auto_trader → subprocess → TS place-orders.ts
                                                       │
                                         手写 EIP-712 → Send Txs → 403 ❌
```

### 之后（官方 MCP）
```
Python scanner → Python auto_trader → BorosMCPClient (stdio JSON-RPC)
                                           │
                                     @pendle/boros-mcp (44 tools)
                                           │
                                     Agent 签名 → Send Txs → ✅
```

## 关键变化

| 组件 | 之前 | 之后 |
|------|------|------|
| 下单 | `place-orders.ts` (手写签名) | MCP `place_order` / `place_orders` |
| 模拟 | 无 | 强制 `simulate → confirm → execute` |
| 撤单 | 手写 calldata | MCP `cancel_orders` |
| Gas | `topup-gas.ts` (合约回退) | MCP `pay_gas` (Agent 签名) |
| 市场 | REST API 分页扫描 | MCP `get_markets` |
| 激励 | 150次单独 API 调用 | MCP `get_maker_incentives` |
| 订单簿 | REST API | MCP `get_orderbook` |
| 风控 | 自建检查 | MCP simulate 前置 + 自建后置 |

## Agent 管理

之前: 我们手动生成 + 批准 Agent (0x9FDF...Ce7A)
之后: MCP 自动管理 Agent (加密存储于 ~/.boros-mcp/agent.enc)

两个 Agent 可以共存。MCP Agent 只需一次浏览器授权（免费，不消耗 Gas）。
