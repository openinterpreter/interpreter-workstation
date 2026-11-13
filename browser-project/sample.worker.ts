import type { WorkerRequest, WorkerReply } from '../src/browser-project/workerHost';
let sequence = 0;
let value = 0;
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = event.data;
  let reply: WorkerReply;
  if (type === 'create' && typeof (payload as { seed?: unknown })?.seed === 'number') {
    sequence = 0; value = (payload as { seed: number }).seed;
    reply = { id, ok: true, payload: { sequence, value } };
  } else if (type === 'step' && Number.isFinite((payload as { amount?: number })?.amount) && Math.abs((payload as { amount: number }).amount) <= 100) {
    sequence++; value += (payload as { amount: number }).amount;
    reply = { id, ok: true, payload: { sequence, value } };
  } else if (type === 'snapshot') reply = { id, ok: true, payload: { sequence, value } };
  else reply = { id, ok: false, error: 'Unsupported or invalid worker operation' };
  self.postMessage(reply);
};
