import { pathBasename } from '@/ipc';

class ThumbnailCache {
  private cache = new Map<string, string>();
  private loading = new Set<string>();
  private subscribers = new Map<string, Set<(url: string) => void>>();

  private shortName(path: string): string {
    return pathBasename(path) || path;
  }

  get(path: string): string | undefined {
    const result = this.cache.get(path);
    return result;
  }

  set(path: string, url: string): void {
    if (!url.trim()) {
      return;
    }
    this.cache.set(path, url);
    this.notify(path, url);
  }

  subscribe(path: string, callback: (url: string) => void): () => void {
    if (!this.subscribers.has(path)) {
      this.subscribers.set(path, new Set());
    }
    this.subscribers.get(path)!.add(callback);
    // const subCount = this.subscribers.get(path)!.size;
    // console.log(`[CACHE:SUBSCRIBE] ${this.shortName(path)} subscribers=${subCount}`);
    return () => {
      const subs = this.subscribers.get(path);
      subs?.delete(callback);
      // console.log(`[CACHE:UNSUBSCRIBE] ${this.shortName(path)} subscribers=${subs?.size || 0}`);
    };
  }

  private notify(path: string, url: string): void {
    const subs = this.subscribers.get(path);
    const subCount = subs?.size || 0;
    // const isBlack = url.length < 200;
    // console.log(`[CACHE:NOTIFY] ${this.shortName(path)} subscribers=${subCount} len=${url.length} isBlack=${isBlack}`);
    if (subCount > 0) {
      subs?.forEach((cb) => {
        // console.log(`[CACHE:NOTIFY] ${this.shortName(path)} calling subscriber`);
        cb(url);
      });
    }
  }

  isLoading(path: string): boolean {
    const result = this.loading.has(path);
    // console.log(`[CACHE:IS_LOADING] ${this.shortName(path)} -> ${result} (loadingSize=${this.loading.size})`);
    return result;
  }

  markLoading(path: string): void {
    // console.log(`[CACHE:MARK_LOADING] ${this.shortName(path)} loadingSize=${this.loading.size}->${this.loading.size + 1}`);
    this.loading.add(path);
  }

  clearLoading(path: string): void {
    // const hadIt = this.loading.has(path);
    this.loading.delete(path);
    // console.log(`[CACHE:CLEAR_LOADING] ${this.shortName(path)} wasLoading=${hadIt} loadingSize=${this.loading.size}`);
  }

  clear(): void {
    // console.log(`[CACHE:CLEAR] clearing cache=${this.cache.size} loading=${this.loading.size}`);
    this.cache.clear();
    this.loading.clear();
  }

  debugDump(): void {
    console.log(`[CACHE:DUMP] cache=${this.cache.size} loading=${this.loading.size} subscribers=${this.subscribers.size}`);
    console.log(`[CACHE:DUMP] cached keys:`, [...this.cache.keys()].map(k => this.shortName(k)));
    console.log(`[CACHE:DUMP] loading keys:`, [...this.loading].map(k => this.shortName(k)));
  }
}

export const thumbnailCache = new ThumbnailCache();

// Make it accessible from console for debugging
if (typeof window !== 'undefined') {
  (window as any).thumbnailCache = thumbnailCache;
}
