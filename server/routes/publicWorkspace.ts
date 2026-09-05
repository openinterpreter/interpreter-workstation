import { Router, type Request, type Response } from 'express';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { matchesPublicThreadToken } from '../utils/publicThreadSnapshot';
import {
  listPublicWorkspace,
  MAX_PUBLIC_FILE_BYTES,
  publicWorkspaceMimeType,
  resolvePublicWorkspaceEntry,
} from '../utils/publicWorkspace';

const router = Router();
const SAFE_PUBLIC_ERRORS = new Set([
  'Invalid workspace path.',
  'Workspace path is not a directory.',
  'Workspace path is not a file.',
  'Workspace symlinks cannot leave the public root.',
]);

function bearerToken(request: Request): string | undefined {
  const authorization = request.header('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
}

function configuration(request: Request, response: Response): { root: string; name: string } | null {
  const root = process.env.INTERPRETER_PUBLIC_WORKSPACE_ROOT?.trim();
  const expectedToken = process.env.INTERPRETER_PUBLIC_THREAD_TOKEN?.trim();
  if (!root || !expectedToken) {
    response.status(503).json({ error: 'Public workspace viewing is not configured.' });
    return null;
  }
  if (!matchesPublicThreadToken(bearerToken(request), expectedToken)) {
    response.status(401).json({ error: 'Unauthorized.' });
    return null;
  }
  return {
    root,
    name: process.env.INTERPRETER_PUBLIC_WORKSPACE_NAME?.trim() || 'Artifacts',
  };
}

router.get('/', async (req: Request, res: Response) => {
  const config = configuration(req, res);
  if (!config) return;
  try {
    const listing = await listPublicWorkspace(config.root, req.query.path ?? '', config.name);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(listing);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Public workspace is unavailable.';
    const status = message === 'Invalid workspace path.' ? 400 : 404;
    return res.status(status).json({ error: SAFE_PUBLIC_ERRORS.has(message) ? message : 'Public workspace is unavailable.' });
  }
});

router.get('/file', async (req: Request, res: Response) => {
  const config = configuration(req, res);
  if (!config) return;
  try {
    const resolved = await resolvePublicWorkspaceEntry(config.root, req.query.path ?? '');
    const metadata = await stat(resolved.absolutePath);
    if (!metadata.isFile()) return res.status(400).json({ error: 'Workspace path is not a file.' });
    if (metadata.size > MAX_PUBLIC_FILE_BYTES) return res.status(413).json({ error: 'File is too large to preview.' });

    const mimeType = publicWorkspaceMimeType(resolved.absolutePath);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.setHeader('Content-Type', mimeType);
    const basename = path.basename(resolved.absolutePath);
    res.setHeader('Content-Disposition', `inline; filename="artifact"; filename*=UTF-8''${encodeURIComponent(basename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(resolved.absolutePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Public file is unavailable.';
    const status = message === 'Invalid workspace path.' ? 400 : 404;
    return res.status(status).json({ error: SAFE_PUBLIC_ERRORS.has(message) ? message : 'Public file is unavailable.' });
  }
});

export default router;
