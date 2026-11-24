import { beforeAll, afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { LowerLeftNoticeProvider } from '../../../src/contexts/LowerLeftNoticesContext';
import { ToastProvider } from '../../../src/contexts/ToastContext';
import { BrowserPiAppServerSession } from './piSession';
import { AppSimpleBrowserProject as SimpleBrowserProject } from '../../../src/browser-project/AppSimpleBrowserProject';
import { useBrowserProjectHost, type BrowserProjectHost } from '../../../src/browser-project/host';
import { MemoryProjectFiles } from '../../../src/browser-project/project';
import { projectFilesWorkspaceCapability } from '../../../src/browser-project/workspace';
import { AGENT_THREAD_ID, ONBOARDING_CONTINUE_BUTTON_ID } from '../../../shared/element-ids';
import { agentNotifications, getHostCapabilities } from '../../../src/ipc';
import { createDefaultOnboardingState } from '../../../shared/types/onboardingState';
import { DESKTOP_HOST_CAPABILITIES } from '../../../shared/types/hostCapabilities';
import type { BrowserProjectBackend } from '../../../src/browser-project/host';
import { BrowserLocalModelCatalog } from './modelCatalog';
import { BrowserModelCatalogAppServer } from './appServer';

beforeAll(() => {
  document.elementFromPoint = () => document.querySelector('[data-testid="main-composer-input"]');
  Range.prototype.getClientRects = () => ({ length: 1, item: () => new DOMRect(),
    [Symbol.iterator]: function* () { yield new DOMRect(); }, 0: new DOMRect() }) as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(getHostCapabilities()).toEqual(DESKTOP_HOST_CAPABILITIES);
  localStorage.clear();
});

test('fresh browser project mounts the real onboarding overlay before opening any session', async () => {
  localStorage.clear();
  const catalog = new BrowserLocalModelCatalog([
    { id: 'first', name: 'First model', assets: [{ path: 'weights', url: '/first',
      bytes: 1, sha256: '0'.repeat(64) }] },
    { id: 'second', name: 'Second model', assets: [{ path: 'weights', url: '/second',
      bytes: 1, sha256: '0'.repeat(64) }] },
  ], 'https://browser.test');
  const adapter = new BrowserModelCatalogAppServer(catalog, 'browser');
  const model = { id: 'second', name: 'Second model', provider: 'browser', api: 'browser-local',
    baseUrl: '', input: ['text' as const], cost: { input: 0, output: 0,
      cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 4096, maxTokens: 256 };
  const session = new BrowserPiAppServerSession({ projectId: 'fresh_project',
    threadId: 'fresh_thread', model, tools: [], systemPrompt: '',
    streamFn: () => createAssistantMessageEventStream() });
  const openSession = vi.fn(async (modelId: string) => {
    if (modelId !== 'second') throw new Error('Unexpected selected model');
    return { projectId: 'fresh_project', threadId: 'fresh_thread',
      model: { id: 'second', name: 'Second model' }, appServer: session.appServer,
      stream: session.stream.bind(session), dispose: () => session.dispose() };
  });
  const progress = vi.fn();
  let finishDownload: (() => void) | undefined;
  const downloadModel: BrowserProjectBackend['downloadModel'] = async (_providerId, modelId, onProgress) => {
    progress(modelId);
    onProgress({ total: 100, completed: 50, status: 'Downloading' });
    await new Promise<void>(resolve => { finishDownload = () => {
      onProgress({ total: 100, completed: 100, done: true }); resolve();
    }; });
  };
  const backend: BrowserProjectBackend = { projectId: 'fresh_project',
    request: adapter.request.bind(adapter), downloadModel, openSession };
  const files = projectFilesWorkspaceCapability('fresh_project', new MemoryProjectFiles());
  const first = render(<LowerLeftNoticeProvider><ToastProvider>
    <SimpleBrowserProject backend={backend} projectFiles={files} canvas={<div>Canvas</div>}
      onOpenSettings={() => {}} onCloseSettings={() => {}} onLeaveFeedback={() => {}} />
  </ToastProvider></LowerLeftNoticeProvider>);
  await screen.findByText('Welcome to Interpreter');
  expect(screen.queryByText('Canvas')).toBeNull();
  expect(openSession).not.toHaveBeenCalled();
  expect(screen.queryByTestId('main-composer-input')).toBeNull();
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('Enter your name'), 'Browser user');
  await user.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByText('Privacy');
  fireEvent.click(screen.getByText('Keep everything private'));
  await screen.findByText('Local browser models');
  expect(screen.queryByText('ChatGPT')).toBeNull();
  expect(screen.queryByText('Interpreter')).toBeNull();
  expect(screen.queryByText('Custom model')).toBeNull();
  expect(screen.queryByText('OpenAI')).toBeNull();
  expect(screen.queryByText('Anthropic')).toBeNull();
  expect(screen.queryByText('Ollama')).toBeNull();
  expect(screen.queryByText('LM Studio')).toBeNull();
  await user.click(screen.getByText('Local browser models'));
  await screen.findByText('First model');
  await screen.findByText('Second model');
  await user.click(screen.getByText('First model'));
  await user.click(screen.getByText('Second model'));
  await user.click(screen.getByTestId(ONBOARDING_CONTINUE_BUTTON_ID));
  await waitFor(() => expect(progress).toHaveBeenCalledWith('second'));
  await screen.findByText('Downloading 50%');
  finishDownload?.();
  await waitFor(() => expect(openSession).toHaveBeenCalledWith('second'));
  await screen.findByTestId('main-composer-input');
  expect(JSON.parse(localStorage.getItem(
    'workstation:browser-project:browser-fresh_project:defaultProfileId') || 'null'))
    .toContain('second');
  first.unmount();
  render(<LowerLeftNoticeProvider><ToastProvider>
    <SimpleBrowserProject backend={backend} projectFiles={files} canvas={<div>Canvas</div>}
      onOpenSettings={() => {}} onCloseSettings={() => {}} onLeaveFeedback={() => {}} />
  </ToastProvider></LowerLeftNoticeProvider>);
  await waitFor(() => expect(openSession).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Welcome to Interpreter')).toBeNull();
  const { resetOnboardingState } = await import('../../../src/api');
  await resetOnboardingState();
  window.dispatchEvent(new Event('settings:restart-onboarding'));
  await screen.findByText('Welcome to Interpreter');
  expect(screen.queryByTestId('main-composer-input')).toBeNull();
});

test.each([
  { label: 'profile storage', key: ':profiles', error: 'Profile storage blocked' },
  { label: 'onboarding completion', key: ':onboardingState', error: 'Onboarding completion blocked' },
])('real browser model review displays $label failure without opening a session', async ({ key, error }) => {
  localStorage.clear();
  localStorage.setItem('workstation:browser-project:origin:onboardingState',
    JSON.stringify({ ...createDefaultOnboardingState(), completedStepIds: ['name', 'privacy'] }));
  const catalog = new BrowserLocalModelCatalog([
    { id: 'first', name: 'First model', assets: [{ path: 'weights', url: '/first',
      bytes: 1, sha256: '0'.repeat(64) }] },
    { id: 'second', name: 'Second model', assets: [{ path: 'weights', url: '/second',
      bytes: 1, sha256: '0'.repeat(64) }] },
  ], 'https://browser.test');
  const adapter = new BrowserModelCatalogAppServer(catalog, 'browser');
  const openSession = vi.fn();
  const downloadModel = vi.fn(async (_provider: string, _model: string,
    onProgress: (value: { done: boolean }) => void) => onProgress({ done: true }));
  const backend = { projectId: 'blocked_project', request: adapter.request.bind(adapter),
    openSession, downloadModel } as BrowserProjectBackend;
  const files = projectFilesWorkspaceCapability('blocked_project', new MemoryProjectFiles());
  const originalSet = Storage.prototype.setItem;
  const storageSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (name, value) {
    if (name.endsWith(key) && (key !== ':onboardingState' || JSON.parse(value).completed))
      throw new Error(error);
    return originalSet.call(this, name, value);
  });
  try {
    render(<LowerLeftNoticeProvider><ToastProvider>
      <SimpleBrowserProject backend={backend} projectFiles={files} canvas={<div>Canvas</div>}
        onOpenSettings={() => {}} onCloseSettings={() => {}} onLeaveFeedback={() => {}} />
    </ToastProvider></LowerLeftNoticeProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByText('Local browser models'));
    await screen.findByText('Second model');
    await user.click(screen.getByTestId(ONBOARDING_CONTINUE_BUTTON_ID));
    await waitFor(() => expect(downloadModel).toHaveBeenCalledOnce());
    await screen.findByText(error);
    expect(openSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('main-composer-input')).toBeNull();
  } finally { storageSpy.mockRestore(); }
});

function readyBackend(session: BrowserPiAppServerSession): BrowserProjectBackend {
  localStorage.setItem('workstation:browser-project:origin:onboardingState',
    JSON.stringify({ ...createDefaultOnboardingState(), completed: true }));
  const profile = { id: `selected-${session.projectId}`, name: session.model.name,
    provider: 'local', modelId: session.model.id, isBuiltin: false };
  localStorage.setItem(`workstation:browser-project:browser-${session.projectId}:profiles`,
    JSON.stringify([profile]));
  localStorage.setItem(`workstation:browser-project:browser-${session.projectId}:defaultProfileId`,
    JSON.stringify(profile.id));
  return { projectId: session.projectId,
    request: session.appServer.request.bind(session.appServer),
    downloadModel: async () => {},
    openSession: async modelId => {
      if (modelId !== session.model.id) throw new Error('Unexpected test model');
      return { projectId: session.projectId, threadId: session.threadId,
        model: { id: session.model.id, name: session.model.name },
        appServer: session.appServer, stream: session.stream.bind(session),
        dispose: () => session.dispose() };
    } };
}

test('real SimpleShell, AgentThread, ComposerArea and useChat render a Pi browser-local reply', async () => {
  const model = { id: 'local-pi-test', name: 'Local Pi Test', api: 'browser-local', provider: 'browser',
    baseUrl: '', input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 4096, maxTokens: 256 };
  const session = new BrowserPiAppServerSession({ projectId: 'project_simple', threadId: 'thread_simple',
    model, systemPrompt: '', tools: [], streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Genuine Pi reply' }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: 'stop' as const, usage: { input: 1, output: 1, cacheRead: 0,
          cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0,
            cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); });
      return stream;
    } });
  const files = projectFilesWorkspaceCapability('project_simple', new MemoryProjectFiles());
  render(<LowerLeftNoticeProvider><ToastProvider>
    <SimpleBrowserProject backend={readyBackend(session)} projectFiles={files} canvas={<div>Canvas</div>}
      onOpenSettings={() => {}} onCloseSettings={() => {}} onLeaveFeedback={() => {}} />
  </ToastProvider></LowerLeftNoticeProvider>);
  const editor = await screen.findByTestId('main-composer-input');
  await userEvent.setup().type(editor, 'Hello{Enter}');
  await waitFor(() => expect(screen.getByText('Genuine Pi reply')).toBeInTheDocument());
  expect(session.agent.state.messages.some(message => message.role === 'user')).toBe(true);
});

test('re-rendering the real Simple canvas retains the same project/thread host binding', async () => {
  const model = { id: 'local-pi-stable', name: 'Local Pi Stable', api: 'browser-local', provider: 'browser',
    baseUrl: '', input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 4096, maxTokens: 256 };
  const session = new BrowserPiAppServerSession({ projectId: 'project_stable', threadId: 'thread_stable',
    model, systemPrompt: '', tools: [], streamFn: () => createAssistantMessageEventStream() });
  const files = projectFilesWorkspaceCapability('project_stable', new MemoryProjectFiles());
  const observed: BrowserProjectHost[] = [];
  function Canvas({ label }: { label: string }) {
    const host = useBrowserProjectHost();
    if (host) observed.push(host);
    return <div>{label}</div>;
  }
  const props = { backend: readyBackend(session), projectFiles: files, onOpenSettings: () => {},
    onCloseSettings: () => {}, onLeaveFeedback: () => {} };
  const view = render(<LowerLeftNoticeProvider><ToastProvider>
    <SimpleBrowserProject {...props} canvas={<Canvas label="First canvas" />} />
  </ToastProvider></LowerLeftNoticeProvider>);
  await screen.findByText('First canvas');
  const original = observed[observed.length - 1];
  expect(original?.session.appServer).toBe(session.appServer);
  view.rerender(<LowerLeftNoticeProvider><ToastProvider>
    <SimpleBrowserProject {...props} canvas={<Canvas label="Second canvas" />} />
  </ToastProvider></LowerLeftNoticeProvider>);
  await screen.findByText('Second canvas');
  expect(observed[observed.length - 1]).toBe(original);
  expect(observed[observed.length - 1]?.workspacePath).toBe('browser-project:project_stable');
  // The project host must not permanently disable ordinary browser SSE after
  // navigating away from its actual Simple surface.
  view.unmount();
  await waitFor(() => expect(getHostCapabilities()).toEqual(DESKTOP_HOST_CAPABILITIES));
  const sources = vi.fn(function EventSourceStub() {
    return { close: vi.fn() };
  });
  vi.stubGlobal('EventSource', sources);
  const unsubscribe = agentNotifications.onNotification(() => {});
  await waitFor(() => expect(sources).toHaveBeenCalledOnce());
  unsubscribe();
  vi.unstubAllGlobals();
});

test('actual Simple UI keeps two Pi model-selected tool turns and their grounded replies in one thread', async () => {
  const model = { id: 'local-pi-tools', name: 'Local Pi Tools', api: 'browser-local', provider: 'browser',
    baseUrl: '', input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 4096, maxTokens: 256 };
  const values: number[] = [];
  let sequence = 0;
  const session = new BrowserPiAppServerSession({ projectId: 'project_tool_ui', threadId: 'thread_tool_ui',
    model, systemPrompt: 'Use the registered measure tool.',
    tools: [{ name: 'measure', label: 'Measure', description: 'Measure numeric value',
      parameters: { type: 'object', properties: { value: { type: 'number' } },
        required: ['value'], additionalProperties: false },
      execute: async (_id, args: { value: number }) => {
        values.push(args.value);
        return { content: [{ type: 'text', text: `value=${args.value * 2}` }], details: null };
      } }],
    streamFn: (_model, context) => {
      const stream = createAssistantMessageEventStream();
      const distinct = JSON.stringify([...context.messages].reverse().find(item => item.role === 'user'))
        .toLowerCase().includes('different');
      const value = distinct ? 4 : 0;
      const toolResult = context.messages[context.messages.length - 1]?.role === 'toolResult';
      const message = { role: 'assistant' as const,
        content: toolResult ? [{ type: 'text' as const, text: `Grounded result ${value * 2}` }] :
          [{ type: 'toolCall' as const, id: `tool-${++sequence}`, name: 'measure', arguments: { value } }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: toolResult ? 'stop' as const : 'toolUse' as const,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message }); });
      return stream;
    } });
  const files = projectFilesWorkspaceCapability('project_tool_ui', new MemoryProjectFiles());
  render(<LowerLeftNoticeProvider><ToastProvider>
    <SimpleBrowserProject backend={readyBackend(session)} projectFiles={files} canvas={<div>Canvas</div>}
      onOpenSettings={() => {}} onCloseSettings={() => {}} onLeaveFeedback={() => {}} />
  </ToastProvider></LowerLeftNoticeProvider>);
  const editor = await screen.findByTestId('main-composer-input');
  await userEvent.setup().type(editor, 'Baseline{Enter}');
  await waitFor(() => expect(screen.getByText('Grounded result 0')).toBeInTheDocument());
  await userEvent.setup().type(editor, 'Different experiment{Enter}');
  await waitFor(() => expect(screen.getByText('Grounded result 8')).toBeInTheDocument());
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open drawer' }));
  await waitFor(() => expect(screen.getByTestId(AGENT_THREAD_ID('simple-primary-agent')))
    .toHaveAttribute('data-active', 'true'));
  expect(values).toEqual([0, 4]);
  expect(session.agent.state.messages.filter(item => item.role === 'toolResult')).toHaveLength(2);
  expect(session.agent.state.messages.filter(item => item.role === 'user')).toHaveLength(2);
});
