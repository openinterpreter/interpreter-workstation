@echo off
setlocal EnableExtensions

set "SOURCE=%~1"
set "BUNDLE=%~2"
set "BRANCH=%~3"
set "COMMIT=%~4"
set "DIRTY=%~5"
set "SOURCE_PATH=%~6"
set "SYNCED_AT=%~7"

if "%INTERPRETER_WINDOWS_WORKSPACE%"=="" (
  set "DEST=%USERPROFILE%\workstation-app-win"
) else (
  set "DEST=%INTERPRETER_WINDOWS_WORKSPACE%"
)

set "STATE_FILE=.interpreter-windows-mirror-state.txt"

if not exist "%DEST%" mkdir "%DEST%"
pushd "%DEST%" || exit /b 1

if not exist ".git" git init || exit /b 1
git config core.autocrlf false || exit /b 1
git config core.filemode false || exit /b 1
git config submodule.recurse false || exit /b 1
if not exist ".git\info\exclude" (
  type nul > ".git\info\exclude"
)
findstr /x /c:"/.interpreter-windows-mirror-state.txt" ".git\info\exclude" >nul || echo /.interpreter-windows-mirror-state.txt>>".git\info\exclude"

git fetch "%BUNDLE%" HEAD:refs/remotes/source-bundle/HEAD || exit /b 1
git submodule deinit -f --all >nul 2>nul
git -c submodule.recurse=false -c submodule.active= checkout -f -B "%BRANCH%" source-bundle/HEAD || exit /b 1

robocopy "%SOURCE%" "%DEST%" /MIR /FFT /R:2 /W:1 ^
  /XD ".git" "node_modules" "dist" "dist-electron" ".cache" ".build" ".platform-workspace" "scenario-runs" "test-runs" "browser-form-tests\\test-output" "website" ".turbo" "coverage" "monocart-report" ".pytest_cache" "__pycache__" "target" ".venv" ^
      "%SOURCE%\\scenario-runs" "%DEST%\\scenario-runs" "%SOURCE%\\website" "%DEST%\\website" "%SOURCE%\\codex\\codex-rs\\target" "%DEST%\\codex\\codex-rs\\target" "%SOURCE%\\apps\\interpreter-cua\\target" "%DEST%\\apps\\interpreter-cua\\target" ^
  /XF ".DS_Store" ".git" "CLAUDE.md" ^
  /NFL /NDL /NP
if errorlevel 8 exit /b %ERRORLEVEL%
if exist "CLAUDE.md.lnk" del /f /q "CLAUDE.md.lnk"

(
  echo source_windows_path=%SOURCE%
  echo source_bundle_path=%BUNDLE%
  echo source_path=%SOURCE_PATH%
  echo branch=%BRANCH%
  echo commit=%COMMIT%
  echo dirty=%DIRTY%
  echo synced_at=%SYNCED_AT%
) > "%STATE_FILE%"

echo synced source=%SOURCE% dest=%DEST% branch=%BRANCH% commit=%COMMIT% dirty=%DIRTY%
