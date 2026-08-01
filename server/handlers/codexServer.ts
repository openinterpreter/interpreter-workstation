/**
 * Codex Server Handlers
 *
 * COMMENTED OUT - Removed in model system redesign.
 * The Codex Server profile (builtin:codex with provider: 'agent') has been removed.
 * Codex Terminal (builtin:codex-terminal with provider: 'terminal') is still supported.
 *
 * This file contained the business logic for Codex app-server integration,
 * including CodexConnection singleton and request/response communication.
 */

// NOTE: All code in this file has been commented out as part of the
// onboarding and model system redesign. The Codex Server profile has been
// removed in favor of the simpler Codex Terminal profile which runs in a PTY.

/*
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { broadcastEvent } from './broadcast';
import { resolveCodexPath } from './providers';

// Thread storage in ~/.interpreter/codex-threads/
const CODEX_THREADS_DIR = path.join(os.homedir(), '.interpreter', 'codex-threads');

export class CodexConnection {
  private process: ChildProcess | null = null;
  private request_id = 0;
  private pending_requests = new Map<number, { resolve: Function; reject: Function }>();
  private buffer = '';
  private last_cwd: string = '';

  async connect(cwd: string): Promise<void> {
    this.last_cwd = cwd;

    const codex_path = await resolveCodexPath();
    if (!codex_path) {
      throw new Error('Codex binary not found. Install from: https://github.com/openinterpreter/codex/releases');
    }

    console.log('[CodexConnection] Starting codex app-server at:', codex_path);
    console.log('[CodexConnection] Working directory:', cwd);

    this.process = spawn(codex_path, ['app-server'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data) => this.handle_data(data.toString()));
    this.process.stderr?.on('data', (data) => console.error('[codex stderr]', data.toString()));

    this.process.on('exit', (code) => {
      console.log('[CodexConnection] Process exited with code:', code);
      for (const [, { reject }] of this.pending_requests) {
        reject(new Error(`Codex process exited with code ${code}`));
      }
      this.pending_requests.clear();
      this.process = null;
      if (code !== 0 && code !== null) {
        broadcastEvent('codex:event', {
          method: 'error',
          params: { message: `Codex server exited with code ${code}`, retryable: true },
        });
      }
    });

    this.process.on('error', (err) => {
      console.error('[CodexConnection] Process error:', err);
      broadcastEvent('codex:event', {
        method: 'error',
        params: { message: `Codex server error: ${err.message}`, retryable: true },
      });
    });

    await this.send_request('initialize', {
      clientInfo: { name: 'interpreter', version: '1.0.0' },
      clientVersion: '1.0.0',
    });

    console.log('[CodexConnection] Connected successfully');
  }

  private handle_data(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);

        if ('id' in message && this.pending_requests.has(message.id)) {
          const { resolve, reject } = this.pending_requests.get(message.id)!;
          this.pending_requests.delete(message.id);
          if (message.error) {
            const errMsg = message.error.message || JSON.stringify(message.error);
            reject(new Error(`Codex error: ${errMsg}`));
          } else {
            resolve(message.result);
          }
        }
        else if ('method' in message) {
          console.log('[CodexConnection] Event:', message.method);
          broadcastEvent('codex:event', message);
        }
      } catch (e) {
        console.error('[CodexConnection] Parse error:', line, e);
      }
    }
  }

  async send_request(method: string, params: unknown, timeout = 60_000): Promise<unknown> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Codex not connected');
    }

    const id = this.request_id++;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.pending_requests.delete(id);
      };

      this.pending_requests.set(id, {
        resolve: (value: unknown) => { cleanup(); resolve(value); },
        reject: (err: unknown) => { cleanup(); reject(err); },
      });

      this.process?.stdin?.write(message + '\n');

      if (timeout > 0) {
        timer = setTimeout(() => {
          if (this.pending_requests.has(id)) {
            this.pending_requests.delete(id);
            reject(new Error(`Codex request '${method}' timed out after ${timeout}ms`));
          }
        }, timeout);
      }
    });
  }

  disconnect(): void {
    if (this.process) {
      console.log('[CodexConnection] Disconnecting...');
      this.process.kill();
      this.process = null;
    }
    for (const [id, { reject }] of this.pending_requests) {
      reject(new Error('Codex connection closed'));
    }
    this.pending_requests.clear();
  }

  isConnected(): boolean {
    return this.process !== null && !this.process.killed;
  }

  getLastCwd(): string {
    return this.last_cwd;
  }
}

let codex_connection: CodexConnection | null = null;

export function get_connection(): CodexConnection | null {
  return codex_connection;
}

export async function connect(cwd: string): Promise<void> {
  if (codex_connection?.isConnected()) {
    console.log('[codexServer] Already connected');
    return;
  }
  codex_connection = new CodexConnection();
  await codex_connection.connect(cwd);
}

export async function send_request(method: string, params: unknown): Promise<unknown> {
  if (!codex_connection || !codex_connection.isConnected()) {
    const { getCurrentWorkspace, requireExistingWorkspacePath } = await import('../utils/workspace');
    const workspace = requireExistingWorkspacePath(getCurrentWorkspace());
    await connect(workspace);
  }
  return codex_connection!.send_request(method, params);
}

export function save_thread(thread_id: string, items: unknown[]): void {
  fs.mkdirSync(CODEX_THREADS_DIR, { recursive: true });
  const file_path = path.join(CODEX_THREADS_DIR, `${thread_id}.json`);
  fs.writeFileSync(file_path, JSON.stringify(items, null, 2));
  console.log('[codexServer] Saved thread:', thread_id, 'with', items.length, 'items');
}

export function load_thread(thread_id: string): unknown[] | null {
  const file_path = path.join(CODEX_THREADS_DIR, `${thread_id}.json`);
  try {
    const content = fs.readFileSync(file_path, 'utf-8');
    const items = JSON.parse(content);
    console.log('[codexServer] Loaded thread:', thread_id, 'with', items.length, 'items');
    return items;
  } catch {
    console.log('[codexServer] Thread not found:', thread_id);
    return null;
  }
}

export function list_saved_threads(): { id: string; name: string; updated_at: number }[] {
  try {
    if (!fs.existsSync(CODEX_THREADS_DIR)) {
      return [];
    }

    const files = fs.readdirSync(CODEX_THREADS_DIR).filter(f => f.endsWith('.json'));
    const threads: { id: string; name: string; updated_at: number }[] = [];

    for (const file of files) {
      const file_path = path.join(CODEX_THREADS_DIR, file);
      try {
        const stat = fs.statSync(file_path);
        const id = file.replace('.json', '');

        let name = id;
        try {
          const content = fs.readFileSync(file_path, 'utf-8');
          const items = JSON.parse(content);
          const first_user = items.find((item: any) => item.role === 'user');
          if (first_user?.content) {
            const text = typeof first_user.content === 'string'
              ? first_user.content
              : Array.isArray(first_user.content)
                ? first_user.content.find((c: any) => c.type === 'input_text')?.text || ''
                : '';
            if (text) {
              name = text.slice(0, 80);
            }
          }
        } catch {
          // Fall back to thread ID as name
        }

        threads.push({ id, name, updated_at: stat.mtimeMs });
      } catch {
        // Skip files that can't be read
      }
    }

    threads.sort((a, b) => b.updated_at - a.updated_at);
    return threads;
  } catch {
    return [];
  }
}

export function disconnect(): void {
  if (codex_connection) {
    codex_connection.disconnect();
    codex_connection = null;
  }
}
*/

// Stub exports to prevent import errors if any code still references these
export function get_connection(): null { return null; }
export async function connect(_cwd: string): Promise<void> {
  throw new Error('Codex Server has been removed. Use Codex Terminal profile instead.');
}
export async function send_request(_method: string, _params: unknown): Promise<unknown> {
  throw new Error('Codex Server has been removed. Use Codex Terminal profile instead.');
}
export function save_thread(_thread_id: string, _items: unknown[]): void {
  throw new Error('Codex Server has been removed. Use Codex Terminal profile instead.');
}
export function load_thread(_thread_id: string): unknown[] | null {
  throw new Error('Codex Server has been removed. Use Codex Terminal profile instead.');
}
export function list_saved_threads(): { id: string; name: string; updated_at: number }[] {
  return [];
}
export function disconnect(): void {
  // No-op
}
