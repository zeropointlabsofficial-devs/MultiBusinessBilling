[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupFile,
    [Parameter(Mandatory = $true)]
    [string]$TargetDatabaseName,
    [string]$PostgresBinDirectory = 'C:\Program Files\PostgreSQL\18\bin',
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'

function ConvertTo-PgPassField([string]$Value) {
    return $Value.Replace('\', '\\').Replace(':', '\:')
}

function Get-LocalDatabaseTarget([string]$ConnectionString) {
    try { $uri = [System.Uri]::new($ConnectionString) } catch { throw 'BILLING_RESTORE_ADMIN_DATABASE_URL is not a valid PostgreSQL URL.' }
    if ($uri.Scheme -notin @('postgres', 'postgresql')) { throw 'The restore administrator URL must use PostgreSQL.' }
    $hostName = $uri.Host.Trim('[', ']').ToLowerInvariant()
    if ($hostName -notin @('localhost', '127.0.0.1', '::1')) {
        throw 'Restore is restricted to a local PostgreSQL instance.'
    }
    $userInfo = [System.Uri]::UnescapeDataString($uri.UserInfo)
    $separator = $userInfo.IndexOf(':')
    if ($separator -lt 1 -or $separator -eq ($userInfo.Length - 1)) {
        throw 'The restore administrator URL must contain a username and password.'
    }
    return [pscustomobject]@{
        Host = $hostName
        Port = if ($uri.IsDefaultPort) { 5432 } else { $uri.Port }
        User = $userInfo.Substring(0, $separator)
        Password = $userInfo.Substring($separator + 1)
    }
}

function Set-PrivateFilePermissions([string]$Path) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $Path /inheritance:r /grant:r "$identity:F" 'BUILTIN\Administrators:F' 'NT AUTHORITY\SYSTEM:F' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the temporary database credential file.' }
}

if ($TargetDatabaseName -notmatch '^[a-z][a-z0-9_]{2,62}$') {
    throw 'Target database names must be 3-63 lowercase letters, digits, or underscores and start with a letter.'
}
$resolvedBackup = [System.IO.Path]::GetFullPath($BackupFile)
$hashFile = "$resolvedBackup.sha256"
if (-not (Test-Path -LiteralPath $resolvedBackup -PathType Leaf) -or -not (Test-Path -LiteralPath $hashFile -PathType Leaf)) {
    throw 'The backup archive and its SHA-256 sidecar are both required.'
}
$expectedHash = ((Get-Content -LiteralPath $hashFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $resolvedBackup -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedHash -notmatch '^[a-f0-9]{64}$' -or $expectedHash -ne $actualHash) {
    throw 'The backup checksum is invalid; refusing restore.'
}

$pgRestore = Join-Path $PostgresBinDirectory 'pg_restore.exe'
if ($PlanOnly) {
    [ordered]@{
        operation = 'restore into a new PostgreSQL database'
        backup = $resolvedBackup
        checksum = 'verified'
        archiveListing = 'deferred until actual restore'
        targetDatabase = $TargetDatabaseName
        overwrite = $false
        confirmationRequired = "CREATE NEW DATABASE $TargetDatabaseName"
        databaseWrites = $false
    } | ConvertTo-Json -Compress
    exit 0
}

if (-not (Test-Path -LiteralPath $pgRestore -PathType Leaf)) { throw 'pg_restore.exe was not found in the configured PostgreSQL tools directory.' }
& $pgRestore --list $resolvedBackup *> $null
if ($LASTEXITCODE -ne 0) { throw 'The backup archive failed the pg_restore integrity check.' }

if (-not $env:BILLING_RESTORE_ADMIN_DATABASE_URL) {
    throw 'Set BILLING_RESTORE_ADMIN_DATABASE_URL in the invoking process using a restricted local restore administrator.'
}
$target = Get-LocalDatabaseTarget $env:BILLING_RESTORE_ADMIN_DATABASE_URL
$pgRestore = Join-Path $PostgresBinDirectory 'pg_restore.exe'
$psql = Join-Path $PostgresBinDirectory 'psql.exe'
$createdb = Join-Path $PostgresBinDirectory 'createdb.exe'
if (-not (Test-Path -LiteralPath $psql -PathType Leaf) -or -not (Test-Path -LiteralPath $createdb -PathType Leaf)) {
    throw 'Required PostgreSQL restore tools are missing.'
}
$confirmation = Read-Host "Type CREATE NEW DATABASE $TargetDatabaseName to confirm"
if ($confirmation -cne "CREATE NEW DATABASE $TargetDatabaseName") {
    throw 'Restore cancelled; no database was created.'
}

$passFile = Join-Path $env:TEMP "billing-restore-pgpass-$([Guid]::NewGuid().ToString('N'))"
try {
    $passLine = @(
        (ConvertTo-PgPassField $target.Host),
        (ConvertTo-PgPassField ([string]$target.Port)),
        '*',
        (ConvertTo-PgPassField $target.User),
        (ConvertTo-PgPassField $target.Password)
    ) -join ':'
    Set-Content -LiteralPath $passFile -Value $passLine -Encoding Ascii -NoNewline
    Set-PrivateFilePermissions $passFile
    $env:PGPASSFILE = $passFile

    $existsOutput = & $psql --host=$target.Host --port=$target.Port --username=$target.User --dbname=postgres --tuples-only --no-align --command "SELECT (SELECT count(*) FROM pg_database WHERE datname = '$TargetDatabaseName') || ':' || (SELECT count(*) FROM pg_roles WHERE rolname IN ('billing_migrator','billing_app'))" 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the restore target. No database was created.' }
    if (($existsOutput | Out-String).Trim() -ne '0:2') {
        if (($existsOutput | Out-String).Trim().StartsWith('1:')) {
            throw 'The target database already exists. Restore never overwrites an existing database.'
        }
        throw 'The target database must not exist and both least-privilege application roles must be present before restore.'
    }

    & $createdb --host=$target.Host --port=$target.Port --username=$target.User --owner=billing_migrator --template=template0 $TargetDatabaseName 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the new restore target database.' }
    & $pgRestore --host=$target.Host --port=$target.Port --username=$target.User --role=billing_migrator --no-owner --no-acl --dbname=$TargetDatabaseName $resolvedBackup 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Restore failed after creating $TargetDatabaseName. The partial target was preserved; inspect it and decide how to proceed manually. No database was dropped or overwritten."
    }
    $grantSql = "REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT CONNECT ON DATABASE $TargetDatabaseName TO billing_app; GRANT USAGE ON SCHEMA public TO billing_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO billing_app; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO billing_app;"
    & $psql --host=$target.Host --port=$target.Port --username=$target.User --dbname=$TargetDatabaseName --set=ON_ERROR_STOP=1 --command $grantSql 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Database restore completed but application grants could not be applied to $TargetDatabaseName. The new database is preserved for manual review."
    }
    Write-Output "Restore completed into new database $TargetDatabaseName."
} finally {
    Remove-Item Env:PGPASSFILE -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $passFile) { Remove-Item -LiteralPath $passFile -Force }
}
