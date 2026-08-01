import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { AppConfig } from '../configStore';
import { resolveInterpreterDataDir } from '../../shared/interpreterConfigPaths';

type LegacyAwareAppConfig = AppConfig & { mcpOAuth?: unknown };

type LegacyOAuthTokens = {
  access_token?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  expires_at?: unknown;
};

type LegacyOAuthClientInfo = {
  client_id?: unknown;
};

type LegacyOAuthData = {
  tokens?: unknown;
  clientInfo?: unknown;
};

type FallbackTokenEntry = {
  server_name: string;
  server_url: string;
  client_id: string;
  access_token: string;
  expires_at?: number;
  refresh_token?: string;
  scopes: string[];
};

type FallbackTokenStore = Record<string, FallbackTokenEntry>;

type MigrationLogger = Pick<Console, 'warn'>;

export type LegacyMcpOAuthMigrationResult = {
  changed: boolean;
  migratedLegacyUrls: string[];
  skippedLegacyUrls: string[];
};

const FALLBACK_FILENAME = '.credentials.json';
const MIGRATION_LOG_PREFIX = '[ConfigStore] Legacy MCP OAuth migration';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeScopes(scope: unknown): string[] {
  if (typeof scope !== 'string') {
    return [];
  }

  return scope
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeExpiresAtMillis(expiresAt: unknown): number | undefined {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return undefined;
  }

  // Legacy app state used seconds, but a manually edited config may already be in
  // milliseconds. Treat very large values as already-millisecond timestamps.
  if (expiresAt >= 1_000_000_000_000) {
    return Math.floor(expiresAt);
  }

  return Math.floor(expiresAt * 1000);
}

function extractLegacyOAuthData(
  value: unknown,
): { accessToken: string | null; refreshToken: string | null; clientId: string | null; scopes: string[]; expiresAt: number | undefined } {
  const data = isRecord(value) ? value as LegacyOAuthData : null;
  const tokens = isRecord(data?.tokens) ? data.tokens as LegacyOAuthTokens : null;
  const clientInfo = isRecord(data?.clientInfo) ? data.clientInfo as LegacyOAuthClientInfo : null;

  return {
    accessToken: asNonEmptyString(tokens?.access_token),
    refreshToken: asNonEmptyString(tokens?.refresh_token),
    clientId: asNonEmptyString(clientInfo?.client_id),
    scopes: normalizeScopes(tokens?.scope),
    expiresAt: normalizeExpiresAtMillis(tokens?.expires_at),
  };
}

function resolveCodexHome(codexHome?: string): string {
  if (codexHome?.trim()) {
    return resolve(codexHome);
  }

  if (process.env.CODEX_HOME?.trim()) {
    return resolve(process.env.CODEX_HOME);
  }

  return join(resolveInterpreterDataDir(), 'codex-home');
}

function getFallbackFilePath(codexHome?: string): string {
  return join(resolveCodexHome(codexHome), FALLBACK_FILENAME);
}

async function readFallbackTokenStore(
  fallbackFilePath: string,
  logger: MigrationLogger,
): Promise<FallbackTokenStore | null> {
  try {
    const raw = await readFile(fallbackFilePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      logger.warn(`${MIGRATION_LOG_PREFIX} skipped because ${fallbackFilePath} does not contain a JSON object.`);
      return null;
    }
    return parsed as FallbackTokenStore;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ENOENT') {
      return {};
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`${MIGRATION_LOG_PREFIX} skipped because ${fallbackFilePath} could not be read: ${message}`);
    return null;
  }
}

async function writeFallbackTokenStore(
  fallbackFilePath: string,
  store: FallbackTokenStore,
): Promise<void> {
  await mkdir(dirname(fallbackFilePath), { recursive: true });
  await writeFile(fallbackFilePath, JSON.stringify(store), 'utf-8');

  if (process.platform !== 'win32') {
    try {
      await chmod(fallbackFilePath, 0o600);
    } catch {
      // Best-effort only. The contents matter more than the permission fixup.
    }
  }
}

function getMatchingRemoteServerNames(config: AppConfig, legacyUrl: string): string[] {
  const matches: string[] = [];

  for (const [serverId, serverConfig] of Object.entries(config.mcpServers ?? {})) {
    if (serverConfig.url !== legacyUrl) {
      continue;
    }

    matches.push(asNonEmptyString(serverConfig.id) ?? serverId);
  }

  return matches;
}

export function computeCodexMcpOAuthStorageKey(serverName: string, serverUrl: string): string {
  const payload = JSON.stringify({
    type: 'http',
    url: serverUrl,
    headers: {},
  });
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return `${serverName}|${digest}`;
}

/*
Best-effort legacy MCP OAuth migration notes.

What we can recover:
- The legacy app persisted bearer tokens, refresh tokens, scopes, and a client_id
  under config.mcpOAuth[serverUrl].
- The current Codex MCP fallback file only needs server_name, server_url,
  client_id, access_token, optional refresh_token, optional expires_at, and
  scopes, so we can reconstruct that subset without touching vendored Codex.
- When multiple current MCP server ids point at the same legacy URL, we can seed
  the same token material for each server id because Codex keys credentials by
  server_name plus URL hash.

What we know may not survive this migration:
- Keyring-backed users are not fully migrated. We only seed CODEX_HOME
  `.credentials.json`. Codex auto mode can read that fallback file, but explicit
  keyring-only setups will still miss these credentials until the user
  re-authenticates or some later flow writes the keyring entry.
- Pending OAuth handshake state does not survive. The old store kept PKCE code
  verifiers and state only in memory, so any in-flight auth flow is unrecoverable
  across restart.
- Dynamic registration metadata is only partially useful. The old app also stored
  registrationRedirectUrl and could store client_secret. The current fallback
  file format does not have fields for those values, so they are intentionally
  dropped here.
- We require a live config match by remote MCP URL. If the legacy OAuth blob
  exists but the current app config no longer has an MCP server whose `url`
  matches that legacy key, we leave the legacy state in place and do not guess.
- Non-URL MCP transports are not migrated through this path. Legacy state keyed
  by a server URL only maps cleanly onto the current remote-URL MCP entries.
  Stdio entries, websocket-only entries, and other stale transport shapes are
  skipped unless they now have a matching `server.url`.
- Scope formatting can only be reconstructed from the old single string field.
  We split on ASCII whitespace. If an upstream provider encoded scopes in some
  unusual format, this can only be approximated.
- Expiry fidelity is limited by the old stored data. The legacy app persisted
  `expires_at` in seconds. We convert that to milliseconds when present. If the
  old record only had `expires_in`, that relative duration is not trustworthy
  after restart, so we intentionally do not synthesize a fresh absolute expiry.
- Existing current-format credentials win. If `.credentials.json` already has an
  entry for the same server id plus URL key, we do not overwrite it with legacy
  data because the current store is the newer source of truth.
- Corrupt current credentials storage is treated conservatively. If the fallback
  file already exists but cannot be parsed, we leave legacy state untouched
  instead of overwriting a file we no longer understand.
*/
export async function migrateLegacyMcpOAuthToCodex(
  config: LegacyAwareAppConfig,
  options: { codexHome?: string; logger?: MigrationLogger } = {},
): Promise<LegacyMcpOAuthMigrationResult> {
  const logger = options.logger ?? console;
  const legacyEntries = isRecord(config.mcpOAuth) ? { ...config.mcpOAuth } : null;
  const legacyUrls = legacyEntries ? Object.keys(legacyEntries) : [];

  if (!legacyEntries || legacyUrls.length === 0) {
    return {
      changed: false,
      migratedLegacyUrls: [],
      skippedLegacyUrls: [],
    };
  }

  const fallbackFilePath = getFallbackFilePath(options.codexHome);
  const currentStore = await readFallbackTokenStore(fallbackFilePath, logger);
  if (!currentStore) {
    return {
      changed: false,
      migratedLegacyUrls: [],
      skippedLegacyUrls: legacyUrls,
    };
  }

  const nextStore: FallbackTokenStore = { ...currentStore };
  const removableLegacyUrls: string[] = [];
  const skippedLegacyUrls: string[] = [];

  for (const [legacyUrl, legacyValue] of Object.entries(legacyEntries)) {
    const matchingServerNames = getMatchingRemoteServerNames(config, legacyUrl);
    const { accessToken, refreshToken, clientId, scopes, expiresAt } = extractLegacyOAuthData(legacyValue);

    if (matchingServerNames.length === 0 || !accessToken || !clientId) {
      skippedLegacyUrls.push(legacyUrl);
      continue;
    }

    for (const serverName of matchingServerNames) {
      const storeKey = computeCodexMcpOAuthStorageKey(serverName, legacyUrl);
      if (nextStore[storeKey]) {
        continue;
      }

      nextStore[storeKey] = {
        server_name: serverName,
        server_url: legacyUrl,
        client_id: clientId,
        access_token: accessToken,
        expires_at: expiresAt,
        refresh_token: refreshToken ?? undefined,
        scopes,
      };
    }

    removableLegacyUrls.push(legacyUrl);
  }

  const storeChanged = JSON.stringify(nextStore) !== JSON.stringify(currentStore);
  if (storeChanged) {
    try {
      await writeFallbackTokenStore(fallbackFilePath, nextStore);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`${MIGRATION_LOG_PREFIX} skipped because ${fallbackFilePath} could not be written: ${message}`);
      return {
        changed: false,
        migratedLegacyUrls: [],
        skippedLegacyUrls: legacyUrls,
      };
    }
  }

  if (removableLegacyUrls.length === 0) {
    return {
      changed: false,
      migratedLegacyUrls: [],
      skippedLegacyUrls,
    };
  }

  const remainingLegacyEntries = { ...legacyEntries };
  for (const legacyUrl of removableLegacyUrls) {
    delete remainingLegacyEntries[legacyUrl];
  }

  if (Object.keys(remainingLegacyEntries).length === 0) {
    delete config.mcpOAuth;
  } else {
    config.mcpOAuth = remainingLegacyEntries;
  }

  return {
    changed: storeChanged || removableLegacyUrls.length > 0,
    migratedLegacyUrls: removableLegacyUrls,
    skippedLegacyUrls,
  };
}
