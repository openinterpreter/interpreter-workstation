import { execFileSync } from 'node:child_process';
import type { ScreenElement } from './ocr-segmentation/index.js';
import { getInterpreterOverlayNativeHelperPath } from './native-helper-paths.js';

function getVerifiedPointBinaryPath(): string {
  return getInterpreterOverlayNativeHelperPath('verified-point');
}

export interface VerifiedPointHit {
  id: string;
  role: string;
  label: string;
  value?: string;
  bbox?: ScreenElement['bbox'];
}

export type VerifiedPointResult =
  | { kind: 'match'; point: { x: number; y: number } }
  | { kind: 'blocked'; point: { x: number; y: number }; hit: VerifiedPointHit }
  | { kind: 'no-match' };

export function findVerifiedPointForElement(
  element: Pick<ScreenElement, 'id' | 'bbox'>,
): VerifiedPointResult | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  const start = Date.now();
  try {
    const result = execFileSync(
      getVerifiedPointBinaryPath(),
      [
        element.id,
        Math.round(element.bbox.x).toString(),
        Math.round(element.bbox.y).toString(),
        Math.max(1, Math.round(element.bbox.width)).toString(),
        Math.max(1, Math.round(element.bbox.height)).toString(),
      ],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          INTERPRETER_OVERLAY_EXCLUDED_PID: String(process.pid),
        },
      },
    ).trim();

    if (!result || result === 'no_match') {
      console.log(
        `[VerifiedPoint] [TARGETING_TIMING] outcome=no-match element=${element.id} durationMs=${Date.now() - start}`,
      );
      return { kind: 'no-match' };
    }

    const parsed = JSON.parse(result) as
      | { status?: 'match'; x?: number; y?: number }
      | { status?: 'blocked'; x?: number; y?: number; hit?: VerifiedPointHit };

    if (parsed.status === 'match' && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      console.log(
        `[VerifiedPoint] [TARGETING_TIMING] outcome=success element=${element.id} durationMs=${Date.now() - start} point=(${parsed.x},${parsed.y})`,
      );
      return { kind: 'match', point: { x: parsed.x, y: parsed.y } };
    }

    if (
      parsed.status === 'blocked'
      && typeof parsed.x === 'number'
      && typeof parsed.y === 'number'
      && parsed.hit
      && typeof parsed.hit.id === 'string'
      && typeof parsed.hit.role === 'string'
      && typeof parsed.hit.label === 'string'
    ) {
      console.warn(
        `[VerifiedPoint] [TARGETING_TIMING] outcome=blocked element=${element.id} durationMs=${Date.now() - start} point=(${parsed.x},${parsed.y}) hit=${parsed.hit.id} role=${parsed.hit.role} label=${JSON.stringify(parsed.hit.label)}`,
      );
      return {
        kind: 'blocked',
        point: { x: parsed.x, y: parsed.y },
        hit: parsed.hit,
      };
    }

    if (
      typeof (parsed as { x?: number; y?: number }).x === 'number'
      && typeof (parsed as { x?: number; y?: number }).y === 'number'
    ) {
      const legacy = parsed as { x: number; y: number };
      console.log(
        `[VerifiedPoint] [TARGETING_TIMING] outcome=legacy-success element=${element.id} durationMs=${Date.now() - start} point=(${legacy.x},${legacy.y})`,
      );
      return { kind: 'match', point: { x: legacy.x, y: legacy.y } };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      console.warn(
        `[VerifiedPoint] [TARGETING_TIMING] outcome=invalid-json element=${element.id} durationMs=${Date.now() - start}`,
      );
      return null;
    }
    console.warn(
      `[VerifiedPoint] [TARGETING_TIMING] outcome=invalid-payload element=${element.id} durationMs=${Date.now() - start} payload=${result}`,
    );
    return null;
  } catch (error) {
    console.error(
      `[VerifiedPoint] [TARGETING_TIMING] outcome=error element=${element.id} durationMs=${Date.now() - start}`,
    );
    console.error('[VerifiedPoint] Failed to resolve verified point:', error);
    return null;
  }
}
