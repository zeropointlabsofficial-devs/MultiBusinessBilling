[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ServerRoot,
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$rollbackSupport = Join-Path $PSScriptRoot 'install-rollback.ps1'
$tlsSecurity = Join-Path $PSScriptRoot 'tls-security.ps1'
if (-not (Test-Path -LiteralPath $rollbackSupport -PathType Leaf)) {
    throw 'The server installation rollback support script is missing.'
}
if (-not (Test-Path -LiteralPath $tlsSecurity -PathType Leaf)) {
    throw 'The TLS security validation script is missing.'
}
. $rollbackSupport
. $tlsSecurity
$serviceName = 'MultiBusinessBillingPostgreSQL'
$taskName = 'MultiBusinessBillingBackend'
$firewallName = 'MultiBusinessBilling-HTTPS-API'
$resolvedRoot = [System.IO.Path]::GetFullPath($ServerRoot)
$environmentFile = Join-Path $resolvedRoot '.env'
$entrypoint = Join-Path $resolvedRoot 'apps\server\dist\src\index.js'
$runner = Join-Path $PSScriptRoot 'start-backend.ps1'

function Read-EnvironmentValue([string]$Name) {
    $match = Get-Content -LiteralPath $environmentFile | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
    if (-not $match) { return $null }
    $value = ($match -replace "^\s*$Name\s*=", '').Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
}

function Test-LoopbackAddress([string]$HostName) {
    if ($HostName -eq 'localhost') { return $true }
    $address = $null
    if ([System.Net.IPAddress]::TryParse($HostName, [ref]$address)) {
        return [System.Net.IPAddress]::IsLoopback($address)
    }
    return $false
}

if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw 'Create the server .env with a restricted database URL and reviewed TLS settings before registering backend startup.'
}
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw 'The compiled backend entrypoint is missing. Build the server before registering startup.'
}
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw 'The backend startup wrapper is missing.'
}
if (-not (Read-EnvironmentValue 'DATABASE_URL')) {
    throw 'The server .env must contain DATABASE_URL.'
}

$hostName = Read-EnvironmentValue 'HOST'
if (-not $hostName) { $hostName = '127.0.0.1' }
$portText = Read-EnvironmentValue 'PORT'
if (-not $portText) { $portText = '4317' }
$port = 0
if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw 'The configured API port is invalid.'
}
$loopback = Test-LoopbackAddress $hostName
$certificatePath = Read-EnvironmentValue 'TLS_CERT_PATH'
$keyPath = Read-EnvironmentValue 'TLS_KEY_PATH'
$keyAclAssessment = $null
$tlsServerName = Read-EnvironmentValue 'TLS_SERVER_NAME'
if (-not $loopback) {
    if (-not $certificatePath -or -not $keyPath) {
        throw 'LAN binding requires TLS_CERT_PATH and TLS_KEY_PATH; plaintext LAN startup is refused.'
    }
    $certificatePath = Resolve-BillingTlsFile -Path $certificatePath
    $keyPath = Resolve-BillingTlsFile -Path $keyPath
    if ([string]::Equals($certificatePath, $keyPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The TLS certificate and private key must be separate files.'
    }
    $keyAclAssessment = Assert-BillingPrivateKeyAcl -Path $keyPath
    if (-not $tlsServerName) {
        $tlsServerName = $hostName
        if ($tlsServerName -in @('0.0.0.0', '::', '[::]')) {
            throw 'A wildcard LAN bind requires TLS_SERVER_NAME to identify the DNS name or IP address clients will use.'
        }
    }
}

$bundledNode = Join-Path $resolvedRoot 'runtime\node.exe'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    $bundledNode
} elseif ($nodeCommand) {
    $nodeCommand.Source
} else {
    $null
}
if (-not $nodePath) { throw 'A bundled Node.js runtime or Node.js 20 or newer on PATH is required.' }
$nodeVersion = (& $nodePath --version 2>$null) -replace '^v', ''
$nodeMajor = 0
if (-not [int]::TryParse(($nodeVersion -split '\.')[0], [ref]$nodeMajor) -or $nodeMajor -lt 20) {
    throw 'Node.js 20 or newer is required.'
}
if (-not $loopback) {
    Assert-BillingTlsCertificate -NodePath $nodePath `
        -CertificatePath $certificatePath `
        -PrivateKeyPath $keyPath `
        -ServerName $tlsServerName
}

$postgresService = $null
$existingTask = $null
$existingFirewall = $null
if (-not $PlanOnly) {
    $postgresService = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
    if (-not $postgresService) {
        throw "A dedicated PostgreSQL service named $serviceName is required. Install PostgreSQL from the official EDB installer linked by https://www.postgresql.org/download/windows/ and configure a separate local-only instance first. Existing PostgreSQL services are never modified."
    }
    $pgCtlMatch = [regex]::Match($postgresService.PathName, '^\s*"?([^" ]+pg_ctl\.exe)')
    if (-not $pgCtlMatch.Success) { throw 'Could not identify the PostgreSQL installation used by the dedicated service.' }
    $postgresBinary = Join-Path (Split-Path -Parent $pgCtlMatch.Groups[1].Value) 'postgres.exe'
    if (-not (Test-Path -LiteralPath $postgresBinary -PathType Leaf)) { throw 'The dedicated PostgreSQL server binary is missing.' }
    $postgresVersion = & $postgresBinary --version 2>$null
    $versionMatch = [regex]::Match(($postgresVersion | Out-String), 'PostgreSQL\s+(\d+)')
    if (-not $versionMatch.Success -or [int]$versionMatch.Groups[1].Value -lt 16 -or [int]$versionMatch.Groups[1].Value -gt 18) {
        throw 'A stable PostgreSQL 16, 17, or 18 installation is required.'
    }
    $dataDirectoryMatch = [regex]::Match($postgresService.PathName, '-D\s+(?:"([^"]+)"|(\S+))')
    if (-not $dataDirectoryMatch.Success) {
        throw 'Could not identify the dedicated PostgreSQL data directory from its service definition.'
    }
    $postgresDataDirectory = if ($dataDirectoryMatch.Groups[1].Success) { $dataDirectoryMatch.Groups[1].Value } else { $dataDirectoryMatch.Groups[2].Value }
    $postgresConfig = Join-Path $postgresDataDirectory 'postgresql.conf'
    $pgHbaConfig = Join-Path $postgresDataDirectory 'pg_hba.conf'
    if (-not (Test-Path -LiteralPath $postgresConfig -PathType Leaf) -or -not (Test-Path -LiteralPath $pgHbaConfig -PathType Leaf)) {
        throw 'The dedicated PostgreSQL configuration files could not be located.'
    }
    $listenLine = Get-Content -LiteralPath $postgresConfig | Where-Object { $_ -match '^\s*listen_addresses\s*=' } | Select-Object -Last 1
    $listenAddresses = if ($listenLine) {
        (($listenLine -replace '^\s*listen_addresses\s*=\s*', '' -replace '#.*$', '').Trim().Trim("'").Trim('"') -split ',') | ForEach-Object { $_.Trim().Trim("'").Trim('"') }
    } else { @('localhost') }
    if (-not ($listenAddresses | Where-Object { $_ -in @('localhost', '127.0.0.1', '::1') }) -or
        ($listenAddresses | Where-Object { $_ -and $_ -notin @('localhost', '127.0.0.1', '::1') })) {
        throw 'The dedicated PostgreSQL instance listens on a non-loopback address. Refusing server setup.'
    }
    foreach ($line in Get-Content -LiteralPath $pgHbaConfig) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $columns = $trimmed -split '\s+'
        if ($columns[0] -in @('host', 'hostssl', 'hostnossl') -and $columns.Count -ge 5 -and
            $columns[3] -notin @('localhost', '127.0.0.1/32', '::1/128')) {
            throw 'pg_hba.conf contains a non-loopback TCP access rule. Refusing server setup.'
        }
    }
    $postgresPort = 5432
    $postgresPortLine = Get-Content -LiteralPath $postgresConfig | Where-Object { $_ -match '^\s*port\s*=' } | Select-Object -Last 1
    if ($postgresPortLine) {
        $portValue = (($postgresPortLine -replace '^\s*port\s*=\s*', '' -replace '#.*$', '').Trim().Trim("'").Trim('"'))
        if (-not [int]::TryParse($portValue, [ref]$postgresPort)) { throw 'The dedicated PostgreSQL port setting is invalid.' }
    }
    $databaseUrl = Read-EnvironmentValue 'DATABASE_URL'
    try { $databaseUri = [System.Uri]::new($databaseUrl) } catch { throw 'DATABASE_URL is not a valid PostgreSQL URL.' }
    if ($databaseUri.Scheme -notin @('postgres', 'postgresql') -or
        $databaseUri.Host.Trim('[', ']').ToLowerInvariant() -notin @('localhost', '127.0.0.1', '::1')) {
        throw 'DATABASE_URL must target the dedicated local PostgreSQL instance.'
    }
    $databasePort = if ($databaseUri.Port -gt 0) { $databaseUri.Port } else { 5432 }
    if ($databasePort -ne $postgresPort) {
        throw 'DATABASE_URL port does not match the dedicated PostgreSQL instance.'
    }
    if ($postgresPort -eq 5432) {
        throw 'The dedicated PostgreSQL instance must use a separate port, not the shared default port 5432.'
    }
    $postgresListeners = Get-NetTCPConnection -State Listen -LocalPort $postgresPort -ErrorAction SilentlyContinue
    foreach ($listener in $postgresListeners) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if (-not $processInfo -or $processInfo.CommandLine -notlike "*$postgresDataDirectory*") {
            throw 'The dedicated PostgreSQL port is also used by a process outside its configured data directory.'
        }
    }
    $apiListeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if ($apiListeners) { throw 'The configured API port is already in use; refusing to register backend startup.' }
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) { throw "The task $taskName already exists; inspect it before changing startup configuration." }
    $existingFirewall = Get-NetFirewallRule -Name $firewallName -ErrorAction SilentlyContinue
    if ($existingFirewall) { throw "The firewall rule $firewallName already exists; inspect it before changing firewall configuration." }
}

$plan = [ordered]@{
    result = 'READY_TO_REGISTER'
    postgresService = $serviceName
    postgresServiceState = if ($PlanOnly) { 'not queried in plan mode' } else { $postgresService.State }
    backendEntrypoint = $entrypoint
    backendTask = $taskName
    backendRunAs = 'NT AUTHORITY\LOCAL SERVICE'
    apiHost = $hostName
    apiPort = $port
    tlsRequired = (-not $loopback)
    postgresFirewallRule = 'NONE (PostgreSQL remains local-only)'
    apiFirewallRule = if ($loopback) { 'NONE (loopback only)' } else { "$firewallName limited to LocalSubnet" }
    automaticRecovery = 'Task Scheduler retries up to 5 times at 1-minute intervals.'
    migrations = 'Not applied by this script.'
}
if ($PlanOnly) {
    $plan | ConvertTo-Json -Compress
    exit 0
}

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this configuration step from an elevated PowerShell session.'
}

if ($postgresService.StartMode -ne 'Auto' -or $postgresService.State -ne 'Running') {
    throw "The dedicated PostgreSQL service $serviceName must already be running with Automatic startup. Configure only that dedicated instance and retry; this installer does not change PostgreSQL service state."
}
$postgresListeners = Get-NetTCPConnection -State Listen -LocalPort $postgresPort -ErrorAction SilentlyContinue
if (-not $postgresListeners) { throw 'The dedicated PostgreSQL service did not open its configured local port within the startup timeout.' }
foreach ($listener in $postgresListeners) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $processInfo -or $processInfo.CommandLine -notlike "*$postgresDataDirectory*") {
        throw 'A process outside the dedicated PostgreSQL data directory is listening on the configured port.'
    }
}

$logDirectory = Join-Path $env:ProgramData 'MultiBusinessBilling\logs'
$rollback = New-BillingInstallRollbackState
try {
    Save-BillingAclSnapshot -State $rollback -Path $resolvedRoot
    Save-BillingAclSnapshot -State $rollback -Path $environmentFile
    if (Test-Path -LiteralPath $logDirectory -PathType Container) {
        Save-BillingAclSnapshot -State $rollback -Path $logDirectory
    }
    if (-not $loopback) {
        Save-BillingAclSnapshot -State $rollback -Path $keyPath
    }

    Ensure-BillingCreatedDirectoryTree -State $rollback -Path $logDirectory
    & icacls.exe $resolvedRoot /grant 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant the backend service read access to the application files.' }
    & icacls.exe $environmentFile /grant 'NT AUTHORITY\LOCAL SERVICE:R' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant the backend service access to its environment file.' }
    & icacls.exe $logDirectory /grant 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant the backend service access to its lifecycle log.' }
    if (-not $loopback) {
        if (-not $keyAclAssessment.ServiceCanRead) {
            & icacls.exe $keyPath /grant 'NT AUTHORITY\LOCAL SERVICE:R' *> $null
            if ($LASTEXITCODE -ne 0) { throw 'Could not grant the backend service read access to the TLS private key.' }
            $verifiedKeyAcl = Assert-BillingPrivateKeyAcl -Path $keyPath
            if (-not $verifiedKeyAcl.ServiceCanRead) {
                throw 'The backend service read permission on the TLS private key could not be verified.'
            }
        }
    }

    $powerShellPath = Join-Path $PSHOME 'powershell.exe'
    $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument "-NoProfile -NonInteractive -File `"$runner`" -ServerRoot `"$resolvedRoot`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited -Description 'Starts the MultiBusinessBilling API at Windows startup.' | Out-Null
    $rollback.TaskCreated = $true
    if (-not $loopback) {
        New-NetFirewallRule -Name $firewallName -DisplayName 'MultiBusinessBilling HTTPS API (Local Subnet)' -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress LocalSubnet -Action Allow -Profile Domain,Private | Out-Null
        $rollback.FirewallCreated = $true
    }
    Start-ScheduledTask -TaskName $taskName
} catch {
    $originalFailure = $_.Exception.Message
    $rollbackErrors = Invoke-BillingInstallRollback -State $rollback `
        -RemoveCreatedTask { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } `
        -RemoveCreatedFirewallRule { Remove-NetFirewallRule -Name $firewallName -ErrorAction Stop }
    foreach ($rollbackError in $rollbackErrors) {
        Write-Warning "Rollback error after '$originalFailure': $rollbackError"
    }
    if ($rollbackErrors.Count -gt 0) {
        throw "Installation failed: $originalFailure. Rollback also reported: $($rollbackErrors -join ' | ')"
    }
    throw "Installation failed: $originalFailure. Changes made by this attempt were rolled back."
}
Write-Output 'Backend startup task registered. Migration status was not checked and no migrations were applied.'
