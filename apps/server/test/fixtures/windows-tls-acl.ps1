param(
    [Parameter(Mandatory = $true)][string]$Scenario,
    [string]$Root
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot '..\..\scripts\windows\tls-security.ps1'
. $helper

function New-FixtureRule {
    param([string]$Sid, [string]$Rights)
    $identity = New-Object System.Security.Principal.SecurityIdentifier($Sid)
    $fileRights = [System.Enum]::Parse([System.Security.AccessControl.FileSystemRights], $Rights)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity,
        $fileRights,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    return $rule
}

$script:aclFailure = $false
$script:mockAcl = $null
function Get-Acl {
    if ($script:aclFailure) {
        throw 'injected ACL inspection failure'
    }
    return $script:mockAcl
}

$administrators = New-FixtureRule -Sid 'S-1-5-32-544' -Rights 'Read'
$service = New-FixtureRule -Sid 'S-1-5-19' -Rights 'Read'
$script:mockAcl = [pscustomobject]@{ Access = @($administrators, $service) }

switch ($Scenario) {
    'secure' {
        $assessment = Assert-BillingPrivateKeyAcl -Path 'C:\fixture\server.key'
        if (-not $assessment.ServiceCanRead) { throw 'Secure ACL was not recognized.' }
        Write-Output 'PASS secure'
    }
    'broad' {
        $everyone = New-FixtureRule -Sid 'S-1-1-0' -Rights 'Read'
        $script:mockAcl = [pscustomobject]@{ Access = @($administrators, $service, $everyone) }
        try {
            Assert-BillingPrivateKeyAcl -Path 'C:\fixture\server.key'
            throw 'Broad ACL was accepted.'
        } catch {
            if ($_.Exception.Message -notmatch 'unauthorized Windows identity') { throw }
            Write-Output 'PASS broad-rejected'
        }
    }
    'unresolved' {
        $identity = New-Object System.Security.Principal.NTAccount('BILLING_TEST\NoSuchUser')
        $unknown = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $identity,
            [System.Security.AccessControl.FileSystemRights]::Read,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $script:mockAcl = [pscustomobject]@{ Access = @($administrators, $unknown) }
        try {
            Assert-BillingPrivateKeyAcl -Path 'C:\fixture\server.key'
            throw 'Unauthorized identity was accepted.'
        } catch {
            if ($_.Exception.Message -notmatch 'identity could not be resolved') { throw }
            Write-Output 'PASS unresolved-identity-rejected'
        }
    }
    'inspection-failure' {
        $script:aclFailure = $true
        try {
            Assert-BillingPrivateKeyAcl -Path 'C:\fixture\server.key'
            throw 'ACL inspection failure was accepted.'
        } catch {
            if ($_.Exception.Message -notmatch 'could not be inspected') { throw }
            Write-Output 'PASS inspection-failure'
        }
    }
    'service-write' {
        $writeService = New-FixtureRule -Sid 'S-1-5-19' -Rights 'Modify'
        $script:mockAcl = [pscustomobject]@{ Access = @($administrators, $writeService) }
        try {
            Assert-BillingPrivateKeyAcl -Path 'C:\fixture\server.key'
            throw 'Service write access was accepted.'
        } catch {
            if ($_.Exception.Message -notmatch 'more than read-only access') { throw }
            Write-Output 'PASS service-write-rejected'
        }
    }
    'certificate-invalid' {
        if (-not $Root) { throw 'A temporary test root is required.' }
        $directory = Join-Path $Root 'TLS test files'
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $certificate = Join-Path $directory 'invalid certificate.pem'
        $privateKey = Join-Path $directory 'invalid private key.pem'
        Set-Content -LiteralPath $certificate -Value 'not a certificate' -NoNewline
        Set-Content -LiteralPath $privateKey -Value 'not a key' -NoNewline
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        try {
            Assert-BillingTlsCertificate -NodePath $node -CertificatePath $certificate `
                -PrivateKeyPath $privateKey -ServerName 'billing.example.test'
            throw 'Invalid certificate was accepted.'
        } catch {
            if ($_.Exception.Message -notmatch 'TLS certificate validation failed') { throw }
            Write-Output 'PASS invalid-certificate-rejected'
        }
    }
    'unsafe-path' {
        try {
            Resolve-BillingTlsFile -Path 'relative\server.key'
            throw 'Relative TLS path was accepted.'
        } catch {
            if ($_.Exception.Message -notmatch 'absolute local file paths') { throw }
            Write-Output 'PASS unsafe-path-rejected'
        }
    }
    default {
        throw "Unknown fixture scenario: $Scenario"
    }
}
