import { describe, expect, test } from 'bun:test';
import { remapSavedAnnotationIds, reconcileSavedAnnotationState } from './pdfAnnotationIdRemap';

interface MockAnnotation {
  id: string;
  originalId?: string;
  isDirty: boolean;
  label: string;
}

function matchesMockAnnotation(live: MockAnnotation, saved: MockAnnotation): boolean {
  return live.id === saved.id
    && live.originalId === saved.originalId
    && live.isDirty === saved.isDirty
    && live.label === saved.label;
}

describe('remapSavedAnnotationIds', () => {
  test('reindexes clean annotations when a lower index is removed', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'moved-name' },
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'pan' },
    ];

    const remapped = remapSavedAnnotationIds(
      annotations,
      ['a0'],
      [{ savedAnnotations: [{ id: 'a0', originalId: 'a0', isDirty: true, label: 'moved-name' }], createdIds: ['a1'] }],
      matchesMockAnnotation
    );

    expect(remapped).toEqual([
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'moved-name' },
      { id: 'a0', originalId: 'a0', isDirty: false, label: 'pan' },
    ]);
  });

  test('keeps unaffected IDs stable when removals are after them', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a0', originalId: 'a0', isDirty: false, label: 'name' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'moved-pan' },
    ];

    const remapped = remapSavedAnnotationIds(
      annotations,
      ['a1'],
      [{ savedAnnotations: [{ id: 'a1', originalId: 'a1', isDirty: true, label: 'moved-pan' }], createdIds: ['a1'] }],
      matchesMockAnnotation
    );

    expect(remapped).toEqual([
      { id: 'a0', originalId: 'a0', isDirty: false, label: 'name' },
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'moved-pan' },
    ]);
  });

  test('consumes created IDs in order when dirty annotations share the same old ID', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'first' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'second' },
    ];

    const remapped = remapSavedAnnotationIds(
      annotations,
      ['a1', 'a1'],
      [{
        savedAnnotations: [
          { id: 'a1', originalId: 'a1', isDirty: true, label: 'first' },
          { id: 'a1', originalId: 'a1', isDirty: true, label: 'second' },
        ],
        createdIds: ['a0', 'a1']
      }],
      matchesMockAnnotation
    );

    expect(remapped).toEqual([
      { id: 'a0', originalId: 'a0', isDirty: false, label: 'first' },
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'second' },
    ]);
  });

  test('deduplicates removed IDs before shifting higher clean annotations', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'first' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'second' },
      { id: 'a2', originalId: 'a2', isDirty: false, label: 'clean-higher' },
    ];

    const remapped = remapSavedAnnotationIds(
      annotations,
      ['a1', 'a1'],
      [{
        savedAnnotations: [
          { id: 'a1', originalId: 'a1', isDirty: true, label: 'first' },
          { id: 'a1', originalId: 'a1', isDirty: true, label: 'second' },
        ],
        createdIds: ['a0', 'a1']
      }],
      matchesMockAnnotation
    );

    expect(remapped).toEqual([
      { id: 'a0', originalId: 'a0', isDirty: false, label: 'first' },
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'second' },
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'clean-higher' },
    ]);
  });

  test('clears dirty flag even when the backend does not return a created ID', () => {
    const annotations: MockAnnotation[] = [
      { id: 'local-1', originalId: undefined, isDirty: true, label: 'new-local' },
    ];

    const remapped = remapSavedAnnotationIds(
      annotations,
      [],
      [{ savedAnnotations: [{ id: 'local-1', originalId: undefined, isDirty: true, label: 'new-local' }], createdIds: [] }],
      matchesMockAnnotation
    );

    expect(remapped).toEqual([
      { id: 'local-1', originalId: undefined, isDirty: false, label: 'new-local' },
    ]);
  });

  test('preserves newer edits on a saved annotation while carrying forward the new PDF id', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'latest-edit' },
    ];

    const remapped = remapSavedAnnotationIds(
      annotations,
      ['a0'],
      [{ savedAnnotations: [{ id: 'a0', originalId: 'a0', isDirty: true, label: 'earlier-edit' }], createdIds: ['a1'] }],
      matchesMockAnnotation
    );

    expect(remapped).toEqual([
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'latest-edit' },
    ]);
  });

  test('shifts a pending dirty annotation when a lower saved annotation is recreated', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-now' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'edited-later' },
    ];

    const remapped = remapSavedAnnotationIds(
      annotations,
      ['a0'],
      [{ savedAnnotations: [{ id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-now' }], createdIds: ['a1'] }],
      matchesMockAnnotation
    );

    expect(remapped).toEqual([
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'saved-now' },
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'edited-later' },
    ]);
  });

  test('shifts every pending dirty annotation below a recreated annotation after a lower removal', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-now' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'edited-later-first' },
      { id: 'a2', originalId: 'a2', isDirty: true, label: 'edited-later-second' },
    ];

    const remapped = remapSavedAnnotationIds(
      annotations,
      ['a0'],
      [{ savedAnnotations: [{ id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-now' }], createdIds: ['a2'] }],
      matchesMockAnnotation
    );

    expect(remapped).toEqual([
      { id: 'a2', originalId: 'a2', isDirty: false, label: 'saved-now' },
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'edited-later-first' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'edited-later-second' },
    ]);
  });

  test('shifts a pending dirty annotation by every lower removal in the completed save batch', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-first' },
      { id: 'a2', originalId: 'a2', isDirty: true, label: 'saved-second' },
      { id: 'a3', originalId: 'a3', isDirty: true, label: 'edited-later' },
    ];

    const remapped = remapSavedAnnotationIds(
      annotations,
      ['a0', 'a2'],
      [{
        savedAnnotations: [
          { id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-first' },
          { id: 'a2', originalId: 'a2', isDirty: true, label: 'saved-second' },
        ],
        createdIds: ['a2', 'a3']
      }],
      matchesMockAnnotation
    );

    expect(remapped).toEqual([
      { id: 'a2', originalId: 'a2', isDirty: false, label: 'saved-first' },
      { id: 'a3', originalId: 'a3', isDirty: false, label: 'saved-second' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'edited-later' },
    ]);
  });
});

describe('reconcileSavedAnnotationState', () => {
  test('keeps dirty duplicates distinct and remaps selection to the first recreated ID', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'first' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'second' },
    ];

    const reconciled = reconcileSavedAnnotationState({
      annotations,
      removedOriginalIds: ['a1', 'a1'],
      createdIdBatches: [
        {
          savedAnnotations: [
            { id: 'a1', originalId: 'a1', isDirty: true, label: 'first' },
            { id: 'a1', originalId: 'a1', isDirty: true, label: 'second' },
          ],
          createdIds: ['a0', 'a1']
        },
      ],
      selectedAnnotationId: 'a1',
      selectedAnnotationIds: new Set(['a1']),
      matchesSavedAnnotation: matchesMockAnnotation,
    });

    expect(reconciled.annotations).toEqual([
      { id: 'a0', originalId: 'a0', isDirty: false, label: 'first' },
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'second' },
    ]);
    expect(reconciled.selectedAnnotationId).toBe('a0');
    expect(Array.from(reconciled.selectedAnnotationIds)).toEqual(['a0']);
  });

  test('reindexes selected IDs when a lower ephemeral annotation is removed', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'moved-name' },
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'pan' },
    ];

    const reconciled = reconcileSavedAnnotationState({
      annotations,
      removedOriginalIds: ['a0'],
      createdIdBatches: [
        {
          savedAnnotations: [
            { id: 'a0', originalId: 'a0', isDirty: true, label: 'moved-name' },
          ],
          createdIds: ['a1']
        },
      ],
      selectedAnnotationId: 'a1',
      selectedAnnotationIds: new Set(['a0', 'a1']),
      matchesSavedAnnotation: matchesMockAnnotation,
    });

    expect(reconciled.annotations).toEqual([
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'moved-name' },
      { id: 'a0', originalId: 'a0', isDirty: false, label: 'pan' },
    ]);
    expect(reconciled.selectedAnnotationId).toBe('a0');
    expect(Array.from(reconciled.selectedAnnotationIds)).toEqual(['a1', 'a0']);
  });

  test('preserves empty selection state and leaves non-ephemeral IDs unchanged', () => {
    const annotations: MockAnnotation[] = [
      { id: 'local-1', originalId: undefined, isDirty: true, label: 'new-local' },
    ];

    const reconciled = reconcileSavedAnnotationState({
      annotations,
      removedOriginalIds: [],
      createdIdBatches: [
        { savedAnnotations: [{ id: 'local-1', originalId: undefined, isDirty: true, label: 'new-local' }], createdIds: [] },
      ],
      selectedAnnotationId: null,
      selectedAnnotationIds: new Set(),
      matchesSavedAnnotation: matchesMockAnnotation,
    });

    expect(reconciled.annotations).toEqual([
      { id: 'local-1', originalId: undefined, isDirty: false, label: 'new-local' },
    ]);
    expect(reconciled.selectedAnnotationId).toBeNull();
    expect(reconciled.selectedAnnotationIds).toEqual(new Set());
  });

  test('shifts dirty annotations that were not part of the completed save attempt when lower ids were removed', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'saved' },
      { id: 'a2', originalId: 'a2', isDirty: true, label: 'pending' },
    ];

    const reconciled = reconcileSavedAnnotationState({
      annotations,
      removedOriginalIds: ['a0'],
      createdIdBatches: [
        {
          savedAnnotations: [
            { id: 'a0', originalId: 'a0', isDirty: true, label: 'moved-name' },
          ],
          createdIds: ['a1']
        },
      ],
      selectedAnnotationId: 'a2',
      selectedAnnotationIds: new Set(['a2']),
      matchesSavedAnnotation: matchesMockAnnotation,
    });

    expect(reconciled.annotations).toEqual([
      { id: 'a0', originalId: 'a0', isDirty: false, label: 'saved' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'pending' },
    ]);
    expect(reconciled.selectedAnnotationId).toBe('a1');
    expect(Array.from(reconciled.selectedAnnotationIds)).toEqual(['a1']);
  });

  test('remaps pending dirty selection away from a recreated annotation id', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-now' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'edited-later' },
    ];

    const reconciled = reconcileSavedAnnotationState({
      annotations,
      removedOriginalIds: ['a0'],
      createdIdBatches: [
        {
          savedAnnotations: [
            { id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-now' },
          ],
          createdIds: ['a1']
        },
      ],
      selectedAnnotationId: 'a1',
      selectedAnnotationIds: new Set(['a0', 'a1']),
      matchesSavedAnnotation: matchesMockAnnotation,
    });

    expect(reconciled.annotations).toEqual([
      { id: 'a1', originalId: 'a1', isDirty: false, label: 'saved-now' },
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'edited-later' },
    ]);
    expect(reconciled.selectedAnnotationId).toBe('a0');
    expect(reconciled.selectedAnnotationIds).toEqual(new Set(['a1', 'a0']));
  });

  test('shifts multiple pending dirty annotations in the selection set after a lower-id recreation', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-now' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'edited-later-first' },
      { id: 'a2', originalId: 'a2', isDirty: true, label: 'edited-later-second' },
    ];

    const reconciled = reconcileSavedAnnotationState({
      annotations,
      removedOriginalIds: ['a0'],
      createdIdBatches: [
        {
          savedAnnotations: [
            { id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-now' },
          ],
          createdIds: ['a2']
        },
      ],
      selectedAnnotationId: 'a2',
      selectedAnnotationIds: new Set(['a1', 'a2']),
      matchesSavedAnnotation: matchesMockAnnotation,
    });

    expect(reconciled.annotations).toEqual([
      { id: 'a2', originalId: 'a2', isDirty: false, label: 'saved-now' },
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'edited-later-first' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'edited-later-second' },
    ]);
    expect(reconciled.selectedAnnotationId).toBe('a1');
    expect(reconciled.selectedAnnotationIds).toEqual(new Set(['a0', 'a1']));
  });

  test('updates the next-save removal target for a pending dirty annotation after a lower-id recreation', () => {
    const annotations: MockAnnotation[] = [
      { id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-now' },
      { id: 'a1', originalId: 'a1', isDirty: true, label: 'edited-later' },
    ];

    const reconciled = reconcileSavedAnnotationState({
      annotations,
      removedOriginalIds: ['a0'],
      createdIdBatches: [
        {
          savedAnnotations: [
            { id: 'a0', originalId: 'a0', isDirty: true, label: 'saved-now' },
          ],
          createdIds: ['a1']
        },
      ],
      selectedAnnotationId: null,
      selectedAnnotationIds: new Set(),
      matchesSavedAnnotation: matchesMockAnnotation,
    });

    const nextRemovalTargets = reconciled.annotations
      .filter(annotation => annotation.isDirty && annotation.originalId)
      .map(annotation => annotation.originalId);

    expect(nextRemovalTargets).toEqual(['a0']);
  });
});
