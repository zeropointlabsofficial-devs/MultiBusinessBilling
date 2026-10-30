[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot,
    [Parameter(Mandatory = $true)]
    [string]$ServerRoot,
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$global:BillingInstallStage = 'validate-platform'
if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'The Server installer requires 64-bit Windows.'
}
$global:BillingInstallStage = 'resolve-install-paths'
$payload = [System.IO.Path]::GetFullPath($PayloadRoot)
$root = [System.IO.Path]::GetFullPath($ServerRoot)
$manifestPath = Join-Path $payload 'server-payload-manifest.json'
$rollbackSupport = Join-Path $payload 'apps\server\scripts\windows\install-rollback.ps1'
$environmentFile = Join-Path $root '.env'
$entrypoint = Join-Path $root 'apps\server\dist\src\index.js'
$installedManifestPath = Join-Path $root 'server-payload-manifest.json'
$uninstallerPath = Join-Path $root 'uninstall.exe'
$setupScript = Join-Path $payload 'apps\server\scripts\windows\setup-server.ps1'

$global:BillingInstallStage = 'validate-payload-manifest'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'The server payload manifest is missing. No files were installed.'
}
$global:BillingInstallStage = 'validate-server-configuration'
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw "A protected server configuration file is required at $environmentFile. Prepare the dedicated PostgreSQL instance and configuration before installing; no database was created or changed."
}
$environmentAcl = Get-Acl -LiteralPath $environmentFile
if (-not $environmentAcl.AreAccessRulesProtected) {
    throw 'The server configuration inherits permissions. Restrict its ACL with the database provisioning script before installation.'
}
$broadPrincipals = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
foreach ($rule in $environmentAcl.Access) {
    $sid = $null
    try { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { }
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $sid -in $broadPrincipals) {
        throw 'The server configuration grants access to a broad Windows principal. Restrict its ACL before installation.'
    }
}
if (Test-Path -LiteralPath $entrypoint) {
    throw 'A server application is already installed at this path. Automatic upgrades are disabled to prevent replacing application files or data.'
}
if ((Test-Path -LiteralPath $installedManifestPath) -or (Test-Path -LiteralPath $uninstallerPath)) {
    throw 'Existing installer metadata was found at the target. Refusing to replace it.'
}

$global:BillingInstallStage = 'validate-payload-integrity'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.version -ne 1 -or -not $manifest.files) {
    throw 'The server payload manifest is invalid.'
}
if (-not (Test-Path -LiteralPath $rollbackSupport -PathType Leaf)) {
    throw 'The server installation rollback support script is missing.'
}
. $rollbackSupport
$files = @()
foreach ($item in $manifest.files) {
    $relative = [string]$item.path
    if ([System.IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)') {
        throw 'The server payload contains an unsafe path.'
    }
    if ($relative -notmatch '^(apps[\\/]+server|node_modules|runtime)[\\/]') {
        throw 'The server payload references a path outside the application-owned directories.'
    }
    $source = [System.IO.Path]::GetFullPath((Join-Path $payload $relative))
    if (-not $source.StartsWith($payload.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The server payload contains a path outside its package root.'
    }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "A packaged server file is missing: $relative"
    }
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$item.sha256).ToLowerInvariant()) {
        throw "A packaged server file failed its integrity check: $relative"
    }
    $destination = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $destination.StartsWith($root.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The server payload contains a destination outside its install root.'
    }
    if (Test-Path -LiteralPath $destination) {
        throw "The install would replace an existing file: $relative"
    }
    $files += [pscustomobject]@{ Source = $source; Destination = $destination; Relative = $relative }
}

$global:BillingInstallStage = 'validate-install-prerequisites'
if ($PlanOnly) {
    [ordered]@{
        operation = 'install server application files and register automatic API startup'
        installRoot = $root
        packagedFiles = $files.Count
        nodeRuntime = 'bundled and signature-checked during packaging'
        requiredConfiguration = $environmentFile
        postgres = 'preinstalled dedicated local instance; never installed or modified by this installer'
        migrations = 'not applied'
        existingFilesOverwritten = $false
        databaseWrites = $false
    } | ConvertTo-Json -Compress
    exit 0
}

$global:BillingInstallStage = 'copy-application-files'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run the server installer elevated. No files were installed.'
}
foreach ($runtimeFile in @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')) {
    if (-not (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\$runtimeFile") -PathType Leaf)) {
        throw 'Microsoft Visual C++ 2015-2022 Redistributable (x64) is required. Install it from Microsoft before retrying.'
    }
}

$rollback = New-BillingInstallRollbackState
try {
    foreach ($file in $files) {
        $global:BillingInstallStage = 'copy-application-files'
        $parent = Split-Path -Parent $file.Destination
        Ensure-BillingCreatedDirectoryTree -State $rollback -Path $parent
        Copy-Item -LiteralPath $file.Source -Destination $file.Destination -ErrorAction Stop
        Register-BillingCreatedFile -State $rollback -Path $file.Destination
    }
    $global:BillingInstallStage = 'copy-installed-manifest'
    $installedManifest = Join-Path $root 'server-payload-manifest.json'
    Copy-Item -LiteralPath $manifestPath -Destination $installedManifest -ErrorAction Stop
    Register-BillingCreatedFile -State $rollback -Path $installedManifest

    $global:BillingInstallStage = 'configure-backend-startup'
    $installedSetup = Join-Path $root 'apps\server\scripts\windows\setup-server.ps1'
    & $installedSetup -ServerRoot $root
} catch {
    $originalFailure = $_.Exception.Message
    $global:BillingInstallFailureStage = [string]$global:BillingInstallStage
    $global:BillingInstallStage = 'rollback'
    $rollbackErrors = Invoke-BillingInstallRollback -State $rollback `
        -RemoveCreatedTask { } `
        -RemoveCreatedFirewallRule { }
    foreach ($rollbackError in $rollbackErrors) {
        Write-Warning "Rollback error after '$originalFailure': $rollbackError"
    }
    if ($rollbackErrors.Count -gt 0) {
        throw "Server installation failed: $originalFailure. Rollback also reported: $($rollbackErrors -join ' | ')"
    }
    throw "Server installation failed and newly copied application files/directories were rolled back. Existing configuration and database data were preserved. $originalFailure"
}

Write-Output 'Server files installed and backend startup registered. No migrations or catalog imports were run.'
