import type { BuiltinToolDefinition } from '../../builtinTools';
import { browserService } from '../../../../electron/services/browser';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getSandboxDir } from '../../../utils/sandboxManager';
import { normalizeBrowserId } from './index';

export const takeScreenshotTool: BuiltinToolDefinition = {
  name: 'browser_take_screenshot',
  description: 'Capture a screenshot of a browser tab. Returns the path to the saved screenshot image.',
  inputSchema: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'string',
        description: 'The unique identifier of the browser tab to screenshot (can include browser:// prefix from mentions)'
      }
    },
    required: ['tab_id']
  },
  handler: async (args: Record<string, any>) => {
    try {
      const tabId = normalizeBrowserId(args.tab_id as string);
      const imageData = await browserService.takeScreenshot(tabId);

      if (!imageData) {
        return {
          content: [{
            type: 'text',
            text: `Browser tab not found or screenshot failed: ${tabId}`
          }],
          isError: true
        };
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot-${tabId}-${timestamp}.png`;
      const screenshotPath = path.join(getSandboxDir(), filename);

      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await fs.writeFile(screenshotPath, imageData);

      return {
        content: [{
          type: 'text',
          text: `Screenshot saved to: ${screenshotPath}`
        }],
        isError: false
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Failed to take screenshot: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
