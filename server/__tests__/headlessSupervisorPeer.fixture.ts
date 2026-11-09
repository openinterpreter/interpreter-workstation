// Isolated HTTP fixture: import the actual headless server module with a
// synthetic enrolled verifier and native Goal CAS. Never use a real home.
import { mock } from 'bun:test';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const threadId = '00000000-0000-4000-8000-000000000001';
const goalId = '00000000-0000-4000-8000-000000000004';
const stateFile = process.env.SUPERVISOR_FIXTURE_STATE!;
type State = { status: 'blocked' | 'active'; lifecycleRevision: number };
const read = (): State => JSON.parse(readFileSync(stateFile, 'utf8'));
let nativeCalls = 0;
mock.module('../utils/supervisorPeerVerifier', () => ({
  createSupervisorPeerVerifier: (config: { audience: string; targetComputer: string }) =>
    async (req: { get: (name: string) => string | undefined }) => {
      if (config.audience !== 'https://verifier.example.test' ||
          config.targetComputer !== 'fixture-target' ||
          req.get('x-interpreter-supervisor-assertion') !== 'fixture-assertion') return null;
      return { issuer: 'fixture-issuer', subject: 'fixture-supervisor',
        sourceComputer: 'fixture-source', targetComputer: 'fixture-target', threadId,
        capabilities: ['goal:read', 'goal:resume'], expiresAt: Date.now() + 30_000 };
    },
}));
const realCodexService = await import('../../src/lib/codex/service');
mock.module('../../src/lib/codex/service', () => ({
  ...realCodexService,
  getCodexService: () => ({
    getThreadGoalWithRevision: async () => {
      const state = read();
      return { goal: { threadId, status: state.status, objective: 'fixture goal' },
        revision: { goalId, status: state.status, missionRevision: 1,
          lifecycleRevision: state.lifecycleRevision } };
    },
    getThreadGoalDocument: async () => { throw Error('fixture read delegated below'); },
    setThreadGoalWithRevision: async (_id: string, expected: State & { goalId: string;
      missionRevision: number }) => {
      nativeCalls++;
      const current = read();
      if (expected.goalId !== goalId || expected.missionRevision !== 1 ||
          expected.status !== current.status ||
          expected.lifecycleRevision !== current.lifecycleRevision) {
        const { GoalRevisionConflictError } = await import('../../src/lib/codex/goal-revision');
        throw new GoalRevisionConflictError();
      }
      const next: State = { status: 'active', lifecycleRevision: current.lifecycleRevision + 1 };
      writeFileSync(stateFile, JSON.stringify(next));
      return { revision: { goalId, status: next.status, missionRevision: 1,
        lifecycleRevision: next.lifecycleRevision } };
    },
  }),
}));
mock.module('../utils/supervisorGoalRead', () => ({
  readStableSupervisorGoal: async () => {
    const state = read();
    // A null Goal is also a positive scoped read, without touching native data.
    return { goal: null, revision: null, document: null, fixtureState: state.status };
  },
}));

if (process.env.SUPERVISOR_FIXTURE_STANDALONE === '1') {
  const { app } = await import('../server');
  app.get('/fixture/native-call-count', (_req, res) => res.json({ nativeCalls }));
  const { runStandaloneCli } = await import('../standalone');
  await runStandaloneCli(['--home', process.env.HOME!, '--workspace', process.env.HOME!,
    '--port', 'auto', '--quiet-startup', '--stream-jsonl']);
} else {
  const { app } = await import('../server');
  app.get('/fixture/native-call-count', (_req, res) => res.json({ nativeCalls }));
  const server = createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') process.stdout.write(`FIXTURE_PORT=${address.port}\n`);
  });
}
