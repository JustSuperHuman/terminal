[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release', 'AuditMode')]
    [string]$Configuration = 'Debug',

    [ValidateSet('x64', 'x86', 'arm64')]
    [string]$Platform = 'x64',

    # Where the side-by-side loose layout lives. Kept apart from the build
    # output so a later build never overwrites files under a running app.
    [string]$Destination,

    # Bridge data root for this package. A non-default root gives the build
    # its own bridge host (own owner mutex, own port, own project store), so
    # the everyday terminal's host keeps running untouched.
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TerminalWebNext'),

    [switch]$NoLaunch
)

# Registers the freshly built loose package under a SECOND identity
# (WindowsTerminalDevNext, alias wtdn.exe) so it runs next to the everyday
# WindowsTerminalDev package instead of shutting its windows down. Use this
# to try a new build while work is still open in the current terminal.

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $true
}

$identityName = 'WindowsTerminalDevNext'
$aliasName = 'wtdn.exe'
$publisherId = '8wekyb3d8bbwe'
$familyName = "${identityName}_$publisherId"
$appUserModelId = "$familyName!App"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = Join-Path $repoRoot "src\cascadia\CascadiaPackage\bin\$Platform\$Configuration"
$sourceManifest = Join-Path $sourceRoot 'AppxManifest.xml'
if (-not (Test-Path $sourceManifest)) {
    throw "The loose package manifest was not found: $sourceManifest`nBuild the package first ('bun run build')."
}
if (-not $Destination) {
    $Destination = Join-Path $repoRoot "artifacts\$identityName-$Platform-$Configuration"
}
$Destination = [IO.Path]::GetFullPath($Destination)

# Only instances running from the staging folder are stopped; the everyday
# WindowsTerminalDev windows are never touched.
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($Destination.TrimEnd([char]92) + [char]92, [StringComparison]::OrdinalIgnoreCase)
})
if ($running.Count -gt 0) {
    Write-Host "Stopping $($running.Count) process(es) running from the previous $identityName layout..."
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

Write-Host "Staging the loose layout into $Destination..."
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
# robocopy exit codes below 8 are success variants, so its exit code must not
# be treated as a failure by $PSNativeCommandUseErrorActionPreference.
$previousNativePreference = $PSNativeCommandUseErrorActionPreference
$PSNativeCommandUseErrorActionPreference = $false
try {
    & robocopy $sourceRoot $Destination /MIR /XF *.pdb *.appxrecipe /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
    $robocopyExit = $LASTEXITCODE
}
finally {
    $PSNativeCommandUseErrorActionPreference = $previousNativePreference
}
if ($robocopyExit -ge 8) {
    throw "robocopy failed with exit code $robocopyExit while staging the layout."
}

$devImagesRoot = Join-Path $repoRoot 'res\terminal\images-Dev'
Copy-Item -Path (Join-Path $devImagesRoot '*') -Destination (Join-Path $Destination 'Images') -Recurse -Force

$manifestPath = Join-Path $Destination 'AppxManifest.xml'
$xml = [xml](Get-Content $manifestPath -Raw)
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace('m', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
$ns.AddNamespace('uap3', 'http://schemas.microsoft.com/appx/manifest/uap/windows10/3')
$ns.AddNamespace('desktop', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10')
$ns.AddNamespace('com', 'http://schemas.microsoft.com/appx/manifest/com/windows10')
$ns.AddNamespace('desktop4', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/4')

$now = Get-Date
$stampedVersion = '0.{0}.{1}.{2}' -f (($now.Year - 2020) * 12 + $now.Month), ($now.Day * 100 + $now.Hour), ($now.Minute * 100 + $now.Second)
$identity = $xml.SelectSingleNode('/m:Package/m:Identity', $ns)
$identity.SetAttribute('Name', $identityName)
$identity.SetAttribute('Version', $stampedVersion)

# A second alias so `wtdn` reaches this package while `wtd` keeps reaching the
# everyday one.
foreach ($aliasExtension in $xml.SelectNodes('//uap3:Extension[@Category="windows.appExecutionAlias"]', $ns)) {
    # Only the alias name changes; Executable must stay a file in the layout.
    foreach ($alias in $aliasExtension.SelectNodes('.//desktop:ExecutionAlias', $ns)) {
        $alias.SetAttribute('Alias', $aliasName)
    }
}

# Drop the system-integration registrations that the everyday package already
# owns: COM handoff servers/interfaces (same CLSIDs), the console/terminal host
# app extensions, and the Explorer context menu. The side-by-side build is
# for trying the app itself, not for taking over default-terminal duties.
$removeXPaths = @(
    '//com:Extension',
    '//uap3:Extension[@Category="windows.appExtension"]',
    '//desktop4:Extension[@Category="windows.fileExplorerContextMenus"]'
)
foreach ($xpath in $removeXPaths) {
    foreach ($node in @($xml.SelectNodes($xpath, $ns))) {
        $node.ParentNode.RemoveChild($node) | Out-Null
    }
}
$xml.Save($manifestPath)

Write-Host "Registering $identityName $stampedVersion..."
Add-AppxPackage -Register $manifestPath -ForceUpdateFromAnyVersion

# First registration: start from the everyday package's settings so the
# side-by-side build looks and behaves the same (state.json carries the
# persisted window layouts, so restore can be exercised too).
$sourceState = Join-Path $env:LOCALAPPDATA "Packages\WindowsTerminalDev_$publisherId\LocalState"
$targetState = Join-Path $env:LOCALAPPDATA "Packages\$familyName\LocalState"
if ((Test-Path $sourceState) -and -not (Test-Path (Join-Path $targetState 'settings.json'))) {
    Write-Host "Seeding settings from $sourceState..."
    New-Item -ItemType Directory -Path $targetState -Force | Out-Null
    foreach ($file in 'settings.json', 'state.json') {
        $candidate = Join-Path $sourceState $file
        if (Test-Path $candidate) {
            Copy-Item $candidate $targetState -Force
        }
    }
}

$registered = Get-AppxPackage -Name $identityName
if (-not $registered) {
    throw "Registration finished but $identityName is not listed by Get-AppxPackage."
}
Write-Host "Registered $($registered.PackageFullName) from $($registered.InstallLocation)"

if (-not $NoLaunch) {
    # The execution alias inherits this environment, which is how the data
    # root reaches the packaged app; the AppsFolder fallback cannot carry it.
    $aliasExe = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\$aliasName"
    New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
    $env:TERMINAL_WEB_DATA_ROOT = $DataRoot
    if (Test-Path $aliasExe) {
        Write-Host "Launching $aliasName with TERMINAL_WEB_DATA_ROOT=$DataRoot..."
        Start-Process -FilePath $aliasExe
    }
    else {
        Write-Host "Alias missing; launching $appUserModelId (bridge will share the default data root)..."
        Start-Process "shell:AppsFolder\$appUserModelId"
    }
}
