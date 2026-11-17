# 卸载：移除 junction / 依赖 / bundle / patch entry，并恢复旧出图插件。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
# 注意：不会删除插件目录本身，也不会动 ComfyUI 和权重。

[CmdletBinding()]
param([string]$ProfileDir = "")

$ErrorActionPreference = 'Stop'
if (-not $ProfileDir) { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web' }
$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).Path
$pkgPath = Join-Path $ProfileDir 'package.json'
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$pluginName = '@kittensleepwalk/dsh-image-generation-ks'
$linkPath = Join-Path $ProfileDir 'node_modules\@kittensleepwalk\dsh-image-generation-ks'
$toolConflictPlugin = 'dsh-comfyui-image'

function Step([string]$Message) { Write-Host "[image-ks] $Message" }
function WriteText([string]$Path, [string]$Text) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -eq 'Junction') {
    Remove-Item -LiteralPath $linkPath -Force
    Step "已删除 junction: $linkPath"
  } else {
    Step "跳过：$linkPath 不是 junction（未动它）"
  }
}

if (Test-Path -LiteralPath $pkgPath) {
  $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $dirty = $false
  if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties[$pluginName]) {
    $pkg.dependencies.PSObject.Properties.Remove($pluginName)
    $dirty = $true
    Step 'package.json：已移除依赖'
  }
  if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
    $kept = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $pluginName })
    if ($kept.Count -ne @($pkg.dsh.profile.bundles).Count) {
      $pkg.dsh.profile.bundles = $kept
      $dirty = $true
      Step 'package.json：已移除 bundle'
    }
  }
  if ($dirty) { WriteText $pkgPath (($pkg | ConvertTo-Json -Depth 40) + "`n") }
}

if (Test-Path -LiteralPath $patchPath) {
  $patch = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
  $original = $patch
  $patch = [regex]::Replace($patch, ",\s*\{\s*insert:\s*\[\s*\{\s*id:\s*image-generation-ks[^}]*\}\s*\]\s*\}", '')
  $patch = [regex]::Replace($patch, ",\s*\{\s*id:\s*$toolConflictPlugin,\s*name:\s*$toolConflictPlugin,\s*disabled:\s*true\s*\}", '')
  if ($patch -ne $original) {
    WriteText $patchPath $patch
    Step 'cordis.patch.yml：已移除条目并恢复旧插件'
  } else {
    Step 'cordis.patch.yml：没有找到插件条目'
  }
}

Step '卸载完成。重启 DSH 后生效。'
Step '（插件目录与 ComfyUI/权重都保留，重新双击 install.cmd 即可再次安装）'
