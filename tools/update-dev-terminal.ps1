[CmdletBinding()]
param(
    [switch]$NoLaunch,
    [switch]$MakeDefault,
    [switch]$Pull
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

$configuration = 'Debug'
$platform = 'x64'
$packageRoot = Join-Path $repoRoot "src\cascadia\CascadiaPackage\bin\$platform\$configuration"
$manifest = Join-Path $packageRoot 'AppxManifest.xml'
$devExe = Join-Path $packageRoot 'WindowsTerminal.exe'
$appUserModelId = 'WindowsTerminalDev_8wekyb3d8bbwe!App'
$devConsoleClsid = '{1F9F2BF5-5BC3-4F17-B0E6-912413F1F451}'
$devTerminalClsid = '{051F34EE-C1FD-4B19-AF75-9BA54648434C}'

if ($Pull) {
    git pull --ff-only
}

if (Test-Path $devExe) {
    $runningDevTerminals = Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and [string]::Equals($_.Path, $devExe, [System.StringComparison]::OrdinalIgnoreCase)
    }

    if ($runningDevTerminals) {
        Write-Host "Stopping running WindowsTerminalDev instances..."
        $runningDevTerminals | Stop-Process -Force
        Start-Sleep -Seconds 1
    }
}

Write-Host 'Restoring NuGet packages...'
& .\dep\nuget\nuget.exe restore .\dep\nuget\packages.config -PackagesDirectory .\packages

Write-Host 'Configuring MSBuild environment...'
Import-Module .\tools\OpenConsole.psm1 -Force
Set-MsBuildDevEnvironment

Write-Host "Building CascadiaPackage ($configuration|$platform)..."
& msbuild .\OpenConsole.slnx `
    /p:Platform=$platform `
    /p:Configuration=$configuration `
    /p:AppxSymbolPackageEnabled=false `
    '/t:Terminal\CascadiaPackage' `
    /m `
    /v:minimal `
    /nologo

if (-not (Test-Path $manifest)) {
    throw "Build succeeded, but the loose package manifest was not found: $manifest"
}

Write-Host 'Registering WindowsTerminalDev loose package...'
$existingPackages = Get-AppxPackage -Name WindowsTerminalDev -ErrorAction SilentlyContinue
if ($existingPackages) {
    Write-Host 'Unregistering existing WindowsTerminalDev package...'
    $removePackageCommand = Get-Command Remove-AppxPackage

    foreach ($existingPackage in $existingPackages) {
        $removePackageArgs = @{
            Package = $existingPackage.PackageFullName
        }

        if ($removePackageCommand.Parameters.ContainsKey('PreserveApplicationData')) {
            $removePackageArgs.PreserveApplicationData = $true
        }

        Remove-AppxPackage @removePackageArgs
    }
}

Add-AppxPackage -Register $manifest -ForceUpdateFromAnyVersion -ForceApplicationShutdown

if ($MakeDefault) {
    Write-Host 'Setting WindowsTerminalDev as the default terminal application...'
    $startupKey = 'HKCU:\Console\%%Startup'
    New-Item -Path $startupKey -Force | Out-Null
    New-ItemProperty -Path $startupKey -Name DelegationConsole -Value $devConsoleClsid -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $startupKey -Name DelegationTerminal -Value $devTerminalClsid -PropertyType String -Force | Out-Null
}

if (-not $NoLaunch) {
    Write-Host 'Launching WindowsTerminalDev...'
    Start-Process "shell:AppsFolder\$appUserModelId"
}

Write-Host 'WindowsTerminalDev is updated.'
