export type WorkstationHost = 'local' | 'remote';
export type WorkstationAccess = 'read-only' | 'read-write';
export type WorkstationAuthentication = 'none' | 'password' | 'pairing';

export type WorkstationPairingPayload = {
  schemaVersion: 1;
  endpoint: string;
  pairingToken: string;
  expiresAt: string;
  hostName: string;
  projectId: string;
  projectName: string;
  projectPathHint: string;
};

export type WorkstationPairingSession = {
  schemaVersion: 1;
  endpoint: string;
  accessToken: string;
  expiresAt: string;
  access: WorkstationAccess;
};

export type WorkstationConnectionDescriptor = {
  schemaVersion: 1;
  host: WorkstationHost;
  access: WorkstationAccess;
  authentication: {
    method: WorkstationAuthentication;
    required: boolean;
    authenticated: boolean;
  };
};
