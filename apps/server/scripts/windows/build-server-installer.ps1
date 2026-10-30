[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$OutputDirectory,
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
}
$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$server = Join-Path $root 'apps\server'
$entrypoint = Join-Path $server 'dist\src\index.js'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw 'Build the backend first; apps/server/dist/src/index.js is missing.'
}
if (-not $nodeCommand) { throw 'A signed Node.js 20+ runtime is required to prepare the server package.' }
$nodePath = $nodeCommand.Source
$nodeVersionText = (& $nodePath --version 2>$null) -replace '^v', ''
$nodeMajor = 0
if (-not [int]::TryParse(($nodeVersionText -split '\.')[0], [ref]$nodeMajor) -or $nodeMajor -lt 20) {
    throw 'Node.js 20 or newer is required to prepare the server package.'
}
$nodeArchitecture = & $nodePath -p 'process.arch'
if ($LASTEXITCODE -ne 0 -or $nodeArchitecture.Trim() -ne 'x64') {
    throw 'The Windows Server installer only supports an x64 OpenJS Node.js runtime.'
}
$nodeSignature = Get-AuthenticodeSignature -LiteralPath $nodePath
if ($nodeSignature.Status -ne 'Valid' -or $nodeSignature.SignerCertificate.Subject -notmatch 'OpenJS Foundation') {
    throw 'The Node.js runtime must have a valid OpenJS Foundation signature before it can be bundled.'
}
$makensisCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'),
    (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\Bin\makensis.exe')
)
$makensis = $makensisCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $makensis) { throw 'NSIS makensis.exe is unavailable. Install NSIS from its official distribution or use the verified Tauri NSIS toolchain.' }

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $server 'target\server-installers'
}
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$installerPath = Join-Path $output 'Business Billing Server_0.1.0_x64-setup.exe'
if ($PlanOnly) {
    [ordered]@{
        operation = 'prepare a standalone Windows Server installer'
        installer = $installerPath
        backendEntrypoint = $entrypoint
        nodeRuntime = $nodeVersionText
        nodeSigner = $nodeSignature.SignerCertificate.Subject
        postgres = 'separate, operator-installed official PostgreSQL prerequisite'
        migrations = 'not run'
        databaseChanges = $false
        existingClientInstallerOverwritten = $false
    } | ConvertTo-Json -Compress
    exit 0
}
if (Test-Path -LiteralPath $installerPath) {
    throw "Candidate installer already exists at $installerPath. Choose a new output directory; existing artifacts are never overwritten."
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) "billing-server-package-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$originalDatabaseUrl = $env:DATABASE_URL
try {
    New-Item -ItemType Directory -Path (Join-Path $stage 'apps\server') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage 'apps\desktop') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $root 'package-lock.json') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $server 'package.json') -Destination (Join-Path $stage 'apps\server')
    Copy-Item -LiteralPath (Join-Path $root 'apps\desktop\package.json') -Destination (Join-Path $stage 'apps\desktop')
    Copy-Item -LiteralPath (Join-Path $server 'prisma.config.ts') -Destination (Join-Path $stage 'apps\server')
    New-Item -ItemType Directory -Path (Join-Path $stage 'apps\server\prisma') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $server 'prisma\schema.prisma') -Destination (Join-Path $stage 'apps\server\prisma')
    Copy-Item -LiteralPath (Join-Path $server 'prisma\migrations') -Destination (Join-Path $stage 'apps\server\prisma') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $stage 'apps\server\dist') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $server 'dist\src') -Destination (Join-Path $stage 'apps\server\dist') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $stage 'apps\server\scripts') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $server 'scripts\windows') -Destination (Join-Path $stage 'apps\server\scripts') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force | Out-Null
    Copy-Item -LiteralPath $nodePath -Destination (Join-Path $stage 'runtime\node.exe')
    $nodeLicense = Join-Path (Split-Path -Parent $nodePath) 'LICENSE'
    if (Test-Path -LiteralPath $nodeLicense -PathType Leaf) {
        Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $stage 'runtime\NODE-LICENSE')
    }

    Push-Location $stage
    try {
        $env:DATABASE_URL = 'postgresql://billing_package:build-only@127.0.0.1:55432/billing_package'
        & npm.cmd ci --workspace @billing/server --omit=dev --include-workspace-root=false --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Could not install the locked production server dependencies into the temporary package staging directory.' }
        & npm.cmd prune --workspace @billing/server --omit=dev --include-workspace-root=false --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove non-production packages from the temporary server package.' }
        & npm.cmd ls --workspace @billing/server --omit=dev --depth=0
        if ($LASTEXITCODE -ne 0) { throw 'The staged production dependency tree does not match the server workspace manifest.' }
        $expectedZodVersion = (Get-Content -LiteralPath (Join-Path $stage 'apps\server\package.json') -Raw | ConvertFrom-Json).dependencies.zod
        $stagedZodVersion = (& $nodePath -p "require('./node_modules/zod/package.json').version")
        if ($LASTEXITCODE -ne 0 -or $stagedZodVersion.Trim() -ne $expectedZodVersion) {
            throw 'The staged Zod runtime version does not match the server manifest.'
        }
        & $nodePath -e "import('argon2').then(() => console.log('Argon2 native runtime loaded.')).catch((error) => { console.error(error.message); process.exit(1); })"
        if ($LASTEXITCODE -ne 0) { throw 'The staged Argon2 native runtime could not load on this Windows build host.' }
    } finally {
        Pop-Location
        if ($null -eq $originalDatabaseUrl) {
            Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
        } else {
            $env:DATABASE_URL = $originalDatabaseUrl
        }
    }

    foreach ($path in @('package.json', 'package-lock.json', 'apps\desktop\package.json')) {
        Remove-Item -LiteralPath (Join-Path $stage $path) -Force -ErrorAction SilentlyContinue
    }
    $requiredPayloadPaths = @(
        'apps\server\dist\src\index.js',
        'apps\server\scripts\windows\install-server.ps1',
        'apps\server\scripts\windows\run-server-install.ps1',
        'apps\server\scripts\windows\setup-server.ps1',
        'apps\server\scripts\windows\install-rollback.ps1',
        'apps\server\scripts\windows\uninstall-server.ps1',
        'runtime\node.exe'
    )
    foreach ($relativePath in $requiredPayloadPaths) {
        $requiredPath = Join-Path $stage $relativePath
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "A required Server installer payload file is missing from staging: $relativePath"
        }
    }
    $payloadFiles = Get-ChildItem -LiteralPath $stage -File -Recurse | ForEach-Object {
        $relative = $_.FullName.Substring($stage.TrimEnd('\').Length + 1)
        [ordered]@{
            path = $relative
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    [ordered]@{ version = 1; files = @($payloadFiles) } |
        ConvertTo-Json -Depth 6 |
        Set-Content -LiteralPath (Join-Path $stage 'server-payload-manifest.json') -Encoding UTF8

    New-Item -ItemType Directory -Path $output -Force | Out-Null
    $nsi = Join-Path $PSScriptRoot 'server-installer.nsi'
    $buildLog = Join-Path $output 'makensis-build.log'
    if (Test-Path -LiteralPath $buildLog) {
        throw "NSIS build log already exists at $buildLog. Choose a new output directory; existing artifacts are never overwritten."
    }
    $compilerVersion = (& $makensis -VERSION 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Could not query the selected NSIS compiler version at $makensis."
    }
    $compilerOutput = @(& $makensis '/V4' "/DPAYLOAD_DIR=$stage" "/DOUTPUT_FILE=$installerPath" $nsi 2>&1)
    $compilerExitCode = $LASTEXITCODE
    $compilerOutput | Set-Content -LiteralPath $buildLog -Encoding UTF8
    $compilerOutput | ForEach-Object { Write-Output $_ }
    if ($compilerExitCode -ne 0 -or -not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
        throw "NSIS failed to create the Server installer candidate. See the preserved build log: $buildLog"
    }
    $artifact = Get-Item -LiteralPath $installerPath
    $hash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
    $manifestHash = (Get-FileHash -LiteralPath (Join-Path $stage 'server-payload-manifest.json') -Algorithm SHA256).Hash
    [ordered]@{
        installer = $artifact.FullName
        bytes = $artifact.Length
        sha256 = $hash
        makensis = $makensis
        makensisVersion = $compilerVersion
        sourceScript = $nsi
        buildLog = $buildLog
        payloadManifestSha256 = $manifestHash
        signature = (Get-AuthenticodeSignature -LiteralPath $installerPath).Status.ToString()
        signed = $false
        message = 'Unsigned candidate; configure a legitimate publisher certificate before client distribution.'
    } | ConvertTo-Json -Compress
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
