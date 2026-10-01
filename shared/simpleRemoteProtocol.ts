/** Stable v1 wire identities; never put paths, API keys or device enrollment secrets on the wire. */
export const SIMPLE_REMOTE_PROTOCOL_VERSION = 1;

export type SimpleRemoteCapability = {
  version: 1;
  projectId: string;
  sessionId: string;
  threadId: string;
  host: 'remote';
  tools: { remoteFilesystem: true; remoteComputer: boolean; localComputer: false };
  interface: { executableReact: boolean; hotReload: boolean; lastKnownGood: boolean };
  commands: { send: boolean; steer: boolean; queue: boolean; stop: boolean; voiceDelegate: boolean; fileDrop: boolean };
};

export type SimpleRemoteMessage = {
  version: 1;
  windowId: string;
  eventId: string;
  source: 'composer' | 'interface' | 'voice';
  message: string;
  /** Explicitly supplied display-device text, never inferred from local tools. */
  selectedText?: string;
};
