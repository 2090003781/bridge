# Bridge · 部署到 Obsidian 库
# 用法：powershell -File scripts\deploy.ps1 [-Vault "D:\个人数据\辞玖"]
param(
  [string]$Vault = "D:\个人数据\辞玖"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $Vault ".obsidian\plugins\obsidian-bridge"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host "[1/3] 打包（src/lib 内联成单文件 main.js）"
node (Join-Path $root "scripts\build.js")

if (Test-Path $dest) {
  $backup = Join-Path $Vault ".obsidian\plugins\.obsidian-bridge.bak-$stamp"
  Copy-Item $dest $backup -Recurse -Force
  Write-Host "[2/3] 已备份旧插件到 $backup"
} else {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Write-Host "[2/3] 新建插件目录"
}

Copy-Item (Join-Path $root "manifest.json") $dest -Force
Copy-Item (Join-Path $root "dist\main.js") $dest -Force
Write-Host "[3/3] 已部署到 $dest"
Get-ChildItem $dest | Select-Object Name, Length | Format-Table -AutoSize
Write-Host "启用：把 `"obsidian-bridge`" 写进 .obsidian/community-plugins.json，然后重启 Obsidian。"