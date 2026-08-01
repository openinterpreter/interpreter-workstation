// Test Approval Server
// Provides tools for testing the approval system

import type { BuiltinServerDefinition } from '../../builtinTools';
import { testApprovalTool } from './testApprovalTool';

export const testApprovalServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-test-approval',
  name: 'Test Approval',
  description: 'Tools for testing the approval system',
  isBuiltin: true,
  tools: [testApprovalTool],
  resources: [],
  prompts: []
};
