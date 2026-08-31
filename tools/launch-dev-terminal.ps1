# Options are parsed by hand instead of through param(). PowerShell's prefix
# matching would bind wt's own '-d <dir>' to a '-Direct' switch and swallow the
# flag, and a literal '--' separator fails parameter binding outright, so
# everything after the leading options has to reach wtd.exe untouched.
$restart = $false
$direct = $false
$noRegister = $false

$argIndex = 0
while ($argIndex -lt $args.Count) {
    $arg = [string]$args[$argIndex]
    if ($arg -ieq '-Restart') { $restart = $true; $argIndex++ }
    elseif ($arg -ieq '-Direct') { $direct = $true; $argIndex++ }
    elseif ($arg -ieq '-NoRegister') { $noRegister = $true; $argIndex++ }
    elseif ($arg -eq '--') { $argIndex++; break }
    else { break }
}

$arguments = @()
if ($argIndex -lt $args.Count) {
    $arguments = @($args[$argIndex..($args.Count - 1)] | ForEach-Object { [string]$_ })
}

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $true
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$configuration = 'Debug'
$platform = 'x64'
$packageRoot = Join-Path $repoRoot "src\cascadia\CascadiaPackage\bin\$platform\$configuration"
$devExe = Join-Path $packageRoot 'WindowsTerminal.exe'
$appUserModelId = 'WindowsTerminalDev_8wekyb3d8bbwe!App'
# Execution alias installed by the package registration. Launching through it is
# what gives the exe package identity; running the exe out of the loose layout
# directly starts a process with no identity and Terminal bails out.
$aliasExe = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wtd.exe'

if (-not (Test-Path $devExe)) {
    throw "WindowsTerminal.exe was not found in the loose package layout: $devExe`nBuild it first with 'bun run build' (or 'bun run update' to build and re-register)."
}

function Get-DevPackage {
    Get-AppxPackage -Name WindowsTerminalDev -ErrorAction SilentlyContinue | Select-Object -First 1
}

$package = Get-DevPackage
if (-not $package -and -not $direct) {
    # Rebuilding CascadiaPackage rewrites AppxManifest.xml with the source
    # version, which drops the loose-package registration. Re-register the
    # layout that is already on disk instead of forcing a full 'bun run update'.
    if ($noRegister) {
        throw "The WindowsTerminalDev package is not registered. Run 'bun run update' (or drop -NoRegister) to register it."
    }

    Write-Host 'WindowsTerminalDev is not registered; registering the existing build...'
    & (Join-Path $PSScriptRoot 'register-dev-terminal.ps1') -Configuration $configuration -Platform $platform
    $package = Get-DevPackage
    if (-not $package) {
        throw "Registering WindowsTerminalDev did not produce a package registration. Run 'bun run update' to rebuild and register."
    }
}

if ($package -and $package.InstallLocation -and -not [string]::Equals($package.InstallLocation.TrimEnd('\'), $packageRoot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Warning "WindowsTerminalDev is registered from $($package.InstallLocation), not $packageRoot. Run 'bun run update' to re-register this build."
}

if ($restart) {
    $running = Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and [string]::Equals($_.Path, $devExe, [System.StringComparison]::OrdinalIgnoreCase)
    }

    if ($running) {
        Write-Host 'Stopping running WindowsTerminalDev instances...'
        $running | Stop-Process -Force
        Start-Sleep -Seconds 1
    }
}

if ($direct) {
    Write-Warning 'Running WindowsTerminal.exe directly. Without package identity Terminal usually fails to start; use this only for debugging the launch itself.'
    Start-Process -FilePath $devExe -ArgumentList $arguments
    return
}

if (Test-Path $aliasExe) {
    Write-Host "Launching WindowsTerminalDev via $aliasExe..."
    Start-Process -FilePath $aliasExe -ArgumentList $arguments
    return
}

if ($arguments.Count -gt 0) {
    throw "The wtd.exe execution alias was not found at $aliasExe, so command-line arguments cannot be forwarded. Run 'bun run update' to re-register the package."
}

Write-Host 'wtd.exe execution alias not found; launching through the app model id instead...'
Start-Process "shell:AppsFolder\$appUserModelId"
