[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',

    [ValidateSet('x64', 'x86', 'arm64')]
    [string]$Platform = 'x64',

    [switch]$SkipNativeBuild
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $true
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$artifactsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'artifacts'))
$workRoot = [IO.Path]::GetFullPath((Join-Path $artifactsRoot "ready-terminal-$Platform-$Configuration"))
$releaseRoot = Join-Path $workRoot 'WindowsTerminalReady'
$payloadRoot = Join-Path $workRoot 'Payload'
$terminalPackageRoot = Join-Path $repoRoot "src\cascadia\CascadiaPackage\bin\$Platform\$Configuration"
$msixPath = Join-Path $releaseRoot "WindowsTerminalReady-$Platform.msix"
$certificatePath = Join-Path $releaseRoot 'WindowsTerminalReady.cer'
$zipPath = Join-Path $artifactsRoot "WindowsTerminalReady-$Platform-$Configuration.zip"

# Recursive cleanup is deliberately constrained to this one generated folder.
$artifactsPrefix = $artifactsRoot.TrimEnd('\') + '\'
if (-not $workRoot.StartsWith($artifactsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a packaging path outside $artifactsRoot"
}

if (Test-Path $workRoot) {
    Remove-Item -LiteralPath $workRoot -Recurse -Force
}
if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
New-Item -ItemType Directory -Path $releaseRoot, $payloadRoot -Force | Out-Null

Write-Host 'Building the production terminal-web client...'
Push-Location (Join-Path $repoRoot 'tools\terminal-web')
try {
    & bun run build:client
}
finally {
    Pop-Location
}

if (-not $SkipNativeBuild) {
    Write-Host "Building WindowsTerminalDev ($Configuration|$Platform)..."
    # C++/WinRT's incremental cache can survive after its generated projection
    # directory is removed, causing a false up-to-date result followed by a
    # missing winrt/base.h compile failure. A distributable build starts from
    # clean generated output so the projection and payload are reproducible.
    $nativeGeneratedRoots = @(
        [IO.Path]::GetFullPath((Join-Path $repoRoot "obj\$Platform\$Configuration")),
        [IO.Path]::GetFullPath((Join-Path $repoRoot "bin\$Platform\$Configuration")),
        [IO.Path]::GetFullPath($terminalPackageRoot)
    )
    $allowedGeneratedPrefixes = @(
        ([IO.Path]::GetFullPath((Join-Path $repoRoot 'obj')).TrimEnd('\') + '\')
        ([IO.Path]::GetFullPath((Join-Path $repoRoot 'bin')).TrimEnd('\') + '\')
        ([IO.Path]::GetFullPath((Join-Path $repoRoot 'src\cascadia\CascadiaPackage\bin')).TrimEnd('\') + '\')
    )
    foreach ($generatedRoot in $nativeGeneratedRoots) {
        if (-not ($allowedGeneratedPrefixes | Where-Object { $generatedRoot.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })) {
            throw "Refusing to clean unexpected native output path: $generatedRoot"
        }
        if (Test-Path $generatedRoot) {
            Remove-Item -LiteralPath $generatedRoot -Recurse -Force
        }
    }

    & (Join-Path $repoRoot 'dep\nuget\nuget.exe') restore (Join-Path $repoRoot 'dep\nuget\packages.config') -PackagesDirectory (Join-Path $repoRoot 'packages')
    Import-Module (Join-Path $repoRoot 'tools\OpenConsole.psm1') -Force
    Set-MsBuildDevEnvironment
    & msbuild (Join-Path $repoRoot 'OpenConsole.slnx') `
        /p:Platform=$Platform `
        /p:Configuration=$Configuration `
        /p:AppxSymbolPackageEnabled=false `
        '/t:Terminal\CascadiaPackage' `
        /m `
        /v:minimal `
        /nologo
}

$manifest = Join-Path $terminalPackageRoot 'AppxManifest.xml'
if (-not (Test-Path $manifest)) {
    throw "The native package layout was not found at $terminalPackageRoot"
}

Write-Host 'Staging the native package payload...'
Copy-Item -Path (Join-Path $terminalPackageRoot '*') -Destination $payloadRoot -Recurse -Force

# Symbols and the WAP build recipe are developer outputs, not runtime files.
# Leaving them in more than doubles the distributable without helping an
# installed package, including PDBs nested under production dependencies.
Get-ChildItem -LiteralPath $payloadRoot -Recurse -File -Filter '*.pdb' | Remove-Item -Force
Get-ChildItem -LiteralPath $payloadRoot -File -Filter '*.appxrecipe' | Remove-Item -Force

# The WAP loose layout omits these Dev-branding assets even though the manifest
# references them. Include them explicitly so the installed MSIX has complete
# Start/taskbar imagery.
$imagesRoot = Join-Path $payloadRoot 'Images'
New-Item -ItemType Directory -Path $imagesRoot -Force | Out-Null
Copy-Item -Path (Join-Path $repoRoot 'res\terminal\images-Dev\*') -Destination $imagesRoot -Recurse -Force

# Stamp a valid monotonically changing four-part package version.
$now = Get-Date
$packageVersion = '0.{0}.{1}.{2}' -f ($now.Year - 2020), (($now.DayOfYear * 100) + $now.Hour), (($now.Minute * 100) + $now.Second)
$stagedManifest = Join-Path $payloadRoot 'AppxManifest.xml'
$manifestXml = Get-Content $stagedManifest -Raw
$manifestXml = $manifestXml -replace '(<Identity[^>]*\sVersion=")[0-9.]+(")', "`${1}$packageVersion`${2}"
Set-Content -Path $stagedManifest -Value $manifestXml -Encoding UTF8

$sdkBin = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory |
    Where-Object Name -Match '^\d+\.\d+\.\d+\.\d+$' |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64' } |
    Where-Object { (Test-Path (Join-Path $_ 'MakeAppx.exe')) -and (Test-Path (Join-Path $_ 'SignTool.exe')) } |
    Select-Object -First 1
if (-not $sdkBin) {
    throw 'A Windows SDK containing MakeAppx.exe and SignTool.exe was not found.'
}

Write-Host 'Creating the installable MSIX...'
& (Join-Path $sdkBin 'MakeAppx.exe') pack /d $payloadRoot /p $msixPath /o

$signingCertificate = $null
try {
    Write-Host 'Signing the MSIX with a package-specific local certificate...'
    $signingCertificate = New-SelfSignedCertificate `
        -Type Custom `
        -Subject 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' `
        -FriendlyName 'WindowsTerminalReady package signing' `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -KeyUsage DigitalSignature `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -NotAfter (Get-Date).AddYears(3) `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}CA=false')

    Export-Certificate -Cert $signingCertificate -FilePath $certificatePath -Type CERT | Out-Null
    & (Join-Path $sdkBin 'SignTool.exe') sign /fd SHA256 /sha1 $signingCertificate.Thumbprint /s My $msixPath
}
finally {
    if ($signingCertificate) {
        Remove-Item -LiteralPath $signingCertificate.PSPath -Force
    }
}

Copy-Item (Join-Path $PSScriptRoot 'ready-package\Install.ps1') $releaseRoot
Copy-Item (Join-Path $PSScriptRoot 'ready-package\README.txt') $releaseRoot

$unpackedRoot = Join-Path $workRoot 'VerifiedMsix'
New-Item -ItemType Directory -Path $unpackedRoot -Force | Out-Null
& (Join-Path $sdkBin 'MakeAppx.exe') unpack /p $msixPath /d $unpackedRoot /o
$unpackedManifest = Join-Path $unpackedRoot 'AppxManifest.xml'
$manifestDetails = [xml](Get-Content $unpackedManifest -Raw)
$nativeBridgePath = Join-Path $unpackedRoot 'TerminalConnection.dll'
if (-not (Test-Path $nativeBridgePath)) {
    throw 'The packaged native Rust bridge DLL is missing.'
}
$nativeBridgeText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($nativeBridgePath))
if (-not $nativeBridgeText.Contains('<title>Terminal Web Host</title>')) {
    throw 'The packaged native Rust bridge DLL does not contain the embedded web client.'
}
foreach ($legacyRuntime in @(
    'TerminalWeb',
    'TerminalWeb\dist\server',
    'TerminalWeb\dist\bridge',
    'TerminalWeb\node_modules',
    'TerminalWeb\package.json',
    'TerminalWeb\terminal-web-host.exe'
)) {
    if (Test-Path (Join-Path $unpackedRoot $legacyRuntime)) {
        throw "The package still contains the legacy relay runtime: $legacyRuntime"
    }
}
if ($manifestDetails.Package.Identity.Version -ne $packageVersion) {
    throw "MSIX version verification failed: expected $packageVersion"
}

Write-Host 'Creating the ready-to-install ZIP...'
Compress-Archive -Path (Join-Path $releaseRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entryNames = @($archive.Entries.FullName)
    foreach ($required in @("WindowsTerminalReady-$Platform.msix", 'WindowsTerminalReady.cer', 'Install.ps1', 'README.txt')) {
        if ($required -notin $entryNames) {
            throw "The final archive is missing $required"
        }
    }
}
finally {
    $archive.Dispose()
}

$hash = Get-FileHash $zipPath -Algorithm SHA256
[pscustomobject]@{
    PackageVersion = $packageVersion
    Msix = $msixPath
    Zip = $zipPath
    ZipBytes = (Get-Item $zipPath).Length
    SHA256 = $hash.Hash
} | Format-List
