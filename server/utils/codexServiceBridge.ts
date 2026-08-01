/**
 * Thin re-export bridge for codex service accessors.
 *
 * This module exists so that server/handlers/providers.ts can import
 * getCodexService/getCodexClient through a mockable seam without
 * coupling its test mocks to the real src/lib/codex/service.ts module.
 *
 * See the detailed comment at the top of server/handlers/providers.test.ts
 * for why this is necessary (bun mock.module() is process-global).
 */
export {
  getCodexService,
  getCodexClient,
} from '../../src/lib/codex/service';
