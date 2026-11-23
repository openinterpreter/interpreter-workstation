import type { AppServerNotification, RequestMap } from '../../../src/lib/codex/protocol';
import { CLIENT_METHOD } from './protocolWire';
import type { v2 } from '../../../server/handlers/codex-generated-types/index';
import type { BrowserPiAppServerSession } from './piSession';
import type { BrowserLocalModelCatalog } from './modelCatalog';

/** Pre-session catalogue uses the same canonical app-server list methods. */
export class BrowserModelCatalogAppServer {
  constructor(readonly catalog: BrowserLocalModelCatalog, readonly providerId: string,
    readonly selectedModelId?: string) {}

  async request<M extends keyof RequestMap>(method: M,
    params: RequestMap[M]['params']): Promise<RequestMap[M]['result']> {
    if (method === CLIENT_METHOD.interpreterProviderList) {
      const provider: v2.InterpreterProvider = {
        id: this.providerId, name: 'Browser-local models',
        description: 'Models registered for this browser',
        isCurrent: true, configured: true, isDefault: true,
      };
      return { data: [provider] } as RequestMap[M]['result'];
    }
    if (method === CLIENT_METHOD.interpreterModelList || method === CLIENT_METHOD.modelList) {
      const input = params as RequestMap[typeof CLIENT_METHOD.interpreterModelList]['params'];
      if (method === CLIENT_METHOD.modelList) {
        const paged = params as RequestMap[typeof CLIENT_METHOD.modelList]['params'];
        if (paged.cursor || paged.limit != null && paged.limit < 1)
          throw new Error('Browser model pagination capability unavailable');
      }
      const models: v2.Model[] = input.modelProvider && input.modelProvider !== this.providerId ? [] :
        this.catalog.list().map(entry => ({
          id: entry.id, model: entry.id, upgrade: null, upgradeInfo: null,
          availabilityNux: null, displayName: entry.name,
          description: 'Browser-local model registered for this browser', modelSpecialty: null,
          hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'none',
          inputModalities: [...(entry.inputModalities ?? ['text'])], supportsPersonality: false,
          multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [],
          defaultServiceTier: null, availableAccessPrograms: null,
          isDefault: entry.id === this.selectedModelId,
        }));
      if (method === CLIENT_METHOD.interpreterModelList)
        return { data: models } as RequestMap[M]['result'];
      return { data: models, nextCursor: null } as RequestMap[M]['result'];
    }
    throw new Error(`Browser app-server capability unavailable: ${String(method)}`);
  }
}

/** The browser host accepts the same app-server methods, not a second chat protocol. */
export class BrowserProjectAppServer {
  private startingTurn = false;
  constructor(readonly session: BrowserPiAppServerSession) {}

  subscribe(listener: (notification: AppServerNotification) => void): () => void {
    return this.session.subscribeNotifications(listener);
  }

  subscribeJsonRpc(listener: (notification: AppServerNotification & { jsonrpc: '2.0' }) => void): () => void {
    return this.subscribe(notification => listener({ jsonrpc: '2.0', ...notification }));
  }

  async request<M extends keyof RequestMap>(method: M,
    params: RequestMap[M]['params']): Promise<RequestMap[M]['result']> {
    const threadId = this.session.threadId;
    if (method === CLIENT_METHOD.interpreterProviderList ||
        method === CLIENT_METHOD.interpreterModelList || method === CLIENT_METHOD.modelList) {
      const model = this.session.model;
      if (this.session.catalog)
        return new BrowserModelCatalogAppServer(this.session.catalog, model.provider, model.id)
          .request(method, params);
      // Sessions without a catalogue still expose their active model.
      const entry = { id: model.id, name: model.name, inputModalities: model.input };
      const provider: v2.InterpreterProvider = { id: model.provider, name: 'Browser-local models',
        description: 'Models registered for this browser', isCurrent: true,
        configured: true, isDefault: true };
      if (method === CLIENT_METHOD.interpreterProviderList)
        return { data: [provider] } as RequestMap[M]['result'];
      const models: v2.Model[] = (params as { modelProvider?: string }).modelProvider &&
        (params as { modelProvider?: string }).modelProvider !== model.provider ? [] : [{
        id: entry.id, model: entry.id, upgrade: null, upgradeInfo: null,
        availabilityNux: null, displayName: entry.name, description: 'Browser-local model',
        modelSpecialty: null, hidden: false, supportedReasoningEfforts: [],
        defaultReasoningEffort: 'none', inputModalities: entry.inputModalities,
        supportsPersonality: false, multiAgentVersion: null, additionalSpeedTiers: [],
        serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null, isDefault: true,
      }];
      return method === CLIENT_METHOD.modelList
        ? { data: models, nextCursor: null } as RequestMap[M]['result']
        : { data: models } as RequestMap[M]['result'];
    }
    if (method === CLIENT_METHOD.threadRead) {
      const input = params as RequestMap[typeof CLIENT_METHOD.threadRead]['params'];
      if (input.threadId !== threadId) throw new Error('Browser thread identity mismatch');
      const thread = this.session.historyThread();
      return { thread: input.includeTurns ? thread : { ...thread, turns: [] } } as RequestMap[M]['result'];
    }
    if (method === CLIENT_METHOD.threadTurnsList) {
      const input = params as RequestMap[typeof CLIENT_METHOD.threadTurnsList]['params'];
      if (input.threadId !== threadId) throw new Error('Browser thread identity mismatch');
      if (input.cursor || input.limit != null || input.sortDirection ||
          input.itemsView && input.itemsView !== 'full')
        throw new Error('Browser thread pagination capability unavailable');
      const turns = this.session.historyThread().turns;
      return { data: (input.sortDirection as string | null | undefined) === 'asc' ? turns : [...turns].reverse(),
        nextCursor: null, backwardsCursor: null } as RequestMap[M]['result'];
    }
    if (method === CLIENT_METHOD.turnStart) {
      const input = params as RequestMap[typeof CLIENT_METHOD.turnStart]['params'];
      if (input.threadId !== threadId || !Array.isArray(input.input) || input.input.length !== 1 ||
          input.input[0]?.type !== 'text' || input.input[0].text_elements.length ||
          input.cwd != null && input.cwd !== `browser-project:${this.session.projectId}` ||
          input.model != null && input.model !== this.session.model.id ||
          input.toolOutput != null || input.disabledPluginIds?.length || input.outputSchema != null ||
          input.approvalPolicy != null || input.sandboxPolicy != null || input.approvalsReviewer != null ||
          input.serviceTier != null || input.serviceTierForTurn != null || input.effort != null ||
          input.summary != null || input.personality != null)
        throw new Error('Browser turn capability unavailable for this request');
      const text = input.input[0].text;
      if (this.startingTurn) throw new Error('Browser turn start already pending');
      this.startingTurn = true;
      // The canonical app-server responds when the turn starts; model/tool work
      // continues through notifications instead of blocking this JSON-RPC reply.
      const turn = await new Promise<v2.Turn>((resolve, reject) => {
        let settled = false;
        const unsubscribe = this.subscribe(notification => {
          if (notification.method !== 'turn/started' || notification.params.threadId !== threadId) return;
          settled = true;
          unsubscribe();
          resolve(notification.params.turn);
        });
        void this.session.send({ threadId, message: text,
          clientUserMessageId: input.clientUserMessageId ?? undefined,
          workspacePath: `browser-project:${this.session.projectId}` }).then(() => {
          if (!settled) { unsubscribe(); reject(new Error('Browser turn start receipt unavailable')); }
        }, error => { if (!settled) { unsubscribe(); reject(error); } });
      }).finally(() => { this.startingTurn = false; });
      return { turn } as RequestMap[M]['result'];
    }
    if (method === CLIENT_METHOD.turnInterrupt) {
      const input = params as RequestMap[typeof CLIENT_METHOD.turnInterrupt]['params'];
      this.session.stop({ threadId: input.threadId });
      return {} as RequestMap[M]['result'];
    }
    throw new Error(`Browser app-server capability unavailable: ${method}`);
  }

  /** JSON-RPC 2.0 envelope for a standard client; all unsupported methods fail closed. */
  async handle(request: unknown): Promise<{ jsonrpc: '2.0'; id: string | number | null;
    result?: unknown; error?: { code: number; message: string } }> {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    const input = request as Record<string, unknown>;
    const id = typeof input.id === 'string' || typeof input.id === 'number' ? input.id : null;
    if (input.jsonrpc !== '2.0' || id === null || typeof input.method !== 'string' ||
        !input.params || typeof input.params !== 'object' || Array.isArray(input.params))
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } };
    try {
      // Validation remains in the method boundary and Pi session; never execute an
      // arbitrary method or route a browser request to the desktop app-server.
      const result = await this.request(input.method as keyof RequestMap, input.params as never);
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Browser request failed';
      return { jsonrpc: '2.0', id, error: { code: message.startsWith('Browser app-server capability unavailable:')
        ? -32601 : -32602, message } };
    }
  }
}
