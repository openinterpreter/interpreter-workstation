import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, expect } from 'bun:test';

const SRC_DIR = join(import.meta.dir, '..');
const COMPONENTS_DIR = join(SRC_DIR, 'components');
const HOOKS_DIR = join(SRC_DIR, 'hooks');

function readSource(dir: string, file: string): string {
  return readFileSync(join(dir, file), 'utf-8');
}

// NOTE(victor): Source of truth is EditorArea.tsx's extension lists and viewer dispatch.
// The drift-detection tests below will fail if a viewer is added/removed from EditorArea
// without updating this map.
const VIEWER_FILES: Record<string, string> = {
  ImageViewer: 'ImageViewer.tsx',
  VideoViewer: 'VideoViewer.tsx',
  AudioViewer: 'AudioViewer.tsx',
  PDFViewer: 'PDFViewer.tsx',
  MarkdownViewer: 'MarkdownViewer.tsx',
  HtmlViewer: 'HtmlViewer.tsx',
  PlainTextViewer: 'PlainTextViewer.tsx',
  OfficeExtensionViewer: 'OfficeExtensionViewer.tsx',
  AutomationViewer: 'automation/AutomationViewer.tsx',
  RemotionViewer: 'RemotionViewer.tsx',
  MovieViewer: 'MovieViewer.tsx',
  CodeViewer: 'CodeViewer.tsx',
};

// NOTE(victor): useFileRefresh is the single viewer-side contract for reacting
// to both external disk edits and agent-driven FILE_REFRESHED events.
const FILESYSTEM_REFRESH = /workspace\.onFilesChanged|useFileRefresh/;
const AGENT_REFRESH = /files\.onRefreshed|useFileRefresh/;
const REFRESH_KEY_PROP = /refreshKey/;

// NOTE(victor): Viewers excluded from filesystem refresh with justification:
// - AutomationViewer: custom .automation format with its own readFile/writeFile API
const FILESYSTEM_REFRESH_EXCEPTIONS = new Set(['AutomationViewer']);
const AGENT_REFRESH_EXCEPTIONS = new Set(['AutomationViewer']);

describe('viewer refresh contracts', () => {
  describe('external filesystem changes', () => {
    for (const [name, file] of Object.entries(VIEWER_FILES)) {
      if (FILESYSTEM_REFRESH_EXCEPTIONS.has(name)) continue;
      test(`${name} subscribes to workspace.onFilesChanged`, () => {
        const source = readSource(COMPONENTS_DIR, file);
        expect(source).toMatch(FILESYSTEM_REFRESH);
      });
    }
  });

  describe('agent-driven changes', () => {
    for (const [name, file] of Object.entries(VIEWER_FILES)) {
      if (AGENT_REFRESH_EXCEPTIONS.has(name)) continue;
      test(`${name} subscribes to files.onRefreshed or accepts refreshKey`, () => {
        const source = readSource(COMPONENTS_DIR, file);
        expect(
          AGENT_REFRESH.test(source) || REFRESH_KEY_PROP.test(source)
        ).toBe(true);
      });
    }

    test('PDFViewer keeps form-fill animation wiring on agent updates', () => {
      const source = readSource(COMPONENTS_DIR, 'PDFViewer.tsx');
      expect(source).toContain('useFileRefresh(filePath');
      expect(source).toContain('onAgentRefresh: () =>');
      expect(source).toContain('scheduleFormFieldTyping(changedTextFields)');
      expect(source).toContain("overlay.className = 'pdf-typing-overlay'");
      expect(source).toContain("span.className = isComplete ? 'pdf-token' : 'pdf-token-leading'");
      expect(source).toContain("delSpan.className = 'pdf-token-deleted'");
    });

    test('HtmlViewer remounts preview but keeps source editor mounted across reloads', () => {
      const source = readSource(COMPONENTS_DIR, 'HtmlViewer.tsx');
      expect(source).toContain('const previewInstanceKey =');
      expect(source).toMatch(/<SandboxedHtmlFrame[\s\S]*key=\{previewInstanceKey\}/);
      expect(source).not.toMatch(/<TextEditor[\s\S]*key=\{/);
    });
  });

  describe('useLayoutIpcListeners refresh coverage', () => {
    test('files:refreshed handler does not skip any file extension', () => {
      const source = readSource(HOOKS_DIR, 'useLayoutIpcListeners.ts');
      const handlerBlock = source.match(/onRefreshed\([\s\S]*?refreshTab/);
      expect(handlerBlock).not.toBeNull();
      expect(handlerBlock![0]).not.toMatch(/\.endsWith\(/);
    });
  });

  describe('useLayoutIpcListeners quick action coverage', () => {
    test('subscribes to tabs.onNew for creating a new agent tab', () => {
      const source = readSource(HOOKS_DIR, 'useLayoutIpcListeners.ts');
      expect(source).toContain('tabsIpc.onNew(');
      expect(source).not.toContain('onNewAgent(');
    });

    test('does not subscribe to removed open-history shortcut', () => {
      const source = readSource(HOOKS_DIR, 'useLayoutIpcListeners.ts');
      expect(source).not.toContain('onOpenHistory(');
    });
  });

  describe('EditorArea viewer coverage', () => {
    test('every registered viewer appears in EditorArea.tsx', () => {
      const source = readSource(COMPONENTS_DIR, 'EditorArea.tsx');
      for (const name of Object.keys(VIEWER_FILES)) {
        expect(source).toContain(name);
      }
    });

    test('every viewer imported by EditorArea.tsx is registered in contracts', () => {
      const source = readSource(COMPONENTS_DIR, 'EditorArea.tsx');
      const imported = [...source.matchAll(/import\s+\{\s*(\w+Viewer)\s*\}\s+from/g)]
        .map(m => m[1]);
      for (const viewer of imported) {
        expect(VIEWER_FILES).toHaveProperty(viewer);
      }
    });

    test('tex extension is routed to CodeViewer', () => {
      const source = readSource(COMPONENTS_DIR, 'EditorArea.tsx');
      const codeExtensionsBlock = source.match(/const codeExtensions = \[([\s\S]*?)\];/);
      expect(codeExtensionsBlock).not.toBeNull();
      expect(codeExtensionsBlock![1]).toContain("'tex'");
    });

    test('movie extension is routed to MovieViewer', () => {
      const source = readSource(COMPONENTS_DIR, 'EditorArea.tsx');
      const movieExtensionsBlock = source.match(/const movieExtensions = \[([\s\S]*?)\];/);
      expect(movieExtensionsBlock).not.toBeNull();
      expect(movieExtensionsBlock![1]).toContain("'movie'");
      expect(source).toContain("type === 'movie'");
    });
  });
});
