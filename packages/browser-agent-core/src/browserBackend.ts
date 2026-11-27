import type { RequestMap } from '../../../src/lib/codex/protocol';
import { BrowserModelCatalogAppServer } from './appServer';
import { BrowserLocalModelCatalog, createBrowserModelDownload } from './modelCatalog';

type SessionOptions = Omit<Parameters<BrowserLocalModelCatalog['openSession']>[0], 'projectId'>;

/** Catalogue and Pi session composition for the normal pre-session browser host. */
export class BrowserLocalProjectBackend {
  private readonly lists: BrowserModelCatalogAppServer;
  readonly downloadModel: ReturnType<typeof createBrowserModelDownload>;

  constructor(readonly projectId: string, readonly providerId: string,
    readonly catalog: BrowserLocalModelCatalog, private readonly sessionOptions: SessionOptions) {
    this.lists = new BrowserModelCatalogAppServer(catalog, providerId);
    this.downloadModel = createBrowserModelDownload(catalog, providerId);
  }

  request<M extends keyof RequestMap>(method: M, params: RequestMap[M]['params']):
    Promise<RequestMap[M]['result']> {
    return this.lists.request(method, params);
  }

  async openSession(modelId: string, signal?: AbortSignal) {
    const entry = this.catalog.list().find(model => model.id === modelId);
    if (!entry) throw new Error('Browser model is not registered');
    // The catalogue verifies assets exactly once per opening, then selects
    // only after the model and transcript have opened successfully.
    const session = await this.catalog.openSession({ ...this.sessionOptions,
      projectId: this.projectId, modelId, providerId: this.providerId, signal });
    return { projectId: this.projectId, threadId: session.threadId,
      model: { id: session.model.id, name: session.model.name },
      appServer: session.appServer, stream: session.stream.bind(session),
      dispose: () => session.dispose() };
  }
}
