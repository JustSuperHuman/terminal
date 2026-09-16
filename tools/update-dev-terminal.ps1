[CmdletBinding()]
param(
    [switch]$NoLaunch,
    [switch]$MakeDefault,
    [switch]$NoWtShim,
    [switch]$Pull
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $true
}

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
$wtShimDir = Join-Path $env:LOCALAPPDATA 'Programs\WindowsTerminalDevShim'
$wtShimExe = Join-Path $wtShimDir 'wt.exe'
$wtShimObj = Join-Path $wtShimDir 'wt-dev-shim.obj'
$wtShimSource = Join-Path $repoRoot 'tools\wt-dev-shim\wt-dev-shim.cpp'
$packageDataBackupRoot = $null
$packageDataRoot = $null

function Remove-PathEntry {
    param(
        [string[]]$Entries,
        [string]$EntryToRemove
    )

    $expandedEntryToRemove = [System.Environment]::ExpandEnvironmentVariables($EntryToRemove).TrimEnd('\')
    foreach ($entry in $Entries) {
        if ([string]::IsNullOrWhiteSpace($entry)) {
            continue
        }

        $expandedEntry = [System.Environment]::ExpandEnvironmentVariables($entry).Trim('"').TrimEnd('\')
        if (-not [string]::Equals($expandedEntry, $expandedEntryToRemove, [System.StringComparison]::OrdinalIgnoreCase)) {
            $entry
        }
    }
}

function Prepend-PathEntry {
    param(
        [string]$PathValue,
        [string]$EntryToPrepend
    )

    $entries = Remove-PathEntry -Entries ($PathValue -split ';') -EntryToRemove $EntryToPrepend
    (@($EntryToPrepend) + @($entries)) -join ';'
}

function Backup-PackageData {
    param([Parameter(Mandatory)]$Package)

    # PreserveApplicationData is only legal for development-mode packages.
    # A Ready/MSIX installation must be removed without that flag before this
    # checkout can be registered as a loose package, so retain Terminal's
    # user-owned state ourselves across that transition.
    if ($Package.IsDevelopmentMode) {
        return
    }

    $script:packageDataRoot = Join-Path $env:LOCALAPPDATA "Packages\$($Package.PackageFamilyName)"
    if (-not (Test-Path -LiteralPath $script:packageDataRoot)) {
        return
    }

    $script:packageDataBackupRoot = Join-Path ([System.IO.Path]::GetTempPath()) "WindowsTerminalDev-update-$PID"
    New-Item -ItemType Directory -Path $script:packageDataBackupRoot -Force | Out-Null

    foreach ($directory in @('LocalState', 'RoamingState')) {
        $source = Join-Path $script:packageDataRoot $directory
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination $script:packageDataBackupRoot -Recurse -Force
        }
    }

    Write-Host "Backed up WindowsTerminalDev user state to $script:packageDataBackupRoot"
}

function Restore-PackageData {
    if (-not $script:packageDataBackupRoot -or -not (Test-Path -LiteralPath $script:packageDataBackupRoot)) {
        return
    }

    New-Item -ItemType Directory -Path $script:packageDataRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $script:packageDataBackupRoot -Directory | ForEach-Object {
        $destination = Join-Path $script:packageDataRoot $_.Name
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        Get-ChildItem -LiteralPath $_.FullName -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
        }
    }

    Remove-Item -LiteralPath $script:packageDataBackupRoot -Recurse -Force
    $script:packageDataBackupRoot = $null
    Write-Host 'Restored WindowsTerminalDev user state.'
}

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

$existingPackages = Get-AppxPackage -Name WindowsTerminalDev -ErrorAction SilentlyContinue
if ($existingPackages) {
    Write-Host 'Unregistering existing WindowsTerminalDev package...'
    $removePackageCommand = Get-Command Remove-AppxPackage

    foreach ($existingPackage in $existingPackages) {
        Backup-PackageData -Package $existingPackage

        $removePackageArgs = @{
            Package = $existingPackage.PackageFullName
        }

        if ($existingPackage.IsDevelopmentMode -and $removePackageCommand.Parameters.ContainsKey('PreserveApplicationData')) {
            $removePackageArgs.PreserveApplicationData = $true
        }

        Remove-AppxPackage @removePackageArgs
    }
}

if (Test-Path $packageRoot) {
    Write-Host 'Clearing generated WindowsTerminalDev loose-package output...'
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
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

# Copies the dev image assets the WAP layout omits, stamps a unique package
# version, and registers the loose package. Shared with 'bun run launch'.
& (Join-Path $PSScriptRoot 'register-dev-terminal.ps1') -Configuration $configuration -Platform $platform
Restore-PackageData

if ($MakeDefault) {
    Write-Host 'Setting WindowsTerminalDev as the default terminal application...'
    $startupKey = 'HKCU:\Console\%%Startup'
    New-Item -Path $startupKey -Force | Out-Null
    New-ItemProperty -Path $startupKey -Name DelegationConsole -Value $devConsoleClsid -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $startupKey -Name DelegationTerminal -Value $devTerminalClsid -PropertyType String -Force | Out-Null
}

if (-not $NoWtShim) {
    Write-Host 'Installing wt.exe shim for WindowsTerminalDev...'
    New-Item -ItemType Directory -Path $wtShimDir -Force | Out-Null

    & cl.exe `
        /nologo `
        /O2 `
        /DUNICODE `
        /D_UNICODE `
        /EHsc `
        "/Fo$wtShimObj" `
        "/Fe$wtShimExe" `
        $wtShimSource `
        /link `
        /SUBSYSTEM:WINDOWS

    Remove-Item -LiteralPath $wtShimObj -Force -ErrorAction SilentlyContinue

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $newUserPath = Prepend-PathEntry -PathValue $userPath -EntryToPrepend $wtShimDir
    if ($newUserPath -ne $userPath) {
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    }
    $env:Path = Prepend-PathEntry -PathValue $env:Path -EntryToPrepend $wtShimDir

    $appPathsKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\wt.exe'
    New-Item -Path $appPathsKey -Force | Out-Null
    Set-Item -Path $appPathsKey -Value $wtShimExe
    New-ItemProperty -Path $appPathsKey -Name Path -Value $wtShimDir -PropertyType String -Force | Out-Null
}

if (-not $NoLaunch) {
    Write-Host 'Launching WindowsTerminalDev...'
    Start-Process "shell:AppsFolder\$appUserModelId"
}

Write-Host 'WindowsTerminalDev is updated.'
