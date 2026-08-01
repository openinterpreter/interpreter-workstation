import { callTool as callInterpreterTool } from '../../../server/handlers/toolServers';
import type { ToolCallResponse } from '../../../server/tools/toolTypes';
import type { OverlaySelectionElement } from '../shared/ipc.js';
import type { Bounds, DisplayInfo } from '../shared/types.js';
import { intersectBounds, toLocalBounds } from '../shared/scope.js';
import { buildOverlayToolManagerIdentity } from './overlay-tool-identity.js';

export type OverlayCuaRegionCallTool = (
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  saveToDisk: boolean | undefined,
  toolContext: {
    callerTabId: string;
    workspace?: string;
    profileId?: string;
  },
  options?: {
    includeHiddenBuiltins?: boolean;
  },
) => Promise<unknown>;

interface CuaUiElementRef {
  elementIndex: number;
  role: string;
  bounds: Bounds;
  label: string;
}

const CUA_UI_ELEMENT_LINE_RE = /^ref=element_index:(\d+) element_index=(\d+) role=([^\s]+) bounds=\{x=(-?\d+(?:\.\d+)?), y=(-?\d+(?:\.\d+)?), width=(\d+(?:\.\d+)?), height=(\d+(?:\.\d+)?), coordinate_space=screen_points\} raw=(.+)$/;

function toolResultText(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return String(result ?? '');
  }
  const content = (result as ToolCallResponse).content;
  if (!Array.isArray(content)) {
    return JSON.stringify(result);
  }
  return content
    .map((item) => item.type === 'text' ? item.text ?? '' : '')
    .filter(Boolean)
    .join('\n');
}

function parseRawLabel(rawJson: string): string {
  const parsed = JSON.parse(rawJson);
  if (typeof parsed !== 'string' || parsed.trim().length === 0) {
    throw new Error('CUA get_ui_elements returned an invalid raw element label.');
  }
  return parsed.trim();
}

export function parseCuaUiElementsResponseForTest(text: string): CuaUiElementRef[] {
  return parseCuaUiElementsResponse(text);
}

function parseCuaUiElementsResponse(text: string): CuaUiElementRef[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === '<ui_elements>');
  const end = lines.findIndex((line, index) => index > start && line.trim() === '</ui_elements>');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('CUA get_ui_elements output missing <ui_elements> block.');
  }

  const elements: CuaUiElementRef[] = [];
  for (const rawLine of lines.slice(start + 1, end)) {
    const line = rawLine.trim();
    if (!line || line === 'No bounded actionable UI elements observed.') {
      continue;
    }
    const match = CUA_UI_ELEMENT_LINE_RE.exec(line);
    if (!match) {
      throw new Error(`CUA get_ui_elements returned an unrecognized element line: ${line}`);
    }
    const refIndex = Number(match[1]);
    const elementIndex = Number(match[2]);
    if (refIndex !== elementIndex) {
      throw new Error(`CUA get_ui_elements returned mismatched ref indexes: ${line}`);
    }
    elements.push({
      elementIndex,
      role: match[3],
      bounds: {
        x: Number(match[4]),
        y: Number(match[5]),
        width: Number(match[6]),
        height: Number(match[7]),
      },
      label: parseRawLabel(match[8]),
    });
  }
  return elements;
}

export async function loadCuaRegionSelectionElements(params: {
  agentId: string;
  workspacePath: string | null;
  profileId: string | null;
  appName: string;
  targetIdentity?: Record<string, unknown>;
  regionBounds: Bounds;
  display: DisplayInfo;
  callTool?: OverlayCuaRegionCallTool;
}): Promise<OverlaySelectionElement[]> {
  const result = await (params.callTool ?? callInterpreterTool)(
    'builtin-cua-driver',
    'get_ui_elements',
    {
      app: params.appName,
      x: params.regionBounds.x,
      y: params.regionBounds.y,
      width: params.regionBounds.width,
      height: params.regionBounds.height,
      ...(params.targetIdentity ? { target_identity: params.targetIdentity } : {}),
    },
    undefined,
    buildOverlayToolManagerIdentity({
      agentId: params.agentId,
      workspacePath: params.workspacePath,
      profileId: params.profileId,
    }),
    { includeHiddenBuiltins: true },
  );
  const text = toolResultText(result);
  if (result && typeof result === 'object' && (result as ToolCallResponse).isError === true) {
    throw new Error(text);
  }

  return parseCuaUiElementsResponse(text)
    .map((element): OverlaySelectionElement | null => {
      const clipped = intersectBounds(element.bounds, params.display.boundsDIP);
      if (!clipped) {
        return null;
      }
      return {
        id: `element_index:${element.elementIndex}`,
        role: element.role,
        label: element.label,
        bounds: toLocalBounds(clipped, params.display.boundsDIP),
        nativeCua: {
          app: params.appName,
          elementIndex: element.elementIndex,
          targetIdentity: params.targetIdentity ? { ...params.targetIdentity } : undefined,
        },
      };
    })
    .filter((element): element is OverlaySelectionElement => element !== null);
}
