import { Router, Request, Response } from 'express';
import {
  INTERPRETER_CLI_CALLER_TOKEN_HEADER,
} from '../utils/interpreterCliRuntime';

const router = Router();
type InterpreterCliHandlers = typeof import('../handlers/interpreterCli');
type InterpreterCliHandlersLoader = () => Promise<InterpreterCliHandlers>;

const loadDefaultInterpreterCliHandlers: InterpreterCliHandlersLoader = () => import('../handlers/interpreterCli');
let loadInterpreterCliHandlers = loadDefaultInterpreterCliHandlers;

export function setInterpreterCliHandlersLoaderForTest(loader: InterpreterCliHandlersLoader | null): void {
  loadInterpreterCliHandlers = loader ?? loadDefaultInterpreterCliHandlers;
}

type FlushableResponse = Response & {
  flush?: () => void;
  flushHeaders?: () => void;
};

function getInterpreterCliErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getInterpreterCliStatus(message: string): number {
  if (message === 'Unknown interpreter caller token.') {
    return 401;
  }
  if (
    message === 'Tool search query is required.'
    || message.startsWith('Missing required args for ')
  ) {
    return 400;
  }
  if (
    message.startsWith("Tool server '")
    || message.startsWith("Tool '")
  ) {
    return 404;
  }
  return 500;
}

function logInterpreterCliError(
  req: Request,
  status: number,
  message: string,
  error: unknown,
): void {
  const log = status >= 500 ? console.error : console.warn;
  log(
    `[Interpreter CLI] ${req.method} ${req.originalUrl} failed (${status}): ${message}`,
    error instanceof Error ? error.stack ?? error.message : error,
  );
}

function respondWithInterpreterCliError(
  req: Request,
  res: Response,
  error: unknown,
  fallback: string,
): Response {
  const message = getInterpreterCliErrorMessage(error, fallback);
  const status = getInterpreterCliStatus(message);
  logInterpreterCliError(req, status, message, error);
  return res.status(status).json({ error: message });
}

function getCallerToken(req: Request): string | null {
  const headerValue = req.header(INTERPRETER_CLI_CALLER_TOKEN_HEADER);
  if (!headerValue) {
    return null;
  }
  const callerToken = headerValue.trim();
  return callerToken.length > 0 ? callerToken : null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSaveToDiskPath(req: Request): string | undefined {
  return typeof req.query.saveToDiskPath === 'string' && req.query.saveToDiskPath.length > 0
    ? req.query.saveToDiskPath
    : undefined;
}

function flushStreamingResponse(res: Response): void {
  const flushable = res as FlushableResponse;
  flushable.flush?.();
}

function writeInterpreterCliStreamLines(
  res: Response,
  kind: 'progress' | 'error',
  text: string,
): void {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const line of normalized.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    res.write(`${kind} ${line}\n`);
  }
}

function writeInterpreterCliStreamResult(res: Response, result: unknown): void {
  res.write(`result ${JSON.stringify(result ?? null)}\n`);
}

// NOTE(interpreter-cli-mcp): Thin transport only. The generated CLI reaches these
// routes, they validate X-Interpreter-Caller-Token, and the handler layer owns
// visibility/dispatch. Do not add MCP discovery here; see
// `server/handlers/interpreterCli.ts`.
router.get('/tools', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  try {
    const { listInterpreterCliTools } = await loadInterpreterCliHandlers();
    return res.json(await listInterpreterCliTools(callerToken));
  } catch (error) {
    return respondWithInterpreterCliError(req, res, error, 'Failed to list interpreter CLI tools.');
  }
});

router.post('/tools/find', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  if (!isJsonObject(req.body)) {
    return res.status(400).json({ error: 'Tool search request body must be a JSON object.' });
  }

  if (typeof req.body.query !== 'string' || req.body.query.trim().length === 0) {
    return res.status(400).json({ error: 'Tool search query is required.' });
  }

  try {
    const { findInterpreterCliTools } = await loadInterpreterCliHandlers();
    return res.json(await findInterpreterCliTools(callerToken, req.body.query));
  } catch (error) {
    return respondWithInterpreterCliError(req, res, error, 'Failed to search interpreter CLI tools.');
  }
});

router.get('/tools/:serverId', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  try {
    const { listInterpreterCliServerTools } = await loadInterpreterCliHandlers();
    return res.json(await listInterpreterCliServerTools(
      callerToken,
      req.params.serverId,
    ));
  } catch (error) {
    return respondWithInterpreterCliError(req, res, error, 'Failed to list interpreter CLI server tools.');
  }
});

router.get('/tools/:serverId/:toolName', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  try {
    const { describeInterpreterCliTool } = await loadInterpreterCliHandlers();
    return res.json(await describeInterpreterCliTool(
      callerToken,
      req.params.serverId,
      req.params.toolName,
    ));
  } catch (error) {
    return respondWithInterpreterCliError(req, res, error, 'Failed to load interpreter CLI tool help.');
  }
});

router.post('/tools/:serverId/:toolName', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  if (!isJsonObject(req.body)) {
    return res.status(400).json({ error: 'Tool args must be a JSON object.' });
  }

  const saveToDiskPath = getSaveToDiskPath(req);
  const saveToDisk = req.query.saveToDisk === 'true' || Boolean(saveToDiskPath);

  try {
    const { callInterpreterCliTool } = await loadInterpreterCliHandlers();
    return res.json(await callInterpreterCliTool({
      callerToken,
      serverId: req.params.serverId,
      toolName: req.params.toolName,
      args: req.body,
      saveToDisk,
      saveToDiskPath,
    }));
  } catch (error) {
    return respondWithInterpreterCliError(req, res, error, 'Failed to call interpreter CLI tool.');
  }
});

router.post('/tools/:serverId/:toolName/stream', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  if (!isJsonObject(req.body)) {
    return res.status(400).json({ error: 'Tool args must be a JSON object.' });
  }

  const saveToDiskPath = getSaveToDiskPath(req);
  const saveToDisk = req.query.saveToDisk === 'true' || Boolean(saveToDiskPath);
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as FlushableResponse).flushHeaders?.();

  try {
    const { callInterpreterCliTool } = await loadInterpreterCliHandlers();
    const result = await callInterpreterCliTool({
      callerToken,
      serverId: req.params.serverId,
      toolName: req.params.toolName,
      args: req.body,
      saveToDisk,
      saveToDiskPath,
      // Keep the stream line-oriented so the generated shell launchers can
      // surface progress without depending on jq, node, or other parsers.
      onProgress: (text) => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        writeInterpreterCliStreamLines(res, 'progress', text);
        flushStreamingResponse(res);
      },
    });
    if (res.writableEnded || res.destroyed) {
      return;
    }
    writeInterpreterCliStreamResult(res, result);
    return res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to call interpreter CLI tool.';
    if (res.writableEnded || res.destroyed) {
      return;
    }
    writeInterpreterCliStreamLines(res, 'error', message);
    return res.end();
  }
});

router.post('/config/get', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  if (!isJsonObject(req.body)) {
    return res.status(400).json({ error: 'Config request body must be a JSON object.' });
  }

  try {
    const { getInterpreterCliConfig } = await loadInterpreterCliHandlers();
    return res.json(await getInterpreterCliConfig(callerToken, String(req.body.path ?? '')));
  } catch (error) {
    return respondWithInterpreterCliError(req, res, error, 'Failed to read interpreter-app config.');
  }
});

router.post('/config/set', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  if (!isJsonObject(req.body)) {
    return res.status(400).json({ error: 'Config request body must be a JSON object.' });
  }

  if (typeof req.body.path !== 'string') {
    return res.status(400).json({ error: 'Config path must be a string.' });
  }

  try {
    const { setInterpreterCliConfig } = await loadInterpreterCliHandlers();
    return res.json(await setInterpreterCliConfig({
      callerToken,
      path: req.body.path,
      value: req.body.value,
      restartRuntime: req.body.restart_runtime === true,
    }));
  } catch (error) {
    return respondWithInterpreterCliError(req, res, error, 'Failed to update interpreter-app config.');
  }
});

router.post('/config/restart-runtime', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  if (!isJsonObject(req.body)) {
    return res.status(400).json({ error: 'Config restart request body must be a JSON object.' });
  }

  try {
    const { restartInterpreterCliRuntime } = await loadInterpreterCliHandlers();
    return res.json(await restartInterpreterCliRuntime({
      callerToken,
      reason: typeof req.body.reason === 'string' ? req.body.reason : undefined,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to restart Interpreter runtime.';
    const status = message === 'Unknown interpreter caller token.' ? 401 : 500;
    return res.status(status).json({ error: message });
  }
});

router.post('/layout/get', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  if (!isJsonObject(req.body)) {
    return res.status(400).json({ error: 'Layout request body must be a JSON object.' });
  }

  try {
    const { getInterpreterCliLayout } = await loadInterpreterCliHandlers();
    return res.json(await getInterpreterCliLayout(callerToken, String(req.body.path ?? '')));
  } catch (error) {
    return respondWithInterpreterCliError(req, res, error, 'Failed to read interpreter-app layout.');
  }
});

router.post('/layout/set', async (req: Request, res: Response) => {
  const callerToken = getCallerToken(req);
  if (!callerToken) {
    return res.status(400).json({ error: `${INTERPRETER_CLI_CALLER_TOKEN_HEADER} header is required.` });
  }

  if (!isJsonObject(req.body)) {
    return res.status(400).json({ error: 'Layout request body must be a JSON object.' });
  }

  if (typeof req.body.path !== 'string') {
    return res.status(400).json({ error: 'Layout path must be a string.' });
  }

  try {
    const { setInterpreterCliLayout } = await loadInterpreterCliHandlers();
    return res.json(await setInterpreterCliLayout({
      callerToken,
      path: req.body.path,
      value: req.body.value,
    }));
  } catch (error) {
    return respondWithInterpreterCliError(req, res, error, 'Failed to update interpreter-app layout.');
  }
});

export default router;
