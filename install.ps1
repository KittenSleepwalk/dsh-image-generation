# Qwen-Image-2.1 出图插件（KS）· 一键安装（Windows，不需要管理员）
#
# 支持两类 profile 的 cordis.patch.yml：
#   - flow 风格：[ { id: ..., name: ... }, ... ]        （web profile）
#   - block 风格：- id: ... / - insert: ...             （DSH Desktop 的 core-021 等）
#
# 做五件事：
#   1. 在 profile 的 node_modules 里建 junction 指向本目录（scoped 包名）
#   2. 在 profile 的 package.json 里加依赖 + bundle 条目
#   3. 在 profile 的 cordis.patch.yml 里插入插件 entry
#   4. 如果该 profile 里有旧的 dsh-comfyui-image，默认禁用它（同名工具）
#   5. 顺手清理旧版 dsh-qwen-image 的接线（升级不残留）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ProfileDir C:\Users\<u>\.dsh\profiles\core-021
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -CheckOnly
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -EnableOld
#
# 安装后需要重启 DSH（或该 profile 的宿主进程）才会出现工具与设置页。

[CmdletBinding()]
param(
  [string]$ProfileDir = "",
  [switch]$CheckOnly,
  [switch]$EnableOld
)

$ErrorActionPreference = 'Stop'
$pluginDir = $PSScriptRoot
if (-not $ProfileDir) { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web' }
$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).Path

$pkgPath = Join-Path $ProfileDir 'package.json'
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$pluginName = '@kittensleepwalk/dsh-image-generation-ks'
$linkRel = 'node_modules\@kittensleepwalk\dsh-image-generation-ks'
$linkPath = Join-Path $ProfileDir $linkRel
$depValue = if ($pluginDir.StartsWith($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase)) { 'link:./.dsh-local-plugins/dsh-image-generation-ks' } else { 'link:' + ($pluginDir -replace '\\\\', '/') }
$entryId = 'image-generation-ks'
$toolConflictPlugin = 'dsh-comfyui-image'
$legacyName = 'dsh-qwen-image'

function Step([string]$Message) { Write-Host "[image-ks] $Message" }
function WriteText([string]$Path, [string]$Text) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

if (-not (Test-Path -LiteralPath $pkgPath)) {
  throw "没有找到 profile 的 package.json：$pkgPath`n用 -ProfileDir 指定正确的 profile 目录。"
}
if (-not (Test-Path -LiteralPath $patchPath)) {
  throw "没有找到 profile 的 cordis.patch.yml：$patchPath"
}

$changes = New-Object System.Collections.Generic.List[string]

# ---------- 1) node_modules junction（scoped） ----------
$linkState = 'missing'
if (Test-Path -LiteralPath $linkPath) {
  $linkedName = $null
  $linkedPkg = Join-Path $linkPath 'package.json'
  if (Test-Path -LiteralPath $linkedPkg) {
    try { $linkedName = (Get-Content -LiteralPath $linkedPkg -Raw -Encoding UTF8 | ConvertFrom-Json).name } catch { $linkedName = $null }
  }
  if ($linkedName -eq $pluginName) { $linkState = 'ok' } else { $linkState = 'conflict' }
}
if ($linkState -eq 'conflict') {
  throw "$linkPath 已存在，但里面不是 $pluginName 包。先删除后重试。"
}
if ($linkState -eq 'missing') {
  if ($CheckOnly) {
    Step "will create junction: $linkRel"
  } else {
    $parent = Split-Path -Parent $linkPath
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    New-Item -ItemType Junction -Path $linkPath -Target $pluginDir | Out-Null
    Step "junction 已创建：$linkRel"
  }
  $changes.Add('junction')
} else {
  Step 'junction 已存在且正确'
}

# 清理旧版 junction（dsh-qwen-image）
$legacyLink = Join-Path $ProfileDir 'node_modules\dsh-qwen-image'
if (Test-Path -LiteralPath $legacyLink) {
  if ($CheckOnly) { Step 'will remove legacy junction node_modules\dsh-qwen-image' }
  else {
    Remove-Item -LiteralPath $legacyLink -Force
    Step '已移除旧版 junction node_modules\dsh-qwen-image'
  }
  $changes.Add('legacy-junction')
}

# ---------- 2) package.json ----------
$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.dependencies) {
  $pkg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{}) -Force
}
$pkgDirty = $false
if (-not $pkg.dependencies.PSObject.Properties[$pluginName]) {
  if ($CheckOnly) { Step "will add dependency $pluginName -> $depValue" }
  else {
    $pkg.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue $depValue
    Step "package.json：已加依赖 $pluginName"
  }
  $pkgDirty = $true
  $changes.Add('dependency')
}
if ($pkg.dependencies.PSObject.Properties[$legacyName]) {
  $pkg.dependencies.PSObject.Properties.Remove($legacyName)
  $pkgDirty = $true
  $changes.Add('legacy-dependency')
  Step 'package.json：已移除旧依赖 dsh-qwen-image'
}
if (-not ($pkg.dsh -and $pkg.dsh.profile)) {
  throw "profile 的 package.json 缺少 dsh.profile 段，无法注册 bundle。"
}
$bundles = @()
if ($pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }
$kept = @($bundles | Where-Object { $_ -ne $legacyName })
if ($kept.Count -ne $bundles.Count) {
  $pkg.dsh.profile.bundles = $kept
  $pkgDirty = $true
  $changes.Add('legacy-bundle')
  Step 'package.json：已移除旧 bundle dsh-qwen-image'
}
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains $pluginName) {
  if ($CheckOnly) { Step "will add bundle $pluginName" }
  else {
    $pkg.dsh.profile.bundles = @($bundles + $pluginName)
    Step "package.json：已加 bundle $pluginName"
  }
  $pkgDirty = $true
  $changes.Add('bundle')
}
if ($pkgDirty -and -not $CheckOnly) {
  WriteText $pkgPath (($pkg | ConvertTo-Json -Depth 40) + "`n")
}

# ---------- 3) cordis.patch.yml（兼容 flow / block 两种风格） ----------
$patch = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
if ($patch -match 'dsh-qwen-image') {
  $patch = [regex]::Replace($patch, ",\s*\{\s*insert:\s*\[\s*\{\s*id:\s*qwen-image[^}]*\}\s*\]\s*\}", '')
  $patch = [regex]::Replace($patch, ",\s*\{\s*id:\s*dsh-qwen-image[^}]*\}", '')
  Step 'cordis.patch.yml：已清理旧版入口'
  $changes.Add('legacy-patch')
}
if ($patch -notmatch [regex]::Escape($pluginName)) {
  $needDisableOld = (-not $EnableOld) -and [bool]$pkg.dependencies.PSObject.Properties[$toolConflictPlugin] -and ($patch -notmatch "id:\s*$toolConflictPlugin[^}]*disabled:\s*true")
  $trimmedPatch = $patch.TrimStart()
  if ($trimmedPatch.StartsWith('[')) {
    # flow 风格
    $entry = "{ insert: [ { id: $entryId, name: '$pluginName' } ] }"
    if ($needDisableOld) {
      $entry = "{ id: $toolConflictPlugin, name: $toolConflictPlugin, disabled: true }, " + $entry
      Step "cordis.patch.yml：顺带禁用旧插件 $toolConflictPlugin（避免两个 generate_image 撞名；用 -EnableOld 可保留）"
    }
    $idx = $patch.LastIndexOf(']')
    if ($idx -lt 0) { throw 'cordis.patch.yml 结构异常：找不到顶层数组的结尾 ]' }
    $updated = $patch.Substring(0, $idx) + ", $entry " + $patch.Substring($idx)
  } else {
    # block 风格
    $lines = New-Object System.Collections.Generic.List[string]
    if ($needDisableOld) {
      $lines.Add('- id: ' + $toolConflictPlugin)
      $lines.Add('  name: ' + $toolConflictPlugin)
      $lines.Add('  disabled: true')
      Step "cordis.patch.yml：顺带禁用旧插件 $toolConflictPlugin"
    }
    $lines.Add('- insert:')
    $lines.Add('    - id: ' + $entryId)
    $lines.Add("      name: '$pluginName'")
    $updated = $patch.TrimEnd() + "`n" + ($lines -join "`n") + "`n"
  }
  if ($CheckOnly) { Step 'will insert plugin entry into cordis.patch.yml' }
  else {
    WriteText $patchPath $updated
    Step 'cordis.patch.yml：已插入插件 entry'
  }
  $changes.Add('patch')
} else {
  Step 'cordis.patch.yml：已有插件 entry'
}

# ---------- 4) 汇总 ----------
Write-Host ''
Step '-------- 安装结果 --------'
Step "profile      : $ProfileDir"
Step "plugin       : $pluginDir"
Step "junction     : $linkState"
Step "dependencies : $pluginName"
Step "bundles      : $pluginName"
Step "patch entry  : $entryId"
if ($CheckOnly) {
  Step '这是 -CheckOnly 模式，没有修改任何文件。'
  exit 0
}
if ($changes.Count -eq 0) {
  Step '没有需要改的东西（已经是安装状态）。'
} else {
  Step ("本次修改：" + ($changes -join ', '))
}
Write-Host ''
Step '下一步：'
Step '  1. 重启对应 profile 的 DSH 宿主（桌面版：完全退出再打开；Web：重启 dsh web 进程）'
Step '  2. 设置页应出现「图像生成 (KS)」：可一键打开 ComfyUI、管模型'
Step '  3. 会话里说「画一张 …」，或让 Agent 调 generate_image / image_models'
Step '  4. 体检：node scripts/doctor.mjs'
Write-Host ''
