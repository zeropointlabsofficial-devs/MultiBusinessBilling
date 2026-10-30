param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\windows\install-rollback.ps1')

function Set-FixtureAclMarker([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::Read,
        [System.Security.AccessControl.InheritanceFlags]::None,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

$stages = @(
    'log-directory-created',
    'root-acl-changed',
    'environment-acl-changed',
    'log-directory-acl-changed',
    'tls-key-acl-changed',
    'scheduled-task-created',
    'firewall-rule-created',
    'scheduled-task-started'
)
$results = New-Object System.Collections.ArrayList
foreach ($stage in $stages) {
    $caseRoot = Join-Path $Root $stage
    $serverRoot = Join-Path $caseRoot 'server'
    $logDirectory = Join-Path $caseRoot 'new\logs'
    $environment = Join-Path $serverRoot '.env'
    $tlsKey = Join-Path $caseRoot 'tls.key'
    New-Item -ItemType Directory -Path $serverRoot -Force | Out-Null
    Set-Content -LiteralPath $environment -Value 'preserve-environment' -NoNewline
    Set-Content -LiteralPath $tlsKey -Value 'preserve-tls-key' -NoNewline

    $rootSddl = (Get-Acl -LiteralPath $serverRoot).Sddl
    $environmentSddl = (Get-Acl -LiteralPath $environment).Sddl
    $tlsSddl = (Get-Acl -LiteralPath $tlsKey).Sddl
    $state = New-BillingInstallRollbackState
    $script:taskRemovalCount = 0
    $script:firewallRemovalCount = 0
    $existingLog = $stage -eq 'log-directory-acl-changed'
    if ($existingLog) {
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $logDirectory 'existing.log') -Value 'preserve-log' -NoNewline
    }
    $logSddl = if ($existingLog) { (Get-Acl -LiteralPath $logDirectory).Sddl } else { $null }

    try {
        if (-not $existingLog) {
            Ensure-BillingCreatedDirectoryTree -State $state -Path $logDirectory
        }
        if ($stage -eq 'log-directory-created') { throw 'injected failure: log-directory-created' }

        Save-BillingAclSnapshot -State $state -Path $serverRoot
        Set-FixtureAclMarker $serverRoot
        if ($stage -eq 'root-acl-changed') { throw 'injected failure: root-acl-changed' }

        Save-BillingAclSnapshot -State $state -Path $environment
        Set-FixtureAclMarker $environment
        if ($stage -eq 'environment-acl-changed') { throw 'injected failure: environment-acl-changed' }

        if ($existingLog) { Save-BillingAclSnapshot -State $state -Path $logDirectory }
        Set-FixtureAclMarker $logDirectory
        if ($stage -eq 'log-directory-acl-changed') { throw 'injected failure: log-directory-acl-changed' }

        Save-BillingAclSnapshot -State $state -Path $tlsKey
        Set-FixtureAclMarker $tlsKey
        if ($stage -eq 'tls-key-acl-changed') { throw 'injected failure: tls-key-acl-changed' }

        $state.TaskCreated = $true
        if ($stage -eq 'scheduled-task-created') { throw 'injected failure: scheduled-task-created' }

        $state.FirewallCreated = $true
        if ($stage -eq 'firewall-rule-created') { throw 'injected failure: firewall-rule-created' }
        if ($stage -eq 'scheduled-task-started') { throw 'injected failure: scheduled-task-started' }
    } catch {
        $original = $_.Exception.Message
        $rollbackErrors = Invoke-BillingInstallRollback -State $state `
            -RemoveCreatedTask { $script:taskRemovalCount++ } `
            -RemoveCreatedFirewallRule { $script:firewallRemovalCount++ }
        if ($rollbackErrors.Count -gt 0) {
            throw "Original failure '$original'; rollback errors: $($rollbackErrors -join ' | ')"
        }
        if ($original -ne "injected failure: $stage") {
            throw "Original installation failure was hidden at $stage`: $original"
        }
    }

    if ((Get-Acl -LiteralPath $serverRoot).Sddl -ne $rootSddl) { throw "Root ACL was not restored at $stage." }
    if ((Get-Acl -LiteralPath $environment).Sddl -ne $environmentSddl) { throw "Environment ACL was not restored at $stage." }
    if ((Get-Acl -LiteralPath $tlsKey).Sddl -ne $tlsSddl) { throw "TLS ACL was not restored at $stage." }
    if ((Get-Content -LiteralPath $environment -Raw) -ne 'preserve-environment') { throw "Environment data changed at $stage." }
    if ((Get-Content -LiteralPath $tlsKey -Raw) -ne 'preserve-tls-key') { throw "TLS data changed at $stage." }
    if ($existingLog) {
        if ((Get-Acl -LiteralPath $logDirectory).Sddl -ne $logSddl) { throw 'Pre-existing log directory ACL was not restored.' }
        if ((Get-Content -LiteralPath (Join-Path $logDirectory 'existing.log') -Raw) -ne 'preserve-log') {
            throw 'Pre-existing log data was changed.'
        }
    } elseif (Test-Path -LiteralPath $logDirectory) {
        throw "The empty log directory created by this attempt was not removed at $stage."
    }

    $expectedTaskRemovals = if ($stage -in @('scheduled-task-created','firewall-rule-created','scheduled-task-started')) { 1 } else { 0 }
    $expectedFirewallRemovals = if ($stage -in @('firewall-rule-created','scheduled-task-started')) { 1 } else { 0 }
    if ($script:taskRemovalCount -ne $expectedTaskRemovals) { throw "Unexpected task rollback scope at $stage." }
    if ($script:firewallRemovalCount -ne $expectedFirewallRemovals) { throw "Unexpected firewall rollback scope at $stage." }
    [void]$results.Add("PASS $stage")
}

$state = New-BillingInstallRollbackState
$script:taskRemovalCount = 0
$script:firewallRemovalCount = 0
$errors = Invoke-BillingInstallRollback -State $state `
    -RemoveCreatedTask { $script:taskRemovalCount++ } `
    -RemoveCreatedFirewallRule { $script:firewallRemovalCount++ }
if ($script:taskRemovalCount -ne 0 -or $script:firewallRemovalCount -ne 0) {
    throw 'Pre-existing scheduled task or firewall resources were targeted.'
}

$failureState = New-BillingInstallRollbackState
$failureState.TaskCreated = $true
$errors = Invoke-BillingInstallRollback -State $failureState `
    -RemoveCreatedTask { throw 'injected task cleanup failure' } `
    -RemoveCreatedFirewallRule { }
if (($errors -join ';') -notmatch 'injected task cleanup failure') {
    throw 'Rollback failure diagnostics did not preserve the cleanup error.'
}
$originalFailure = 'injected scheduled-task start failure'
$reportedFailure = "Installation failed: $originalFailure. Rollback also reported: $($errors -join ' | ')"
if ($reportedFailure -notmatch [regex]::Escape($originalFailure) -or
    $reportedFailure -notmatch 'injected task cleanup failure') {
    throw 'Rollback diagnostics hid the original installation failure.'
}
Write-Output "ROLLBACK_DIAGNOSTIC $reportedFailure"

$tlsFailureRoot = Join-Path $Root 'tls-acl-rollback-failure'
New-Item -ItemType Directory -Path $tlsFailureRoot -Force | Out-Null
$tlsFailureKey = Join-Path $tlsFailureRoot 'server.key'
Set-Content -LiteralPath $tlsFailureKey -Value 'fixture-key' -NoNewline
$tlsFailureState = New-BillingInstallRollbackState
Save-BillingAclSnapshot -State $tlsFailureState -Path $tlsFailureKey
Set-FixtureAclMarker $tlsFailureKey
function Set-Acl {
    param([string]$LiteralPath, $AclObject)
    throw 'injected TLS ACL restore failure'
}
$tlsOriginalFailure = 'injected failure after TLS key permission change'
$tlsRollbackErrors = Invoke-BillingInstallRollback -State $tlsFailureState `
    -RemoveCreatedTask { } `
    -RemoveCreatedFirewallRule { }
Remove-Item Function:\Set-Acl -ErrorAction Stop
$tlsReportedFailure = "Installation failed: $tlsOriginalFailure. Rollback also reported: $($tlsRollbackErrors -join ' | ')"
if (($tlsRollbackErrors -join ';') -notmatch 'injected TLS ACL restore failure' -or
    $tlsReportedFailure -notmatch [regex]::Escape($tlsOriginalFailure) -or
    $tlsReportedFailure -notmatch 'Could not restore original permissions') {
    throw 'TLS ACL rollback failure was not reported alongside the original installation failure.'
}
Write-Output "TLS_ACL_ROLLBACK_DIAGNOSTIC $tlsReportedFailure"

$results
