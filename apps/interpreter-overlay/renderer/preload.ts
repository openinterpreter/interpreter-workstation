/**
 * Preload script - minimal bridge
 *
 * Two IPC channels:
 * - overlay:state (main -> renderer)
 * - overlay:action (renderer -> main)
 */

const { contextBridge, ipcRenderer } = require('electron');
import path from 'node:path';

import type {
  Bounds,
  OverlayState,
  OverlayAction,
  OverlayBootstrapData,
  OverlaySkillsResponse,
} from '../shared/ipc.js';
import { INTERPRETER_OVERLAY_CHANNELS as CHANNELS } from '../electron/channels.js';

let latestOverlayState: OverlayState | null = null;
const stateListeners = new Set<(state: OverlayState) => void>();
const dragPreviewListeners = new Set<(bounds: Bounds | null, color: string) => void>();
ipcRenderer.on(CHANNELS.STATE, (_: any, state: OverlayState) => {
  latestOverlayState = state;
  for (const listener of stateListeners) {
    listener(state);
  }
});
ipcRenderer.on(CHANNELS.DRAG_PREVIEW, (_: any, payload: { bounds: Bounds | null; color: string }) => {
  for (const listener of dragPreviewListeners) {
    listener(payload.bounds, payload.color);
  }
});

contextBridge.exposeInMainWorld('overlay', {
  onState: (cb: (state: OverlayState) => void) => {
    stateListeners.add(cb);
    if (latestOverlayState) {
      queueMicrotask(() => {
        if (stateListeners.has(cb) && latestOverlayState) {
          cb(latestOverlayState);
        }
      });
    }
    return () => {
      stateListeners.delete(cb);
    };
  },

  onRequestInputFocus: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(CHANNELS.REQUEST_INPUT_FOCUS, handler);
    return () => ipcRenderer.removeListener(CHANNELS.REQUEST_INPUT_FOCUS, handler);
  },

  onDragPreview: (cb: (bounds: Bounds | null, color: string) => void) => {
    dragPreviewListeners.add(cb);
    return () => {
      dragPreviewListeners.delete(cb);
    };
  },

  send: (action: OverlayAction) => {
    ipcRenderer.send(CHANNELS.ACTION, action);
  },

  getBootstrap: (): Promise<OverlayBootstrapData> => {
    return ipcRenderer.invoke(CHANNELS.GET_BOOTSTRAP);
  },

  listSkills: (workspacePath: string | null): Promise<OverlaySkillsResponse> => {
    return ipcRenderer.invoke(CHANNELS.LIST_SKILLS, { workspacePath });
  },

  chooseWorkspaceFolder: async (): Promise<{ workspacePath: string; workspaceName: string } | null> => {
    const result = await ipcRenderer.invoke(CHANNELS.CHOOSE_WORKSPACE_FOLDER) as {
      canceled?: boolean;
      filePaths?: string[];
    };
    if (result.canceled) {
      return null;
    }
    const workspacePath = result.filePaths?.[0] ?? null;
    if (!workspacePath) {
      return null;
    }
    const workspaceName = path.basename(workspacePath) || workspacePath;
    return { workspacePath, workspaceName };
  },

  setSelectionPreferences: async (
    preferences: { workspacePath: string | null; noWorkspace: boolean; profileId: string | null },
  ): Promise<void> => {
    await ipcRenderer.invoke(CHANNELS.SET_SELECTION_PREFERENCES, preferences);
  },

  setIgnoreMouse: (ignore: boolean, opts?: { forward?: boolean }) => {
    ipcRenderer.send(CHANNELS.SET_IGNORE_MOUSE_EVENTS, ignore, opts);
  },

  createAdvancedVoiceCall: async (
    request: { offerSdp: string; sessionKind?: 'advanced_voice' | 'onboarding_voice_interview' },
  ): Promise<{ answerSdp: string; callId: string | null }> => {
    return ipcRenderer.invoke(CHANNELS.ADVANCED_VOICE_CREATE_CALL, request);
  },

  handleAdvancedVoiceToolCall: async (request: {
    name: string;
    argumentsJson: string;
  }): Promise<{ output: string; followUpUserMessage?: string; requestResponse?: boolean }> => {
    return ipcRenderer.invoke(CHANNELS.ADVANCED_VOICE_TOOL_CALL, request);
  },

  getAdvancedVoiceTestAudio: async (): Promise<{
    dataUrl?: string;
    mimeType?: string;
    segments?: Array<{ dataUrl: string; mimeType: string; delayAfterMs?: number }>;
  } | null> => {
    return ipcRenderer.invoke(CHANNELS.ADVANCED_VOICE_TEST_AUDIO);
  },

  recordAdvancedVoiceAudioEvent: async (event: { type: string; segmentIndex?: number | null }): Promise<void> => {
    await ipcRenderer.invoke(CHANNELS.ADVANCED_VOICE_AUDIO_EVENT, event);
  },
});
