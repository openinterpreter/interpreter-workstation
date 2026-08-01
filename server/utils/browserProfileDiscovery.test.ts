import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildBrowserControlProfiles,
  buildBrowserControlProfilesWithLocalMatches,
  discoverLocalBrowserProfiles,
} from './browserProfileDiscovery';
import type { BrowserControlConnection } from '../../shared/types/browserControl';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'browser-profile-discovery-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('discoverLocalBrowserProfiles', () => {
  test('lists local Chrome profiles from Local State without launching Chrome', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    mkdirSync(path.join(userDataDir, 'Profile 1'), { recursive: true });
    writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: 'Personal' },
          'Profile 1': { name: 'Work' },
          'System Profile': { name: 'System' },
          'Profile Missing': { name: 'Missing' },
        },
      },
    }));

    const profiles = await discoverLocalBrowserProfiles({
      platform: 'darwin',
      homeDir: home,
      env: {},
    });

    expect(profiles.map((profile) => ({
        browserName: profile.browserName,
        browserChannel: profile.browserChannel,
        policyProfileId: profile.policyProfileId,
        profileName: profile.profileName,
      profilePath: profile.profilePath,
      connectionState: profile.connectionState,
    }))).toEqual([
      {
        browserName: 'Chrome',
        browserChannel: 'stable',
        policyProfileId: null,
        profileName: 'Personal',
        profilePath: path.join(userDataDir, 'Default'),
        connectionState: 'detected',
      },
      {
        browserName: 'Chrome',
        browserChannel: 'stable',
        policyProfileId: null,
        profileName: 'Work',
        profilePath: path.join(userDataDir, 'Profile 1'),
        connectionState: 'detected',
      },
    ]);
    expect(profiles[0]!.profileId.startsWith('local:')).toBe(true);
    expect(profiles[0]!.profileId).not.toBe(profiles[1]!.profileId);
  });
});

describe('buildBrowserControlProfiles', () => {
  test('adds connected extension profiles before local detected profiles', () => {
    const connection: BrowserControlConnection = {
      extensionId: 'extension-1',
      stableKey: 'install:abc',
      profileId: 'install:abc',
      browserName: 'Chrome',
      version: '1.0.0',
      activeSessions: 1,
      targets: [],
      browserWindows: [
        {
          windowId: 1,
          focused: true,
          type: 'normal',
          state: 'normal',
          tabs: [
            {
              tabRef: 'install:abc:chrome-tab:2',
              chromeTabId: 2,
              windowId: 1,
              index: 0,
              active: true,
              highlighted: true,
              pinned: false,
              title: 'Docs',
              url: 'https://example.com',
              status: 'complete',
              controlState: 'observable',
            },
          ],
        },
      ],
      focusedWindowId: 1,
      activeTabRef: 'install:abc:chrome-tab:2',
      focusedWindow: null,
      activeTab: null,
    };

    const profiles = buildBrowserControlProfiles(connection ? [connection] : [], [
      {
        profileId: 'local:work',
        policyProfileId: null,
        browserName: 'Chrome',
        browserChannel: 'stable',
        profileName: 'Work',
        profilePath: '/profiles/Work',
        userDataDir: '/profiles',
        extensionId: null,
        stableKey: null,
        connectionState: 'detected',
        activeSessions: 0,
        windowCount: 0,
        tabCount: 0,
      },
    ]);

    expect(profiles).toMatchObject([
      {
        profileId: 'install:abc',
        policyProfileId: 'install:abc',
        profileName: 'install:abc',
        connectionState: 'connected',
        windowCount: 1,
        tabCount: 1,
      },
      {
        profileId: 'local:work',
        policyProfileId: null,
        profileName: 'Work',
        connectionState: 'detected',
        windowCount: 0,
        tabCount: 0,
      },
    ]);
  });

  test('joins a connected install id to the matching local Chrome profile', async () => {
    const home = makeTempDir();
    const userDataDir = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    const profilePath = path.join(userDataDir, 'Profile 1');
    const installId = '0b16524c-74c4-4f5c-a937-d996d957f021';
    mkdirSync(
      path.join(profilePath, 'IndexedDB', 'chrome-extension_pebbngnfojnignonigcnkdilknapkgid_0.indexeddb.leveldb'),
      { recursive: true },
    );
    writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify({
      profile: {
        info_cache: {
          'Profile 1': { name: 'Work' },
        },
      },
    }));
    writeFileSync(
      path.join(
        profilePath,
        'IndexedDB',
        'chrome-extension_pebbngnfojnignonigcnkdilknapkgid_0.indexeddb.leveldb',
        '000003.log',
      ),
      `relay-install-id:${installId}`,
    );

    const localProfiles = await discoverLocalBrowserProfiles({
      platform: 'darwin',
      homeDir: home,
      env: {},
    });
    const connection: BrowserControlConnection = {
      extensionId: 'extension-1',
      stableKey: `install:${installId}`,
      profileId: `install:${installId}`,
      browserName: 'Chrome',
      version: '1.0.0',
      activeSessions: 1,
      targets: [],
      browserWindows: [],
      focusedWindowId: null,
      activeTabRef: null,
      focusedWindow: null,
      activeTab: null,
    };

    const profiles = await buildBrowserControlProfilesWithLocalMatches([connection], localProfiles);

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      profileId: localProfiles[0]!.profileId,
      policyProfileId: `install:${installId}`,
      profileName: 'Work',
      profilePath,
      extensionId: 'extension-1',
      stableKey: `install:${installId}`,
      connectionState: 'connected',
    });
  });
});
