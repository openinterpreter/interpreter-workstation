import watcher, { type AsyncSubscription, type Event } from '@parcel/watcher';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { getCurrentWorkspace } from './utils/workspace';

type FileChangeCallback = (
  eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change',
  path: string,
  mtime?: number
) => void;

// NOTE(victor): Comprehensive ignore patterns for efficient recursive watching.
// These prevent watching large directories that change frequently but aren't user content.
const IGNORE_PATTERNS = [
  // Hidden files/folders (dotfiles)
  '**/.*',

  // Package managers
  '**/node_modules/**',
  '**/.pnpm/**',
  '**/bower_components/**',

  // Version control
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',

  // Build outputs
  '**/dist/**',
  // NOTE(victor): Do not ignore generic `build/` or `out/` directories here.
  // Those names are too broad and often contain user-visible workspace content.
  // VS Code does not exclude them by default from file watching either; it only
  // documents `files.watcherExclude` as an opt-in for noisy build output.
  // Keep narrower framework-specific outputs below instead.
  // '**/build/**',
  // '**/out/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.output/**',

  // Caches
  '**/.cache/**',
  '**/.parcel-cache/**',
  '**/.turbo/**',

  // Python
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',

  // OS files
  '**/.DS_Store',
  '**/Thumbs.db',

  // Windows profile runtime data (very high churn, not user workspace content)
  '**/AppData/**',
];

export class FileWatcherManager {
  private subscription: AsyncSubscription | null = null;
  private stopPromise: Promise<void> | null = null;
  // NOTE(victor): Serialize start()/stop() transitions onto one queue so we
  // never overlap native subscribe/unsubscribe work. @parcel/watcher exposes a
  // single async subscription lifecycle (`await watcher.subscribe(...)`,
  // `await subscription.unsubscribe()`), and VS Code likewise serializes
  // watcher updates before touching the Parcel watcher layer.
  // Sources:
  // - node_modules/@parcel/watcher/README.md
  // - https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/watcher/baseWatcher.ts
  // - https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts
  private lifecyclePromise: Promise<void> = Promise.resolve();
  private callback: FileChangeCallback | null = null;
  private workspace: string | null = null;
  private canonicalWorkspace: string | null = null;
  private workspaceOverride: string | null | undefined = undefined;
  private pendingEvents: Map<string, Event> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private watchStartedAtMs: number = 0;
  protected readonly DEBOUNCE_MS: number = 100;
  private static readonly STARTUP_STALE_CREATE_WINDOW_MS = 75;
  private static readonly FILE_TIMESTAMP_RESOLUTION_GRACE_MS = 1000;
  protected readonly STAT_RETRY_DELAY_MS: number = 25;

  setWorkspaceOverride(path: string | null): void {
    this.workspaceOverride = path;
  }

  private getWorkspace(): string | null {
    if (this.workspaceOverride !== undefined) {
      return this.workspaceOverride;
    }
    return getCurrentWorkspace();
  }

  /**
   * Start recursive watching of the entire workspace.
   * Uses comprehensive ignore patterns for efficiency.
   *
   * NOTE: We don't distinguish between file and directory deletes because:
   * 1. @parcel/watcher doesn't provide this info cross-platform (Windows limitation)
   * 2. Our consumers (Explorer, LayoutContext) handle them identically
   * 3. This follows VS Code's approach for recursive watchers
   */
  async start(callback: FileChangeCallback): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.stopInternal();

      const workspace = this.getWorkspace();
      if (!workspace) {
        console.log('[FileWatcher] No workspace set, not starting watcher');
        return;
      }

      this.callback = callback;
      this.workspace = workspace;
      this.watchStartedAtMs = Date.now();
      this.canonicalWorkspace = await realpath(workspace).catch(() => workspace);

      try {
        this.subscription = await this.subscribe(workspace);
        console.log('[FileWatcher] Started watching:', workspace);
      } catch (error) {
        console.error('[FileWatcher] Failed to start:', error);
      }
    });
  }

  protected async subscribe(workspace: string): Promise<AsyncSubscription> {
    return watcher.subscribe(
      workspace,
      (err, events) => this.handleEvents(err, events),
      { ignore: IGNORE_PATTERNS }
    );
  }

  /**
   * Add a folder to watch (no-op for recursive watching, kept for API compatibility)
   */
  addPath(_folderPath: string): void {
    // NOTE(victor): No-op - recursive watching covers all folders automatically
  }

  /**
   * Remove a folder from watching (no-op for recursive watching, kept for API compatibility)
   */
  removePath(_folderPath: string): void {
    // NOTE(victor): No-op - recursive watching covers all folders automatically
  }

  private handleEvents(err: Error | null, events: Event[]): void {
    if (err) {
      console.error('[FileWatcher] Error:', err);
      return;
    }

    // Coalesce events by path (latest wins)
    for (const event of events) {
      this.pendingEvents.set(event.path, event);
    }

    // Debounce emission
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushEvents(), this.DEBOUNCE_MS);
  }

  private async flushEvents(): Promise<void> {
    const events = Array.from(this.pendingEvents.values());
    this.pendingEvents.clear();
    this.debounceTimer = null;

    for (const event of events) {
      await this.processEvent(event);
    }
  }

  private async processEvent(event: Event): Promise<void> {
    if (!this.callback || !this.workspace) return;

    const callback = this.callback;
    const absolutePath = event.path;
    const canonicalEventPath = await realpath(absolutePath).catch(() => absolutePath);
    const relativePath = this.resolveRelativePath(absolutePath, canonicalEventPath);

    try {
      switch (event.type) {
        case 'create': {
          const stats = await this.statWithRetry(absolutePath);
          if (!stats) return;

          // @parcel/watcher can occasionally deliver delayed startup "create"
          // events for files that existed before subscribe(). Ignore those.
          const mtimeMs = stats.mtime.getTime();
          const ctimeMs = stats.ctime.getTime();
          const withinStartupWindow =
            Date.now() - this.watchStartedAtMs <= FileWatcherManager.STARTUP_STALE_CREATE_WINDOW_MS;
          const appearsOlderThanWatchStart =
            mtimeMs <
              this.watchStartedAtMs - FileWatcherManager.FILE_TIMESTAMP_RESOLUTION_GRACE_MS &&
            ctimeMs < this.watchStartedAtMs - FileWatcherManager.FILE_TIMESTAMP_RESOLUTION_GRACE_MS;
          if (
            withinStartupWindow &&
            !stats.isDirectory() &&
            appearsOlderThanWatchStart
          ) {
            return;
          }

          if (stats.isDirectory()) {
            callback('addDir', relativePath);
          } else {
            callback('add', relativePath, stats.mtime.getTime());
          }
          break;
        }

        case 'update': {
          const stats = await this.statWithRetry(absolutePath);
          if (!stats) return;
          callback('change', relativePath, stats.mtime.getTime());
          break;
        }

        case 'delete': {
          const stats = await this.statWithRetry(absolutePath);
          if (stats) {
            if (stats.isDirectory()) {
              callback('addDir', relativePath);
            } else {
              callback('change', relativePath, stats.mtime.getTime());
            }
            return;
          }

          // NOTE: We emit 'unlink' for both files and directories.
          // Consumers handle them identically, and we can't reliably distinguish
          // on delete (the path no longer exists for stat()).
          callback('unlink', relativePath);
          await this.emitAtomicTempRenameChange(absolutePath, callback);
          break;
        }
      }
    } catch (error) {
      console.error('[FileWatcher] Error processing event:', error);
    }
  }

  private async statWithRetry(path: string) {
    const first = await stat(path).catch(() => null);
    if (first) return first;

    await new Promise((resolve) => setTimeout(resolve, this.STAT_RETRY_DELAY_MS));
    return stat(path).catch(() => null);
  }

  async stop(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.stopInternal();
    });
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecyclePromise.then(operation, operation);
    this.lifecyclePromise = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async stopInternal(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    // NOTE(victor): @parcel/watcher exposes a single async unsubscribe path
    // (`await subscription.unsubscribe()`), and Node-API thread-safe function
    // teardown becomes undefined after release. Serialize concurrent stops onto
    // one promise to avoid overlapping native teardown.
    // NOTE(victor): Sources: node_modules/@parcel/watcher/README.md and
    // https://nodejs.org/download/release/v10.6.0/docs/api/n-api.html
    // Clear debounce state
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingEvents.clear();

    const subscription = this.subscription;
    this.subscription = null;
    this.callback = null;
    this.workspace = null;
    this.watchStartedAtMs = 0;
    this.canonicalWorkspace = null;

    if (!subscription) {
      return;
    }

    this.stopPromise = subscription.unsubscribe().finally(() => {
      this.stopPromise = null;
    });
    await this.stopPromise;
  }

  isWatching(): boolean {
    return this.subscription !== null;
  }

  private resolveRelativePath(originalPath: string, canonicalPath: string): string {
    if (!this.workspace) return originalPath;

    const workspaceCandidates = [this.workspace];
    if (this.canonicalWorkspace && this.canonicalWorkspace !== this.workspace) {
      workspaceCandidates.push(this.canonicalWorkspace);
    }

    const pathCandidates = [originalPath];
    if (canonicalPath !== originalPath) {
      pathCandidates.unshift(canonicalPath);
    }

    for (const workspacePath of workspaceCandidates) {
      for (const candidatePath of pathCandidates) {
        const candidateRelativePath = relative(workspacePath, candidatePath);
        if (
          candidateRelativePath === '' ||
          (!candidateRelativePath.startsWith('..') && !isAbsolute(candidateRelativePath))
        ) {
          return candidateRelativePath;
        }
      }
    }

    return relative(this.workspace, canonicalPath);
  }

  private async emitAtomicTempRenameChange(
    deletedPath: string,
    callback: FileChangeCallback
  ): Promise<void> {
    if (!deletedPath.endsWith('.tmp')) return;

    const destinationPath = deletedPath.slice(0, -4);
    const destinationStats = await stat(destinationPath).catch(() => null);
    if (!destinationStats || destinationStats.isDirectory()) return;

    const canonicalDestinationPath = await realpath(destinationPath).catch(() => destinationPath);
    const destinationRelativePath = this.resolveRelativePath(
      destinationPath,
      canonicalDestinationPath
    );

    callback('change', destinationRelativePath, destinationStats.mtime.getTime());
  }
}

export const fileWatcher = new FileWatcherManager();
