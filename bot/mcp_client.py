"""
Boros MCP 客户端 — Python 通过 stdio JSON-RPC 调用 @pendle/boros-mcp
实现官方 44 个工具的 Python 接口，替换手写签名和 calldata 生成。
"""

import asyncio
import json
import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class BorosMCPClient:
    """
    Boros MCP 客户端
    
    启动 @pendle/boros-mcp 子进程，通过 stdio JSON-RPC 2.0 通信。
    MCP 负责: Agent 密钥管理、EIP-712 签名、Send Txs Bot 提交。
    
    用法:
        client = BorosMCPClient()
        await client.start()
        result = await client.call_tool("get_markets", {})
        await client.stop()
    """

    def __init__(self):
        self._process: Optional[subprocess.Popen] = None
        self._request_id: int = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._reader_task: Optional[asyncio.Task] = None
        self._initialized: bool = False

    # ═══════════════════════════════════════════════════
    # Lifecycle
    # ═══════════════════════════════════════════════════

    async def start(self):
        """启动 MCP 服务进程"""
        if self._process is not None:
            return

        logger.info("Starting Boros MCP server...")
        self._process = subprocess.Popen(
            ["npx", "-y", "@pendle/boros-mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,  # Binary mode for JSON-RPC
        )

        # Start reader
        self._reader_task = asyncio.create_task(self._read_loop())

        # MCP initialize handshake
        init_result = await self._send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "boros-bot", "version": "1.0.0"},
        })
        logger.info(f"MCP initialized: {init_result.get('serverInfo', {}).get('name', 'unknown')}")

        # Send initialized notification
        self._send_notification("notifications/initialized", {})
        self._initialized = True

    async def stop(self):
        """停止 MCP 服务"""
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass

        if self._process:
            self._process.stdin.close()
            self._process.stdout.close()
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
            self._process = None

        self._initialized = False
        logger.info("MCP server stopped")

    # ═══════════════════════════════════════════════════
    # JSON-RPC Communication
    # ═══════════════════════════════════════════════════

    async def _send_request(self, method: str, params: dict) -> dict:
        """发送 JSON-RPC 请求并等待响应"""
        self._request_id += 1
        rid = self._request_id

        msg = json.dumps({
            "jsonrpc": "2.0",
            "id": rid,
            "method": method,
            "params": params,
        })

        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[rid] = future

        # Send
        assert self._process and self._process.stdin
        self._process.stdin.write((msg + "\n").encode())
        self._process.stdin.flush()

        # Wait for response
        try:
            result = await asyncio.wait_for(future, timeout=60.0)
            if "error" in result:
                raise MCPError(result["error"].get("message", str(result["error"])))
            return result.get("result", {})
        finally:
            self._pending.pop(rid, None)

    def _send_notification(self, method: str, params: dict):
        """发送 JSON-RPC 通知（无响应）"""
        msg = json.dumps({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        })
        if self._process and self._process.stdin:
            self._process.stdin.write((msg + "\n").encode())
            self._process.stdin.flush()

    async def _read_loop(self):
        """持续读取 MCP 响应"""
        assert self._process and self._process.stdout
        buffer = b""
        while True:
            try:
                chunk = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: self._process.stdout.read(4096)
                )
                if not chunk:
                    break
                buffer += chunk

                # Parse complete JSON messages (newline-delimited)
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        msg = json.loads(line.decode())
                        rid = msg.get("id")
                        if rid is not None and rid in self._pending:
                            self._pending[rid].set_result(msg)
                        # Notifications are silently consumed
                    except json.JSONDecodeError:
                        logger.warning(f"Invalid JSON from MCP: {line[:100]}")
            except Exception as e:
                logger.error(f"MCP read error: {e}")
                break

    # ═══════════════════════════════════════════════════
    # Tool Interface
    # ═══════════════════════════════════════════════════

    async def call_tool(self, tool_name: str, arguments: dict) -> dict:
        """调用 MCP 工具"""
        if not self._initialized:
            raise RuntimeError("MCP client not started. Call start() first.")

        # List tools to verify availability (cached after first call)
        result = await self._send_request("tools/call", {
            "name": tool_name,
            "arguments": arguments,
        })
        return result

    # ═══════════════════════════════════════════════════
    # Convenience Methods — Trading
    # ═══════════════════════════════════════════════════

    async def place_order(
        self, market_id: int, side: str, size: str, order_type: str = "limit",
        limit_apr: float = None, margin_mode: str = "cross",
        simulate: bool = True,
    ) -> dict:
        """
        下单 (simulate or execute)
        
        官方 MCP 强制 simulate → confirm → execute 流程。
        设置 simulate=True 仅预览，simulate=False 执行。
        """
        mode = "simulate" if simulate else "execute"
        args = {
            "marketId": market_id,
            "side": side,
            "size": size,
            "orderType": order_type,
            "marginMode": margin_mode,
        }
        if limit_apr is not None:
            args["limitApr"] = limit_apr
        if not simulate:
            args["mode"] = "execute"
        else:
            args["mode"] = "simulate"

        return await self.call_tool("place_order", args)

    async def place_orders(
        self, orders: list[dict], margin_mode: str = "cross",
        cancel_all: bool = False, simulate: bool = True,
    ) -> dict:
        """
        批量下单
        
        orders: [{"marketId": 130, "side": "SHORT", "tick": 371, "size": "..."}]
        """
        mode = "simulate" if simulate else "execute"
        return await self.call_tool("place_orders", {
            "orders": orders,
            "marginMode": margin_mode,
            "cancelAll": cancel_all,
            "mode": mode,
        })

    async def cancel_orders(
        self, market_id: int, order_ids: list[str] = None,
        cancel_all: bool = False, margin_mode: str = "cross",
    ) -> dict:
        """撤单"""
        args = {"marketId": market_id, "marginMode": margin_mode}
        if cancel_all:
            args["cancelAll"] = True
        elif order_ids:
            args["orderIds"] = order_ids
        return await self.call_tool("cancel_orders", args)

    async def close_position(
        self, market_id: int, side: str, size: str = None,
        margin_mode: str = "cross", simulate: bool = True,
    ) -> dict:
        """平仓"""
        args = {
            "marketId": market_id,
            "side": side,
            "marginMode": margin_mode,
        }
        if size:
            args["size"] = size
        if not simulate:
            args["mode"] = "execute"
        else:
            args["mode"] = "simulate"
        return await self.call_tool("close_position", args)

    # ═══════════════════════════════════════════════════
    # Convenience Methods — Account & Gas
    # ═══════════════════════════════════════════════════

    async def pay_gas(self, amount_usd: float, market_id: int) -> dict:
        """充值 Gas (Agent 签名，无需浏览器)"""
        return await self.call_tool("pay_gas", {
            "amount": amount_usd,
            "marketId": market_id,
        })

    async def get_gas_info(self) -> dict:
        """查询 Gas 余额和历史"""
        return await self.call_tool("get_gas_info", {})

    async def agent_status(self) -> dict:
        """检查 Agent 状态"""
        return await self.call_tool("agent_status", {})

    async def get_portfolio_summary(self) -> dict:
        """获取投资组合摘要"""
        return await self.call_tool("get_portfolio_summary", {})

    async def get_positions(self) -> dict:
        """获取持仓"""
        return await self.call_tool("get_positions", {})

    async def get_orders(self, market_id: int = None) -> dict:
        """获取挂单"""
        args = {}
        if market_id:
            args["marketId"] = market_id
        return await self.call_tool("get_orders", args)

    # ═══════════════════════════════════════════════════
    # Convenience Methods — Market Data
    # ═══════════════════════════════════════════════════

    async def get_markets(self) -> dict:
        """获取所有市场"""
        return await self.call_tool("get_markets", {})

    async def get_orderbook(self, market_id: int) -> dict:
        """获取订单簿"""
        return await self.call_tool("get_orderbook", {"marketId": market_id})

    async def get_maker_incentives(self, market_id: int) -> dict:
        """获取 Maker 激励数据"""
        return await self.call_tool("get_maker_incentives", {"marketId": market_id})

    async def get_market_indicators(self, market_id: int) -> dict:
        """获取市场指标"""
        return await self.call_tool("get_market_indicators", {"marketId": market_id})

    # ═══════════════════════════════════════════════════
    # Convenience Methods — Wallet Operations
    # ═══════════════════════════════════════════════════

    async def enter_exit_markets(
        self, market_ids: list[int], enter: bool = True,
    ) -> dict:
        """进入/退出市场"""
        return await self.call_tool("enter_exit_markets", {
            "marketIds": market_ids,
            "enter": enter,
        })

    async def cash_transfer(
        self, amount: str, from_cross: bool = True, to_market_id: int = None,
    ) -> dict:
        """全仓↔逐仓转账"""
        return await self.call_tool("cash_transfer", {
            "amount": amount,
            "fromCross": from_cross,
            "toMarketId": to_market_id,
        })


class MCPError(Exception):
    """MCP 错误"""
    pass


# ═══════════════════════════════════════════════════
# Quick Test
# ═══════════════════════════════════════════════════

async def test():
    client = BorosMCPClient()
    try:
        await client.start()

        # Check agent status
        status = await client.agent_status()
        print(f"Agent status: {json.dumps(status, indent=2)[:500]}")

        # Get gas info
        gas = await client.get_gas_info()
        print(f"Gas info: {json.dumps(gas, indent=2)[:500]}")

    finally:
        await client.stop()


if __name__ == "__main__":
    asyncio.run(test())
