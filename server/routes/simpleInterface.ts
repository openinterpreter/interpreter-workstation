import { Router } from 'express';
import {
  promoteSimpleInterfaceCandidate,
  readSimpleInterface,
  readSimpleInterfaceAsset,
  recordSimpleInterfaceAction,
  recordSimpleInterfaceDelivery,
  saveSimpleInterfaceInput,
} from '../handlers/simpleInterface';

const router = Router();

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
