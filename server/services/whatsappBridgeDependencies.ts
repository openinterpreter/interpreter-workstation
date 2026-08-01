// NOTE(victor): Keep bridge tests from mock.module()'ing shared runtime
// modules. Bun module mocks are process-global across test files.
export {
  connectionEvents,
  getPhoneNumber,
  getSocket,
} from '../tools/builtin-tools/whatsapp/connection';
export {
  sendWhatsAppMessageWithRetry,
} from '../tools/builtin-tools/whatsapp/outbound';
export {
  broadcastEvent,
} from '../handlers/broadcast';
export {
  notifyAgent,
} from '../handlers/agentNotifications';
