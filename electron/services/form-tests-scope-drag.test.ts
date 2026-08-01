import { describe, expect, test } from 'bun:test';

const {
  buildMouseDragPath,
  computeBoundsCoverage,
  deriveAxFormRegion,
} = require('../../form-tests/scope-drag-region.cjs');

describe('form-tests scope drag region helpers', () => {
  test('derives a padded form region from field-like AX elements inside the form window', () => {
    const region = deriveAxFormRegion({
      windowBounds: { x: 400, y: 120, width: 600, height: 720 },
      padding: 20,
      elements: [
        { role: 'AXButton', bbox: { x: 430, y: 150, width: 90, height: 32 } },
        { role: 'AXTextField', bbox: { x: 470, y: 240, width: 240, height: 42 } },
        { role: 'AXComboBox', bbox: { x: 470, y: 330, width: 280, height: 42 } },
        { role: 'AXTextArea', bbox: { x: 470, y: 430, width: 320, height: 120 } },
        { role: 'AXTextField', bbox: { x: 80, y: 80, width: 200, height: 42 } },
      ],
    });

    expect(region).toEqual({
      x: 450,
      y: 220,
      width: 360,
      height: 350,
    });
  });

  test('falls back to other interactive AX elements when no field-like controls are present', () => {
    const region = deriveAxFormRegion({
      windowBounds: { x: 100, y: 50, width: 320, height: 240 },
      padding: 12,
      elements: [
        { role: 'AXButton', bbox: { x: 130, y: 110, width: 70, height: 30 } },
        { role: 'AXLink', bbox: { x: 220, y: 150, width: 90, height: 24 } },
      ],
    });

    expect(region).toEqual({
      x: 118,
      y: 98,
      width: 204,
      height: 88,
    });
  });

  test('extends the field region to include a nearby submit button below the inputs', () => {
    const region = deriveAxFormRegion({
      windowBounds: { x: 780, y: 30, width: 720, height: 900 },
      padding: 18,
      elements: [
        { role: 'AXTextField', bbox: { x: 816, y: 222, width: 327, height: 36 } },
        { role: 'AXTextField', bbox: { x: 816, y: 304, width: 327, height: 37 } },
        { role: 'AXTextField', bbox: { x: 1149, y: 304, width: 326, height: 37 } },
        { role: 'AXButton', bbox: { x: 1373, y: 358, width: 111, height: 27 } },
        { role: 'AXButton', bbox: { x: 808, y: 157, width: 43, height: 20 } },
      ],
    });

    expect(region).toEqual({
      x: 798,
      y: 204,
      width: 702,
      height: 199,
    });
  });

  test('builds a multi-point mouse path that stays inside the requested bounds', () => {
    const path = buildMouseDragPath(
      { x: 200, y: 300, width: 140, height: 80 },
      { inset: 10, segments: 4 },
    );

    expect(path).toEqual([
      { x: 210, y: 310 },
      { x: 250, y: 330 },
      { x: 290, y: 350 },
      { x: 330, y: 370 },
    ]);
  });

  test('computes overlap coverage against the expected drag region', () => {
    const coverage = computeBoundsCoverage(
      { x: 100, y: 100, width: 200, height: 100 },
      { x: 120, y: 110, width: 160, height: 90 },
    );

    expect(coverage).toBeCloseTo(0.72, 5);
  });
});
