# =============================================================================
# Conciliación · Instalador automático para Windows
# =============================================================================
# Uso (en el servidor, con PowerShell como administrador):
#   1. git clone <repo> C:\conciliacion
#   2. cd C:\conciliacion
#   3. .\deploy\setup.ps1
#
# Qué hace:
#   · Verifica que Node.js, PostgreSQL y Git estén instalados
#   · Instala PM2 + pm2-windows-startup si faltan
#   · Pide credenciales y genera un .env de producción seguro
#   · Crea la BD si no existe
#   · npm install + prisma + seed + build
#   · Configura firewall + PM2 startup
#   · Inicia el servicio
# =============================================================================

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

function Write-Step {
    param([string]$Msg)
    Write-Host ""
    Write-Host "==> $Msg" -ForegroundColor Cyan
}

function Write-Ok    { param([string]$Msg) Write-Host "  [OK] $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "  [!]  $Msg" -ForegroundColor Yellow }
function Write-Fail  { param([string]$Msg) Write-Host "  [X]  $Msg" -ForegroundColor Red }
function Write-Info  { param([string]$Msg) Write-Host "       $Msg" -ForegroundColor Gray }

function Test-IsAdmin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($current)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Sólo paramos si NO es admin Y el usuario no pasó -SkipAdminCheck
if (-not (Test-IsAdmin)) {
    Write-Warn "Este script normalmente se ejecuta como administrador."
    Write-Info "Necesitamos privilegios para configurar el firewall y registrar PM2 como servicio."
    $resp = Read-Host "¿Continuar de todas formas? (s/N)"
    if ($resp -ne "s" -and $resp -ne "S") {
        Write-Host "Cancelado. Reinicia PowerShell como administrador." -ForegroundColor Yellow
        exit 1
    }
}

# Carpeta del proyecto = padre de este script
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot
Write-Host ""
Write-Host "Proyecto: $ProjectRoot" -ForegroundColor White

# -----------------------------------------------------------------------------
# 1. Verificar prerrequisitos
# -----------------------------------------------------------------------------
Write-Step "1/10 Verificando prerrequisitos"

# Node.js
try {
    $nodeVersion = & node --version 2>&1
    if ($nodeVersion -match "v(\d+)") {
        $major = [int]$matches[1]
        if ($major -lt 18) {
            Write-Fail "Node.js $nodeVersion encontrado, pero se requiere v18+"
            exit 1
        }
        Write-Ok "Node.js $nodeVersion"
    }
} catch {
    Write-Fail "Node.js no encontrado. Instala desde https://nodejs.org (v20 LTS recomendado)"
    exit 1
}

# Git
try {
    $gitVersion = & git --version 2>&1
    Write-Ok ($gitVersion -join " ")
} catch {
    Write-Warn "Git no encontrado (opcional, pero recomendado para actualizaciones)"
}

# PostgreSQL: probar conexión al puerto
$pgRunning = (Test-NetConnection -ComputerName localhost -Port 5432 -WarningAction SilentlyContinue).TcpTestSucceeded
if ($pgRunning) {
    Write-Ok "PostgreSQL escuchando en localhost:5432"
} else {
    Write-Fail "PostgreSQL no responde en localhost:5432. Asegúrate de que el servicio esté corriendo."
    exit 1
}

# Buscar psql.exe
$psqlPath = $null
foreach ($p in @(
    "C:\Program Files\PostgreSQL\18\bin\psql.exe",
    "C:\Program Files\PostgreSQL\17\bin\psql.exe",
    "C:\Program Files\PostgreSQL\16\bin\psql.exe",
    "C:\Program Files\PostgreSQL\15\bin\psql.exe"
)) {
    if (Test-Path $p) { $psqlPath = $p; break }
}
if (-not $psqlPath) {
    $psqlPath = (Get-Command psql.exe -ErrorAction SilentlyContinue).Source
}
if (-not $psqlPath) {
    Write-Fail "No encontré psql.exe. Asegúrate de que PostgreSQL esté instalado."
    exit 1
}
Write-Ok "psql en $psqlPath"

# PM2
$pm2Installed = $null -ne (Get-Command pm2 -ErrorAction SilentlyContinue)
if (-not $pm2Installed) {
    Write-Info "Instalando PM2 (gestor de procesos)..."
    & npm install -g pm2 pm2-windows-startup | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Error instalando PM2"
        exit 1
    }
    Write-Ok "PM2 instalado"
} else {
    Write-Ok "PM2 ya estaba instalado"
}

# -----------------------------------------------------------------------------
# 2. Recolectar configuración
# -----------------------------------------------------------------------------
Write-Step "2/10 Configuración"

$envPath = Join-Path $ProjectRoot ".env"
$envExists = Test-Path $envPath

if ($envExists) {
    Write-Warn "Ya existe un .env. ¿Quieres reescribirlo? (s/N)"
    $rewrite = Read-Host
    if ($rewrite -ne "s" -and $rewrite -ne "S") {
        Write-Info "Manteniendo .env existente."
        $skipEnv = $true
    } else {
        $skipEnv = $false
    }
} else {
    $skipEnv = $false
}

if (-not $skipEnv) {
    Write-Host ""
    Write-Host "  Datos de configuración:" -ForegroundColor White

    # Password de Postgres (usuario postgres)
    $pgPass = Read-Host "  Password del usuario PostgreSQL 'postgres'" -AsSecureString
    $pgPassPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pgPass)
    )

    # Email del usuario gerencia
    $defaultEmail = "gerencia@moregiros.cl"
    $adminEmail = Read-Host "  Email del usuario gerencia [$defaultEmail]"
    if ([string]::IsNullOrWhiteSpace($adminEmail)) { $adminEmail = $defaultEmail }

    # Password del usuario gerencia
    do {
        $adminPass = Read-Host "  Password del usuario gerencia (mín 6 chars)" -AsSecureString
        $adminPassPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminPass)
        )
        if ($adminPassPlain.Length -lt 6) {
            Write-Warn "Demasiado corto, mínimo 6 caracteres."
        }
    } while ($adminPassPlain.Length -lt 6)

    # API Key Dynatech
    $defaultDynKey = "MCX_2026_8fA92kLxQp7ZtR4vNw3YdH6BjKmP9uS"
    $dynKey = Read-Host "  Dynatech API Key [usar default]"
    if ([string]::IsNullOrWhiteSpace($dynKey)) { $dynKey = $defaultDynKey }

    $defaultDynUrl = "http://172.16.10.172:5158/api/depositos"
    $dynUrl = Read-Host "  Dynatech API URL [$defaultDynUrl]"
    if ([string]::IsNullOrWhiteSpace($dynUrl)) { $dynUrl = $defaultDynUrl }

    # Puerto
    $defaultPort = 3000
    $port = Read-Host "  Puerto [$defaultPort]"
    if ([string]::IsNullOrWhiteSpace($port)) { $port = $defaultPort }

    # JWT_SECRET aleatorio (compatible con PowerShell 5.1)
    $rngBytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($rngBytes)
    $rng.Dispose()
    $jwtSecret = [Convert]::ToBase64String($rngBytes)

    # Escribir .env
    $envContent = @"
# Generado por deploy/setup.ps1 — $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

# Base de datos
DATABASE_URL="postgresql://postgres:$pgPassPlain@localhost:5432/conciliacion?schema=public"

# Auth
JWT_SECRET="$jwtSecret"

# Usuario gerencia inicial
SEED_ADMIN_EMAIL="$adminEmail"
SEED_ADMIN_PASSWORD="$adminPassPlain"
SEED_ADMIN_NAME="Gerencia"

# Dynatech
DYNATECH_API_URL="$dynUrl"
DYNATECH_API_KEY="$dynKey"
DYNATECH_TIMEZONE_OFFSET="-04:00"

# Producción
NODE_ENV=production
PORT=$port
"@
    # UTF-8 sin BOM para evitar problemas con parsers
    [IO.File]::WriteAllText($envPath, $envContent, (New-Object Text.UTF8Encoding $false))
    Write-Ok ".env generado"
} else {
    # Cargar el puerto del .env existente
    $envLines = Get-Content $envPath
    $portLine = $envLines | Where-Object { $_ -match "^PORT=" }
    if ($portLine) {
        $port = ($portLine -split "=")[1].Trim()
    } else {
        $port = 3000
    }
    # Cargar password de postgres del .env (para crear la BD)
    $dbUrlLine = $envLines | Where-Object { $_ -match "^DATABASE_URL=" }
    if ($dbUrlLine -match 'postgresql://postgres:([^@]+)@') {
        $pgPassPlain = $matches[1]
    }
}

# -----------------------------------------------------------------------------
# 3. Crear base de datos si no existe
# -----------------------------------------------------------------------------
Write-Step "3/10 Base de datos"

$env:PGPASSWORD = $pgPassPlain
$dbExists = & $psqlPath -U postgres -h localhost -tAc "SELECT 1 FROM pg_database WHERE datname='conciliacion'" 2>$null

if ($dbExists -eq "1") {
    Write-Ok "Base de datos 'conciliacion' ya existe"
} else {
    Write-Info "Creando base de datos 'conciliacion'..."
    & $psqlPath -U postgres -h localhost -d postgres -c "CREATE DATABASE conciliacion;" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Error creando la base. ¿Password de postgres correcta?"
        exit 1
    }
    Write-Ok "Base de datos creada"
}
$env:PGPASSWORD = $null

# -----------------------------------------------------------------------------
# 4. npm install
# -----------------------------------------------------------------------------
Write-Step "4/10 Instalando dependencias (puede tardar 1-3 min)"
& npm install --no-audit --no-fund | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "npm install falló"
    exit 1
}
Write-Ok "Dependencias instaladas"

# -----------------------------------------------------------------------------
# 5. Asegurar script start:server en package.json
# -----------------------------------------------------------------------------
Write-Step "5/10 Configurando scripts de inicio"

$pkgPath = Join-Path $ProjectRoot "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json

if (-not $pkg.scripts.PSObject.Properties.Name.Contains("start:server")) {
    $pkg.scripts | Add-Member -NotePropertyName "start:server" -NotePropertyValue "next start -H 0.0.0.0"
    $pkgJson = $pkg | ConvertTo-Json -Depth 10
    # UTF-8 sin BOM (Set-Content lo escribe con BOM y rompe JSON parsers)
    [IO.File]::WriteAllText($pkgPath, $pkgJson, (New-Object Text.UTF8Encoding $false))
    Write-Ok "Script 'start:server' agregado a package.json"
} else {
    Write-Ok "Script 'start:server' ya existía"
}

# -----------------------------------------------------------------------------
# 6. Prisma
# -----------------------------------------------------------------------------
Write-Step "6/10 Aplicando schema de Prisma"

& npx prisma generate | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "prisma generate falló"
    exit 1
}
Write-Ok "Cliente Prisma generado"

& npx prisma db push | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "prisma db push falló"
    exit 1
}
Write-Ok "Schema aplicado a la BD"

# -----------------------------------------------------------------------------
# 7. Seed
# -----------------------------------------------------------------------------
Write-Step "7/10 Sembrando datos iniciales"
& npm run db:seed | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "El seed reportó un error (puede ser normal si ya estaba sembrado)"
} else {
    Write-Ok "Datos iniciales sembrados (usuario gerencia + cuentas)"
}

# -----------------------------------------------------------------------------
# 8. Build de producción
# -----------------------------------------------------------------------------
Write-Step "8/10 Compilando build de producción (puede tardar 1-2 min)"
& npm run build | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "npm run build falló. Revisa errores ejecutando manualmente: npm run build"
    exit 1
}
Write-Ok "Build listo"

# -----------------------------------------------------------------------------
# 9. Firewall
# -----------------------------------------------------------------------------
Write-Step "9/10 Configurando firewall"

$ruleName = "Conciliación TCP $port"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Ok "Regla de firewall ya existía"
} else {
    try {
        New-NetFirewallRule -DisplayName $ruleName `
            -Direction Inbound -LocalPort $port -Protocol TCP -Action Allow `
            -ErrorAction Stop | Out-Null
        Write-Ok "Regla de firewall creada (puerto $port abierto)"
    } catch {
        Write-Warn "No se pudo crear la regla de firewall (¿corriendo como admin?). Hazlo manual:"
        Write-Info "  New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -LocalPort $port -Protocol TCP -Action Allow"
    }
}

# -----------------------------------------------------------------------------
# 10. PM2 + startup
# -----------------------------------------------------------------------------
Write-Step "10/10 Configurando servicio PM2"

# Detectar si ya hay un proceso 'conciliacion' corriendo
$pm2List = & pm2 jlist 2>$null
$alreadyRunning = $false
try {
    $procs = $pm2List | ConvertFrom-Json
    foreach ($p in $procs) {
        if ($p.name -eq "conciliacion") { $alreadyRunning = $true; break }
    }
} catch {}

if ($alreadyRunning) {
    Write-Info "Eliminando proceso PM2 anterior..."
    & pm2 delete conciliacion | Out-Null
}

Write-Info "Iniciando proceso PM2 'conciliacion' desde ecosystem.config.js..."
& pm2 start ecosystem.config.js | Out-Null
Write-Ok "Proceso iniciado"

& pm2 save | Out-Null
Write-Ok "Configuración PM2 guardada"

# Configurar startup (sólo si no estaba)
$startupConfigured = $null -ne (Get-Service -Name "PM2" -ErrorAction SilentlyContinue)
if (-not $startupConfigured) {
    Write-Info "Configurando inicio automático con Windows..."
    & pm2-startup install | Out-Null
    & pm2 save | Out-Null
    Write-Ok "PM2 arrancará automáticamente al iniciar Windows"
} else {
    Write-Ok "Servicio de startup ya estaba configurado"
}

# -----------------------------------------------------------------------------
# Listo
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "=========================================================" -ForegroundColor Green
Write-Host "  INSTALACIÓN COMPLETA" -ForegroundColor Green
Write-Host "=========================================================" -ForegroundColor Green
Write-Host ""

# Detectar IPs locales
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.PrefixOrigin -ne "WellKnown" -and
        $_.IPAddress -ne "127.0.0.1" -and
        $_.InterfaceAlias -notmatch "Loopback|vEthernet"
    } |
    Select-Object -ExpandProperty IPAddress

Write-Host "Acceder a la aplicación:" -ForegroundColor White
Write-Host "  Local:    http://localhost:$port" -ForegroundColor Cyan
foreach ($ip in $ips) {
    Write-Host "  Red:      http://${ip}:${port}" -ForegroundColor Cyan
}
Write-Host ""
if (-not $skipEnv) {
    Write-Host "Credenciales iniciales:" -ForegroundColor White
    Write-Host "  Email:    $adminEmail" -ForegroundColor Cyan
    Write-Host "  Password: (la que ingresaste)" -ForegroundColor Cyan
    Write-Host ""
}
Write-Host "Comandos útiles:" -ForegroundColor White
Write-Host "  pm2 status              - estado del proceso" -ForegroundColor Gray
Write-Host "  pm2 logs conciliacion   - ver logs en vivo" -ForegroundColor Gray
Write-Host "  pm2 restart conciliacion - reiniciar" -ForegroundColor Gray
Write-Host "  .\deploy\update.bat      - actualizar a la última versión" -ForegroundColor Gray
Write-Host ""
