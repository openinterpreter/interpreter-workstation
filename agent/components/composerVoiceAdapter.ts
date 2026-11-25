/**
 * The composer only describes voice capabilities. The desktop app supplies the
 * implementation; browser embedders do not load native audio modules.
 * Type-only imports are erased from the embedder's runtime dependency graph.
 */
export interface ComposerVoiceAdapter {
  microphoneCaptureRequest: MediaStreamConstraints;
  QwenStreamingCaptureSession: typeof import('../utils/voiceCapture').QwenStreamingCaptureSession;
  QwenVoiceStreamBridge: typeof import('../utils/qwenVoiceStreamBridge').QwenVoiceStreamBridge;
  checkEndOfTurn: typeof import('../utils/voiceCapture').checkEndOfTurn;
  getAdaptiveVoiceSilenceTimeoutMs: typeof import('../utils/voiceCapture').getAdaptiveVoiceSilenceTimeoutMs;
  finishVoiceStreamSession: typeof import('../utils/voiceCapture').finishVoiceStreamSession;
  warmVoiceStreamSession: typeof import('../utils/voiceCapture').warmVoiceStreamSession;
  loadMoonshineModule: typeof import('../utils/moonshine').loadMoonshineModule;
  warmMoonshineModel: typeof import('../utils/moonshine').warmMoonshineModel;
  emitVoiceLatencyEvent: typeof import('../utils/voiceLatency').emitVoiceLatencyEvent;
  trackVoiceModeStarted: typeof import('../../src/utils/telemetry').trackVoiceModeStarted;
  trackVoiceModeStopped: typeof import('../../src/utils/telemetry').trackVoiceModeStopped;
  trackVoiceModeChanged: typeof import('../../src/utils/telemetry').trackVoiceModeChanged;
}
