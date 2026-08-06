# nexus - PowerShell wrapper.
#
#   .\nexus.ps1 help
#
# WHY THIS FILE EXISTS
#
# The project's commands live in nexus.sh, a bash script. PowerShell cannot run
# .sh files - typing `./nexus.sh dev` in PowerShell makes Windows try to *open*
# the file, which launches your editor and runs nothing. That is confusing
# precisely because it looks like nothing happened at all.
#
# This wrapper finds the bash that ships with Git for Windows and hands the
# command over, so the same commands work from PowerShell, cmd, or Git Bash.
#
#   .\nexus.ps1 dev
#   .\nexus.ps1 playtest
#   .\nexus.ps1 test
#
# NOTE: this file is deliberately plain ASCII. Windows PowerShell 5.1 reads .ps1
# files as ANSI unless they carry a byte-order mark, so a stray accented
# character or dash breaks parsing in a way that is very hard to diagnose.

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Find-Bash {
    # Prefer a bash already on PATH...
    $onPath = Get-Command bash.exe -ErrorAction SilentlyContinue
    if ($onPath) {
        # ...but skip the WSL stub in System32, which behaves differently and
        # fails in confusing ways with Docker Desktop.
        if ($onPath.Source -notlike '*System32*') { return $onPath.Source }
    }

    # ...otherwise look where Git for Windows installs it.
    $candidates = @(
        "$env:ProgramFiles\Git\bin\bash.exe",
        "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
        "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe",
        "$env:USERPROFILE\AppData\Local\Programs\Git\bin\bash.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

$bash = Find-Bash

if (-not $bash) {
    Write-Host ""
    Write-Host "  Could not find Git Bash." -ForegroundColor Red
    Write-Host ""
    Write-Host "  These commands are bash scripts, and Windows needs Git Bash to run them."
    Write-Host "  Install Git for Windows (it includes bash):"
    Write-Host "    https://git-scm.com/download/win"
    Write-Host ""
    Write-Host "  Nothing else is needed. Node is NOT required - everything runs in Docker."
    Write-Host ""
    exit 1
}

# Tell nexus.sh how this user actually invokes it, so its help text shows
# commands that work in PowerShell rather than bash syntax.
$env:NEXUS_CMD = '.\nexus.ps1'

# Pass every argument straight through to nexus.sh.
& $bash './nexus.sh' @args
exit $LASTEXITCODE
