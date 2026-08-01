/**
 * Hosted LLM Provider utilities
 *
 * Provides the base hosted LLM server URL for services that need direct
 * API access (e.g., web-agent). Model inference routes through the Codex
 * interpreter profile instead of direct SDK calls.
 *
 * Set USE_LOCAL_API=true to use a compatible local hosted API implementation.
 */

import {
  getInterpreterHostedApiBaseUrl,
  getInterpreterHostedApiOverrideBaseUrl,
} from '../../shared/hostedApi';

const useLocalApi = process.env.USE_LOCAL_API === 'true';
const hostedApiOverride = getInterpreterHostedApiOverrideBaseUrl();

// Hosted LLM server configuration
export const HOSTED_LLM_SERVER = getInterpreterHostedApiBaseUrl();

// Log which API server is being used (helpful for debugging)
if (useLocalApi) {
  console.log(`[Hosted Provider] Using LOCAL API server: ${HOSTED_LLM_SERVER}`);
} else if (hostedApiOverride) {
  console.log(`[Hosted Provider] Using override API server: ${HOSTED_LLM_SERVER}`);
}
