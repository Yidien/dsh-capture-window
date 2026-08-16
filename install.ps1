# ============================================================
# dsh-capture-window · installer
# Builds host (lib/) + client (dist/), installs into the web
# profile, appends the composition line, then tells you to restart.
# Prereqs: node + pnpm (corepack enable pnpm / npm i -g pnpm)
# NOTE: writes to $DSH_HOME and npm cache; run in a normal terminal.
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$pluginName = 'dsh-capture-window'

Write-Host "==> [1/5] Installing build deps"
Push-Location $root
try {
  if (-not (Test-Path 'node_modules')) { pnpm install --ignore-scripts }
} finally { Pop-Location }

Write-Host "==> [2/5] Building host (tsc -> lib/index.js)"
Push-Location $root
try {
  pnpm exec tsc -p tsconfig.json
} finally { Pop-Location }

Write-Host "==> [3/5] Building client bundle (tsdown -> dist/client.cjs)"
Push-Location $root
try {
  pnpm exec tsdown
} finally { Pop-Location }

Write-Host "==> [4/5] Installing into profile node_modules"
Push-Location $profileDir
try {
  pnpm add "$root"
} finally { Pop-Location }

Write-Host "==> [5/5] Appending plugin insert to cordis.patch.yml (idempotent)"
$line = "- insert:`n    - id: $pluginName`n      name: '$pluginName'"
$content = if (Test-Path $patchFile) { Get-Content $patchFile -Raw -Encoding UTF8 } else { '[]' }
if ($content -notmatch $pluginName) {
  if ($content.Trim() -eq '[]') {
    Set-Content -Path $patchFile -Value $line -Encoding UTF8
  } else {
    Add-Content -Path $patchFile -Value $line -Encoding UTF8
  }
  Write-Host "    written to $patchFile"
} else {
  Write-Host "    already present, skipped"
}

Write-Host ""
Write-Host "==> Done. Restart dsh web to take effect:"
Write-Host "    stop the current dsh web process, then run: npx @deepseek-ai/dsh web"
Write-Host "    verify: press Ctrl+Shift+K to open the capture window."
