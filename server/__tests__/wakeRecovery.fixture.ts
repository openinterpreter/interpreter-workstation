// Isolated fixture around the actual standalone/headless server listener.
// The fixture endpoint invokes the production own-thread tool handler; it is
// never imported by production startup and never touches a real native thread.
import { mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WakeSources, type WakeNative } from '../utils/wakeSources';

const home = process.env.HOME!;
const receiptFile = process.env.WAKE_FIXTURE_RECEIPT!;
let starts = 0;
const native: WakeNative = {
  inspect: async () => ({ messages: [], clientIds: JSON.parse(readFileSync(receiptFile, 'utf8')) }),
  start: async () => { starts++; throw Error('fixture forbids native replay'); },
  steer: async () => { throw Error('fixture forbids steer'); },
};
const wakeSources = new WakeSources(native, home);
let initialization: Promise<void> | undefined;
mock.module('../utils/wakeSourcesRuntime', () => ({
  wakeSources,
  readyWakeSources: () => initialization ??= wakeSources.initialize(),
  stopWakeSources: () => wakeSources.stop(),
  startWakeSources: () => {},
}));

const { app } = await import('../server');
const { wakeScheduleTool } = await import('../tools/builtin-tools/workstation/wakeScheduleTool');
app.post('/fixture/recovery-tool', async (req, res) => {
  // A fixture-only admission gate; the real tool is mainAgentOnly and gets its
  // thread ID from the authenticated runtime context, not caller arguments.
  if (req.header('x-fixture-assertion') !== 'fixture-own-thread') return res.sendStatus(403);
  const result = await wakeScheduleTool.handler(req.body,
    { threadId: req.header('x-fixture-thread') } as Parameters<typeof wakeScheduleTool.handler>[1]);
  res.json(result);
});
app.get('/fixture/native-starts', (_req, res) => res.json({ starts }));
const { runStandaloneCli } = await import('../standalone');
await runStandaloneCli(['--home', home, '--workspace', home,
  '--port', 'auto', '--quiet-startup', '--stream-jsonl']);
