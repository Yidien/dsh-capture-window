# ============================================================
# dsh-capture-window · installer (source install)
# Builds host (lib/) + client (dist/), then installs into the
# web profile via `dsh plugin add` (auto-registers through
# dsh.bundle.patch — no manual cordis.patch.yml edit).
# Prereqs: node + pnpm + npx access to @deepseek-ai/dsh
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "==> [1/4] Installing build deps"
Push-Location $root
try {
  if (-not (Test-Path 'node_modules')) { pnpm install --ignore-scripts }
} finally { Pop-Location }

Write-Host "==> [2/4] Building host (tsc -> lib/index.js)"
Push-Location $root
try {
  pnpm exec tsc -p tsconfig.json
} finally { Pop-Location }

Write-Host "==> [3/4] Building client bundle (tsdown -> dist/client.cjs)"
Push-Location $root
try {
  pnpm exec tsdown
} finally { Pop-Location }

Write-Host "==> [4/4] Installing into web profile (auto-registers via dsh.bundle.patch)"
npx --yes @deepseek-ai/dsh plugin --profile web add "$root"

Write-Host ""
Write-Host "==> Done. Restart dsh web to take effect:"
Write-Host "    stop the current dsh web process, then run: npx @deepseek-ai/dsh web"
Write-Host "    verify: press Ctrl+Shift+K to open the capture window."
