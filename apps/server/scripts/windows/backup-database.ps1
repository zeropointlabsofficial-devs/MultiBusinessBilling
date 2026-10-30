[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupDirectory,
    [string]$PostgresBinDirectory = 'C:\Program Files\PostgreSQL\18\bin',
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'

function ConvertTo-PgPassField([string]$Value) {
    return $Value.Replace('\', '\\').Replace(':', '\:')
}

function Get-LocalDatabaseTarget([string]$ConnectionString) {
    try { $uri = [System.Uri]::new($ConnectionString) } catch { throw 'DATABASE_URL is not a valid PostgreSQL URL.' }
    if ($uri.Scheme -notin @('postgres', 'postgresql')) { throw 'DATABASE_URL must use PostgreSQL.' }
    $hostName = $uri.Host.Trim('[', ']').ToLowerInvariant()
    if ($hostName -notin @('localhost', '127.0.0.1', '::1')) {
        throw 'Backups from this script are limited to a local PostgreSQL instance.'
    }
    $userInfo = [System.Uri]::UnescapeDataString($uri.UserInfo).Split(':', 2)
    if ($userInfo.Count -ne 2 -or -not $userInfo[0] -or -not $userInfo[1]) {
        throw 'DATABASE_URL must contain a username and password.'
    }
    $database = [System.Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
    if (-not $database -or $database -notmatch '^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$') {
        throw 'DATABASE_URL contains an invalid database name.'
    }
    return [pscustomobject]@{
        Host = $hostName
        Port = if ($uri.IsDefaultPort) { 5432 } else { $uri.Port }
        User = $userInfo[0]
        Password = $userInfo[1]
        Database = $database
    }
}

function Set-PrivateFilePermissions([string]$Path) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $Path /inheritance:r /grant:r "$identity:F" 'BUILTIN\Administrators:F' 'NT AUTHORITY\SYSTEM:F' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the temporary database credential file.' }
}

if ($BackupDirectory.StartsWith('\\')) { throw 'Backup output must be on a local disk, not a network share.' }
if ($PlanOnly) {
    [ordered]@{
        operation = 'custom-format PostgreSQL backup'
        outputDirectory = [System.IO.Path]::GetFullPath($BackupDirectory)
        integrityCheck = 'pg_restore --list and SHA-256 sidecar'
        databaseScope = 'loopback PostgreSQL only'
        writesDatabase = $false
    } | ConvertTo-Json -Compress
    exit 0
}

if (-not $env:DATABASE_URL) { throw 'Set DATABASE_URL in the invoking process before running a backup.' }
$target = Get-LocalDatabaseTarget $env:DATABASE_URL
$pgDump = Join-Path $PostgresBinDirectory 'pg_dump.exe'
$pgRestore = Join-Path $PostgresBinDirectory 'pg_restore.exe'
if (-not (Test-Path -LiteralPath $pgDump -PathType Leaf) -or -not (Test-Path -LiteralPath $pgRestore -PathType Leaf)) {
    throw 'The configured PostgreSQL client tools are missing.'
}
New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff')
$backupPath = Join-Path ([System.IO.Path]::GetFullPath($BackupDirectory)) "$($target.Database)-$stamp.dump"
$partialPath = "$backupPath.partial"
$hashPath = "$backupPath.sha256"
if ((Test-Path -LiteralPath $backupPath) -or (Test-Path -LiteralPath $hashPath)) {
    throw 'The timestamped backup destination already exists; refusing to overwrite it.'
}
$passFile = Join-Path $env:TEMP "billing-pgpass-$([Guid]::NewGuid().ToString('N'))"

try {
    $passLine = @(
        (ConvertTo-PgPassField $target.Host),
        (ConvertTo-PgPassField ([string]$target.Port)),
        (ConvertTo-PgPassField $target.Database),
        (ConvertTo-PgPassField $target.User),
        (ConvertTo-PgPassField $target.Password)
    ) -join ':'
    Set-Content -LiteralPath $passFile -Value $passLine -Encoding Ascii -NoNewline
    Set-PrivateFilePermissions $passFile
    $env:PGPASSFILE = $passFile

    & $pgDump --format=custom --no-owner --no-acl --file=$partialPath --host=$target.Host --port=$target.Port --username=$target.User --dbname=$target.Database *> $null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $partialPath -PathType Leaf)) {
        throw 'pg_dump failed. No completed backup was published.'
    }
    & $pgRestore --list $partialPath *> $null
    if ($LASTEXITCODE -ne 0) { throw 'The backup archive integrity check failed.' }
    $hash = (Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Move-Item -LiteralPath $partialPath -Destination $backupPath
    Set-Content -LiteralPath $hashPath -Value "$hash  $(Split-Path -Leaf $backupPath)" -Encoding Ascii
    $storedHash = ((Get-Content -LiteralPath $hashPath -Raw).Trim() -split '\s+')[0]
    $actualHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($storedHash -ne $actualHash) { throw 'The saved backup checksum did not verify.' }
    [ordered]@{ backup = $backupPath; sha256 = $actualHash; integrity = 'verified' } | ConvertTo-Json -Compress
} catch {
    if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
    if (Test-Path -LiteralPath $hashPath) { Remove-Item -LiteralPath $hashPath -Force }
    throw $_.Exception.Message
} finally {
    Remove-Item Env:PGPASSFILE -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $passFile) { Remove-Item -LiteralPath $passFile -Force }
}
