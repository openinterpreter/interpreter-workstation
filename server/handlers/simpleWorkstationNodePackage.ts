/** Managed, server-only API seeded into each standalone Next.js project. The
 * same scoped caller binding is accepted by the existing interpreter-app CLI. */
export const WORKSTATION_NODE_PACKAGE_MANIFEST = `${JSON.stringify({
  name: '@interpreter/workstation',
  private: true,
  version: '0.0.0-workstation',
  type: 'module',
  exports: { '.': './index.mjs' },
}, null, 2)}\n`;

export const WORKSTATION_NODE_PACKAGE = `const serverId = 'builtin-interpreter';
const origin = process.env.INTERPRETER_CLI_SERVER_CONNECTION;
const token = process.env.INTERPRETER_CALLER_TOKEN;

function assertServer() {
  if (typeof window !== 'undefined') throw new Error('@interpreter/workstation is for Next.js server code only.');
  if (!origin || !token) throw new Error('Interpreter project capabilities are unavailable outside the running Workstation project.');
}

async function request(path, method = 'GET', body) {
  assertServer();
  const response = await fetch(new URL(path, origin), {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Interpreter-Caller-Token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'Interpreter capability failed.');
  return value;
}

function unwrap(result) {
  if (result?.isError || result?.is_error) {
    const message = result.content?.find((item) => typeof item.text === 'string')?.text;
    throw new Error(message || 'Interpreter tool failed.');
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find((item) => typeof item.text === 'string')?.text;
  if (typeof text !== 'string') return result;
  try { return JSON.parse(text); } catch { return text; }
}

export const tools = Object.freeze({
  list: () => request('/api/interpreter-cli/tools/' + serverId),
  call: async (name, args = {}) => {
    if (typeof name !== 'string' || !/^interpreter_[a-z0-9_]+$/.test(name)) throw new Error('Invalid Interpreter tool name.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
    return unwrap(await request('/api/interpreter-cli/tools/' + serverId + '/' + name, 'POST', args));
  },
});

export const computer = Object.freeze({
  state: (options = {}) => tools.call('interpreter_whole_computer_state_get', options),
});

export const browser = Object.freeze({
  activateTab: (tabRef) => tools.call('interpreter_browser_tab_activate', { tab_ref: tabRef }),
  inspect: (args) => tools.call('interpreter_browser_page_inspect', args),
  trace: (args) => tools.call('interpreter_browser_page_trace', args),
  click: (args) => tools.call('interpreter_browser_page_click', args),
  type: (args) => tools.call('interpreter_browser_page_type', args),
  select: (args) => tools.call('interpreter_browser_page_select', args),
  scroll: (args) => tools.call('interpreter_browser_page_scroll', args),
  captures: Object.freeze({
    list: async () => (await request('/api/simple-interface/app/tab-captures')).captures,
    answer: (captureId, answerSdp) => request('/api/simple-interface/app/tab-captures/' + encodeURIComponent(captureId) + '/answer', 'POST', { answerSdp }),
    stop: (captureId) => request('/api/simple-interface/app/tab-captures/' + encodeURIComponent(captureId) + '/stop', 'POST', {}),
  }),
});
`;
