const EPHEMERAL_ANNOTATION_ID_PATTERN = /^a(\d+)$/;

export interface AnnotationIdRemapShape {
  id: string;
  originalId?: string;
  isDirty: boolean;
}

export interface AnnotationIdRemapBatch<T extends AnnotationIdRemapShape = AnnotationIdRemapShape> {
  savedAnnotations: T[];
  createdIds: string[];
}

export interface ReconcileSavedAnnotationStateParams<T extends AnnotationIdRemapShape> {
  annotations: T[];
  removedOriginalIds: string[];
  createdIdBatches: AnnotationIdRemapBatch<T>[];
  selectedAnnotationId: string | null;
  selectedAnnotationIds: Set<string>;
  matchesSavedAnnotation: (liveAnnotation: T, savedAnnotation: T) => boolean;
}

export interface ReconcileSavedAnnotationStateResult<T extends AnnotationIdRemapShape> {
  annotations: T[];
  selectedAnnotationId: string | null;
  selectedAnnotationIds: Set<string>;
}

function parseEphemeralAnnotationIndex(id: string): number | null {
  const match = EPHEMERAL_ANNOTATION_ID_PATTERN.exec(id);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

export function parseRemovedEphemeralIndices(annotationIds: string[]): number[] {
  return Array.from(new Set(
    annotationIds
      .map(parseEphemeralAnnotationIndex)
      .filter((index): index is number => index !== null)
  )).sort((a, b) => a - b);
}

export function shiftEphemeralAnnotationId(id: string, removedIndices: number[]): string {
  const currentIndex = parseEphemeralAnnotationIndex(id);
  if (currentIndex === null || removedIndices.length === 0) return id;

  let shiftCount = 0;
  for (const removedIndex of removedIndices) {
    if (removedIndex < currentIndex) {
      shiftCount += 1;
    }
  }

  return `a${Math.max(0, currentIndex - shiftCount)}`;
}

function buildSaveSlotsById<T extends AnnotationIdRemapShape>(
  createdIdBatches: AnnotationIdRemapBatch<T>[]
): Map<string, Array<{ savedAnnotation: T; createdId?: string }>> {
  const saveSlotsById = new Map<string, Array<{ savedAnnotation: T; createdId?: string }>>();

  for (const batch of createdIdBatches) {
    for (let index = 0; index < batch.savedAnnotations.length; index += 1) {
      const savedAnnotation = batch.savedAnnotations[index];
      if (!savedAnnotation) continue;

      const existing = saveSlotsById.get(savedAnnotation.id);
      const slot = { savedAnnotation, createdId: batch.createdIds[index] };
      if (existing) {
        existing.push(slot);
      } else {
        saveSlotsById.set(savedAnnotation.id, [slot]);
      }
    }
  }

  return saveSlotsById;
}

function remapShiftedAnnotationIds<T extends AnnotationIdRemapShape>(
  annotation: T,
  removedIndices: number[]
): T {
  const shiftedId = shiftEphemeralAnnotationId(annotation.id, removedIndices);
  const shiftedOriginalId = annotation.originalId
    ? shiftEphemeralAnnotationId(annotation.originalId, removedIndices)
    : annotation.originalId;

  if (shiftedId === annotation.id && shiftedOriginalId === annotation.originalId) {
    return annotation;
  }

  return {
    ...annotation,
    id: shiftedId,
    originalId: shiftedOriginalId,
  };
}

function buildFirstRemappedIdByOldId<T extends AnnotationIdRemapShape>(
  annotations: T[],
  nextAnnotations: T[]
): Map<string, string> {
  const firstRemappedIdByOldId = new Map<string, string>();

  for (let index = 0; index < annotations.length; index += 1) {
    const annotation = annotations[index];
    const nextAnnotation = nextAnnotations[index];
    if (!annotation || !nextAnnotation || firstRemappedIdByOldId.has(annotation.id)) continue;
    firstRemappedIdByOldId.set(annotation.id, nextAnnotation.id);
  }

  return firstRemappedIdByOldId;
}

export function remapSavedAnnotationIds<T extends AnnotationIdRemapShape>(
  annotations: T[],
  removedOriginalIds: string[],
  createdIdBatches: AnnotationIdRemapBatch<T>[],
  matchesSavedAnnotation: (liveAnnotation: T, savedAnnotation: T) => boolean
): T[] {
  const removedIndices = parseRemovedEphemeralIndices(removedOriginalIds);
  const saveSlotsById = buildSaveSlotsById(createdIdBatches);

  const consumedSaveSlots = new Map<string, number>();

  return annotations.map(annotation => {
    if (annotation.isDirty) {
      const slots = saveSlotsById.get(annotation.id);
      const consumed = consumedSaveSlots.get(annotation.id) ?? 0;
      const slot = slots?.[consumed];
      if (!slot) {
        return remapShiftedAnnotationIds(annotation, removedIndices);
      }

      consumedSaveSlots.set(annotation.id, consumed + 1);

      if (!slot.createdId) {
        if (!matchesSavedAnnotation(annotation, slot.savedAnnotation)) {
          return remapShiftedAnnotationIds(annotation, removedIndices);
        }
        return {
          ...annotation,
          isDirty: false,
        };
      }

      if (!matchesSavedAnnotation(annotation, slot.savedAnnotation)) {
        return {
          ...annotation,
          id: slot.createdId,
          originalId: slot.createdId,
        };
      }

      return {
        ...annotation,
        id: slot.createdId,
        originalId: slot.createdId,
        isDirty: false,
      };
    }

    return remapShiftedAnnotationIds(annotation, removedIndices);
  });
}

export function reconcileSavedAnnotationState<T extends AnnotationIdRemapShape>({
  annotations,
  removedOriginalIds,
  createdIdBatches,
  selectedAnnotationId,
  selectedAnnotationIds,
  matchesSavedAnnotation,
}: ReconcileSavedAnnotationStateParams<T>): ReconcileSavedAnnotationStateResult<T> {
  const nextAnnotations = remapSavedAnnotationIds(
    annotations,
    removedOriginalIds,
    createdIdBatches,
    matchesSavedAnnotation
  );

  const removedIndices = parseRemovedEphemeralIndices(removedOriginalIds);
  const firstRemappedIdByOldId = buildFirstRemappedIdByOldId(annotations, nextAnnotations);

  const remapSelectedId = (id: string): string => {
    const remappedId = firstRemappedIdByOldId.get(id);
    if (remappedId) return remappedId;
    return shiftEphemeralAnnotationId(id, removedIndices);
  };

  return {
    annotations: nextAnnotations,
    selectedAnnotationId: selectedAnnotationId ? remapSelectedId(selectedAnnotationId) : null,
    selectedAnnotationIds: new Set(Array.from(selectedAnnotationIds, remapSelectedId)),
  };
}
