import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getInterpreterAppDataDir } from '../configStore';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const MAX_THREAD_ARTIFACT_BYTES = 1024 * 1024;

export class ArtifactReceiptError extends Error {
  constructor(public readonly code: 'invalid' | 'conflict' | 'unavailable', message: string) {
    super(message);
  }
}

export class ThreadArtifactReceipts {
  constructor(private readonly root = path.join(getInterpreterAppDataDir(), 'thread-artifacts')) {}

  async create(threadId: string, receiptId: string, bytes: Buffer, expectedSha256: string) {
    if (!THREAD.test(threadId) || !ID.test(receiptId) || !/^[a-f0-9]{64}$/.test(expectedSha256) ||
        bytes.length === 0 || bytes.length > MAX_THREAD_ARTIFACT_BYTES) {
      throw new ArtifactReceiptError('invalid', 'Invalid thread artifact receipt request.');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== expectedSha256) {
      throw new ArtifactReceiptError('invalid', 'Artifact digest mismatch.');
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await root.stat();
      if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())) {
        throw new ArtifactReceiptError('unavailable', 'Artifact root is unavailable.');
      }
    } finally { await root.close(); }
    const dir = path.join(this.root, threadId);
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    // Never follow a substituted directory or widen permissions to accept it.
    const directory = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await directory.stat();
      if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())) {
        throw new ArtifactReceiptError('unavailable', 'Artifact directory is unavailable.');
      }
      const destination = path.join(dir, receiptId);
      const temporary = path.join(dir, `.${randomUUID()}.part`);
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      catch (error) { await file.close(); await unlink(temporary); throw error; }
      await file.close();
      let created = true;
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        created = false;
      }
      finally { await unlink(temporary); }
      // The data file was synced before the exclusive link. Sync the directory
      // before acknowledging a newly claimed ID so a crash cannot lose the
      // name while the caller believes the receipt is durable.
      if (created) await directory.sync();
      const saved = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await saved.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
            (process.getuid && stat.uid !== process.getuid()) || stat.size !== bytes.length ||
            createHash('sha256').update(await saved.readFile()).digest('hex') !== digest) {
          throw new ArtifactReceiptError('conflict', 'Artifact receipt ID is already claimed.');
        }
      } finally { await saved.close(); }
      return { threadId, receiptId, sha256: digest, size: bytes.length, created,
        path: destination };
    } finally { await directory.close(); }
  }

  async get(threadId: string, receiptId: string) {
    if (!THREAD.test(threadId) || !ID.test(receiptId)) {
      throw new ArtifactReceiptError('invalid', 'Invalid thread artifact receipt request.');
    }
    for (const directory of [this.root, path.join(this.root, threadId)]) {
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
            (process.getuid && stat.uid !== process.getuid())) {
          throw new ArtifactReceiptError('unavailable', 'Artifact directory unavailable.');
        }
      } finally { await handle.close(); }
    }
    const file = await open(path.join(this.root, threadId, receiptId), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid()) || stat.size > MAX_THREAD_ARTIFACT_BYTES) {
        throw new ArtifactReceiptError('unavailable', 'Artifact receipt unavailable.');
      }
      const bytes = await file.readFile();
      return { threadId, receiptId, sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length, path: path.join(this.root, threadId, receiptId) };
    } finally { await file.close(); }
  }
}

export const threadArtifactReceipts = new ThreadArtifactReceipts();
