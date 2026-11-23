import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createRef } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposerArea } from '../../../agent/components/ComposerArea';
import type { BaseTiptapComposerRef } from '../../../agent/components/composer/BaseTiptapComposer';
import { LowerLeftNoticeProvider } from '../../../src/contexts/LowerLeftNoticesContext';
import { ToastProvider } from '../../../src/contexts/ToastContext';
import { BrowserPiAppServerSession } from './piSession';
import { BrowserProjectHostProvider, createBrowserProjectHost } from '../../../src/browser-project/host';
import { MemoryProjectFiles } from '../../../src/browser-project/project';
import { projectFilesWorkspaceCapability } from '../../../src/browser-project/workspace';

const nativeIsDirectory = vi.hoisted(() => vi.fn());
beforeAll(() => {
  // ProseMirror's pointer/caret geometry needs browser methods absent from jsdom.
  document.elementFromPoint = () => document.querySelector('[data-testid="main-composer-input"]');
  Range.prototype.getClientRects = () => ({ length: 1, item: () => new DOMRect(),
    [Symbol.iterator]: function* () { yield new DOMRect(); }, 0: new DOMRect() }) as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
vi.mock('../../../src/ipc', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/ipc')>();
  return { ...original, files: { ...original.files, isDirectory: nativeIsDirectory } };
});
afterEach(cleanup);

test('real ComposerArea sends browser-project text through ProjectFiles without native directory IPC', async () => {
  const session = new BrowserPiAppServerSession({ projectId: 'project_a', threadId: 'thread_a',
    model: { id: 'local', name: 'local', api: 'browser-local', provider: 'browser', baseUrl: '',
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false, contextWindow: 1024, maxTokens: 128 },
    streamFn: () => { throw new Error('Model not requested by composer-only test'); },
    tools: [], systemPrompt: '',
  });
  const host = createBrowserProjectHost(session,
    projectFilesWorkspaceCapability('project_a', new MemoryProjectFiles()));
  const onAgentSend = vi.fn();
  const composer = createRef<BaseTiptapComposerRef>();
  render(<LowerLeftNoticeProvider><ToastProvider><BrowserProjectHostProvider host={host}>
    <ComposerArea ref={composer} isTerminal={false} agentId="simple-primary-agent"
      messageCount={0} workspacePath={host.workspacePath} onAgentSend={onAgentSend} />
  </BrowserProjectHostProvider></ToastProvider></LowerLeftNoticeProvider>);
  await waitFor(() => expect(composer.current).not.toBeNull());
  await userEvent.setup().type(screen.getByTestId('main-composer-input'), 'Compute 2{Enter}');
  await waitFor(() => expect(onAgentSend).toHaveBeenCalled());
  expect(onAgentSend.mock.calls[0]?.[1]?.workspacePath).toBe(host.workspacePath);
  expect(nativeIsDirectory).not.toHaveBeenCalled();
});
