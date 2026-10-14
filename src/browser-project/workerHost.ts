/** The project supplies an installed, versioned worker asset; prompts never become worker source. */
export type WorkerRequest = { id: string; type: string; payload: unknown };
export type WorkerReply = { id: string; ok: boolean; payload?: unknown; error?: string };

export class BrowserWorkerHost {
  private readonly worker: Worker;
  private readonly pending = new Map<string, { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(assetUrl: URL, private readonly timeoutMs = 5000) {
    if (assetUrl.origin !== location.origin) throw new Error('Worker asset must be same-origin');
    this.worker = new Worker(assetUrl, { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const entry = this.pending.get(event.data?.id);
      if (!entry) return;
      this.pending.delete(event.data.id);
      clearTimeout(entry.timer);
      entry.resolve(event.data);
    };
    this.worker.onerror = () => this.stop();
  }
  request(type: string, payload: unknown): Promise<WorkerReply> {
    if (!/^[a-z][a-z0-9-]{0,48}$/.test(type)) throw new Error('Invalid worker operation');
    if (this.pending.size >= 32) throw new Error('Worker request limit reached');
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Worker timeout')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, payload } satisfies WorkerRequest);
    });
  }
  stop(): void {
    this.worker.terminate();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Worker stopped')); }
    this.pending.clear();
  }
}
