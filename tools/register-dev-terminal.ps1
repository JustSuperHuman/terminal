[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release', 'AuditMode')]
    [string]$Configuration = 'Debug',

    [ValidateSet('x64', 'x86', 'arm64')]
    [string]$Platform = 'x64'
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $true
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageRoot = Join-Path $repoRoot "src\cascadia\CascadiaPackage\bin\$Platform\$Configuration"
$packageImagesRoot = Join-Path $packageRoot 'Images'
$devImagesRoot = Join-Path $repoRoot 'res\terminal\images-Dev'
$manifest = Join-Path $packageRoot 'AppxManifest.xml'

if (-not (Test-Path $manifest)) {
    throw "The loose package manifest was not found: $manifest`nBuild the package first ('bun run build')."
}

# The WAP build records these resource-qualified assets in package.map.txt but
# does not copy them into the loose layout used by Add-AppxPackage -Register.
# Without them, Windows has no Square44x44Logo asset for the taskbar.
if (-not (Test-Path $devImagesRoot)) {
    throw "WindowsTerminalDev image assets were not found: $devImagesRoot"
}

Write-Host 'Copying WindowsTerminalDev image assets into the loose package...'
New-Item -ItemType Directory -Path $packageImagesRoot -Force | Out-Null
Copy-Item -Path (Join-Path $devImagesRoot '*') -Destination $packageImagesRoot -Recurse -Force

# Stamp a unique, monotonically increasing package version. Re-registering the
# same version can hit ERROR_SHARING_VIOLATION (0x80070020) when Windows fails
# to delete the stale AppRepository metadata directory from the previous
# registration; a fresh version gets a fresh metadata directory instead.
$now = Get-Date
$stampedVersion = '0.{0}.{1}.{2}' -f (($now.Year - 2020) * 12 + $now.Month), ($now.Day * 100 + $now.Hour), ($now.Minute * 100 + $now.Second)
Write-Host "Stamping loose package version $stampedVersion..."
$manifestXml = Get-Content $manifest -Raw
$manifestXml = $manifestXml -replace '(<Identity[^>]*\sVersion=")[0-9.]+(")', "`${1}$stampedVersion`${2}"
Set-Content -Path $manifest -Value $manifestXml -Encoding UTF8

Write-Host 'Registering WindowsTerminalDev loose package...'
Add-AppxPackage -Register $manifest -ForceUpdateFromAnyVersion -ForceApplicationShutdown
