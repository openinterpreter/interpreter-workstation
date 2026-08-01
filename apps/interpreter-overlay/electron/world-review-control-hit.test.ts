import { describe, expect, test } from 'bun:test';
import {
  getWorldReviewControlHit,
  getWorldReviewControlHitFromGlobalPoint,
} from './world-review-control-hit';

describe('getWorldReviewControlHit', () => {
  const bounds = { x: 494, y: 558, width: 212, height: 40 };

  test('returns null outside the visible review control', () => {
    expect(getWorldReviewControlHit({ x: 493, y: 578 }, bounds)).toBeNull();
    expect(getWorldReviewControlHit({ x: 647, y: 599 }, bounds)).toBeNull();
    expect(getWorldReviewControlHit({ x: 647, y: 578 }, null)).toBeNull();
  });

  test('splits the pinned review control into reject and accept halves', () => {
    expect(getWorldReviewControlHit({ x: 560, y: 578 }, bounds)).toBe('reject');
    expect(getWorldReviewControlHit({ x: 600, y: 578 }, bounds)).toBe('accept');
    expect(getWorldReviewControlHit({ x: 647, y: 578 }, bounds)).toBe('accept');
  });

  test('accepts ambiguous hook points on Retina displays', () => {
    const displayBoundsDIP = { x: 0, y: 0, width: 1280, height: 831 };

    expect(getWorldReviewControlHitFromGlobalPoint(
      { x: 647, y: 578 },
      displayBoundsDIP,
      2,
      bounds,
    )).toBe('accept');

    expect(getWorldReviewControlHitFromGlobalPoint(
      { x: 1294, y: 1156, coordinateSpace: 'physical' },
      displayBoundsDIP,
      2,
      bounds,
    )).toBe('accept');
  });
});
