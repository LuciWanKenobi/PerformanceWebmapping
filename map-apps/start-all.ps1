$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'start-all.mjs') @args
exit $LASTEXITCODE
