import express, { type Router } from 'express';
import { productionSimpleRemoteRouter } from './routes/simpleRemote';

/** The Serve target exposes no operator API, renderer, filesystem or full sidecar. */
export function createRemoteSimpleListener(router: Router = productionSimpleRemoteRouter()) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use('/api/simple-remote/v1', router);
  return app;
}
