/**
 * Compatibility-free module boundary for the Electron controller: the
 * computer_batch implementation lives with the unified Interpreter builtin,
 * and this file only re-exports that single implementation for existing
 * controller imports.
 */
export {
  executeUnifiedComputerBatchToolCall as executeAdvancedVoiceComputerBatchToolCall,
  formatToolCallResponseForComputerBatch as formatToolCallResponseForAdvancedVoice,
  parseUnifiedComputerBatchArguments as parseAdvancedVoiceComputerBatchArguments,
} from '../../../server/tools/builtin-tools/interpreter-overlay/computerBatchExecutor.js';
export type {
  AdvancedVoiceComputerBatchAction,
  AdvancedVoiceComputerBatchArguments,
  AdvancedVoiceComputerBatchCallInput,
  AdvancedVoiceInterpreterToolAction,
  AdvancedVoiceSelectedTargetAction,
} from '../../../server/tools/builtin-tools/interpreter-overlay/computerBatchExecutor.js';
