import { nanoid } from 'nanoid';
import { getCodexService } from '../../src/lib/codex/service';
import { agentTabManager } from '../agentTabManager';
import { getServerPort } from './serverPort';
import {
  buildInterpreterCliServerConnection,
  buildInterpreterCliShellEnvironmentPolicy,
} from './interpreterCliRuntime';
import { resolveAgentInterpreterCliTransport } from './codexRuntime';
import { WakeSources } from './wakeSources';

export async function startWakeThreadTurn(
  threadId: string,
  message: string,
  service = getCodexService(),
): Promise<string> {
  const thread = await service.readThread(threadId);
  if (thread.id !== threadId) throw new Error('Wake destination changed');
  // Native wake admission resumes OIX directly, bypassing runCodexAgentTurn.
  // A resumed thread does not retain that request's shell policy, so bind its
  // existing caller (or a fresh, thread-scoped caller after a host restart)
  // and reapply only the app-tool bridge. Preserve its native model/provider.
  const binding = agentTabManager.getBindingForThread(threadId);
  const callerToken = binding?.callerToken ?? `agtok_${nanoid()}`;
  if (!binding) {
    agentTabManager.bindThread({
      agentId: `wake-${nanoid()}`,
      callerToken,
      threadId,
      workspacePath: thread.cwd ?? undefined,
    });
  }
  const connection = buildInterpreterCliServerConnection(getServerPort(), {
    transport: resolveAgentInterpreterCliTransport(process.platform),
  });
  return service.startExistingThreadTurn(threadId, message, thread.cwd ?? undefined, {
    mcp_servers: {},
    shell_environment_policy: buildInterpreterCliShellEnvironmentPolicy(
      callerToken, process.env, process.platform, thread.cwd ?? undefined, connection,
    ),
  });
}

export const wakeSources = new WakeSources({
  async inspect(threadId) {
    const thread = await getCodexService().readThread(threadId);
    if (thread.id !== threadId) throw new Error('Wake destination changed');
    return {
      activeTurnId: [...thread.turns].reverse().find(turn => turn.status === 'inProgress')?.id,
      messages: thread.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'userMessage'
        ? item.content.filter(input => input.type === 'text').map(input => input.text)
        : [])),
    };
  },
  steer(threadId, turnId, message) {
    return getCodexService().steer(threadId, { turnId, message });
  },
  async start(threadId, message) {
    return startWakeThreadTurn(threadId, message);
  },
});
let initialization: Promise<void> | undefined;
let stopping = false;
export function readyWakeSources(): Promise<void> {
  if (stopping) return Promise.reject(new Error('Wake admission is draining for restart'));
  return initialization ??= wakeSources.initialize().catch(error => {
    initialization = undefined;
    throw error;
  });
}
/** Fence new admission, finish in-flight custody, then release the sole owner. */
export async function stopWakeSources(): Promise<void> {
  stopping = true;
  if (initialization) {
    try { await initialization; } catch { return; }
    await wakeSources.stop();
  }
}
export function startWakeSources(): void {
  void readyWakeSources().catch(error => {
    console.error('[Wake sources] Durable state unavailable; no wake input will be acknowledged.', error);
  });
}
