$ErrorActionPreference = 'Stop'

# The hosted runner checks out under a long nested path. Native node-gyp builds
# can exceed CL.exe's legacy path limit inside node_modules/.pnpm there.
$driveRoot = [System.IO.Path]::GetPathRoot($env:GITHUB_WORKSPACE)
if (-not $driveRoot -or -not (Test-Path -LiteralPath $driveRoot)) {
  throw 'A verified runner workspace drive is required'
}
$virtualStore = Join-Path $driveRoot 'workstation-pnpm-ci'
pnpm install --frozen-lockfile --virtual-store-dir $virtualStore
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
