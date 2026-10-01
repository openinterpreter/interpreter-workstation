import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let selected = '';
mock.module('./configStore', () => ({
  getSimpleProjectSetting: async () => selected,
  setSimpleProjectSetting: async (path: string) => { selected = path; },
}));
mock.module('./simpleWorkspace', () => ({
  getSimpleWorkspacePath: async () => join(tmpdir(), 'separate-control-workspace'),
  validateSimpleWorkspacePath: (path: string) => path,
}));
mock.module('./handlers/broadcast', () => ({ broadcastEvent: mock(() => {}) }));

import { checkedProjectPath, getSimpleProjectPath, readSimpleProject, recordProjectAction, recordProjectDelivery, validateSimpleProjectPath } from './simpleProject';

beforeEach(async () => { selected = await mkdtemp(join(tmpdir(), 'simple-react-project-')); });
afterEach(async () => { await rm(selected, { recursive: true, force: true }); });

describe('standalone executable React project', () => {
  test('creates a project separate from the control workspace with explicit guidance', async () => {
    const root = await getSimpleProjectPath();
    expect(root).toBe(selected);
    expect(await readFile(join(root, 'src/main.tsx'), 'utf8')).toContain("from 'react'");
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('same durable primary conversation');
    expect(() => validateSimpleProjectPath(join(tmpdir(), 'separate-control-workspace'), join(tmpdir(), 'separate-control-workspace'))).toThrow();
    expect(() => checkedProjectPath(root, '../escape')).toThrow();
  });

  test('builds React, keeps last-good on a broken edit, and recovers', async () => {
    const initial = await readSimpleProject();
    expect(initial.diagnostic).toBeNull();
    expect(initial.bundle).toContain('What would you like to make?');
    const path = join(selected, 'src/main.tsx');
    await writeFile(path, "import secret from 'node:fs'; document.body.textContent = secret");
    const broken = await readSimpleProject();
    expect(broken.revision).toBe(initial.revision);
    expect(broken.diagnostic).toContain('Only bundled React');
    expect(JSON.parse(await readFile(join(selected, '.interpreter/diagnostics.json'), 'utf8')).error).toBeTruthy();
    await writeFile(path, "import React from 'react'; import { createRoot } from 'react-dom/client'; createRoot(document.getElementById('root')!).render(<h1>Recovered</h1>);");
    const recovered = await readSimpleProject();
    expect(recovered.bundle).toContain('Recovered');
    expect(recovered.revision).not.toBe(initial.revision);
    expect(recovered.diagnostic).toBeNull();
  });

  test('rejects symlink imports and accepts only current-revision action and delivery', async () => {
    const initial = await readSimpleProject();
    const outside = join(tmpdir(), `simple-outside-${Date.now()}.tsx`);
    await writeFile(outside, 'export default 1');
    try {
      await symlink(outside, join(selected, 'src/escape.tsx'));
      expect(() => checkedProjectPath(selected, 'src/escape.tsx')).toThrow('symlinks');
      await expect(recordProjectAction({ revision: 'outdated', message: 'no' })).rejects.toThrow('outdated');
      const action = await recordProjectAction({ revision: initial.revision, message: 'one primary agent' });
      await recordProjectDelivery(action.id, 'dispatched');
      expect(await readFile(join(selected, '.interpreter/events.jsonl'), 'utf8')).toContain('one primary agent');
      expect(await readFile(join(selected, '.interpreter/deliveries.jsonl'), 'utf8')).toContain('dispatched');
    } finally { await rm(outside, { force: true }); }
  });

  test('bundles versioned app-owned viewers, state hooks, motion and the durable agent bridge', async () => {
    await getSimpleProjectPath();
    await writeFile(join(selected, 'src/main.tsx'), `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { FileView, FolderView, EditorView, Motion, runAgent, useState } from '@interpreter/simple-runtime/v1';
      function Interface() { const [value, setValue] = useState('Note');
        return <Motion><FolderView name="Files"><FileView name="notes.md" onOpen={() => runAgent('Open notes')} />
          <EditorView value={value} onChange={setValue} /></FolderView></Motion>; }
      createRoot(document.getElementById('root')!).render(<Interface />);`);
    const result = await readSimpleProject();
    expect(result.diagnostic).toBeNull();
    expect(result.bundle).toContain('interpreter-file');
    expect(result.bundle).toContain('interpreter-editor');
    expect(result.bundle).toContain('interpreter-simple-action');
  });
});
