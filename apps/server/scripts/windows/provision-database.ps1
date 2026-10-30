[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ServerRoot,
    [string]$PostgresBinDirectory = 'C:\Program Files\PostgreSQL\18\bin',
    [string]$DatabaseName = 'billing',
    [string]$ServerHost = '127.0.0.1',
    [int]$ApiPort = 4317,
    [string]$TlsCertificatePath,
    [string]$TlsPrivateKeyPath,
    [string]$TlsServerName,
    [string]$MigrationEnvironmentFile = (Join-Path $env:ProgramData 'MultiBusinessBilling\operator\migrations.env'),
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = [System.IO.Path]::GetFullPath($ServerRoot)
$applicationEnvironmentFile = Join-Path $resolvedRoot '.env'

function Test-LoopbackAddress([string]$HostName) {
    if ($HostName -eq 'localhost') { return $true }
    $address = $null
    if ([System.Net.IPAddress]::TryParse($HostName, [ref]$address)) {
        return [System.Net.IPAddress]::IsLoopback($address)
    }
    return $false
}

function ConvertTo-PgPassField([string]$Value) {
    return $Value.Replace('\', '\\').Replace(':', '\:')
}

function New-UrlSafePassword {
    $bytes = New-Object byte[] 36
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Set-PrivateFilePermissions([string]$Path) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $Path /inheritance:r /grant:r "$identity:F" 'BUILTIN\Administrators:F' 'NT AUTHORITY\SYSTEM:F' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to a temporary credential file.' }
}

if ($DatabaseName -notmatch '^[a-z][a-z0-9_]{2,62}$') { throw 'Database name must be 3-63 lowercase letters, digits, or underscores and start with a letter.' }
if ($ApiPort -lt 1 -or $ApiPort -gt 65535) { throw 'API port must be a valid TCP port.' }
if ($ServerHost -notmatch '^[A-Za-z0-9.:-]+$') { throw 'Server host contains unsupported characters.' }
$loopback = Test-LoopbackAddress $ServerHost
if (-not $loopback -and (-not $TlsCertificatePath -or -not $TlsPrivateKeyPath)) {
    throw 'A non-loopback server requires TLS certificate and private-key paths.'
}
if (-not $loopback -and ((-not (Test-Path -LiteralPath $TlsCertificatePath -PathType Leaf)) -or (-not (Test-Path -LiteralPath $TlsPrivateKeyPath -PathType Leaf)))) {
    throw 'The configured TLS certificate or private-key file does not exist.'
}
if (-not $loopback) {
    if (-not $TlsServerName) {
        $TlsServerName = $ServerHost
    }
    $serverAddress = $null
    if ($TlsServerName -match '[\s*/\\]' -or
        (-not [System.Net.IPAddress]::TryParse($TlsServerName, [ref]$serverAddress) -and
            [System.Uri]::CheckHostName($TlsServerName) -ne [System.UriHostNameType]::Dns)) {
        throw 'TLS server name must be a DNS name or IP address without a wildcard, path, or whitespace.'
    }
    if ($TlsServerName -in @('0.0.0.0', '::')) {
        throw 'TLS_SERVER_NAME must be a concrete DNS name or IP address, not a wildcard bind address.'
    }
}
if ($PlanOnly) {
    [ordered]@{
        operation = 'create a new dedicated PostgreSQL database and least-privilege application role'
        postgresSource = 'Use the official EDB installer linked from https://www.postgresql.org/download/windows/; this script does not install PostgreSQL.'
        postgresTarget = '127.0.0.1:55432 only'
        database = $DatabaseName
        migrationRole = 'billing_migrator (database owner; credentials stored separately)'
        applicationRole = 'billing_app (DML only; no database/schema ownership)'
        serverRoot = $resolvedRoot
        tlsServerName = if ($loopback) { $null } else { $TlsServerName }
        applicationEnvironment = $applicationEnvironmentFile
        migrationEnvironment = $MigrationEnvironmentFile
        migrationsApplied = $false
        writesDatabase = $false
    } | ConvertTo-Json -Compress
    exit 0
}

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run database provisioning from an elevated PowerShell session.'
}
if ($env:BILLING_PROVISION_ADMIN_DATABASE_URL -notmatch '^postgres(?:ql)?://') {
    throw 'Set BILLING_PROVISION_ADMIN_DATABASE_URL privately to the dedicated local PostgreSQL administrator URL.'
}
try { $adminUri = [System.Uri]::new($env:BILLING_PROVISION_ADMIN_DATABASE_URL) } catch { throw 'The private PostgreSQL administrator URL is invalid.' }
if ($adminUri.Scheme -notin @('postgres', 'postgresql') -or
    $adminUri.Host.Trim('[', ']').ToLowerInvariant() -notin @('localhost', '127.0.0.1', '::1') -or
    $adminUri.Port -ne 55432) {
    throw 'Provisioning is restricted to the dedicated loopback PostgreSQL instance on port 55432.'
}
if ((Test-Path -LiteralPath $applicationEnvironmentFile) -or (Test-Path -LiteralPath $MigrationEnvironmentFile)) {
    throw 'An application or migration environment file already exists. Nothing was overwritten.'
}

$psql = Join-Path $PostgresBinDirectory 'psql.exe'
if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) { throw 'PostgreSQL 18 command-line tools were not found in the default official installation directory.' }
$migrationPassword = New-UrlSafePassword
$applicationPassword = New-UrlSafePassword
$adminUserInfo = [System.Uri]::UnescapeDataString($adminUri.UserInfo)
$adminSeparator = $adminUserInfo.IndexOf(':')
if ($adminSeparator -lt 1) { throw 'The private administrator URL must include a username and password.' }
$adminUser = $adminUserInfo.Substring(0, $adminSeparator)
$adminPassword = $adminUserInfo.Substring($adminSeparator + 1)
$passFile = Join-Path $env:TEMP "billing-provision-pgpass-$([Guid]::NewGuid().ToString('N'))"
$sqlFile = Join-Path $env:TEMP "billing-provision-$([Guid]::NewGuid().ToString('N')).sql"
$appTemp = $null
$migrationTemp = $null

try {
    $passLine = @('127.0.0.1', '55432', '*', (ConvertTo-PgPassField $adminUser), (ConvertTo-PgPassField $adminPassword)) -join ':'
    Set-Content -LiteralPath $passFile -Value $passLine -Encoding Ascii -NoNewline
    Set-PrivateFilePermissions $passFile
    $env:PGPASSFILE = $passFile
    $existing = & $psql --host=127.0.0.1 --port=55432 --username=$adminUser --dbname=postgres --tuples-only --no-align --command "SELECT (SELECT count(*) FROM pg_database WHERE datname = '$DatabaseName') || ':' || (SELECT count(*) FROM pg_roles WHERE rolname IN ('billing_migrator','billing_app'))" 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Could not validate the dedicated database target.' }
    if (($existing | Out-String).Trim() -ne '0:0') { throw 'The target database or one of its roles already exists. Nothing was overwritten.' }

    $sql = @"
CREATE ROLE billing_migrator LOGIN PASSWORD '$migrationPassword';
CREATE ROLE billing_app LOGIN PASSWORD '$applicationPassword';
CREATE DATABASE $DatabaseName OWNER billing_migrator TEMPLATE template0;
\connect $DatabaseName
GRANT CONNECT ON DATABASE $DatabaseName TO billing_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO billing_app;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billing_app;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_migrator IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO billing_app;
"@
    Set-Content -LiteralPath $sqlFile -Value $sql -Encoding Ascii
    Set-PrivateFilePermissions $sqlFile
    & $psql --host=127.0.0.1 --port=55432 --username=$adminUser --dbname=postgres --set=ON_ERROR_STOP=1 --file=$sqlFile *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Role/database creation failed. No existing database was overwritten; review the dedicated instance for partial new objects.'
    }

    $encodedAppPassword = [System.Uri]::EscapeDataString($applicationPassword)
    $encodedMigrationPassword = [System.Uri]::EscapeDataString($migrationPassword)
    $appUrl = "postgresql://billing_app:${encodedAppPassword}@127.0.0.1:55432/$DatabaseName?schema=public"
    $migrationUrl = "postgresql://billing_migrator:${encodedMigrationPassword}@127.0.0.1:55432/$DatabaseName?schema=public"
    $environment = @(
        "DATABASE_URL=$appUrl",
        "HOST=$ServerHost",
        "PORT=$ApiPort",
        'SESSION_TTL_HOURS=8'
    )
    if (-not $loopback) {
        $environment += "TLS_CERT_PATH=$TlsCertificatePath"
        $environment += "TLS_KEY_PATH=$TlsPrivateKeyPath"
        $environment += "TLS_SERVER_NAME=$TlsServerName"
    }
    New-Item -ItemType Directory -Path $resolvedRoot -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $MigrationEnvironmentFile) -Force | Out-Null
    $appTemp = "$applicationEnvironmentFile.$([Guid]::NewGuid().ToString('N')).tmp"
    $migrationTemp = "$MigrationEnvironmentFile.$([Guid]::NewGuid().ToString('N')).tmp"
    Set-Content -LiteralPath $appTemp -Value $environment -Encoding Ascii
    Set-Content -LiteralPath $migrationTemp -Value "DATABASE_URL=$migrationUrl" -Encoding Ascii
    Set-PrivateFilePermissions $appTemp
    Set-PrivateFilePermissions $migrationTemp
    [System.IO.File]::Move($appTemp, $applicationEnvironmentFile)
    [System.IO.File]::Move($migrationTemp, $MigrationEnvironmentFile)
    & icacls.exe $applicationEnvironmentFile /grant 'NT AUTHORITY\LOCAL SERVICE:R' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Database roles were created, but the backend environment ACL could not be configured.' }
    Write-Output "Created a new database and least-privilege roles. Application configuration: $applicationEnvironmentFile. Migration credentials: $MigrationEnvironmentFile. Passwords were not printed. No migrations were applied."
} catch {
    throw $_.Exception.Message
} finally {
    Remove-Item Env:PGPASSFILE -ErrorAction SilentlyContinue
    foreach ($path in @($passFile, $sqlFile, $appTemp, $migrationTemp)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
}
