import { describe, expect, it } from 'vitest';
import { applyApprovedEdit, exportProject, MemoryProjectFiles, projectFileName } from './project';
import { previewDocument, updatePreview } from './preview';

describe('visitor-local project boundary', () => {
  it('rejects traversal and hidden control files', () => {
    for (const name of ['../key', '/secret', '.env', 'src/../key', 'src//key', 'src/./key']) {
      expect(() => projectFileName(name)).toThrow();
    }
  });
  it('requires approval and exact revision for every write', async () => {
    const files = new MemoryProjectFiles();
    await expect(applyApprovedEdit(files, { name: 'index.html', content: 'a', expectedRevision: null, approved: false })).rejects.toThrow();
    const revision = await applyApprovedEdit(files, { name: 'index.html', content: 'a', expectedRevision: null, approved: true });
    await expect(files.write('index.html', 'b', null)).rejects.toThrow('changed');
    expect(await files.write('index.html', 'b', revision)).not.toBe(revision);
    expect((await files.read('index.html'))?.content).toBe('b');
    expect(JSON.parse(await exportProject(files))).toEqual({ format: 'interpreter-browser-project', version: 1, files: { 'index.html': 'b' } });
  });
  it('isolates preview origin and network', () => {
    const frame = document.createElement('iframe');
    updatePreview(frame, '<h1>Live</h1>', 'body { color: teal }');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.srcdoc).toContain("connect-src 'none'");
    expect(frame.srcdoc).toContain('<h1>Live</h1>');
    expect(previewDocument('', '')).toContain("default-src 'none'");
  });
});
