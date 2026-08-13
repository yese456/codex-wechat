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
  if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected -and $env:CODEX_WECHAT_NONINTERACTIVE -ne "1") {
    Write-Host "==> running first-use wizard"
    node dist/src/cli.js init
  } else {
    $agentToken = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
    @"
startup_mode: gateway
machine_name: windows
default_cwd: ~/code
allowed_roots:
  - ~/code
codex_sandbox_mode: read-only
codex_approval_policy: on-request
approval_timeout_sec: 300
max_reply_chars: 3500
agent:
  host: 127.0.0.1
  port: 18765
  token: $agentToken
  allow_insecure_http: false
"@ | Set-Content -Path $cfg -Encoding UTF8
    Write-Host "==> wrote $cfg (non-interactive safe defaults)"
  }
} else {
  Write-Host "==> keep existing $cfg"
}

Write-Host ""
Write-Host "Next:"
Write-Host "  1) codex login"
Write-Host "  2) node dist/src/cli.js                # 按 startup_mode 启动"
Write-Host "     or: node dist/src/cli.js host     # 显式 Host / Gateway"
Write-Host "     or: node dist/src/cli.js agent    # 显式 Agent"
Write-Host "  3) Host / Gateway 模式运行 node dist/src/cli.js bind"
Write-Host ""
Write-Host "To run at logon: Task Scheduler -> trigger At log on ->"
Write-Host "  program: node   args: `"$Root\dist\src\cli.js`""
Write-Host "  start in: $Root"
Write-Host "Or use NSSM to install as a service."
