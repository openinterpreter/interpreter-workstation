$ErrorActionPreference = 'Stop'

# Native node-gyp builds exceed CL.exe's path limit under the hosted runner's
# nested checkout. Alias this exact job-local checkout at a short drive root,
# retaining pnpm's normal project-local virtual store and module resolution.
if (-not $env:GITHUB_WORKSPACE -or -not (Test-Path -LiteralPath $env:GITHUB_WORKSPACE -PathType Container)) {
  throw 'A verified runner workspace is required'
}
$shortDrive = 'W:'
$shortWorkspace = 'W:\'
if (Test-Path -LiteralPath $shortWorkspace) {
  throw 'Short Windows workspace drive is already assigned'
}
& subst $shortDrive $env:GITHUB_WORKSPACE
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $shortWorkspace 'pnpm-lock.yaml'))) {
  throw 'Verified short Windows workspace alias could not be established'
}
Push-Location $shortWorkspace
$installExit = 1
try {
  pnpm install --frozen-lockfile
  $installExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($installExit -ne 0) { exit $installExit }
if (-not (Test-Path -LiteralPath (Join-Path $shortWorkspace 'node_modules\.pnpm') -PathType Container)) {
  throw 'Project-local pnpm virtual store is absent from the verified workspace'
}
