[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ServerRoot
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($ServerRoot)
$manifestPath = Join-Path $root 'server-payload-manifest.json'
$taskName = 'MultiBusinessBillingBackend'
$firewallName = 'MultiBusinessBilling-HTTPS-API'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run server removal elevated. No files or services were changed.'
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'The installed payload manifest is missing. Refusing to guess which files are safe to remove.'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.version -ne 1 -or -not $manifest.files) {
    throw 'The installed payload manifest is invalid. No files were removed.'
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task -and $task.Description -ne 'Starts the MultiBusinessBilling API at Windows startup.') {
    throw "The scheduled task name $taskName is used by a different task. No files were removed."
}
$rule = Get-NetFirewallRule -Name $firewallName -ErrorAction SilentlyContinue
if ($rule -and $rule.DisplayName -ne 'MultiBusinessBilling HTTPS API (Local Subnet)') {
    throw "The firewall rule name $firewallName is used by a different rule. No files were removed."
}

if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
}
if ($rule) {
    Remove-NetFirewallRule -Name $firewallName -ErrorAction Stop
}

foreach ($item in $manifest.files) {
    $relative = [string]$item.path
    if ([System.IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)') {
        throw 'The installed manifest contains an unsafe path; remaining application files were preserved.'
    }
    if ($relative -notmatch '^(apps[\\/]+server|node_modules|runtime)[\\/]') {
        throw 'The installed manifest references a path outside application-owned directories; remaining files were preserved.'
    }
    $path = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $path.StartsWith($root.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The installed manifest references a file outside the application root.'
    }
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
    }
}
Remove-Item -LiteralPath $manifestPath -Force -ErrorAction Stop

$ownedDirectories = @($manifest.files | ForEach-Object {
    $directory = Split-Path -Parent (Join-Path $root ([string]$_.path))
    while ($directory -and $directory.StartsWith($root.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $directory
        $directory = Split-Path -Parent $directory
    }
} | Sort-Object Length -Descending -Unique)
foreach ($directory in $ownedDirectories) {
    if ((Test-Path -LiteralPath $directory -PathType Container) -and
        -not (Get-ChildItem -LiteralPath $directory -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $directory -Force -ErrorAction Stop
    }
}

Write-Output 'Backend startup and its API firewall rule were removed. PostgreSQL, databases, configuration, backups, logs, and user data were preserved.'
