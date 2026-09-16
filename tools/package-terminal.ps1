[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64', 'x86')]
    [string[]]$Platform = @('x64'),
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$')]
    [string]$Version,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Version) { $Version = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version }
$outputRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'artifacts\releases'))
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

function Assert-ChildPath([string]$Path, [string]$Parent) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Generated path leaves its expected directory: $resolved"
    }
}

Push-Location $repoRoot
try {
    Import-Module (Join-Path $PSScriptRoot 'OpenConsole.psm1') -Force
    Set-MsBuildDevEnvironment
    $sdkBin = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory |
        Where-Object Name -Match '^\d+\.\d+\.\d+\.\d+$' |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64' } |
        Where-Object { (Test-Path (Join-Path $_ 'makeappx.exe')) -and (Test-Path (Join-Path $_ 'makepri.exe')) } |
        Select-Object -First 1
    if (-not $sdkBin) { throw 'Install a Windows SDK containing MakeAppx and MakePri.' }

    if (-not $SkipBuild) {
        & bun install --frozen-lockfile --cwd (Join-Path $repoRoot 'tools\terminal-web')
        & bun run --cwd (Join-Path $repoRoot 'tools\terminal-web') build:client
        & (Join-Path $repoRoot 'dep\nuget\nuget.exe') restore (Join-Path $repoRoot 'dep\nuget\packages.config') -PackagesDirectory (Join-Path $repoRoot 'packages')
    }

    $checksums = @()
    foreach ($arch in ($Platform | Select-Object -Unique)) {
        if (-not $SkipBuild) {
            Write-Host "Building Release|$arch with the embedded web client..."
            & msbuild (Join-Path $repoRoot 'OpenConsole.slnx') '/t:Terminal\CascadiaPackage' `
                /p:Configuration=Release /p:Platform=$arch /p:WholeProgramOptimization=false `
                /p:GenerateAppxPackageOnBuild=false /p:AppxSymbolPackageEnabled=false /m /v:minimal /nologo
        }
        $layout = Join-Path $repoRoot "src\cascadia\CascadiaPackage\bin\$arch\Release"
        if (-not (Test-Path (Join-Path $layout 'WindowsTerminal.exe'))) { throw "Build output is missing: $layout" }
        $xaml = Get-ChildItem (Join-Path $repoRoot 'packages') -Directory -Filter 'Microsoft.UI.Xaml.*' |
            Where-Object Name -Match '^Microsoft\.UI\.Xaml\.\d+\.\d+\.\d+(?:\.\d+)?$' |
            Sort-Object { [version]($_.Name -replace '^Microsoft.UI.Xaml\.', '') } -Descending |
            ForEach-Object { Join-Path $_.FullName "tools\AppX\$arch\Release\Microsoft.UI.Xaml.2.8.appx" } |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $xaml) { throw "Microsoft.UI.Xaml runtime package for $arch is missing. Restore NuGet packages first." }

        $name = "JustTerminal-$Version-windows-$arch"
        $stage = Join-Path $outputRoot $name
        $zipPath = Join-Path $outputRoot "$name.zip"
        Assert-ChildPath $stage $outputRoot
        Assert-ChildPath $zipPath $outputRoot
        if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

        # Upstream's portable conversion merges WinUI resources and includes
        # the app-local XAML runtime, so no package registration is needed.
        $portable = & (Join-Path $repoRoot 'build\scripts\New-UnpackagedTerminalDistribution.ps1') `
            -TerminalLayout $layout -XamlAppX $xaml -MakeAppxPath (Join-Path $sdkBin 'makeappx.exe') -PortableMode |
            Where-Object { $_ -is [IO.DirectoryInfo] } | Select-Object -Last 1
        if (-not $portable) { throw 'Portable layout conversion did not return a directory.' }
        Assert-ChildPath $portable.FullName ([IO.Path]::GetTempPath())
        Copy-Item -LiteralPath $portable.FullName -Destination $stage -Recurse
        Assert-ChildPath $stage $outputRoot
        Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object { $_.Extension -in @('.pdb', '.appxrecipe') } | Remove-Item -Force

        # Ship the redistributable CRT beside the executable when the toolchain
        # supplies it. This is the app-local runtime, never a developer SDK.
        if ($env:VCToolsRedistDir) {
            $crt = Get-ChildItem (Join-Path $env:VCToolsRedistDir $arch) -Directory -Filter 'Microsoft.VC*.CRT' | Select-Object -First 1
            if ($crt) { Copy-Item -Path (Join-Path $crt.FullName '*.dll') -Destination $stage -Force }
        }
        Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $stage
        Copy-Item -LiteralPath (Join-Path $repoRoot 'NOTICE.md') -Destination $stage
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable-README.txt') -Destination (Join-Path $stage 'README.txt')
        $sourceCommit = (& git rev-parse HEAD).Trim()
        @{ version = $Version; platform = $arch; configuration = 'Release'; sourceCommit = $sourceCommit; builtAt = [DateTime]::UtcNow.ToString('o') } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'build-info.json') -Encoding utf8

        foreach ($required in @('WindowsTerminal.exe', 'wtd.exe', 'TerminalConnection.dll', 'Microsoft.UI.Xaml.dll', 'resources.pri', '.portable', 'README.txt', 'LICENSE')) {
            if (-not (Test-Path (Join-Path $stage $required))) { throw "Portable package is missing $required" }
        }
        $bridge = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes((Join-Path $stage 'TerminalConnection.dll')))
        if (-not $bridge.Contains('<title>Terminal Web Host</title>')) { throw 'The built bridge does not contain the web client.' }
        $unsafe = @(Get-ChildItem -LiteralPath $stage -Recurse -Force -File | Where-Object {
            $_.Name -match '^\.env($|\.)|^\.terminal-web-|\.(pfx|key)$' -or $_.Name -eq 'settings.json'
        })
        if ($unsafe.Count) { throw 'The staging directory contains local configuration or credential files.' }

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $true)
        $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            foreach ($required in @('WindowsTerminal.exe', 'TerminalConnection.dll', '.portable', 'README.txt', 'build-info.json')) {
                if ("$name/$required" -notin @($zip.Entries.FullName)) { throw "ZIP is missing $required" }
            }
        } finally { $zip.Dispose() }
        $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $checksums += "$hash  $name.zip"
        Write-Host "Created $zipPath ($([Math]::Round((Get-Item $zipPath).Length / 1MB, 1)) MB)"
    }
    $checksums | Set-Content -LiteralPath (Join-Path $outputRoot 'SHA256SUMS.txt') -Encoding ascii
    Write-Host "Packages and checksums: $outputRoot"
} finally { Pop-Location }
