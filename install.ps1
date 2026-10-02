param([string]$DshDirectory = 'E:\dsh')
$ErrorActionPreference = 'Stop'
$DshCli = Join-Path $DshDirectory 'resources\runtime\cli\bin\dsh.cmd'
$InstallRoot = Join-Path $DshDirectory 'plugins\zotero-pdf2zh-archive'
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
    throw 'Please fully quit DeepSeek Harness, including the tray, before installing.'
}
if (-not (Test-Path -LiteralPath $DshCli)) { throw "DSH CLI was not found under $DshDirectory." }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package.json'))) { throw 'Download the complete repository before running this installer.' }
$ResolvedSource = [IO.Path]::GetFullPath($PSScriptRoot)
$ResolvedInstall = [IO.Path]::GetFullPath($InstallRoot)
if ($ResolvedSource.TrimEnd('\') -ne $ResolvedInstall.TrimEnd('\')) {
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    foreach ($TaskFile in @('package.json','index.js','archive.js','cordis.patch.yml','config.json','README.md')) {
        $TaskDestination = Join-Path $InstallRoot $TaskFile
        if ($TaskFile -eq 'config.json' -and (Test-Path -LiteralPath $TaskDestination)) { continue }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $TaskFile) -Destination $TaskDestination -Force
    }
    foreach ($TaskDirectory in @('locale','test')) {
        New-Item -ItemType Directory -Path (Join-Path $InstallRoot $TaskDirectory) -Force | Out-Null
        Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot $TaskDirectory) -File | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $InstallRoot $TaskDirectory) -Force
        }
    }
}
& $DshCli plugin --profile desktop add $InstallRoot --offline --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "DSH plugin installation failed with exit code $LASTEXITCODE." }
Write-Host 'Installed Zotero Translation Archive. Start DSH and PDF2zh, then translate normally in Zotero.'
