/**
 * Global type declarations for the overlay frontend
 */

import type {
  Bounds,
  OverlayState,
  OverlayAction,
  OverlayBootstrapData,
  OverlaySkillsResponse,
} from '../shared/ipc.js';

export {};

declare global {
  interface Window {
    overlay: {
      onState: (cb: (state: OverlayState) => void) => () => void;
      onRequestInputFocus: (cb: () => void) => () => void;
      onDragPreview: (cb: (bounds: Bounds | null, color: string) => void) => () => void;
      send: (action: OverlayAction) => void;
      getBootstrap: () => Promise<OverlayBootstrapData>;
      listSkills: (workspacePath: string | null) => Promise<OverlaySkillsResponse>;
      chooseWorkspaceFolder: () => Promise<{ workspacePath: string; workspaceName: string } | null>;
      setSelectionPreferences: (preferences: {
        workspacePath: string | null;
        noWorkspace: boolean;
        profileId: string | null;
      }) => Promise<void>;
      setIgnoreMouse: (ignore: boolean, opts?: { forward?: boolean }) => void;
      createAdvancedVoiceCall: (request: {
        offerSdp: string;
        sessionKind?: 'advanced_voice' | 'onboarding_voice_interview';
      }) => Promise<{ answerSdp: string; callId: string | null }>;
      handleAdvancedVoiceToolCall: (request: {
        name: string;
        argumentsJson: string;
      }) => Promise<{ output: string; followUpUserMessage?: string; requestResponse?: boolean }>;
      getAdvancedVoiceTestAudio: () => Promise<{
        dataUrl?: string;
        mimeType?: string;
        segments?: Array<{ dataUrl: string; mimeType: string; delayAfterMs?: number }>;
      } | null>;
      recordAdvancedVoiceAudioEvent: (event: {
        type: string;
        segmentIndex?: number | null;
      }) => Promise<void>;
    };
  }
}
