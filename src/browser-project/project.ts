/** Visitor-owned project files. No server, model credential, or native host is involved. */
export const MAX_PROJECT_FILE_BYTES = 256 * 1024;
export const MAX_PROJECT_FILES = 64;
const encoder = new TextEncoder();

export function projectFileName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..') ||
      name.startsWith('.')) throw new Error('Invalid project file path');
  return name;
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface ProjectFiles {
  list(): Promise<string[]>;
  read(name: string): Promise<{ content: string; revision: string } | null>;
  write(name: string, content: string, expectedRevision: string | null): Promise<string>;
}

/** Portable, bounded user export; browser storage itself is not a durable backup. */
export async function exportProject(files: ProjectFiles): Promise<string> {
  const entries: Record<string, string> = {};
  for (const name of await files.list()) {
    const file = await files.read(name);
    if (file) entries[name] = file.content;
  }
  return JSON.stringify({ format: 'interpreter-browser-project', version: 1, files: entries });
}

export class MemoryProjectFiles implements ProjectFiles {
  private files = new Map<string, string>();
  async list(): Promise<string[]> { return [...this.files.keys()].sort(); }
  async read(name: string) {
    const content = this.files.get(projectFileName(name));
    return content === undefined ? null : { content, revision: await digest(content) };
  }
  async write(name: string, content: string, expectedRevision: string | null): Promise<string> {
    name = projectFileName(name);
    if (encoder.encode(content).byteLength > MAX_PROJECT_FILE_BYTES) throw new Error('Project file too large');
    const previous = await this.read(name);
    if ((previous?.revision ?? null) !== expectedRevision) throw new Error('Project file changed; reload before writing');
    if (!previous && this.files.size >= MAX_PROJECT_FILES) throw new Error('Project file limit reached');
    this.files.set(name, content);
    return digest(content);
  }
}

/** OPFS is origin-private and subject to browser eviction; users must export important work. */
export class OpfsProjectFiles implements ProjectFiles {
  private constructor(private readonly directory: FileSystemDirectoryHandle) {}
  static async open(projectId: string): Promise<OpfsProjectFiles> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) throw new Error('Invalid project ID');
    if (!navigator.storage?.getDirectory) throw new Error('Origin-private storage is unavailable');
    const root = await navigator.storage.getDirectory();
    const projects = await root.getDirectoryHandle('interpreter-projects', { create: true });
    return new OpfsProjectFiles(await projects.getDirectoryHandle(projectId, { create: true }));
  }
  private async handle(name: string, create = false) {
    const parts = projectFileName(name).split('/');
    let directory = this.directory;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
    return directory.getFileHandle(parts[parts.length - 1]!, { create });
  }
  async list(): Promise<string[]> {
    const found: string[] = [];
    async function visit(directory: FileSystemDirectoryHandle, prefix = ''): Promise<void> {
      for await (const [name, handle] of directory as FileSystemDirectoryHandle & AsyncIterable<[string, FileSystemHandle]>) {
        if (handle.kind === 'directory') await visit(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
        else found.push(projectFileName(`${prefix}${name}`));
        if (found.length > MAX_PROJECT_FILES) throw new Error('Project file limit exceeded');
      }
    }
    await visit(this.directory);
    return found.sort();
  }
  async read(name: string) {
    try {
      const file = await (await this.handle(name)).getFile();
      if (file.size > MAX_PROJECT_FILE_BYTES) throw new Error('Project file too large');
      const content = await file.text();
      return { content, revision: await digest(content) };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }
  async write(name: string, content: string, expectedRevision: string | null): Promise<string> {
    projectFileName(name);
    if (encoder.encode(content).byteLength > MAX_PROJECT_FILE_BYTES) throw new Error('Project file too large');
    const previous = await this.read(name);
    if ((previous?.revision ?? null) !== expectedRevision) throw new Error('Project file changed; reload before writing');
    if (!previous && (await this.list()).length >= MAX_PROJECT_FILES) throw new Error('Project file limit reached');
    const writable = await (await this.handle(name, true)).createWritable();
    try { await writable.write(content); await writable.close(); }
    catch (error) { await writable.abort().catch(() => {}); throw error; }
    return digest(content);
  }
}

export async function applyApprovedEdit(files: ProjectFiles, edit: {
  name: string; content: string; expectedRevision: string | null; approved: boolean;
}): Promise<string> {
  if (edit.approved !== true) throw new Error('Explicit approval required');
  return files.write(edit.name, edit.content, edit.expectedRevision);
}
