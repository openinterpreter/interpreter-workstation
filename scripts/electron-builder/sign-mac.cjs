const fs = require('node:fs');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const { signAsync } = require('@electron/osx-sign');

const FINDER_SYNC_EXTENSION_NAME = 'InterpreterFinderSync.appex';
const FINDER_SYNC_ENTITLEMENTS = path.join(
  process.cwd(),
  'build',
  'azure-pipelines',
  'darwin',
  'finder-sync-entitlements.plist',
);
const execFileAsync = promisify(execFile);

function isInsidePath(candidatePath, parentPath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = async function signMacApplication(options) {
  if (!options.identity && process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.warn('[sign-mac] Skipping macOS signing because no signing identity was provided and CSC_IDENTITY_AUTO_DISCOVERY=false.');
    return;
  }

  const appPath = options.app;
  const finderSyncExtensionPath = path.join(
    appPath,
    'Contents',
    'PlugIns',
    FINDER_SYNC_EXTENSION_NAME,
  );

  if (!fs.existsSync(finderSyncExtensionPath)) {
    await signAsync(options);
    return;
  }

  if (!fs.existsSync(FINDER_SYNC_ENTITLEMENTS)) {
    throw new Error(`[sign-mac] Missing Finder Sync entitlements: ${FINDER_SYNC_ENTITLEMENTS}`);
  }

  const originalIgnore = options.ignore;
  const originalOptionsForFile = options.optionsForFile;
  const finderSyncExecutablePath = path.join(
    finderSyncExtensionPath,
    'Contents',
    'MacOS',
    'InterpreterFinderSync',
  );

  await signAsync({
    ...options,
    binaries: [
      ...(options.binaries ?? []),
      finderSyncExecutablePath,
      finderSyncExtensionPath,
    ],
    ignore: (filePath) => {
      if (isInsidePath(filePath, finderSyncExtensionPath)) {
        return false;
      }
      return typeof originalIgnore === 'function' ? originalIgnore(filePath) : false;
    },
    optionsForFile: (filePath) => {
      const baseOptions = originalOptionsForFile ? originalOptionsForFile(filePath) : {};
      if (isInsidePath(filePath, finderSyncExtensionPath)) {
        return {
          ...baseOptions,
          entitlements: FINDER_SYNC_ENTITLEMENTS,
          hardenedRuntime: true,
        };
      }
      return baseOptions;
    },
  });

  await codesignPath({
    filePath: finderSyncExtensionPath,
    identity: options.identity,
    keychain: options.keychain,
    entitlements: FINDER_SYNC_ENTITLEMENTS,
    hardenedRuntime: true,
    timestamp: options.timestamp,
  });

  const appSignOptions = options.optionsForFile ? await options.optionsForFile(appPath) : {};
  await codesignPath({
    filePath: appPath,
    identity: options.identity,
    keychain: options.keychain,
    entitlements: appSignOptions.entitlements,
    hardenedRuntime: appSignOptions.hardenedRuntime,
    requirements: appSignOptions.requirements,
    timestamp: appSignOptions.timestamp,
    additionalArguments: appSignOptions.additionalArguments,
  });
};

async function codesignPath({
  filePath,
  identity,
  keychain,
  entitlements,
  hardenedRuntime,
  requirements,
  timestamp,
  additionalArguments,
}) {
  if (!identity) {
    throw new Error(`[sign-mac] Cannot sign ${filePath} without a signing identity.`);
  }
  if (!entitlements) {
    throw new Error(`[sign-mac] Cannot sign ${filePath} without entitlements.`);
  }

  const args = ['--sign', identity, '--force'];
  if (keychain) {
    args.push('--keychain', keychain);
  }
  if (requirements) {
    if (requirements.startsWith('=')) {
      args.push(`-r${requirements}`);
    } else {
      args.push('--requirements', requirements);
    }
  }
  if (timestamp === false) {
    args.push('--timestamp=none');
  } else if (typeof timestamp === 'string') {
    args.push(`--timestamp=${timestamp}`);
  } else {
    args.push('--timestamp');
  }
  if (hardenedRuntime) {
    args.push('--options', 'runtime');
  }
  if (additionalArguments) {
    args.push(...additionalArguments);
  }
  args.push('--entitlements', entitlements, filePath);

  await execFileAsync('codesign', args);
}
