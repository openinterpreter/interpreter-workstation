import { Router } from 'express';
import { extractNotificationThreadId, getCodexService, subscribeCodexNotifications } from '../../src/lib/codex/service';
import { mapNotificationToUiEvents } from '../../src/lib/codex/event-mapper';
import { resolveInterpreterHome } from '../../shared/interpreterHome';
import { join } from 'node:path';
import { watch } from 'node:fs';
import { readSimpleProject } from '../simpleProject';
import { getSimpleWorkspacePath } from '../simpleWorkspace';
import { RemoteSimplePairing } from '../remoteSimplePairing';
import { hostSimpleProjects, type SimpleInterfaceProjects } from '../simpleInterfaceProjects';
import { assertPrivateServe, privateRemotePort } from '../utils/tailnetServeGuard';
import { readyWakeSources, wakeSources } from '../utils/wakeSourcesRuntime';
import type { SimpleRemoteCapability, SimpleRemoteMessage } from '../../shared/simpleRemoteProtocol';

type Options = {
  endpoint: string | null;
  projects: SimpleInterfaceProjects;
  pairing: RemoteSimplePairing;
  preflight: () => void;
  thread: (threadId: string) => Promise<{ id: string; cwd?: string | null; turns: Array<{ id: string; status: string }> }>;
  enqueue: (threadId: string, eventId: string, message: string) => Promise<{ status: string }>;
  interrupt: (threadId: string, turnId: string) => Promise<void>;
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSimpleRemoteRouter(options: Options): Router {
  const router = Router();
  const { endpoint, projects, pairing } = options;
  if (!endpoint) return router; // Remote capability is optional and disabled by default.
  const origin = new URL(endpoint).origin;
  const urlHost = new URL(endpoint).host;

  router.use((req, res, next) => {
    try {
      options.preflight();
      // Require Serve's exact Host. Native clients without Origin must identify
      // themselves explicitly; browsers must use the paired same origin.
      if (req.get('host') !== urlHost) {
        return res.status(403).json({ error: 'Host is not allowed' });
      }
      if (req.get('origin') && req.get('origin') !== origin) return res.status(403).json({ error: 'Origin is not allowed' });
      if (req.method !== 'GET' && req.get('content-type')?.split(';')[0] !== 'application/json') return res.status(415).json({ error: 'JSON is required' });
      if (!req.get('origin') && !req.get('x-interpreter-client')) return res.status(403).json({ error: 'Client identity is required' });
      next();
    } catch { res.status(503).json({ error: 'Private host unavailable' }); }
  });

  router.get('/identity', async (_req, res) => {
    try { res.set('Cache-Control', 'no-store').json({ version: 1, ...(await pairing.identity()) }); }
    catch { res.status(503).json({ error: 'Private host unavailable' }); }
  });

  router.post('/pair', async (req, res) => {
    try {
      const result = await pairing.redeem(req.body ?? {});
      res.set('Cache-Control', 'no-store').json(result);
    } catch { res.status(401).json({ error: 'Pairing unavailable' }); }
  });

  // Every session route is scoped by the credential's own project ID; never
  // accept a project path or an alternate thread ID from a remote client.
  router.use('/sessions/:sessionId/projects/:projectId', async (req, res, next) => {
    const authorization = req.get('authorization') ?? '';
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    const identity = token && await pairing.verify({ token, projectId: req.params.projectId, sessionId: req.params.sessionId });
    if (!identity) return res.status(401).json({ error: 'Session is unavailable' });
    res.locals.remoteSimple = { ...identity, token };
    next();
  });

  router.get('/sessions/:sessionId/projects/:projectId/capabilities', async (req, res) => {
    const { projectId, threadId } = res.locals.remoteSimple as { projectId: string; threadId: string };
    const project = await projects.resolve(projectId);
    if (!project) return res.status(404).json({ error: 'Project unavailable' });
    const capabilities: SimpleRemoteCapability = {
      version: 1, projectId, sessionId: req.params.sessionId, threadId, host: 'remote',
      tools: { remoteFilesystem: true, remoteComputer: false, localComputer: false },
      interface: { executableReact: true, hotReload: true, lastKnownGood: true },
      commands: { send: true, steer: true, queue: true, stop: true, voiceDelegate: true, fileDrop: false },
    };
    res.set('Cache-Control', 'no-store').json(capabilities);
  });

  router.get('/sessions/:sessionId/projects/:projectId/interface', async (_req, res) => {
    const { projectId } = res.locals.remoteSimple as { projectId: string };
    try {
      const project = await projects.resolve(projectId);
      if (!project) return res.status(404).json({ error: 'Project unavailable' });
      const { bundle, diagnostic, revision } = await readSimpleProject(true, project.path);
      res.set('Cache-Control', 'no-store').json({ version: 1, projectId, bundle, diagnostic, revision });
    } catch { res.status(503).json({ error: 'Interface unavailable' }); }
  });

  router.get('/sessions/:sessionId/projects/:projectId/conversation', async (_req, res) => {
    const { projectId, threadId } = res.locals.remoteSimple as { projectId: string; threadId: string };
    try {
      const project = await projects.resolve(projectId);
      const thread = await getCodexService().readThread(threadId);
      if (!project || thread.cwd !== project.path) return res.status(409).json({ error: 'Project and conversation differ' });
      const messages = thread.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'agentMessage'
        ? [{ role: 'agent', text: item.text }] : item.type === 'userMessage'
          ? item.content.filter(input => input.type === 'text').map(input => ({ role: 'user', text: input.text })) : []));
      res.set('Cache-Control', 'no-store').json({ version: 1, projectId, threadId, messages });
    } catch { res.status(503).json({ error: 'Conversation unavailable' }); }
  });

  router.get('/sessions/:sessionId/projects/:projectId/events', async (req, res) => {
    const { projectId, threadId } = res.locals.remoteSimple as { projectId: string; threadId: string };
    const project = await projects.resolve(projectId);
    const thread = await options.thread(threadId);
    if (!project || thread.cwd !== project.path) return res.status(409).json({ error: 'Project and conversation differ' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let alive = true;
    const emit = (event: string, payload: unknown) => {
      if (alive) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    emit('ready', { version: 1, projectId, threadId });
    const unsubscribe = subscribeCodexNotifications(notification => {
      if (extractNotificationThreadId(notification) !== threadId) return;
      for (const event of mapNotificationToUiEvents(notification)) {
        if (['delta', 'final', 'completed', 'userMessage'].includes(event.event)) emit(event.event, event.payload);
      }
    });
    let watcher: ReturnType<typeof watch> | undefined;
    try { watcher = watch(join(project.path, 'src'), { recursive: true }, () => {
      void readSimpleProject(true, project.path).then(snapshot => {
        emit('interface', { version: 1, projectId, revision: snapshot.revision, diagnostic: snapshot.diagnostic });
      }).catch(() => emit('interface', { version: 1, projectId, diagnostic: 'Interface unavailable' }));
    }); } catch { emit('interface', { version: 1, projectId, diagnostic: 'File watcher unavailable' }); }
    const heartbeat = setInterval(() => { if (alive) res.write(': keepalive\n\n'); }, 20_000);
    res.on('close', () => { alive = false; clearInterval(heartbeat); unsubscribe(); watcher?.close(); });
  });

  router.post('/sessions/:sessionId/projects/:projectId/messages', async (req, res) => {
    const payload = req.body as SimpleRemoteMessage;
    if (payload?.version !== 1 || !ID.test(payload.windowId) || !ID.test(payload.eventId)
        || !['composer', 'interface', 'voice'].includes(payload.source)
        || typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 16_000
        || (payload.selectedText !== undefined && (typeof payload.selectedText !== 'string' || payload.selectedText.length > 8_000))
        || Object.keys(payload).some(key => !['version','windowId','eventId','source','message','selectedText'].includes(key))) {
      return res.status(400).json({ error: 'Invalid message' });
    }
    const { projectId, threadId } = res.locals.remoteSimple as { projectId: string; threadId: string };
    try {
      const project = await projects.resolve(projectId);
      const thread = await options.thread(threadId);
      if (!project || thread.id !== threadId || thread.cwd !== project.path) return res.status(409).json({ error: 'Project and conversation differ' });
      const context = `[Remote ${payload.source} window ${payload.windowId}; project ${projectId}]`;
      const body = `${context}\n${payload.selectedText ? `Explicit selection: ${payload.selectedText}\n` : ''}${payload.message}`;
      const queued = await options.enqueue(threadId, payload.eventId, body);
      res.status(202).json({ eventId: payload.eventId, status: queued.status });
    } catch { res.status(503).json({ error: 'Conversation unavailable' }); }
  });

  router.post('/sessions/:sessionId/projects/:projectId/stop', async (_req, res) => {
    const { projectId, threadId } = res.locals.remoteSimple as { projectId: string; threadId: string };
    try {
      const project = await projects.resolve(projectId);
      const thread = await options.thread(threadId);
      if (!project || thread.id !== threadId || thread.cwd !== project.path) return res.status(409).json({ error: 'Project and conversation differ' });
      const turn = [...thread.turns].reverse().find(item => item.status === 'inProgress');
      if (!turn) return res.json({ stopped: false });
      await options.interrupt(threadId, turn.id);
      res.json({ stopped: true });
    } catch { res.status(503).json({ error: 'Conversation unavailable' }); }
  });

  router.post('/sessions/:sessionId/projects/:projectId/disconnect', async (req, res) => {
    const { token } = res.locals.remoteSimple as { token: string };
    await pairing.revoke({ token, projectId: req.params.projectId, sessionId: req.params.sessionId });
    res.json({ disconnected: true });
  });
  return router;
}

/** Production defaults; disabled unless explicitly configured and actually served privately. */
export function productionSimpleRemoteRouter(): Router {
  const endpoint = process.env.INTERPRETER_SIMPLE_REMOTE_ENDPOINT?.trim() || null;
  const projects = hostSimpleProjects(getSimpleWorkspacePath);
  const pairing = new RemoteSimplePairing(join(resolveInterpreterHome(), 'simple-interfaces', 'pairing'),
    async id => Boolean(await projects.resolve(id)));
  return createSimpleRemoteRouter({ endpoint, projects, pairing,
    preflight: () => { if (!endpoint) throw new Error('Private host unavailable'); assertPrivateServe(endpoint, privateRemotePort()); },
    thread: id => getCodexService().readThread(id),
    enqueue: async (threadId, eventId, message) => {
      await readyWakeSources();
      const event = await wakeSources.ingest(threadId, 'simple-remote', eventId, message);
      void wakeSources.tick().catch(() => {});
      return { status: event.status };
    },
    interrupt: async (threadId, turnId) => { await getCodexService().interrupt(threadId, turnId); },
  });
}
