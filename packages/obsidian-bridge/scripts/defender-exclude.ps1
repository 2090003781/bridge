# Bridge 启动优化 · Windows Defender 排除项（需要管理员）
# 用法：右键「以管理员身份运行 PowerShell」，然后：
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\obsidian-bridge\scripts\defender-exclude.ps1
$paths = @(
  'C:\Users\20900\AppData\Roaming\npm\node_modules',
  'C:\Python311',
  'C:\Users\20900\.dsh',
  'D:\obsidian-bridge',
  'D:\qq-bridge',
  'E:\VMs\_tools'
)
foreach ($p in $paths) {
  try { Add-MpPreference -ExclusionPath $p -ErrorAction Stop; Write-Host "✅ 路径 $p" }
  catch { Write-Host "❌ 路径 $p：$($_.Exception.Message)" }
}
foreach ($n in @('python.exe','pythonw.exe','node.exe')) {
  try { Add-MpPreference -ExclusionProcess $n -ErrorAction Stop; Write-Host "✅ 进程 $n" }
  catch { Write-Host "❌ 进程 $n：$($_.Exception.Message)" }
}
Write-Host "`n当前排除路径："
(Get-MpPreference).ExclusionPath
Write-Host "`n当前排除进程："
(Get-MpPreference).ExclusionProcess