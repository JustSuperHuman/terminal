[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release', 'AuditMode')]
    [string]$Configuration = 'Debug',

    [ValidateSet('x64', 'x86', 'arm64')]
    [string]$Platform = 'x64',

    [switch]$Clean,

    [switch]$Prerelease
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path $PSScriptRoot).Path
Set-Location $repoRoot

Import-Module .\tools\OpenConsole.psm1 -Force
Set-MsBuildDevEnvironment -Prerelease:$Prerelease

& .\dep\nuget\nuget.exe restore .\dep\nuget\packages.config -PackagesDirectory .\packages
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$target = if ($Clean) { 'Clean;Build' } else { 'Build' }

msbuild .\OpenConsole.slnx `
    /p:Platform=$Platform `
    /p:Configuration=$Configuration `
    /p:GenerateAppxPackageOnBuild=false `
    /p:AppxBundle=false `
    /t:$target `
    /m `
    /v:minimal `
    /nologo
exit $LASTEXITCODE
