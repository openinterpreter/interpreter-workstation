import path from 'node:path';

export interface MacUpdateInstallScriptOptions {
  appName: string;
  currentPid: number;
  updaterPendingDir: string;
  applicationsDir?: string;
  tempDirRoot?: string;
  relaunchApp?: boolean;
  verifyCodeSignature?: boolean;
}

function quoteShell(value: string): string {
  return JSON.stringify(value);
}

export function buildMacUpdateInstallScript(options: MacUpdateInstallScriptOptions): string {
  const applicationsDir = options.applicationsDir ?? '/Applications';
  const tempDirRoot = options.tempDirRoot ?? '/tmp';
  const relaunchApp = options.relaunchApp ?? true;
  const verifyCodeSignature = options.verifyCodeSignature ?? true;
  const appBundleName = `${options.appName}.app`;
  const appPath = path.join(applicationsDir, appBundleName);

  return `
set -euo pipefail
PENDING_DIR=${quoteShell(options.updaterPendingDir)}
APP_PATH=${quoteShell(appPath)}
APP_BUNDLE_NAME=${quoteShell(appBundleName)}
TEMP_DIR_ROOT=${quoteShell(tempDirRoot)}
VERIFY_CODESIGN=${verifyCodeSignature ? '1' : '0'}
BACKUP_PATH=""
INSTALL_COMPLETE=0
STAGING_DIR=$(mktemp -d "$TEMP_DIR_ROOT/interpreter-update.XXXXXX")

restore_previous_app() {
  if [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ]; then
    rm -rf "$APP_PATH"
    mv "$BACKUP_PATH" "$APP_PATH"
  fi
}

cleanup() {
  if [ "$INSTALL_COMPLETE" -ne 1 ]; then
    restore_previous_app || true
  fi
  rm -rf "$STAGING_DIR"
}

trap cleanup EXIT

ZIP=$(ls -t "$PENDING_DIR"/Interpreter*.zip 2>/dev/null | head -n1) || exit 1
while kill -0 ${options.currentPid} 2>/dev/null; do sleep 0.1; done
/usr/bin/ditto -xk "$ZIP" "$STAGING_DIR"
STAGED_APP="$STAGING_DIR/$APP_BUNDLE_NAME"

if [ ! -d "$STAGED_APP" ]; then
  echo "Extracted update missing app bundle: $STAGED_APP" >&2
  exit 1
fi

if [ "$VERIFY_CODESIGN" = "1" ]; then
  /usr/bin/codesign --verify --strict --deep "$STAGED_APP"
fi

if [ -e "$APP_PATH" ]; then
  BACKUP_PATH="$APP_PATH.preupdate.$$"
  mv "$APP_PATH" "$BACKUP_PATH"
fi

/usr/bin/ditto "$STAGED_APP" "$APP_PATH"

if [ "$VERIFY_CODESIGN" = "1" ]; then
  /usr/bin/codesign --verify --strict --deep "$APP_PATH"
fi

if [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ]; then
  rm -rf "$BACKUP_PATH"
  BACKUP_PATH=""
fi

INSTALL_COMPLETE=1
${relaunchApp ? 'open -n "$APP_PATH"' : 'true'}
`;
}
