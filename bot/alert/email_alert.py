"""
告警模块: Telegram primary, email optional fallback.
"""

import asyncio
import logging
import smtplib
import sys
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from datetime import datetime, timezone

import aiohttp

from ..config import alert

logger = logging.getLogger(__name__)


class AlertManager:
    """告警管理器"""

    def __init__(self):
        self._last_alert: dict[str, float] = {}  # alert_type → timestamp
        self._cooldown_sec: int = 300             # 同类型告警冷却 5 分钟
        self._sent_count: int = 0
        self._daily_limit: int = 50

    async def send(
        self,
        subject: str,
        body: str,
        alert_type: str,
        severity: str = "WARNING",
        bypass_cooldown: bool = False,
    ) -> bool:
        """
        发送告警
        
        内置冷却机制: 同类型告警 5 分钟内只发一次
        """
        # 冷却检查
        now = time.time()
        if not bypass_cooldown and alert_type in self._last_alert:
            if now - self._last_alert[alert_type] < self._cooldown_sec:
                logger.debug(f"Alert '{alert_type}' in cooldown")
                return False

        # 日发送上限
        if self._sent_count >= self._daily_limit:
            logger.warning("Daily alert limit reached")
            return False

        sent = False
        if alert.channel in {"telegram", "both"}:
            sent = await self._send_telegram(subject, body, alert_type, severity)

        if alert.channel in {"email", "both"} and not sent:
            sent = await self._send_email(subject, body, alert_type, severity)

        if sent:
            self._last_alert[alert_type] = now
            self._sent_count += 1
            logger.info("Alert sent via %s: [%s] %s", alert.channel, severity, alert_type)
            return True

        self._log_to_file(subject, body, severity)
        return False

    async def _send_telegram(self, subject: str, body: str, alert_type: str, severity: str) -> bool:
        if not alert.telegram_configured:
            logger.warning("Telegram alert not configured, skipping alert")
            return False

        text = (
            f"[BorosBot] [{severity}] {subject}\n"
            f"Type: {alert_type}\n"
            f"Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}\n\n"
            f"{body}"
        )
        if len(text) > 3900:
            text = text[:3900] + "\n...[truncated]"

        url = f"{alert.telegram_api_base}/bot{alert.telegram_bot_token}/sendMessage"
        payload = {
            "chat_id": alert.telegram_chat_id,
            "text": text,
            "disable_web_page_preview": True,
        }
        try:
            timeout = aiohttp.ClientTimeout(total=alert.telegram_timeout_sec)
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload, timeout=timeout) as resp:
                    if resp.status == 200:
                        return True
                    err = await resp.text()
                    logger.error("Telegram alert failed: HTTP %s %s", resp.status, err[:500])
                    return False
        except Exception as exc:
            logger.error("Telegram alert failed: %r", exc)
            return False

    async def _send_email(self, subject: str, body: str, alert_type: str, severity: str) -> bool:
        if not alert.email_configured:
            logger.warning("SMTP not configured, skipping email alert")
            return False

        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"[BorosBot] [{severity}] {subject}"
        msg["From"] = alert.smtp_user
        msg["To"] = alert.alert_email

        # HTML 正文
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; padding: 20px;">
            <h2 style="color: {'red' if severity == 'CRITICAL' else 'orange'};">Boros Bot Alert</h2>
            <p><b>类型:</b> {alert_type}</p>
            <p><b>级别:</b> {severity}</p>
            <p><b>时间:</b> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>
            <hr>
            <pre style="background: #f5f5f5; padding: 15px; border-radius: 5px;">{body}</pre>
            <hr>
            <p style="color: #999; font-size: 12px;">Boros Maker Reward Bot · Auto Alert</p>
        </body>
        </html>
        """
        msg.attach(MIMEText(html_body, "html"))

        # 发送
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                self._send_smtp,
                msg,
            )
            return True
        except Exception as e:
            logger.error(f"Failed to send email alert: {e}")
            return False

    def _send_smtp(self, msg: MIMEMultipart):
        """同步 SMTP 发送"""
        if alert.smtp_port == 465:
            server = smtplib.SMTP_SSL(alert.smtp_host, alert.smtp_port, timeout=15)
        else:
            server = smtplib.SMTP(alert.smtp_host, alert.smtp_port, timeout=15)
            server.starttls()

        try:
            server.login(alert.smtp_user, alert.smtp_pass)
            server.sendmail(alert.smtp_user, alert.alert_email, msg.as_string())
        finally:
            server.quit()

    def _log_to_file(self, subject: str, body: str, severity: str):
        """邮件无法发送时写入本地日志"""
        from ..config import LOG_DIR
        alert_log = LOG_DIR / "alerts.log"
        with open(alert_log, "a", encoding="utf-8") as f:
            f.write(f"\n{'='*60}\n")
            f.write(f"[{datetime.now().isoformat()}] [{severity}] {subject}\n")
            f.write(f"{body}\n")

    # ═══════════════════════════════════════════════════
    # 便捷方法
    # ═══════════════════════════════════════════════════

    async def alert_loss_threshold(self, total_loss_usd: float, capital: float):
        """亏损超阈值告警"""
        if total_loss_usd > alert.loss_threshold_usd:
            await self.send(
                subject=f"Loss threshold exceeded: ${total_loss_usd:.0f}",
                body=(
                    f"累计亏损: ${total_loss_usd:.2f}\n"
                    f"本金: ${capital:.2f}\n"
                    f"亏损比例: {total_loss_usd/capital*100:.2f}%\n"
                    f"告警阈值: ${alert.loss_threshold_usd:.0f}"
                ),
                alert_type="LOSS_THRESHOLD",
                severity="CRITICAL",
            )

    async def alert_position_exceeded(self, position_usd: float, max_usd: float):
        """持仓超限告警"""
        await self.send(
            subject=f"Position exceeded: ${position_usd:.0f} > ${max_usd:.0f}",
            body=(
                f"当前持仓: ${position_usd:.2f}\n"
                f"最大允许: ${max_usd:.2f}\n"
                f"超额: ${position_usd - max_usd:.2f}\n"
                f"建议: 立即平仓或减少挂单"
            ),
            alert_type="POSITION_EXCEEDED",
            severity="CRITICAL",
        )

    async def alert_api_errors(self, error_count: int):
        """API 连续错误告警"""
        if error_count >= alert.api_error_threshold:
            await self.send(
                subject=f"API errors: {error_count} consecutive failures",
                body=(
                    f"连续 API 错误次数: {error_count}\n"
                    f"阈值: {alert.api_error_threshold}\n"
                    f"可能原因: 网络问题 / API 限流 / 配置错误"
                ),
                alert_type="API_ERRORS",
                severity="HIGH",
            )

    async def alert_gas_overrun(self, gas_used: float, budget: float):
        """Gas 超预算告警"""
        if gas_used > alert.gas_overrun_threshold:
            await self.send(
                subject=f"Gas overrun: ${gas_used:.2f} > ${budget:.2f}",
                body=(
                    f"今日 Gas 消耗: ${gas_used:.2f}\n"
                    f"每日预算: ${budget:.2f}\n"
                    f"超额: ${gas_used - budget:.2f}"
                ),
                alert_type="GAS_OVERRUN",
                severity="WARNING",
            )

    async def alert_system_health(self, stats: dict):
        """系统健康报告 (每 6 小时)"""
        await self.send(
            subject=f"Health Report: PnL ${stats.get('pnl', 0):.2f}",
            body=(
                f"总盈亏: ${stats.get('pnl', 0):.2f}\n"
                f"活跃市场: {stats.get('active_markets', 0)}\n"
                f"今日 Gas: ${stats.get('gas_today', 0):.2f}\n"
                f"API 错误: {stats.get('api_errors', 0)}\n"
                f"CU 消耗: {stats.get('cu_consumed', 0):.0f}\n"
                f"告警发送: {self._sent_count}/{self._daily_limit}"
            ),
            alert_type="HEALTH_REPORT",
            severity="INFO",
        )


async def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    ok = await AlertManager().send(
        subject="Telegram alert test",
        body="YIYIone alert channel is reachable.",
        alert_type="ALERT_TEST",
        severity="INFO",
        bypass_cooldown=True,
    )
    print("alert_sent=" + str(ok))
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
