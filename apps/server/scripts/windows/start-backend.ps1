[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ServerRoot
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = [System.IO.Path]::GetFullPath($ServerRoot)
$entrypoint = Join-Path $resolvedRoot 'apps\server\dist\src\index.js'
$bundledNode = Join-Path $resolvedRoot 'runtime\node.exe'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    $bundledNode
} elseif ($nodeCommand) {
    $nodeCommand.Source
} else {
    $null
}
$logDirectory = Join-Path $env:ProgramData 'MultiBusinessBilling\logs'
$statusLog = Join-Path $logDirectory 'backend-lifecycle.log'

if (-not $nodePath) {
    throw 'A bundled Node.js runtime or Node.js 20 or newer on PATH is required to start the backend.'
}
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw 'The compiled backend entrypoint is missing. Build the server before enabling startup.'
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Set-Location -LiteralPath $resolvedRoot
$startedAt = [DateTime]::UtcNow.ToString('o')
Add-Content -LiteralPath $statusLog -Value "Backend process starting at $startedAt"
& $nodePath $entrypoint *> $null
$exitCode = $LASTEXITCODE
$finishedAt = [DateTime]::UtcNow.ToString('o')
Add-Content -LiteralPath $statusLog -Value "Backend process exited at $finishedAt with code $exitCode"
exit $exitCode
