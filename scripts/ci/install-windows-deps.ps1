$ErrorActionPreference = 'Stop'

# Native node-gyp builds exceed CL.exe's path limit under the hosted runner's
# nested checkout. Keep a job-local virtual store on the workspace drive root.
# Package extensions declare dependencies imported by third-party packages so
# module resolution does not depend on hoisting from the project node_modules.
if (-not $env:GITHUB_WORKSPACE -or -not (Test-Path -LiteralPath $env:GITHUB_WORKSPACE -PathType Container)) {
  throw 'A verified runner workspace is required'
}
$driveRoot = [System.IO.Path]::GetPathRoot($env:GITHUB_WORKSPACE)
if (-not $driveRoot -or -not (Test-Path -LiteralPath $driveRoot)) {
  throw 'A verified runner workspace drive is required'
}
$virtualStore = Join-Path $driveRoot 'workstation-pnpm-ci'
pnpm install --frozen-lockfile --virtual-store-dir $virtualStore
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
