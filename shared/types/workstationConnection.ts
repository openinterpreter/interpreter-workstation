export type WorkstationHost = 'local' | 'remote';
export type WorkstationAccess = 'read-only' | 'read-write';
export type WorkstationAuthentication = 'none' | 'password';

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
