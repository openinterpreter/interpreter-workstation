import { Router } from 'express';
import { readSimpleProject, recordProjectAction, recordProjectDelivery } from '../simpleProject';
import { hostSimpleProjects } from '../simpleInterfaceProjects';
import { getSimpleWorkspacePath } from '../simpleWorkspace';
import { RemoteSimplePairing } from '../remoteSimplePairing';
import { resolveInterpreterHome } from '../../shared/interpreterHome';
import { join } from 'node:path';
import { assertPrivateServe, privateRemotePort } from '../utils/tailnetServeGuard';
import { getSimplePrimaryThread } from '../handlers/simplePrimaryThread';
import { getCodexService } from '../../src/lib/codex/service';
import QRCode from 'qrcode';

const router = Router();
const projects = hostSimpleProjects(getSimpleWorkspacePath);
const pairing = new RemoteSimplePairing(join(resolveInterpreterHome(), 'simple-interfaces', 'pairing'),
  async id => Boolean(await projects.resolve(id)));
const windowId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid window identity');
  return value;
};
async function activeProject(window: unknown, projectId: unknown) {
  const project = await projects.active(windowId(window));
  if (!project || project.id !== projectId) throw new Error('Project is not open in this window');
  return project;
}

router.get('/projects', async (req, res) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json({ projects: await projects.list(), active: await projects.active(windowId(req.query.windowId)) }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Projects unavailable' }); }
});
router.post('/projects/new', async (req, res) => {
  try { res.json(await projects.create(req.body?.parentPath, req.body?.name, windowId(req.body?.windowId))); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create project' }); }
});
router.post('/projects/open', async (req, res) => {
  try { res.json(await projects.open(req.body?.projectPath, windowId(req.body?.windowId))); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not open project' }); }
});
router.post('/projects/close', async (req, res) => {
  try { await projects.close(windowId(req.body?.windowId)); res.json({ closed: true }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not close project' }); }
});
router.post('/projects/pairing', async (req, res) => {
  try {
    const project = await activeProject(req.body?.windowId, req.body?.projectId);
    const endpoint = process.env.INTERPRETER_SIMPLE_REMOTE_ENDPOINT;
    if (!endpoint) throw new Error('Private remote hosting is not configured');
    assertPrivateServe(endpoint, privateRemotePort());
    const { threadId } = await getSimplePrimaryThread(undefined,
      { projectId: project.id, windowId: req.body.windowId });
    if (!threadId || (await getCodexService().readThread(threadId)).cwd !== project.path) throw new Error('A project conversation is required before pairing');
    res.setHeader('Cache-Control', 'no-store');
    const offer = await pairing.create({ endpoint, projectId: project.id, threadId });
    res.json({ ...offer, qrImage: await QRCode.toDataURL(JSON.stringify(offer.qr), { width: 196, margin: 1 }) });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Pairing unavailable' }); }
});

router.get('/project', async (req, res) => {
  try { const project = await activeProject(req.query.windowId, req.query.projectId);
    res.setHeader('Cache-Control', 'no-store'); res.json(await readSimpleProject(false, project.path)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Project unavailable' }); }
});

router.post('/project/promote', async (req, res) => {
  try { const project = await activeProject(req.body?.windowId, req.body?.projectId);
    res.setHeader('Cache-Control', 'no-store'); res.json(await readSimpleProject(true, project.path)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Project unavailable' }); }
});

router.post('/project/action', async (req, res) => {
  try { const project = await activeProject(req.body?.windowId, req.body?.projectId);
    res.json(await recordProjectAction(req.body, project.path)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid action' }); }
});

router.post('/project/delivery', async (req, res) => {
  try { const project = await activeProject(req.body?.windowId, req.body?.projectId);
    await recordProjectDelivery(req.body?.id, req.body?.status, project.path); res.json({ success: true }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid delivery' }); }
});

export default router;
