$ErrorActionPreference = 'Stop'

# Native node-gyp builds exceed CL.exe's path limit under the hosted runner's
# nested checkout. Keep pnpm's default virtual store INSIDE node_modules so
# peer resolution is unchanged; access the same checkout through a short
# runner-local drive spelling while native install scripts compile.
if (-not $env:GITHUB_WORKSPACE -or -not (Test-Path -LiteralPath $env:GITHUB_WORKSPACE -PathType Container)) {
  throw 'A verified runner workspace is required'
}
if (Test-Path -LiteralPath 'W:\') { throw 'Short CI drive W: is already in use' }
& subst W: $env:GITHUB_WORKSPACE
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Push-Location 'W:\'
try {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
