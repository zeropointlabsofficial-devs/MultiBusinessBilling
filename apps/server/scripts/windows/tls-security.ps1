function Resolve-BillingTlsFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [System.IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\') -or
        ($Path.Length -gt 2 -and $Path.Substring(2).Contains(':'))) {
        throw 'TLS certificate and private-key paths must be absolute local file paths without alternate streams.'
    }
    try {
        $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
        $item = Get-Item -LiteralPath $resolved.ProviderPath -ErrorAction Stop
    } catch {
        throw 'The configured TLS certificate or private-key file could not be resolved.'
    }
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'TLS certificate and private-key paths must reference regular files, not directories or reparse points.'
    }
    $parent = $item.Directory
    while ($null -ne $parent) {
        if ($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'TLS certificate and private-key paths cannot be located beneath a reparse-point directory.'
        }
        $parent = $parent.Parent
    }
    return $item.FullName
}

function Assert-BillingPrivateKeyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        if ($null -eq $acl -or $null -eq $acl.Access) {
            throw 'ACL data was unavailable.'
        }
    } catch {
        throw 'TLS private-key permissions could not be inspected. Setup stopped without changing permissions.'
    }

    $administratorsSid = 'S-1-5-32-544'
    $serviceSid = 'S-1-5-19'
    $allowedSids = @($administratorsSid, $serviceSid)
    $readMask = [long][System.Security.AccessControl.FileSystemRights]::Read
    $executeRight = [long][System.Security.AccessControl.FileSystemRights]::ExecuteFile
    $serviceWriteMask = [long](
        [System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    $administratorRights = [long]0
    $serviceRights = [long]0

    foreach ($rule in @($acl.Access)) {
        try {
            $sid = $rule.IdentityReference.Translate(
                [System.Security.Principal.SecurityIdentifier]
            ).Value
        } catch {
            throw 'A TLS private-key ACL identity could not be resolved. Setup stopped without changing permissions.'
        }

        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
            throw 'The TLS private-key ACL contains a deny rule. Setup cannot safely determine effective access.'
        }
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            throw 'The TLS private-key ACL contains an unsupported access rule.'
        }
        if ($sid -notin $allowedSids) {
            throw "The TLS private-key ACL grants access to an unauthorized Windows identity (SID $sid). Remove or explicitly authorize that access before setup."
        }

        $rights = [long]$rule.FileSystemRights
        if ($sid -eq $administratorsSid) {
            $administratorRights = $administratorRights -bor $rights
        } else {
            if (($rights -band $serviceWriteMask) -ne 0 -or ($rights -band $executeRight) -ne 0) {
                throw 'The backend service identity has more than read-only access to the TLS private key. Restrict its access before setup.'
            }
            $serviceRights = $serviceRights -bor $rights
        }
    }

    if (($administratorRights -band $readMask) -ne $readMask) {
        throw 'The TLS private-key ACL must grant read access to BUILTIN\Administrators.'
    }
    return [pscustomobject]@{
        ServiceCanRead = (($serviceRights -band $readMask) -eq $readMask)
    }
}

function Assert-BillingTlsCertificate {
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string]$CertificatePath,
        [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
        [Parameter(Mandatory = $true)][string]$ServerName
    )

    $validationScript = @'
const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");
const { X509Certificate, createPrivateKey, createPublicKey, timingSafeEqual } = require("node:crypto");

try {
  const [certificatePath, privateKeyPath, serverName] = process.argv.slice(1);
  if (!certificatePath || !privateKeyPath || !serverName || /[*\s]/.test(serverName)) {
    throw new Error();
  }
  const certificatePem = fs.readFileSync(certificatePath);
  const privateKeyPem = fs.readFileSync(privateKeyPath);
  const certificate = new X509Certificate(certificatePem);
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new Error();
  }
  const match = net.isIP(serverName)
    ? certificate.checkIP(serverName)
    : certificate.checkHost(serverName, { subject: "never" });
  if (!match) {
    throw new Error();
  }
  tls.createSecureContext({ cert: certificatePem, key: privateKeyPem });
  const certKey = certificate.publicKey.export({ format: "der", type: "spki" });
  const privateKey = createPrivateKey(privateKeyPem);
  const privateKeyPublic = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (certKey.length !== privateKeyPublic.length || !timingSafeEqual(certKey, privateKeyPublic)) {
    throw new Error();
  }
} catch {
  console.error("TLS certificate validation failed (validity, SAN identity, private-key match, or certificate parsing).");
  process.exit(1);
}
'@
    $previousErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $null = & $NodePath -e $validationScript $CertificatePath $PrivateKeyPath $ServerName 2>$null
        $validationExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorPreference
    }
    if ($validationExitCode -ne 0) {
        throw 'TLS certificate validation failed. Verify the certificate is current, includes the configured server name in its SAN, matches the private key, and is readable by the installer.'
    }
}
