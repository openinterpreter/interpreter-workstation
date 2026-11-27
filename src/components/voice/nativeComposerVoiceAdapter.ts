import {
  MICROPHONE_CAPTURE_REQUEST,
  QwenStreamingCaptureSession,
  checkEndOfTurn,
  getAdaptiveVoiceSilenceTimeoutMs,
  finishVoiceStreamSession,
  warmVoiceStreamSession,
} from '../../../agent/utils/voiceCapture';
import { QwenVoiceStreamBridge } from '../../../agent/utils/qwenVoiceStreamBridge';
import { loadMoonshineModule, warmMoonshineModel } from '../../../agent/utils/moonshine';
import { emitVoiceLatencyEvent } from '../../../agent/utils/voiceLatency';
import { trackVoiceModeStarted, trackVoiceModeStopped, trackVoiceModeChanged } from '../../utils/telemetry';
import type { ComposerVoiceAdapter } from '../../../agent/components/composerVoiceAdapter';

/** Only desktop-owned entry points import native capture and model libraries. */
export const nativeComposerVoiceAdapter: ComposerVoiceAdapter = {
  microphoneCaptureRequest: MICROPHONE_CAPTURE_REQUEST,
  QwenStreamingCaptureSession,
  QwenVoiceStreamBridge,
  checkEndOfTurn,
  getAdaptiveVoiceSilenceTimeoutMs,
  finishVoiceStreamSession,
  warmVoiceStreamSession,
  loadMoonshineModule,
  warmMoonshineModel,
  emitVoiceLatencyEvent,
  trackVoiceModeStarted,
  trackVoiceModeStopped,
  trackVoiceModeChanged,
};
