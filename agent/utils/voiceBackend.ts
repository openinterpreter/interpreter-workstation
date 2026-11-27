import { getRuntimeSystemInfo } from '../../src/ipc';
import type { SttBackend } from '../../shared/types/stt';

/** Backend selection has no audio or model dependency. */
export function shouldUseMoonshineVoiceBackend(preferredBackend?: SttBackend): boolean {
  const forcedBackend = (globalThis as { __VOICE_BACKEND__?: string }).__VOICE_BACKEND__;
  if (forcedBackend === 'moonshine') return true;
  if (forcedBackend === 'qwen') return false;
  if (preferredBackend === 'moonshine') return true;
  if (preferredBackend === 'qwen') return false;
  return getRuntimeSystemInfo().platform === 'win32';
}
