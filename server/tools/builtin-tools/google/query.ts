// Web Search Tool
// Uses a web agent proxy to provide web search, code interpreter, and website visiting capabilities

import type { BuiltinToolDefinition } from '../../builtinTools';
import { HOSTED_LLM_SERVER } from '../../../utils/hostedProvider';

// Web agent endpoint
const WEB_AGENT_ENDPOINT = `${HOSTED_LLM_SERVER}/v0/web-agent/chat/completions`;

export const googleQueryTool: BuiltinToolDefinition = {
  name: 'web_search',
  description: 'Search the web for information. This tool connects you to a cloud-based agent with web search, a Python code interpreter, and the ability to visit specific websites. Perfect for finding information, doing math, or retrieving data from the web.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Your query or question. The agent has access to web search, a Python interpreter for calculations, and can visit specific websites you mention.',
      }
    },
    required: ['query']
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async (args: Record<string, any>) => {
    try {
      const startTime = Date.now();
      const query = args.query;

      console.log(`[Web Search] Query: "${query}"`);

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Error: Please provide a valid query'
          }],
          isError: true
        };
      }

      console.log(`[Web Search] Sending request to web agent proxy...`);
      const requestSentTime = Date.now();

      // Call the web agent proxy endpoint
      const response = await fetch(WEB_AGENT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: query
            }
          ],
          model: 'groq/compound',
          temperature: 0,
          max_completion_tokens: 8192,
          top_p: 1,
          stream: false,
          stop: null,
          compound_custom: {
            tools: {
              enabled_tools: [
                'web_search',
                'code_interpreter',
                'visit_website'
              ]
            }
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Web Search] Proxy error: ${response.status} - ${errorText}`);
        return {
          content: [{
            type: 'text',
            text: `Error from web agent: ${response.status} - ${errorText}`
          }],
          isError: true
        };
      }

      const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const endTime = Date.now();
      const totalTime = endTime - startTime;
      const responseTime = endTime - requestSentTime;

      const fullResponse = result.choices?.[0]?.message?.content || '';

      console.log(`[Web Search] Complete! Total: ${totalTime}ms | Response time: ${responseTime}ms | Response length: ${fullResponse.length} chars`);

      return {
        content: [{
          type: 'text',
          text: fullResponse
        }],
        isError: false
      };
    } catch (error: any) {
      console.error('[Web Search] Error:', error);
      return {
        content: [{
          type: 'text',
          text: `Error querying web agent: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
