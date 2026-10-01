import { Router } from 'express';
import { remoteSimpleClient } from '../remoteSimpleClient';

const router = Router();
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/connections', (_req, res) => res.set('Cache-Control', 'no-store').json(remoteSimpleClient.list()));
router.post('/connections', async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await remoteSimpleClient.connect(req.body)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Pairing failed' }); }
});

router.use('/connections/:id', (req, res, next) => {
  if (!ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid connection' });
  next();
});

router.post('/connections/:id/disconnect', async (req, res) => {
  try { res.json({ revoked: await remoteSimpleClient.disconnect(req.params.id) }); }
  catch { res.status(404).json({ error: 'Connection unavailable' }); }
});

for (const resource of ['capabilities', 'interface', 'conversation'] as const) {
  router.get(`/connections/:id/${resource}`, async (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(await remoteSimpleClient.forward(req.params.id, resource)); }
    catch { res.status(503).json({ error: 'Remote project unavailable' }); }
  });
}

for (const resource of ['messages', 'stop'] as const) {
  router.post(`/connections/:id/${resource}`, async (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(await remoteSimpleClient.forward(req.params.id, resource, req.body ?? {})); }
    catch { res.status(503).json({ error: 'Remote conversation unavailable' }); }
  });
}

router.get('/connections/:id/events', async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const response = await remoteSimpleClient.eventStream(req.params.id, controller.signal);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    for await (const chunk of response.body!) {
      if (controller.signal.aborted) break;
      res.write(chunk);
    }
    res.end();
  } catch { if (!res.headersSent) res.status(503).json({ error: 'Remote event stream unavailable' }); else res.end(); }
});

export default router;
