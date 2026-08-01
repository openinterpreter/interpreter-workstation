/**
 * Thumbnail Service
 *
 * Generates thumbnails and file icons for the file explorer.
 * Works in both Electron and sidecar mode:
 * - Electron: Uses native APIs for OS file icons
 * - Sidecar: Uses generic icons based on file extension
 *
 * Image processing uses 'sharp' (works everywhere).
 * HTTP requests use native 'fetch' (works everywhere).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LRUCache } from 'lru-cache';
import type { FileThumbnailData, FileThumbnailKind } from '../shared/types/fileThumbnail';

const execAsync = promisify(exec);

// Detect if we're running in Electron
const isElectron = !!process.versions.electron;

// Lazy-load Electron APIs only when in Electron mode
let electronApp: Electron.App | null = null;
let electronNativeImage: typeof Electron.nativeImage | null = null;

if (isElectron) {
  try {
    const electron = require('electron');
    electronApp = electron.app;
    electronNativeImage = electron.nativeImage;
  } catch {
    // silently ignore - Electron APIs not available
  }
}

// Lazy-load sharp (may not be installed in all environments)
let sharp: any = null;
try {
  sharp = require('sharp');
} catch {
  // sharp not available
}

interface ThumbnailCacheEntry {
  dataUrl: string;
  width?: number;
  height?: number;
  mtime: number;
  kind: FileThumbnailKind;
}

export interface ThumbnailResult extends FileThumbnailData {}

export interface DimensionResult {
  width: number;
  height: number;
}

// ============================================================================
// GENERIC ICONS (used in sidecar mode)
// ============================================================================

// Base64-encoded 1x1 transparent PNG as fallback
const TRANSPARENT_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Generic icon SVGs for common file types (simple, recognizable)
const GENERIC_ICONS: Record<string, string> = {
  // Documents
  '.pdf': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#E53935"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h6v6h6v10H6z"/><text x="12" y="16" font-size="6" text-anchor="middle" fill="#E53935">PDF</text></svg>`,
  '.doc': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#1565C0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h6v6h6v10H6z"/><text x="12" y="16" font-size="5" text-anchor="middle" fill="#1565C0">DOC</text></svg>`,
  '.docx': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#1565C0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h6v6h6v10H6z"/><text x="12" y="16" font-size="5" text-anchor="middle" fill="#1565C0">DOC</text></svg>`,
  // Spreadsheets
  '.xls': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#2E7D32"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h6v6h6v10H6z"/><text x="12" y="16" font-size="5" text-anchor="middle" fill="#2E7D32">XLS</text></svg>`,
  '.xlsx': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#2E7D32"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h6v6h6v10H6z"/><text x="12" y="16" font-size="5" text-anchor="middle" fill="#2E7D32">XLS</text></svg>`,
  // Presentations
  '.ppt': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#D84315"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h6v6h6v10H6z"/><text x="12" y="16" font-size="5" text-anchor="middle" fill="#D84315">PPT</text></svg>`,
  '.pptx': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#D84315"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h6v6h6v10H6z"/><text x="12" y="16" font-size="5" text-anchor="middle" fill="#D84315">PPT</text></svg>`,
  // Code
  '.js': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#F7DF1E"><rect width="24" height="24" fill="#323330"/><text x="12" y="17" font-size="10" text-anchor="middle" fill="#F7DF1E" font-weight="bold">JS</text></svg>`,
  '.ts': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#3178C6"><rect width="24" height="24" fill="#3178C6"/><text x="12" y="17" font-size="10" text-anchor="middle" fill="white" font-weight="bold">TS</text></svg>`,
  '.py': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#3776AB"><rect width="24" height="24" fill="#FFD43B"/><text x="12" y="17" font-size="9" text-anchor="middle" fill="#3776AB" font-weight="bold">PY</text></svg>`,
  '.json': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#666"><rect width="24" height="24" fill="#f5f5f5"/><text x="12" y="15" font-size="6" text-anchor="middle" fill="#666">{  }</text></svg>`,
  // Interpreter workspace layout
  '.tabs': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="9.17" y="0" width="5.66" height="5.66" rx="2.83" fill="#999"/><rect x="9.17" y="8" width="5.66" height="16" rx="2.83" fill="#999"/></svg>`,
  // Default
  'default': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#757575"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h6v6h6v10H6z"/></svg>`,
};

function getGenericIconDataUrl(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const svg = GENERIC_ICONS[ext] || GENERIC_ICONS['default'];
  const base64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

// ============================================================================
// THUMBNAIL SERVICE
// ============================================================================

class ThumbnailService {
  private cache: LRUCache<string, ThumbnailCacheEntry>;
  private readonly DISK_CACHE_VERSION = 'v2';

  // Concurrency control for qlmanage to prevent EAGAIN errors
  private qlmanageActive = 0;
  private readonly MAX_QLMANAGE_CONCURRENT = 6;
  private readonly QLMANAGE_TIMEOUT_MS = 900;
  private readonly QLMANAGE_VIDEO_TIMEOUT_MS = 1500;

  // Persistent disk cache settings
  private readonly DISK_CACHE_DIR: string;
  private readonly CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes - show cached immediately, refresh on next view if stale

  // Pause flag - enabled on non-macOS platforms where qlmanage isn't available
  public paused = process.platform !== 'darwin';

  constructor() {
    // Set disk cache directory - use Electron userData in Electron mode, /tmp in sidecar mode
    if (electronApp) {
      this.DISK_CACHE_DIR = path.join(electronApp.getPath('userData'), 'thumbnail-cache');
    } else {
      this.DISK_CACHE_DIR = path.join('/tmp', 'workstation-thumbnail-cache');
    }

    this.cache = new LRUCache<string, ThumbnailCacheEntry>({
      max: 500,
      ttl: 1000 * 60 * 60, // 1 hour
    });
    fs.promises.mkdir(this.DISK_CACHE_DIR, { recursive: true }).catch(() => {});
  }

  private getDiskCacheKey(filePath: string, size: number): string {
    const hash = crypto.createHash('sha256').update(`${this.DISK_CACHE_VERSION}:${filePath}:${size}`).digest('hex');
    return hash.slice(0, 16) + '.json';
  }

  private getDiskCachePath(filePath: string, size: number): string {
    return path.join(this.DISK_CACHE_DIR, this.getDiskCacheKey(filePath, size));
  }

  private async readDiskCache(filePath: string, size: number): Promise<{ entry: ThumbnailCacheEntry; isStale: boolean } | null> {
    try {
      const cachePath = this.getDiskCachePath(filePath, size);
      const data = await fs.promises.readFile(cachePath, 'utf-8');
      const cached = JSON.parse(data) as ThumbnailCacheEntry & { cachedAt: number };
      const age = Date.now() - cached.cachedAt;
      const isStale = age > this.CACHE_MAX_AGE_MS;
      return { entry: cached, isStale };
    } catch {
      return null;
    }
  }

  private async writeDiskCache(filePath: string, size: number, entry: ThumbnailCacheEntry): Promise<void> {
    try {
      const cachePath = this.getDiskCachePath(filePath, size);
      const data = JSON.stringify({ ...entry, cachedAt: Date.now() });
      await fs.promises.writeFile(cachePath, data, 'utf-8');
    } catch {
      // Ignore write errors
    }
  }

  private refreshThumbnailInBackground(filePath: string, size: number, mtime: number, cacheKey: string): void {
    this.generateThumbnailFresh(filePath, size).then((result: ThumbnailResult | null) => {
      if (result && result.dataUrl) {
        const entry = { ...result, mtime };
        this.cache.set(cacheKey, entry);
        this.writeDiskCache(filePath, size, entry);
      }
    }).catch(() => {});
  }

  private async generateThumbnailFresh(filePath: string, size: number): Promise<ThumbnailResult | null> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.webloc') {
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const bookmarkData = JSON.parse(content);
        if (bookmarkData.faviconUrl) {
          const faviconResult = await this.fetchFavicon(bookmarkData.faviconUrl);
          if (faviconResult) {
            return faviconResult;
          }
        }
      } catch {
        // Fall through to file icon
      }
      const icon = await electronApp!.getFileIcon(filePath, { size: 'normal' });
      const dataUrl = icon.toDataURL();
      const { width, height } = icon.getSize();
      return { dataUrl, width, height, kind: 'icon' };
    }

    if (process.platform === 'darwin' && !this.shouldSkipQlmanage(filePath)) {
      const qlResult = await this.generateWithQlmanage(filePath, size);
      if (qlResult && (qlResult.width ?? 0) > 0 && (qlResult.height ?? 0) > 0) {
        return qlResult;
      }
    }

    if (process.platform === 'win32') {
      try {
        const icon = await electronNativeImage!.createThumbnailFromPath(filePath, { width: size, height: size });
        if (!icon.isEmpty()) {
          const dataUrl = icon.toDataURL();
          const { width, height } = icon.getSize();
          return { dataUrl, width, height, kind: 'preview' };
        }
      } catch {
        // Continue to fallbacks
      }
    }

    if (this.isDirectImage(filePath)) {
      try {
        const loadedImage = electronNativeImage!.createFromPath(filePath);
        if (!loadedImage.isEmpty()) {
          const icon = loadedImage.resize({ width: size, quality: 'good' });
          const dataUrl = icon.toDataURL();
          const { width, height } = icon.getSize();
          return { dataUrl, width, height, kind: 'preview' };
        }
      } catch {
        // Continue to file icon
      }
    }

    const icon = await electronApp!.getFileIcon(filePath, { size: 'normal' });
    const dataUrl = icon.toDataURL();
    const { width, height } = icon.getSize();
    return { dataUrl, width, height, kind: 'icon' };
  }

  /**
   * Run a function with concurrency limiting for qlmanage processes.
   * Prevents EAGAIN errors from spawning too many processes.
   */
  private async withQlmanageConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
    while (this.qlmanageActive >= this.MAX_QLMANAGE_CONCURRENT) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    this.qlmanageActive++;
    try {
      return await fn();
    } finally {
      this.qlmanageActive--;
    }
  }

  private isDirectImage(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.ico', '.heic', '.heif'].includes(ext);
  }

  /**
   * Check if file is a video type (needs longer timeout for qlmanage)
   */
  private isVideoFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.mov', '.mp4', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp'].includes(ext);
  }

  /**
   * Check if file type should skip qlmanage entirely (go straight to file icon).
   * These are files that either timeout, hang, or produce no useful visual thumbnail.
   */
  private shouldSkipQlmanage(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return [
      // Disk images - qlmanage tries to mount, causes timeout
      '.dmg', '.iso', '.img', '.sparseimage', '.sparsebundle',
      // Package installers
      '.pkg', '.mpkg', '.deb', '.rpm', '.msi',
      // Archives - no visual preview
      '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zip', '.rar', '.7z', '.cab', '.jar', '.war',
      // Binary/executable - no visual preview
      '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
      // Database files
      '.db', '.sqlite', '.sqlite3', '.mdb',
      // Config/data files - text, no visual preview
      '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.plist', '.lock',
      // Log files
      '.log',
      // Certificates/keys
      '.pem', '.crt', '.key', '.p12', '.pfx', '.cer',
      // Source code - text, no visual preview (file icon is better)
      '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
      '.java', '.rb', '.php', '.swift', '.kt', '.scala', '.cs', '.fs', '.lua', '.pl',
      '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
      // Markup/styles - text
      '.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte',
      // Data formats
      '.csv', '.tsv', '.ndjson',
    ].includes(ext);
  }

  private getDefaultDimensionsForType(filePath: string): DimensionResult | null {
    const ext = path.extname(filePath).toLowerCase();
    if (['.pptx', '.ppt', '.key', '.odp'].includes(ext)) return { width: 16, height: 9 };
    if (['.docx', '.doc', '.odt', '.pdf'].includes(ext)) return { width: 8.5, height: 11 };
    if (['.xlsx', '.xls', '.ods'].includes(ext)) return { width: 11, height: 8.5 };
    return null;
  }

  async getDimensions(filePath: string): Promise<DimensionResult | null> {
    if (process.platform !== 'darwin') {
      return this.getDefaultDimensionsForType(filePath);
    }

    if (this.isDirectImage(filePath)) {
      try {
        const { stdout } = await execAsync(`sips -g pixelWidth -g pixelHeight "${filePath}"`);
        const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
        const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
        if (widthMatch && heightMatch) {
          return { width: parseInt(widthMatch[1], 10), height: parseInt(heightMatch[1], 10) };
        }
      } catch {
        return null;
      }
    }

    return this.getDefaultDimensionsForType(filePath);
  }

  /**
   * Get file icon - uses Electron in Electron mode, generic SVG icons in sidecar mode
   */
  async getFileIcon(filePath: string): Promise<string | null> {
    const ext = path.extname(filePath).toLowerCase();

    // App-owned extensions use our custom icon instead of the OS default
    if (ext === '.tabs') {
      return getGenericIconDataUrl(filePath);
    }

    // In Electron mode, use native file icon
    if (isElectron && electronApp) {
      try {
        const icon = await electronApp.getFileIcon(filePath, { size: 'normal' });
        if (!icon.isEmpty()) {
          return icon.toDataURL();
        }
      } catch {
        // Fall through to generic icon
      }
    }

    // In sidecar mode (or if Electron failed), use generic icon
    return getGenericIconDataUrl(filePath);
  }

  async batchGetFileIcons(filePaths: string[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    for (const filePath of filePaths) {
      const icon = await this.getFileIcon(filePath);
      if (icon) {
        results.set(filePath, icon);
      }
    }
    return results;
  }

  async batchGetDimensions(filePaths: string[]): Promise<Map<string, DimensionResult>> {
    const results = new Map<string, DimensionResult>();
    const imagePaths: string[] = [];

    for (const filePath of filePaths) {
      if (this.isDirectImage(filePath)) {
        imagePaths.push(filePath);
      } else {
        const defaultDims = this.getDefaultDimensionsForType(filePath);
        if (defaultDims) {
          results.set(filePath, defaultDims);
        }
      }
    }

    if (process.platform === 'darwin' && imagePaths.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < imagePaths.length; i += batchSize) {
        const batch = imagePaths.slice(i, i + batchSize);
        const quotedPaths = batch.map(p => `"${p}"`).join(' ');
        try {
          const { stdout } = await execAsync(`sips -g pixelWidth -g pixelHeight ${quotedPaths}`);
          const fileBlocks = stdout.split(/(?=\/)/).filter(Boolean);
          for (const block of fileBlocks) {
            const pathMatch = block.match(/^([^\n]+)/);
            const widthMatch = block.match(/pixelWidth:\s*(\d+)/);
            const heightMatch = block.match(/pixelHeight:\s*(\d+)/);
            if (pathMatch && widthMatch && heightMatch) {
              const filePath = pathMatch[1].trim();
              results.set(filePath, {
                width: parseInt(widthMatch[1], 10),
                height: parseInt(heightMatch[1], 10),
              });
            }
          }
        } catch {
          // sips failed for batch, skip
        }
      }
    }

    return results;
  }

  /**
   * Check if PNG image data appears to be mostly black/empty
   */
  private isBlackImage(pngData: Buffer): boolean {
    // PNG files have IDAT chunks containing pixel data
    // A simple heuristic: if the compressed data is very small, it's likely a solid color
    // Black 64x64 PNG is typically ~300-500 bytes, real thumbnails are larger
    if (pngData.length < 600) {
      return true;
    }
    return false;
  }

  /**
   * Generate thumbnail using qlmanage (macOS Quick Look CLI)
   * Returns thumbnail with natural aspect ratio, not letterboxed
   * Uses concurrency limiting to prevent EAGAIN errors from too many processes
   */
  private async generateWithQlmanage(filePath: string, size: number, timeoutMs?: number): Promise<ThumbnailResult | null> {
    const timeout = timeoutMs ?? (this.isVideoFile(filePath) ? this.QLMANAGE_VIDEO_TIMEOUT_MS : this.QLMANAGE_TIMEOUT_MS);
    return this.withQlmanageConcurrencyLimit(async () => {
      const tempDir = '/tmp/iworkstation-thumbnails';
      const fileName = path.basename(filePath);

      try {
        await fs.promises.mkdir(tempDir, { recursive: true });

        await execAsync(`qlmanage -t -x -s ${size} -o "${tempDir}" "${filePath}" 2>/dev/null`, {
          timeout,
          killSignal: 'SIGKILL',
        });

        const generatedFile = path.join(tempDir, fileName + '.png');

        try {
          await fs.promises.access(generatedFile);
          const thumbnailData = await fs.promises.readFile(generatedFile);

          let width = 0;
          let height = 0;
          if (thumbnailData.length > 24) {
            width = thumbnailData.readUInt32BE(16);
            height = thumbnailData.readUInt32BE(20);
          }

          await fs.promises.unlink(generatedFile).catch(() => {});

          if (this.isBlackImage(thumbnailData)) {
            return null;
          }

          const base64 = thumbnailData.toString('base64');
          const dataUrl = `data:image/png;base64,${base64}`;

          return { dataUrl, width, height, kind: 'preview' };
        } catch {
          return null;
        }
      } catch {
        return null;
      }
    });
  }

  /**
   * Load and resize image using sharp (works in sidecar mode)
   */
  private async loadImageWithSharp(filePath: string, size: number): Promise<ThumbnailResult | null> {
    if (!sharp) return null;

    try {
      const image = sharp(filePath);
      const metadata = await image.metadata();
      const buffer = await image.resize(size).png().toBuffer();
      const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
      return {
        dataUrl,
        width: metadata.width || size,
        height: metadata.height || size,
        kind: 'preview',
      };
    } catch {
      return null;
    }
  }

  /**
   * Load and resize image using Electron nativeImage
   */
  private async loadImageWithElectron(filePath: string, size: number): Promise<ThumbnailResult | null> {
    if (!electronNativeImage) return null;

    try {
      const loadedImage = electronNativeImage.createFromPath(filePath);
      if (!loadedImage.isEmpty()) {
        const icon = loadedImage.resize({ width: size, quality: 'good' });
        const dataUrl = icon.toDataURL();
        const { width, height } = icon.getSize();
        return { dataUrl, width, height, kind: 'preview' };
      }
    } catch {
      // Fall through
    }
    return null;
  }

  /**
   * Fetch favicon using native fetch (works in sidecar mode)
   */
  private async fetchFavicon(url: string): Promise<ThumbnailResult | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) return null;

      const buffer = Buffer.from(await response.arrayBuffer());

      // Try to resize with sharp if available
      if (sharp) {
        try {
          const resizedBuffer = await sharp(buffer).resize(32).png().toBuffer();
          const dataUrl = `data:image/png;base64,${resizedBuffer.toString('base64')}`;
          return { dataUrl, width: 32, height: 32, kind: 'preview' };
        } catch {
          // Fall through to raw buffer
        }
      }

      // Fall back to raw buffer as data URL
      const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
      return { dataUrl, width: 32, height: 32, kind: 'preview' };
    } catch {
      return null;
    }
  }

  /**
   * Get thumbnail for a single file path
   */
  async getThumbnail(filePath: string, size: number = 256): Promise<ThumbnailResult | null> {
    if (this.paused) {
      return null;
    }

    // App-owned extensions: return custom icon directly, skip thumbnail pipeline
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.tabs') {
      const dataUrl = getGenericIconDataUrl(filePath);
      return { dataUrl, width: 24, height: 24, kind: 'icon' };
    }

    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.size === 0) {
        return null;
      }
      const currentMtime = stats.mtime.getTime();

      const cacheKey = this.getCacheKey(filePath, size);
      const memCached = this.cache.get(cacheKey);

      if (memCached && memCached.mtime === currentMtime) {
        return {
          dataUrl: memCached.dataUrl,
          width: memCached.width,
          height: memCached.height,
          kind: memCached.kind,
        };
      }

      // Check disk cache - stale-while-revalidate pattern
      const diskCached = await this.readDiskCache(filePath, size);
      if (diskCached) {
        const { entry, isStale } = diskCached;
        // Populate memory cache
        this.cache.set(cacheKey, entry);

        if (isStale || entry.mtime !== currentMtime) {
          // Return cached immediately, refresh in background
          this.refreshThumbnailInBackground(filePath, size, currentMtime, cacheKey);
        }
        return {
          dataUrl: entry.dataUrl,
          width: entry.width,
          height: entry.height,
          kind: entry.kind,
        };
      }
      const ext = path.extname(filePath).toLowerCase();

      // Handle .webloc bookmark files
      if (ext === '.webloc') {
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const bookmarkData = JSON.parse(content);
          const faviconUrl = bookmarkData.faviconUrl;

          if (faviconUrl) {
            const faviconResult = await this.fetchFavicon(faviconUrl);
            if (faviconResult) {
              this.cache.set(cacheKey, { ...faviconResult, mtime: currentMtime });
              return faviconResult;
            }
          }
        } catch {
          // Fall through to file icon
        }

        const iconUrl = await this.getFileIcon(filePath);
        const result = { dataUrl: iconUrl || TRANSPARENT_PIXEL, width: 32, height: 32, kind: 'icon' as const };
        this.cache.set(cacheKey, { ...result, mtime: currentMtime });
        return result;
      }

      // Try macOS Quick Look first (works for most file types)
      if (process.platform === 'darwin' && !this.shouldSkipQlmanage(filePath)) {
        const qlResult = await this.generateWithQlmanage(filePath, size);
        if (qlResult && (qlResult.width ?? 0) > 0 && (qlResult.height ?? 0) > 0) {
          const entry = { ...qlResult, mtime: currentMtime };
          this.cache.set(cacheKey, entry);
          this.writeDiskCache(filePath, size, entry);
          return qlResult;
        }
      }

      // Try Windows thumbnail (Electron only)
      if (process.platform === 'win32' && electronNativeImage) {
        try {
          const icon = await electronNativeImage.createThumbnailFromPath(filePath, { width: size, height: size });
          if (!icon.isEmpty()) {
            const dataUrl = icon.toDataURL();
            const { width, height } = icon.getSize();
            const result = { dataUrl, width, height, kind: 'preview' as const };
            this.cache.set(cacheKey, { ...result, mtime: currentMtime });
            return result;
          }
        } catch {
          // Fall through
        }
      }

      // For images, load and resize directly
      if (this.isDirectImage(filePath)) {
        // Try sharp first (works in sidecar mode)
        const sharpResult = await this.loadImageWithSharp(filePath, size);
        if (sharpResult) {
          const entry = { ...sharpResult, mtime: currentMtime };
          this.cache.set(cacheKey, entry);
          this.writeDiskCache(filePath, size, entry);
          return sharpResult;
        }

        // Fall back to Electron nativeImage
        const electronResult = await this.loadImageWithElectron(filePath, size);
        if (electronResult) {
          const entry = { ...electronResult, mtime: currentMtime };
          this.cache.set(cacheKey, entry);
          this.writeDiskCache(filePath, size, entry);
          return electronResult;
        }
      }

      // Fall back to file icon
      const iconUrl = await this.getFileIcon(filePath);
      const result = { dataUrl: iconUrl || TRANSPARENT_PIXEL, width: 32, height: 32, kind: 'icon' as const };
      const entry = { ...result, mtime: currentMtime };
      this.cache.set(cacheKey, entry);
      this.writeDiskCache(filePath, size, entry);

      return result;
    } catch {
      return { dataUrl: TRANSPARENT_PIXEL, width: 1, height: 1, kind: 'icon' };
    }
  }

  async batchGetThumbnails(
    filePaths: string[],
    onProgress?: (current: number, total: number) => void,
    size: number = 256
  ): Promise<Map<string, ThumbnailResult>> {
    const results = new Map<string, ThumbnailResult>();
    const total = filePaths.length;

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      const result = await this.getThumbnail(filePath, size);
      if (result) {
        results.set(filePath, result);
      }

      if (onProgress) {
        onProgress(i + 1, total);
      }

      await new Promise(resolve => setImmediate(resolve));
    }

    return results;
  }

  invalidate(filePath: string): void {
    const cacheKey = this.getCacheKey(filePath);
    this.cache.delete(cacheKey);
  }

  clearCache(): void {
    this.cache.clear();
  }

  getStats(): { size: number; max: number } {
    return {
      size: this.cache.size,
      max: this.cache.max,
    };
  }

  private getCacheKey(filePath: string, size: number = 64): string {
    return `${filePath}:${size}`;
  }
}

export const thumbnailService = new ThumbnailService();
