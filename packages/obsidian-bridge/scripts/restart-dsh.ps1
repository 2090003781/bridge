# 重启 DSH web（Bridge 注入 / 连接器新代码需要重启才生效）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File .\restart-dsh.ps1
$ErrorActionPreference = "Stop"
# 自动探测 node（避免把安装路径写死）
# PowerShell 5.1 不认 ?. （那是 PS 7 的语法），老老实实两步走
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = $null
if ($nodeCmd) { $node = $nodeCmd.Source }
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$bin = Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
if (-not (Test-Path $bin)) { throw "找不到 dsh bin.js：$bin" }

$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -match 'dsh\\lib\\bin\.js"+\s+web|dsh/lib/bin\.js\s+web'
}
if ($targets) {
  foreach ($p in $targets) {
    Write-Host "停止 DSH PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Host "没找到运行中的 DSH web 进程"
}

Start-Sleep -Seconds 2
Write-Host "启动 DSH web（新窗口）"
Start-Process -FilePath $node -ArgumentList @($bin, 'web') -WorkingDirectory 'D:\RAG'
Write-Host "已拉起。等 10 秒后可用 http://127.0.0.1:18080 检查。"