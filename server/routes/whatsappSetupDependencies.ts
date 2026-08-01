// NOTE(victor): Keep route tests from mock.module()'ing shared WhatsApp runtime
// modules. Bun module mocks are process-global across test files.
export {
  initializeSocket,
  disconnectSocket,
  getConnectionState,
  getPhoneNumber,
  connectionEvents,
} from '../tools/builtin-tools/whatsapp/connection';
export {
  loadCredentials,
  isConfigured,
} from '../tools/builtin-tools/whatsapp/credentials';
