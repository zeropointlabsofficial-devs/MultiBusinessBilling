function New-BillingInstallRollbackState {
    return [pscustomobject]@{
        AclSnapshots = New-Object System.Collections.ArrayList
        CreatedFiles = New-Object System.Collections.ArrayList
        CreatedDirectories = New-Object System.Collections.ArrayList
        TaskCreated = $false
        FirewallCreated = $false
    }
}

function Save-BillingAclSnapshot {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved)) {
        throw "Cannot snapshot permissions for a missing path: $resolved"
    }
    if ($State.AclSnapshots | Where-Object { $_.Path -eq $resolved }) {
        return
    }
    [void]$State.AclSnapshots.Add([pscustomobject]@{
        Path = $resolved
        Acl = Get-Acl -LiteralPath $resolved
    })
}

function Ensure-BillingCreatedDirectoryTree {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $resolved -PathType Container) {
        return
    }
    $parent = Split-Path -Parent $resolved
    if ($parent -and $parent -ne $resolved) {
        Ensure-BillingCreatedDirectoryTree -State $State -Path $parent
    }
    try {
        New-Item -ItemType Directory -Path $resolved -ErrorAction Stop | Out-Null
        [void]$State.CreatedDirectories.Add($resolved)
    } catch {
        if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
            throw
        }
    }
}

function Register-BillingCreatedFile {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Path
    )
    [void]$State.CreatedFiles.Add([System.IO.Path]::GetFullPath($Path))
}

function Invoke-BillingInstallRollback {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][scriptblock]$RemoveCreatedTask,
        [Parameter(Mandatory = $true)][scriptblock]$RemoveCreatedFirewallRule
    )
    $errors = New-Object System.Collections.ArrayList

    if ($State.FirewallCreated) {
        try { & $RemoveCreatedFirewallRule } catch {
            [void]$errors.Add("Could not remove firewall rule created by this attempt: $($_.Exception.Message)")
        }
    }
    if ($State.TaskCreated) {
        try { & $RemoveCreatedTask } catch {
            [void]$errors.Add("Could not remove scheduled task created by this attempt: $($_.Exception.Message)")
        }
    }

    for ($index = $State.AclSnapshots.Count - 1; $index -ge 0; $index--) {
        $snapshot = $State.AclSnapshots[$index]
        try {
            if (Test-Path -LiteralPath $snapshot.Path) {
                Set-Acl -LiteralPath $snapshot.Path -AclObject $snapshot.Acl -ErrorAction Stop
            }
        } catch {
            [void]$errors.Add("Could not restore original permissions on $($snapshot.Path): $($_.Exception.Message)")
        }
    }

    for ($index = $State.CreatedFiles.Count - 1; $index -ge 0; $index--) {
        $path = [string]$State.CreatedFiles[$index]
        try {
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                Remove-Item -LiteralPath $path -Force -ErrorAction Stop
            }
        } catch {
            [void]$errors.Add("Could not remove file created by this attempt at $path`: $($_.Exception.Message)")
        }
    }

    for ($index = $State.CreatedDirectories.Count - 1; $index -ge 0; $index--) {
        $path = [string]$State.CreatedDirectories[$index]
        try {
            if ((Test-Path -LiteralPath $path -PathType Container) -and
                -not (Get-ChildItem -LiteralPath $path -Force | Select-Object -First 1)) {
                Remove-Item -LiteralPath $path -Force -ErrorAction Stop
            }
        } catch {
            [void]$errors.Add("Could not remove empty directory created by this attempt at $path`: $($_.Exception.Message)")
        }
    }
    return ,@($errors)
}
