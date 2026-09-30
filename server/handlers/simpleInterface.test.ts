import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

let workspace = '';
mock.module('../simpleWorkspace', () => ({
  getSimpleWorkspacePath: async () => workspace,
  assertSimpleWorkspaceChildPath: (root: string, candidate: string) => {
    if (relative(root, candidate).startsWith('..' + sep) || relative(root, candidate) === '..') throw new Error('outside workspace');
    return candidate;
  },
}));

const {
  validateSimplePage,
  promoteSimpleInterfaceCandidate,
  readSimpleInterface,
  recordSimpleInterfaceAction,
  recordSimpleInterfaceDelivery,
  saveSimpleInterfaceInput,
  readSimpleInterfaceAsset,
} = await import('./simpleInterface');

beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), 'simple-interface-')); });
afterEach(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });

const page = {
  version: 1, title: 'Generated dashboard', blocks: [
    { type: 'heading', id: 'title', text: 'This is {{data.answer}}' },
    { type: 'button', id: 'choose', label: 'Choose', message: 'Choose option A' },
    { type: 'input', id: 'question', label: 'Question', message: 'Answer: {{value}}' },
  ],
};

describe('inert generated interface contract', () => {
  test('rejects executable/unknown properties, external assets, duplicate IDs and missing input substitution', () => {
    expect(() => validateSimplePage({ ...page, script: 'alert(1)' })).toThrow('Unsupported property');
    expect(() => validateSimplePage({ ...page, blocks: [{ ...page.blocks[0], dangerouslySetInnerHTML: { __html: '<script>' } }] })).toThrow('Unsupported property');
    expect(() => validateSimplePage({ ...page, blocks: [{ type: 'image', id: 'remote', asset: 'https://example.com/x.png', alt: '' }] })).toThrow('asset');
    expect(() => validateSimplePage({ ...page, blocks: [page.blocks[1], page.blocks[1]] })).toThrow('unique');
    expect(() => validateSimplePage({ ...page, blocks: [{ ...page.blocks[2], message: 'Value missing' }] })).toThrow('{{value}}');
  });

  test('automatically promotes accepted page, retains last-good on invalid edit, and recovers', async () => {
    const first = await promoteSimpleInterfaceCandidate();
    expect(first.page.title).toBe('Interpreter');
    const directory = join(workspace, 'interface');
    await writeFile(join(directory, 'page.json'), JSON.stringify(page));
    const accepted = await promoteSimpleInterfaceCandidate();
    expect(accepted.page.title).toBe('Generated dashboard');
    expect(await readSimpleInterface()).toMatchObject({ revision: accepted.revision, page: { title: 'Generated dashboard' } });

    await writeFile(join(directory, 'page.json'), '{ invalid');
    const broken = await promoteSimpleInterfaceCandidate();
    expect(broken.revision).toBe(accepted.revision);
    expect(broken.diagnostic).toContain('Invalid interface/page.json');
    expect(JSON.parse(await readFile(join(directory, 'diagnostics.json'), 'utf8')).error).toContain('Invalid interface/page.json');

    await writeFile(join(directory, 'page.json'), JSON.stringify({ ...page, title: 'Repaired' }));
    expect((await promoteSimpleInterfaceCandidate()).page.title).toBe('Repaired');
    expect((await readSimpleInterface()).diagnostic).toBeNull();
  });

  test('disk-backed data and input state survive refresh; action messages derive only from validated accepted page', async () => {
    await promoteSimpleInterfaceCandidate();
    const directory = join(workspace, 'interface');
    await writeFile(join(directory, 'page.json'), JSON.stringify(page));
    await writeFile(join(directory, 'data.json'), JSON.stringify({ answer: '42' }));
    const accepted = await promoteSimpleInterfaceCandidate();
    expect(accepted.data.answer).toBe('42');
    await writeFile(join(directory, 'data.json'), '{ invalid');
    const invalidData = await promoteSimpleInterfaceCandidate();
    expect(invalidData.data.answer).toBe('42');
    expect(invalidData.diagnostic).toContain('Invalid interface/data.json');
    await writeFile(join(directory, 'data.json'), JSON.stringify({ answer: '43' }));
    expect((await promoteSimpleInterfaceCandidate()).data.answer).toBe('43');
    await saveSimpleInterfaceInput({ id: 'question', revision: accepted.revision, value: 'Persist me' });
    expect((await readSimpleInterface()).inputs.question).toBe('Persist me');
    const event = await recordSimpleInterfaceAction({ actionId: 'question', revision: accepted.revision, value: 'Persist me' });
    expect(event).toMatchObject({ message: 'Answer: Persist me', actionId: 'question', status: 'pending' });
    await recordSimpleInterfaceDelivery({ id: event.id, status: 'dispatched' });
    expect(JSON.parse((await readFile(join(directory, 'events.jsonl'), 'utf8')).trim()).message).toBe('Answer: Persist me');
    expect(JSON.parse((await readFile(join(directory, 'deliveries.jsonl'), 'utf8')).trim()).status).toBe('dispatched');
    await expect(recordSimpleInterfaceAction({ actionId: 'title', revision: accepted.revision })).rejects.toThrow('not present');
    await expect(recordSimpleInterfaceAction({ actionId: 'choose', revision: 'stale' })).rejects.toThrow('outdated');
  });

  test('symlinked candidate and asset are rejected; generated page remains inert', async () => {
    await promoteSimpleInterfaceCandidate();
    const outside = join(workspace, 'outside.txt');
    await writeFile(outside, JSON.stringify(page));
    const directory = join(workspace, 'interface');
    await rm(join(directory, 'page.json'));
    await symlink(outside, join(directory, 'page.json'));
    await expect(promoteSimpleInterfaceCandidate()).rejects.toThrow('Symlink');
    await mkdir(join(directory, 'assets'));
    await symlink(outside, join(directory, 'assets', 'escape.png'));
    await expect(readSimpleInterfaceAsset('escape.png')).rejects.toThrow('Symlink');
    await expect(readSimpleInterfaceAsset('../outside.txt')).rejects.toThrow('Invalid asset name');
  });
});
