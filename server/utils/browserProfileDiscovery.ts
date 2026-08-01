import { createHash } from 'node:crypto';
import { existsSync, type Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  BrowserControlConnection,
  BrowserControlProfile,
} from '../../shared/types/browserControl';

interface BrowserProfileRoot {
  browserName: string;
  browserChannel: string | null;
  userDataDir: string;
}

interface BrowserProfileDiscoveryOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

interface LocalStateProfileInfo {
  name?: unknown;
  gaia_name?: unknown;
}

const EXTENSION_INSTALL_STABLE_KEY_PREFIX = 'install:';

function stableLocalProfileId(browserName: string, userDataDir: string, profileDir: string): string {
  const hash = createHash('sha256')
    .update(browserName)
    .update('\0')
    .update(path.resolve(userDataDir))
    .update('\0')
    .update(profileDir)
    .digest('hex')
    .slice(0, 24);
  return `local:${hash}`;
}

function profileNameFromInfo(profileDir: string, info: LocalStateProfileInfo): string {
  if (typeof info.name === 'string' && info.name.trim().length > 0) {
    return info.name.trim();
  }
  if (typeof info.gaia_name === 'string' && info.gaia_name.trim().length > 0) {
    return info.gaia_name.trim();
  }
  return profileDir;
}

function browserProfileRoots(options: BrowserProfileDiscoveryOptions = {}): BrowserProfileRoot[] {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;

  if (platform === 'darwin') {
    const applicationSupport = path.join(home, 'Library', 'Application Support');
    return [
      { browserName: 'Chrome', browserChannel: 'stable', userDataDir: path.join(applicationSupport, 'Google', 'Chrome') },
      { browserName: 'Chrome', browserChannel: 'beta', userDataDir: path.join(applicationSupport, 'Google', 'Chrome Beta') },
      { browserName: 'Chromium', browserChannel: null, userDataDir: path.join(applicationSupport, 'Chromium') },
      { browserName: 'Brave', browserChannel: null, userDataDir: path.join(applicationSupport, 'BraveSoftware', 'Brave-Browser') },
      { browserName: 'Edge', browserChannel: null, userDataDir: path.join(applicationSupport, 'Microsoft Edge') },
    ];
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      { browserName: 'Chrome', browserChannel: 'stable', userDataDir: path.join(localAppData, 'Google', 'Chrome', 'User Data') },
      { browserName: 'Chrome', browserChannel: 'beta', userDataDir: path.join(localAppData, 'Google', 'Chrome Beta', 'User Data') },
      { browserName: 'Chromium', browserChannel: null, userDataDir: path.join(localAppData, 'Chromium', 'User Data') },
      { browserName: 'Brave', browserChannel: null, userDataDir: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { browserName: 'Edge', browserChannel: null, userDataDir: path.join(localAppData, 'Microsoft', 'Edge', 'User Data') },
    ];
  }

  const configHome = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return [
    { browserName: 'Chrome', browserChannel: 'stable', userDataDir: path.join(configHome, 'google-chrome') },
    { browserName: 'Chrome', browserChannel: 'beta', userDataDir: path.join(configHome, 'google-chrome-beta') },
    { browserName: 'Chromium', browserChannel: null, userDataDir: path.join(configHome, 'chromium') },
    { browserName: 'Brave', browserChannel: null, userDataDir: path.join(configHome, 'BraveSoftware', 'Brave-Browser') },
    { browserName: 'Edge', browserChannel: null, userDataDir: path.join(configHome, 'microsoft-edge') },
  ];
}

async function pathIsDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

function installIdFromStableKey(stableKey: string | null): string | null {
  if (!stableKey?.startsWith(EXTENSION_INSTALL_STABLE_KEY_PREFIX)) {
    return null;
  }

  const installId = stableKey.slice(EXTENSION_INSTALL_STABLE_KEY_PREFIX.length).trim();
  return installId.length > 0 ? installId : null;
}

function isExtensionIndexedDbDirectory(name: string): boolean {
  return name.startsWith('chrome-extension_') && name.endsWith('_0.indexeddb.leveldb');
}

async function fileContainsInstallId(filePath: string, installId: string): Promise<boolean> {
  let contents: Buffer;
  try {
    contents = await readFile(filePath);
  } catch {
    return false;
  }

  return contents.includes(Buffer.from(installId, 'utf8'))
    || contents.includes(Buffer.from(installId, 'utf16le'));
}

async function directoryContainsInstallId(directoryPath: string, installId: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (await directoryContainsInstallId(entryPath, installId)) {
        return true;
      }
      continue;
    }

    if (entry.isFile() && await fileContainsInstallId(entryPath, installId)) {
      return true;
    }
  }

  return false;
}

async function localProfileContainsExtensionInstallId(
  profile: BrowserControlProfile,
  installId: string,
): Promise<boolean> {
  if (!profile.profilePath) {
    return false;
  }

  const indexedDbPath = path.join(profile.profilePath, 'IndexedDB');
  let entries: Dirent[];
  try {
    entries = await readdir(indexedDbPath, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isExtensionIndexedDbDirectory(entry.name)) {
      continue;
    }

    if (await directoryContainsInstallId(path.join(indexedDbPath, entry.name), installId)) {
      return true;
    }
  }

  return false;
}

async function matchConnectionsToLocalProfiles(
  connections: BrowserControlConnection[],
  localProfiles: BrowserControlProfile[],
): Promise<Map<string, BrowserControlProfile>> {
  const matches = new Map<string, BrowserControlProfile>();

  for (const connection of connections) {
    const connectionProfileId = connection.stableKey ?? connection.extensionId;
    const installId = installIdFromStableKey(connection.stableKey);
    if (!installId) {
      continue;
    }

    for (const localProfile of localProfiles) {
      if (matches.has(connectionProfileId)) {
        break;
      }

      if (await localProfileContainsExtensionInstallId(localProfile, installId)) {
        matches.set(connectionProfileId, localProfile);
      }
    }
  }

  return matches;
}

async function discoverProfilesForRoot(root: BrowserProfileRoot): Promise<BrowserControlProfile[]> {
  const localStatePath = path.join(root.userDataDir, 'Local State');
  if (!existsSync(localStatePath)) {
    return [];
  }

  const parsed = JSON.parse(await readFile(localStatePath, 'utf8')) as {
    profile?: {
      info_cache?: Record<string, LocalStateProfileInfo>;
    };
  };
  const infoCache = parsed.profile?.info_cache;
  if (!infoCache || typeof infoCache !== 'object') {
    return [];
  }

  const profiles: BrowserControlProfile[] = [];
  for (const [profileDir, profileInfo] of Object.entries(infoCache)) {
    if (!profileDir || profileDir === 'System Profile') {
      continue;
    }

    const profilePath = path.join(root.userDataDir, profileDir);
    if (!(await pathIsDirectory(profilePath))) {
      continue;
    }

    profiles.push({
      profileId: stableLocalProfileId(root.browserName, root.userDataDir, profileDir),
      policyProfileId: null,
      browserName: root.browserName,
      browserChannel: root.browserChannel,
      profileName: profileNameFromInfo(profileDir, profileInfo),
      profilePath,
      userDataDir: root.userDataDir,
      extensionId: null,
      stableKey: null,
      connectionState: 'detected',
      activeSessions: 0,
      windowCount: 0,
      tabCount: 0,
    });
  }

  return profiles;
}

export async function discoverLocalBrowserProfiles(
  options: BrowserProfileDiscoveryOptions = {},
): Promise<BrowserControlProfile[]> {
  const nestedProfiles = await Promise.all(
    browserProfileRoots(options).map(discoverProfilesForRoot),
  );

  return nestedProfiles
    .flat()
    .sort((left, right) => {
      const byBrowser = (left.browserName ?? '').localeCompare(right.browserName ?? '');
      if (byBrowser !== 0) {
        return byBrowser;
      }
      const byName = left.profileName.localeCompare(right.profileName);
      return byName !== 0 ? byName : left.profilePath.localeCompare(right.profilePath);
    });
}

export function buildBrowserControlProfiles(
  connections: BrowserControlConnection[],
  localProfiles: BrowserControlProfile[],
  matchedLocalProfiles: Map<string, BrowserControlProfile> = new Map(),
): BrowserControlProfile[] {
  const connectedProfiles = connections.map((connection): BrowserControlProfile => {
    const windowCount = connection.browserWindows.length;
    const tabCount = connection.browserWindows.reduce((count, window) => count + window.tabs.length, 0);
    const connectionProfileId = connection.stableKey ?? connection.extensionId;
    const localProfile = matchedLocalProfiles.get(connectionProfileId);

    return {
      profileId: localProfile?.profileId ?? connectionProfileId,
      policyProfileId: connectionProfileId,
      browserName: localProfile?.browserName ?? connection.browserName,
      browserChannel: localProfile?.browserChannel ?? null,
      profileName: localProfile?.profileName ?? connectionProfileId,
      profilePath: localProfile?.profilePath ?? '',
      userDataDir: localProfile?.userDataDir ?? '',
      extensionId: connection.extensionId,
      stableKey: connection.stableKey,
      connectionState: 'connected',
      activeSessions: connection.activeSessions,
      windowCount,
      tabCount,
    };
  });

  const seenProfileIds = new Set(connectedProfiles.map((profile) => profile.profileId));
  const disconnectedLocalProfiles = localProfiles.filter((profile) => !seenProfileIds.has(profile.profileId));

  return [...connectedProfiles, ...disconnectedLocalProfiles];
}

export async function buildBrowserControlProfilesWithLocalMatches(
  connections: BrowserControlConnection[],
  localProfiles: BrowserControlProfile[],
): Promise<BrowserControlProfile[]> {
  return buildBrowserControlProfiles(
    connections,
    localProfiles,
    await matchConnectionsToLocalProfiles(connections, localProfiles),
  );
}
