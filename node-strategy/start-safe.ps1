# 防睡眠 + 崩溃自启 启动脚本(对应最新版 lo-bot-safe.js)
Add-Type -Name Power -Namespace System -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED = 阻止系统自动休眠
[System.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host " 防睡眠已开启 · 启动 lo-bot-safe.js (最新版)" -ForegroundColor Green
Write-Host " 崩溃后自动5秒重启 · 关闭窗口或Ctrl+C停止" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
while ($true) {
    node lo-bot-safe.js
    Write-Host "`n[!] bot 已停止,5秒后自动重启..." -ForegroundColor Red
    Start-Sleep -Seconds 5
}