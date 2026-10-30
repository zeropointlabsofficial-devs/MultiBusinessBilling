[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerScript,
    [Parameter(Mandatory = $true)]
    [string]$DiagnosticLog,
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot,
    [Parameter(Mandatory = $true)]
    [string]$ServerRoot
)

$ErrorActionPreference = 'Stop'
$stdoutPath = $null
$stderrPath = $null
$exitCode = 0
$failure = $null
$stage = 'initialize'

function ConvertTo-SafeDiagnosticText([string]$Text) {
    $safe = $Text
    $safe = [regex]::Replace($safe, '(?im)^(\s*(?:DATABASE_URL|TLS_KEY_PATH|PASSWORD|PASSWD|TOKEN|SECRET|API[_-]?KEY)\s*=).+$', '$1<redacted>')
    $safe = [regex]::Replace($safe, '(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://[^\s"''<>]+', '<redacted-connection-string>')
    $safe = [regex]::Replace($safe, '(?i)\b(password|passwd|pwd|token|secret|api[_-]?key)\s*([=:])\s*("[^"]*"|''[^'']*''|[^;\s,]+)', '$1$2<redacted>')
    if ($safe.Length -gt 32768) {
        $safe = $safe.Substring(0, 32768) + "`r`n<diagnostic output truncated>"
    }
    return $safe
}

function Read-DiagnosticOutput([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return ''
    }
    return ConvertTo-SafeDiagnosticText (Get-Content -LiteralPath $Path -Raw)
}

try {
    $logDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($DiagnosticLog))
    if (-not (Test-Path -LiteralPath $logDirectory -PathType Container)) {
        throw 'The temporary diagnostic log directory is unavailable.'
    }
    [System.IO.File]::AppendAllText(
        $DiagnosticLog,
        "Business Billing Server installation diagnostics`r`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    $global:BillingInstallStage = 'launch-installer-script'
    $global:BillingInstallFailureStage = $null
    & $InstallerScript -PayloadRoot $PayloadRoot -ServerRoot $ServerRoot 1> $stdoutPath 2> $stderrPath
} catch {
    $exitCode = 1
    $failure = $_.Exception.Message
    if ($global:BillingInstallFailureStage) {
        $stage = [string]$global:BillingInstallFailureStage
    } elseif ($global:BillingInstallStage) {
        $stage = [string]$global:BillingInstallStage
    }
}

try {
    $stdout = Read-DiagnosticOutput $stdoutPath
    $stderr = Read-DiagnosticOutput $stderrPath
    $failure = ConvertTo-SafeDiagnosticText ([string]$failure)
    $logContent = @(
        "timestamp_utc=$([DateTime]::UtcNow.ToString('o'))"
        "stage=$stage"
        "exit_code=$exitCode"
        '--- stdout ---'
        $stdout
        '--- stderr ---'
        $stderr
        '--- failure ---'
        $failure
    ) -join "`r`n"
    [System.IO.File]::AppendAllText(
        $DiagnosticLog,
        $logContent + "`r`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
} catch {
    $exitCode = 1
    $failure = 'The setup diagnostic log could not be written. Installation was stopped or its result could not be confirmed.'
    $stage = 'write-diagnostic-log'
}

foreach ($temporaryPath in @($stdoutPath, $stderrPath)) {
    if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

if ($exitCode -eq 0) {
    Write-Output "BILLING_INSTALL_STAGE=complete; LOG=$DiagnosticLog"
} else {
    Write-Output "BILLING_INSTALL_STAGE=$stage; LOG=$DiagnosticLog"
}
exit $exitCode
