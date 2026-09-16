[CmdletBinding()]
param(
    # Names the slot. Everything else is derived from it, so two slots never
    # share an identity, an alias, a staging folder or a bridge data root.
    [ValidatePattern('^[A-Za-z][A-Za-z0-9]{0,15}$')]
    [string]$Slot = 'Test',

    [ValidateSet('Debug', 'Release', 'AuditMode')]
    [string]$Configuration = 'Debug',

    [ValidateSet('x64', 'x86', 'arm64')]
    [string]$Platform = 'x64',

    # Where this slot's loose layout lives. Defaults to a per-slot folder under
    # artifacts\ so a later build never writes under a running app.
    [string]$Destination,

    # Bridge data root for this package. A non-default root gives the slot its
    # own bridge host (own owner mutex, port and project store), so the
    # everyday terminal's host keeps running untouched.
    [string]$DataRoot,

    [switch]$NoLaunch
)

# Registers the current build under its own identity (WindowsTerminalDev<Slot>)
# in its own folder, so it runs alongside every other build instead of
# replacing one. Nothing outside this slot's own staging folder is ever
# stopped, overwritten or unregistered.
#
# Unlike register-dev-terminal-next.ps1, this does NOT copy the package layout
# under src\cascadia\CascadiaPackage\bin. That folder is the wapproj's own
# output, so it is locked whenever a terminal is running from it - which is
# exactly when you want a side-by-side build - and a locked layout is a stale
# layout. Instead the layout is assembled from the build's own .appxrecipe,
# which maps every packaged file to the project output it came from. Those
# outputs (bin\<platform>\<config>\<project>\) are never locked by a running
# packaged app, so this works with any number of terminals open.

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $true
}

$identityName = "WindowsTerminalDev$Slot"
$aliasName = ('wtd{0}.exe' -f $Slot.ToLowerInvariant())
$publisherId = '8wekyb3d8bbwe'
$familyName = "${identityName}_$publisherId"
$appUserModelId = "$familyName!App"

if (-not $DataRoot) {
    $DataRoot = Join-Path $env:LOCALAPPDATA "TerminalWeb$Slot"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageRoot = Join-Path $repoRoot "src\cascadia\CascadiaPackage\bin\$Platform\$Configuration"
$recipePath = Join-Path $packageRoot 'CascadiaPackage.build.appxrecipe'
$sourceManifest = Join-Path $packageRoot 'AppxManifest.xml'

foreach ($required in $recipePath, $sourceManifest) {
    if (-not (Test-Path $required)) {
        throw "Not found: $required`nBuild the package at least once first ('bun run build')."
    }
}

if (-not $Destination) {
    $Destination = Join-Path $repoRoot "artifacts\$identityName-$Platform-$Configuration"
}
$Destination = [IO.Path]::GetFullPath($Destination)

if ($Destination.StartsWith($packageRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Destination must not sit inside the wapproj output ($packageRoot)."
}

# Only processes running from THIS slot's folder are stopped. Every other
# terminal - the everyday Dev package, other slots, the Store build - is left
# alone, which is the whole point of a side-by-side slot.
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($Destination.TrimEnd([char]92) + [char]92, [StringComparison]::OrdinalIgnoreCase)
    })
if ($running.Count -gt 0) {
    Write-Host "Stopping $($running.Count) process(es) running from this slot's layout..."
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

Write-Host "Staging $identityName into $Destination..."
New-Item -ItemType Directory -Path $Destination -Force | Out-Null

# The recipe is the build's own manifest of the package: every packaged file
# with the project output it is copied from. Reading it beats mirroring the
# wapproj layout, which may be half-written whenever a copy was blocked.
[xml]$recipe = Get-Content $recipePath -Raw
$msb = 'http://schemas.microsoft.com/developer/msbuild/2003'
$ns = New-Object System.Xml.XmlNamespaceManager($recipe.NameTable)
$ns.AddNamespace('m', $msb)

# MSBuild escapes reserved characters as %XX in item metadata, so a path under
# "Program Files (x86)" arrives as "Program Files %28x86%29" and would look
# like a missing file. Undo that before touching the filesystem.
function Expand-MsBuildEscapes([string]$value) {
    [regex]::Replace($value, '%[0-9A-Fa-f]{2}', {
            param($match)
            [char][Convert]::ToInt32($match.Value.Substring(1), 16)
        })
}

$copied = 0
$missing = @()
foreach ($file in $recipe.SelectNodes('//m:AppxPackagedFile', $ns)) {
    $source = Expand-MsBuildEscapes $file.GetAttribute('Include')
    $relative = Expand-MsBuildEscapes $file.SelectSingleNode('m:PackagePath', $ns).InnerText
    # Recipe paths occasionally contain a doubled separator.
    $source = $source -replace '(?<!^)\\\\+', '\\'
    if (-not (Test-Path -LiteralPath $source)) {
        $missing += $relative
        continue
    }
    $target = Join-Path $Destination $relative
    $targetDir = Split-Path $target -Parent
    if (-not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $source -Destination $target -Force
    $copied++
}
Write-Host "  $copied file(s) staged from the recipe."
if ($missing.Count -gt 0) {
    Write-Warning "$($missing.Count) file(s) listed in the recipe were missing and were skipped:"
    $missing | Select-Object -First 10 | ForEach-Object { Write-Warning "    $_" }
}

Copy-Item -LiteralPath $sourceManifest -Destination (Join-Path $Destination 'AppxManifest.xml') -Force

# Dev-branded tiles/icons, same as the other register scripts.
$devImagesRoot = Join-Path $repoRoot 'res\terminal\images-Dev'
if (Test-Path $devImagesRoot) {
    $imagesDir = Join-Path $Destination 'Images'
    New-Item -ItemType Directory -Path $imagesDir -Force | Out-Null
    Copy-Item -Path (Join-Path $devImagesRoot '*') -Destination $imagesDir -Recurse -Force
}

$manifestPath = Join-Path $Destination 'AppxManifest.xml'
$xml = [xml](Get-Content $manifestPath -Raw)
$mns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$mns.AddNamespace('m', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
$mns.AddNamespace('uap3', 'http://schemas.microsoft.com/appx/manifest/uap/windows10/3')
$mns.AddNamespace('desktop', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10')
$mns.AddNamespace('com', 'http://schemas.microsoft.com/appx/manifest/com/windows10')
$mns.AddNamespace('desktop4', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/4')

# A unique version every time: re-registering the same version can fail when
# Windows cannot delete the previous registration's AppRepository metadata.
$now = Get-Date
$stampedVersion = '0.{0}.{1}.{2}' -f (($now.Year - 2020) * 12 + $now.Month), ($now.Day * 100 + $now.Hour), ($now.Minute * 100 + $now.Second)
$identity = $xml.SelectSingleNode('/m:Package/m:Identity', $mns)
$identity.SetAttribute('Name', $identityName)
$identity.SetAttribute('Version', $stampedVersion)

# Give the slot its own command alias so `wtd<slot>` reaches it while `wtd`
# keeps reaching the everyday package.
foreach ($aliasExtension in $xml.SelectNodes('//uap3:Extension[@Category="windows.appExecutionAlias"]', $mns)) {
    foreach ($alias in $aliasExtension.SelectNodes('.//desktop:ExecutionAlias', $mns)) {
        $alias.SetAttribute('Alias', $aliasName)
    }
}

# Drop the system-integration registrations the everyday package already owns:
# COM handoff servers/interfaces (same CLSIDs), the console/terminal host app
# extensions, and the Explorer context menu. A slot is for trying the app, not
# for taking over default-terminal duties.
foreach ($xpath in '//com:Extension', '//uap3:Extension[@Category="windows.appExtension"]', '//desktop4:Extension[@Category="windows.fileExplorerContextMenus"]') {
    foreach ($node in @($xml.SelectNodes($xpath, $mns))) {
        $node.ParentNode.RemoveChild($node) | Out-Null
    }
}
$xml.Save($manifestPath)

Write-Host "Registering $identityName $stampedVersion..."
Add-AppxPackage -Register $manifestPath -ForceUpdateFromAnyVersion

# First registration: start from the everyday package's settings so the slot
# looks and behaves the same (state.json carries persisted window layouts, so
# session restore can be exercised too).
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
Write-Host "Registered $($registered.PackageFullName)"
Write-Host "  from $($registered.InstallLocation)"

if (-not $NoLaunch) {
    # The execution alias inherits this environment, which is how the data root
    # reaches the packaged app; the AppsFolder fallback cannot carry it.
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
