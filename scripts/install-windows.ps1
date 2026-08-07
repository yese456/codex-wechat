# codex-wechat Windows setup (run in PowerShell)
# Prerequisites: Node.js 22+, Codex CLI logged in (`codex login`)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "==> codex-wechat Windows install"
Write-Host "    root=$Root"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js not found. Install Node 22+ from https://nodejs.org/"
}
$nv = node -v
Write-Host "    node $nv"

if (Test-Path "package-lock.json") {
  npm ci
} else {
  npm install
}
npm run typecheck
npm test
npm run build

$cfgDir = Join-Path $env:USERPROFILE ".codex-wechat"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = Join-Path $cfgDir "config.yaml"
if (-not (Test-Path $cfg)) {
  $agentToken = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
  @"
machine_name: windows
default_cwd: ~/code
approval_timeout_sec: 300
max_reply_chars: 3500
agent:
  host: 127.0.0.1
  port: 18765
  token: $agentToken
"@ | Set-Content -Path $cfg -Encoding UTF8
  Write-Host "==> wrote $cfg"
}

Write-Host ""
Write-Host "Next:"
Write-Host "  1) codex login"
Write-Host "  2) node dist/src/cli.js start          # gateway (WeChat)"
Write-Host "     or: node dist/src/cli.js agent     # agent only (multi-host)"
Write-Host "  3) node dist/src/cli.js bind"
Write-Host ""
Write-Host "To run at logon: Task Scheduler -> trigger At log on ->"
Write-Host "  program: node   args: `"$Root\dist\src\cli.js`" start"
Write-Host "  start in: $Root"
Write-Host "Or use NSSM to install as a service."
