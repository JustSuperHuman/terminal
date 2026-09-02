[CmdletBinding()]
param(
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
trap {
    Write-Error $_
    exit 1
}
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $true
}

$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdministrator) {
    Write-Host 'Administrator approval is required once to trust the local package certificate.'
    $arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    if ($NoLaunch) {
        $arguments += ' -NoLaunch'
    }
    $elevated = Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $elevated.ExitCode
}

$msix = Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'WindowsTerminalReady-*.msix' | Select-Object -First 1
$certificateFile = Join-Path $PSScriptRoot 'WindowsTerminalReady.cer'
if (-not $msix -or -not (Test-Path $certificateFile)) {
    throw 'Keep Install.ps1, WindowsTerminalReady.cer, and the MSIX in the same folder.'
}

$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certificateFile)
$trustedCertificate = Get-Item "Cert:\LocalMachine\TrustedPeople\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
if (-not $trustedCertificate) {
    Write-Host 'Trusting the package signing certificate for this machine...'
    Import-Certificate -FilePath $certificateFile -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
}

$firewallRuleName = 'Windows Terminal Ready Web Bridge'
$firewallRule = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $firewallRule) {
    Write-Host 'Allowing authenticated web/mobile bridge connections through Windows Firewall...'
    $firewallRule = New-NetFirewallRule `
        -DisplayName $firewallRuleName `
        -Description 'Allows the self-hosted Windows Terminal web/mobile bridge. Remote API and WebSocket access still requires the generated bridge token.' `
        -Direction Inbound `
        -Action Allow `
        -Enabled True `
        -Profile Any `
        -Protocol TCP `
        -LocalPort '10001-10021'
}
else {
    $firewallRule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any
    $firewallRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort '10001-10021'
}

Write-Host 'Installing WindowsTerminalDev with its self-contained bridge...'
$existing = Get-AppxPackage -Name WindowsTerminalDev | Select-Object -First 1
if ($existing -and -not $existing.InstallLocation.StartsWith((Join-Path $env:ProgramFiles 'WindowsApps'), [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "Replacing the loose development registration at $($existing.InstallLocation)..."
    Remove-AppxPackage -Package $existing.PackageFullName -PreserveApplicationData
}
elseif ($existing) {
    # AppX ForceApplicationShutdown does not reliably close Terminal windows.
    # Stop only the WindowsTerminal process that owns this bridge's reserved
    # listener range; the user's stable/Preview/Canary terminals stay open.
    $bridgeOwnerIds = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -ge 10001 -and $_.LocalPort -le 10021 } |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($bridgeOwnerId in $bridgeOwnerIds) {
        $bridgeOwner = Get-Process -Id $bridgeOwnerId -ErrorAction SilentlyContinue
        if ($bridgeOwner -and $bridgeOwner.ProcessName -eq 'WindowsTerminal') {
            Write-Host "Closing the running WindowsTerminalDev bridge process ($bridgeOwnerId) for the update..."
            Stop-Process -Id $bridgeOwnerId -Force
            Wait-Process -Id $bridgeOwnerId -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
}
Add-AppxPackage -Path $msix.FullName -ForceUpdateFromAnyVersion -ForceApplicationShutdown

if (-not $NoLaunch) {
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wtd.exe'
    if (Test-Path $alias) {
        Start-Process -FilePath $alias
    }
    else {
        Start-Process 'shell:AppsFolder\WindowsTerminalDev_8wekyb3d8bbwe!App'
    }
}

$installed = Get-AppxPackage -Name WindowsTerminalDev | Select-Object -First 1
if (-not $installed) {
    throw 'WindowsTerminalDev was not present after installation.'
}

Write-Host "Installed WindowsTerminalDev $($installed.Version). The bridge starts automatically with the first terminal session."
