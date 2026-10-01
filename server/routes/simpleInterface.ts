import { Router } from 'express';
import {
  promoteSimpleInterfaceCandidate,
  readSimpleInterface,
  readSimpleInterfaceAsset,
  recordSimpleInterfaceAction,
  recordSimpleInterfaceDelivery,
  saveSimpleInterfaceInput,
} from '../handlers/simpleInterface';
import { readSimpleProject, recordProjectAction, recordProjectDelivery, selectSimpleProjectPath } from '../simpleProject';

const router = Router();

router.get('/project', async (_req, res) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json(await readSimpleProject(false)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Project unavailable' }); }
});

router.post('/project/promote', async (_req, res) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json(await readSimpleProject()); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Project unavailable' }); }
});

router.post('/project/select', async (req, res) => {
  try { res.json({ projectPath: await selectSimpleProjectPath(req.body?.projectPath) }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid project' }); }
});

router.post('/project/action', async (req, res) => {
  try { res.json(await recordProjectAction(req.body)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid action' }); }
});

router.post('/project/delivery', async (req, res) => {
  try { await recordProjectDelivery(req.body?.id, req.body?.status); res.json({ success: true }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid delivery' }); }
});

function errorResponse(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 404 :
    /invalid|outdated|not present|exceeds|must be|not allowed|full/i.test(message) ? 400 : 500;
  return { status, message };
}

router.get('/', async (_req, res) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json(await readSimpleInterface()); }
  catch (error) { const { status, message } = errorResponse(error); res.status(status).json({ error: message }); }
});

router.post('/promote', async (_req, res) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json(await promoteSimpleInterfaceCandidate()); }
  catch (error) { const { status, message } = errorResponse(error); res.status(status).json({ error: message }); }
});

router.post('/action', async (req, res) => {
  try { res.json(await recordSimpleInterfaceAction(req.body)); }
  catch (error) { const { status, message } = errorResponse(error); res.status(status).json({ error: message }); }
});

router.post('/input', async (req, res) => {
  try { res.json(await saveSimpleInterfaceInput(req.body)); }
  catch (error) { const { status, message } = errorResponse(error); res.status(status).json({ error: message }); }
});

router.post('/delivery', async (req, res) => {
  try { res.json(await recordSimpleInterfaceDelivery(req.body)); }
  catch (error) { const { status, message } = errorResponse(error); res.status(status).json({ error: message }); }
});

router.get('/assets/:name', async (req, res) => {
  try {
    const { bytes, mime } = await readSimpleInterfaceAsset(req.params.name);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.send(bytes);
  } catch (error) { const { status, message } = errorResponse(error); res.status(status).json({ error: message }); }
});

export default router;
