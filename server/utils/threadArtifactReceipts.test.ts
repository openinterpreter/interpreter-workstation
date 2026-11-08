import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactReceiptError, ThreadArtifactReceipts } from './threadArtifactReceipts';

const thread = '12345678-1234-1234-1234-123456789abc';
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('exact-thread artifact receipts', () => {
  test('atomic claim across stores; same bytes dedupe, differing bytes conflict and restart readback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'artifact-'));
    try {
      const a = new ThreadArtifactReceipts(path.join(root, 'receipts'));
      const b = new ThreadArtifactReceipts(path.join(root, 'receipts'));
      const bytes = Buffer.from('private owned document');
      const outcomes = await Promise.all([a.create(thread, 'stable', bytes, digest(bytes)), b.create(thread, 'stable', bytes, digest(bytes))]);
      expect(outcomes.map(o => o.created).sort()).toEqual([false, true]);
      expect(await b.get(thread, 'stable')).toMatchObject({ sha256: digest(bytes), size: bytes.length });
      const different = Buffer.from('different document');
      await expect(a.create(thread, 'stable', different, digest(different))).rejects.toMatchObject({ code: 'conflict' });
      expect(await readFile(path.join(root, 'receipts', thread, 'stable'))).toEqual(bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('rejects traversal, oversize and false digest without a claim', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'artifact-'));
    try {
      const store = new ThreadArtifactReceipts(path.join(root, 'receipts'));
      const data = Buffer.from('a');
      for (const id of ['../elsewhere', '..', 'x/y']) {
        await expect(store.create(thread, id, data, digest(data))).rejects.toMatchObject({ code: 'invalid' });
      }
      await expect(store.create(thread, 'bad', data, '0'.repeat(64))).rejects.toMatchObject({ code: 'invalid' });
      await expect(store.create(thread, 'large', Buffer.alloc(1024 * 1024 + 1), digest(Buffer.alloc(1024 * 1024 + 1)))).rejects.toMatchObject({ code: 'invalid' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('a pre-existing symlink or incomplete receipt is never followed or overwritten', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'artifact-'));
    try {
      const receipts = path.join(root, 'receipts');
      await mkdir(path.join(receipts, thread), { recursive: true, mode: 0o700 });
      await writeFile(path.join(root, 'other'), 'untouched');
      await symlink(path.join(root, 'other'), path.join(receipts, thread, 'link'));
      const store = new ThreadArtifactReceipts(receipts);
      const data = Buffer.from('new');
      await expect(store.create(thread, 'link', data, digest(data))).rejects.toThrow();
      await writeFile(path.join(receipts, thread, 'partial'), 'part', { mode: 0o600 });
      await expect(store.create(thread, 'partial', data, digest(data))).rejects.toMatchObject({ code: 'conflict' });
      expect(await readFile(path.join(root, 'other'), 'utf8')).toBe('untouched');
      await expect(store.get(thread, 'link')).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
