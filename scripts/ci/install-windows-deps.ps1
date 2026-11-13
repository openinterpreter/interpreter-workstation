$ErrorActionPreference = 'Stop'

# Native node-gyp builds exceed CL.exe's path limit under pnpm's nested virtual
# store on hosted Windows. Use pnpm's standard hoisted linker for this one job:
# native modules build at root/node_modules/NAME, and Playwright resolves the
# normal project-local Electron executable without an external virtual store.
if (-not $env:GITHUB_WORKSPACE -or -not (Test-Path -LiteralPath $env:GITHUB_WORKSPACE -PathType Container)) {
  throw 'A verified runner workspace is required'
}
pnpm install --frozen-lockfile --config.node-linker=hoisted
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($name in @('electron', 'interpreter-window-pin')) {
  if (-not (Test-Path -LiteralPath (Join-Path $env:GITHUB_WORKSPACE "node_modules\$name\package.json") -PathType Leaf)) {
    throw "Required hoisted Windows package missing: $name"
  }
}
