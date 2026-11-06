<#
.SYNOPSIS
  One-command installer for OpenCode Router Gateway on Windows.

.DESCRIPTION
  Installs dependencies, builds the dashboard, downloads Xray-core (with mirror
  fallback for restricted networks) and prepares .env. Idempotent: safe to re-run.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy\install.ps1 -XrayBase "https://gh-proxy.com/https://github.com"
#>
param(
    [string]$XrayBase = "https://github.com",
    [string]$XrayVersion = "v26.10.31",
    [switch]$SkipXray
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "xx  $msg" -ForegroundColor Red; exit 1 }

Write-Step "OpenCode Router Gateway — Windows installer"
Write-Host "    root: $root"

# ---------------------------------------------------------------- node
try {
    $nodeVersion = (node -v) -replace '^v', ''
} catch {
    Fail "Node.js is required (>= 18). Install it from https://nodejs.org and re-run."
}
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 18) { Fail "Node.js >= 18 required (found v$nodeVersion)" }
Write-Step "Node v$nodeVersion detected"

# ---------------------------------------------------------------- deps
Write-Step "Installing npm dependencies"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }

Write-Step "Rebuilding native modules"
npm rebuild better-sqlite3 2>$null | Out-Null

# ---------------------------------------------------------------- frontend
Write-Step "Building dashboard"
Push-Location (Join-Path $root 'src\frontend')
try {
    npx vite build
    if ($LASTEXITCODE -ne 0) { Fail "vite build failed" }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------- xray
$binDir = Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$xrayExe = Join-Path $binDir 'xray.exe'

if (-not $SkipXray -and -not (Test-Path $xrayExe)) {
    Write-Step "Downloading Xray-core $XrayVersion"
    $zip = Join-Path $env:TEMP "xray-$([guid]::NewGuid().ToString('N')).zip"
    $raw = "$XrayBase/XTLS/Xray-core/releases/download/$XrayVersion/Xray-windows-64.zip"
    $urls = @($raw, "https://gh-proxy.com/$raw", "https://ghfast.top/$raw")
    $ok = $false
    foreach ($u in $urls) {
        try {
            Invoke-WebRequest -Uri $u -OutFile $zip -TimeoutSec 180 -UseBasicParsing
            if ((Get-Item $zip).Length -gt 1000000) { $ok = $true; break }
        } catch {
            Write-Warn "mirror failed: $u"
        }
    }
    if ($ok) {
        Expand-Archive -Path $zip -DestinationPath $binDir -Force
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Write-Step "Xray installed: $xrayExe"
    } else {
        Write-Warn "could not download Xray — place xray.exe in .\bin\ manually"
    }
}

# ---------------------------------------------------------------- env
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $root '.env.example') $envFile
    Write-Step "Created .env from template"
    Write-Warn "Edit .env and set GATEWAY_UPSTREAM_BASE_URL / GATEWAY_UPSTREAM_API_KEY"
} else {
    Write-Step "Keeping existing .env"
}

# ---------------------------------------------------------------- ports
Write-Step "Checking loopback ports"
foreach ($port in 3000, 12000, 12001, 12002, 12003) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $owner = ($conn | Select-Object -First 1).OwningProcess
        Write-Warn "port $port is already in use by PID $owner (pool will retry on another base port)"
    }
}

Write-Host ""
Write-Host "------------------------------------------------------------" -ForegroundColor Green
Write-Host " Installed." -ForegroundColor Green
Write-Host "   Start:  powershell -ExecutionPolicy Bypass -File .\start.ps1"
Write-Host "   Open:   http://localhost:3000"
Write-Host "   Next:   set the upstream in .env, then enable the gateway:"
Write-Host "           Invoke-RestMethod -Method Put http://127.0.0.1:3000/api/settings ``"
Write-Host "             -ContentType 'application/json' -Body '{\"gateway_enabled\":\"true\"}'"
Write-Host "------------------------------------------------------------" -ForegroundColor Green
