const FIELD_LIKE_AX_ROLES = new Set([
  'AXTextField',
  'AXTextArea',
  'AXSearchField',
  'AXSecureTextField',
  'AXComboBox',
  'AXPopUpButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXDateField',
  'AXTimeField',
]);

const FALLBACK_INTERACTIVE_AX_ROLES = new Set([
  ...FIELD_LIKE_AX_ROLES,
  'AXButton',
  'AXMenuButton',
  'AXMenuItem',
  'AXMenuBarItem',
  'AXLink',
  'AXSlider',
]);
const SUPPLEMENTAL_FORM_CONTROL_AX_ROLES = new Set([
  'AXButton',
  'AXMenuButton',
  'AXCheckBox',
  'AXRadioButton',
]);
const FORM_ACTION_MAX_VERTICAL_GAP = 240;
const FORM_ACTION_HORIZONTAL_MARGIN = 48;
const TITLEBAR_CONTROL_MAX_Y_OFFSET = 34;
const TITLEBAR_CONTROL_MAX_SIZE = 32;
const MIN_FALLBACK_REGION_WINDOW_AREA_RATIO = 0.08;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeBounds(bounds) {
  if (!bounds || !isFiniteNumber(bounds.x) || !isFiniteNumber(bounds.y) || !isFiniteNumber(bounds.width) || !isFiniteNumber(bounds.height)) {
    return null;
  }

  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height);
  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: bounds.x,
    y: bounds.y,
    width,
    height,
  };
}

function getBoundsArea(bounds) {
  return bounds.width * bounds.height;
}

function intersectBounds(left, right) {
  const normalizedLeft = normalizeBounds(left);
  const normalizedRight = normalizeBounds(right);
  if (!normalizedLeft || !normalizedRight) {
    return null;
  }

  const x = Math.max(normalizedLeft.x, normalizedRight.x);
  const y = Math.max(normalizedLeft.y, normalizedRight.y);
  const rightEdge = Math.min(normalizedLeft.x + normalizedLeft.width, normalizedRight.x + normalizedRight.width);
  const bottomEdge = Math.min(normalizedLeft.y + normalizedLeft.height, normalizedRight.y + normalizedRight.height);
  const width = rightEdge - x;
  const height = bottomEdge - y;

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { x, y, width, height };
}

function unionBounds(boundsList) {
  const normalized = boundsList.map(normalizeBounds).filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }

  const left = Math.min(...normalized.map((bounds) => bounds.x));
  const top = Math.min(...normalized.map((bounds) => bounds.y));
  const right = Math.max(...normalized.map((bounds) => bounds.x + bounds.width));
  const bottom = Math.max(...normalized.map((bounds) => bounds.y + bounds.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function expandBoundsWithinWindow(bounds, windowBounds, padding) {
  const normalizedBounds = normalizeBounds(bounds);
  const normalizedWindowBounds = normalizeBounds(windowBounds);
  if (!normalizedBounds || !normalizedWindowBounds) {
    return null;
  }

  const inset = Math.max(0, Number(padding) || 0);
  const x = Math.max(normalizedWindowBounds.x, Math.floor(normalizedBounds.x - inset));
  const y = Math.max(normalizedWindowBounds.y, Math.floor(normalizedBounds.y - inset));
  const right = Math.min(
    normalizedWindowBounds.x + normalizedWindowBounds.width,
    Math.ceil(normalizedBounds.x + normalizedBounds.width + inset),
  );
  const bottom = Math.min(
    normalizedWindowBounds.y + normalizedWindowBounds.height,
    Math.ceil(normalizedBounds.y + normalizedBounds.height + inset),
  );

  return normalizeBounds({
    x,
    y,
    width: right - x,
    height: bottom - y,
  });
}

function collectCandidateBounds(elements, windowBounds, roleSet) {
  return elements
    .map((element) => ({
      role: String(element?.role || '').trim(),
      bounds: intersectBounds(element?.bbox, windowBounds),
    }))
    .filter((element) => element.bounds && roleSet.has(element.role) && getBoundsArea(element.bounds) >= 24)
    .map((element) => element.bounds);
}

function isTitlebarChromeBounds(bounds, windowBounds) {
  const normalizedBounds = normalizeBounds(bounds);
  const normalizedWindowBounds = normalizeBounds(windowBounds);
  if (!normalizedBounds || !normalizedWindowBounds) {
    return false;
  }

  const yOffset = normalizedBounds.y - normalizedWindowBounds.y;
  return yOffset >= 0
    && yOffset <= TITLEBAR_CONTROL_MAX_Y_OFFSET
    && normalizedBounds.width <= TITLEBAR_CONTROL_MAX_SIZE
    && normalizedBounds.height <= TITLEBAR_CONTROL_MAX_SIZE;
}

function collectSupplementalFormBounds(elements, windowBounds, fieldUnion) {
  const normalizedFieldUnion = normalizeBounds(fieldUnion);
  if (!normalizedFieldUnion) {
    return [];
  }

  const horizontalMin = normalizedFieldUnion.x - FORM_ACTION_HORIZONTAL_MARGIN;
  const horizontalMax = normalizedFieldUnion.x + normalizedFieldUnion.width + FORM_ACTION_HORIZONTAL_MARGIN;
  const fieldTop = normalizedFieldUnion.y;
  const fieldBottom = normalizedFieldUnion.y + normalizedFieldUnion.height;

  return elements
    .map((element) => ({
      role: String(element?.role || '').trim(),
      bounds: intersectBounds(element?.bbox, windowBounds),
    }))
    .filter(({ role, bounds }) => {
      if (!bounds || !SUPPLEMENTAL_FORM_CONTROL_AX_ROLES.has(role) || getBoundsArea(bounds) < 24) {
        return false;
      }

      const boundsLeft = bounds.x;
      const boundsRight = bounds.x + bounds.width;
      const boundsTop = bounds.y;
      const boundsBottom = bounds.y + bounds.height;
      const overlapsHorizontalBand = boundsRight >= horizontalMin && boundsLeft <= horizontalMax;
      const overlapsVerticalBand = boundsBottom >= fieldTop && boundsTop <= fieldBottom + FORM_ACTION_MAX_VERTICAL_GAP;

      return overlapsHorizontalBand && overlapsVerticalBand;
    })
    .map(({ bounds }) => bounds);
}

function deriveAxFormRegion(options) {
  const windowBounds = normalizeBounds(options?.windowBounds);
  if (!windowBounds) {
    return null;
  }

  const elements = Array.isArray(options?.elements) ? options.elements : [];
  const padding = Math.max(0, Number(options?.padding) || 0);

  const fieldLikeBounds = collectCandidateBounds(elements, windowBounds, FIELD_LIKE_AX_ROLES);
  const candidateBounds = fieldLikeBounds.length > 0
    ? (() => {
        const fieldUnion = unionBounds(fieldLikeBounds);
        return [
          ...fieldLikeBounds,
          ...collectSupplementalFormBounds(elements, windowBounds, fieldUnion),
        ];
      })()
    : collectCandidateBounds(elements, windowBounds, FALLBACK_INTERACTIVE_AX_ROLES)
        .filter((bounds) => !isTitlebarChromeBounds(bounds, windowBounds));

  if (candidateBounds.length === 0) {
    return null;
  }

  const candidateUnion = unionBounds(candidateBounds);
  if (
    fieldLikeBounds.length === 0
    && getBoundsArea(candidateUnion) / getBoundsArea(windowBounds) < MIN_FALLBACK_REGION_WINDOW_AREA_RATIO
  ) {
    return null;
  }

  return expandBoundsWithinWindow(candidateUnion, windowBounds, padding);
}

function deriveWindowFormRegion(options) {
  const windowBounds = normalizeBounds(options?.windowBounds);
  if (!windowBounds) {
    return null;
  }

  const padding = Math.max(0, Number(options?.padding) || 0);
  return expandBoundsWithinWindow(windowBounds, windowBounds, padding);
}

function buildMouseDragPath(bounds, options = {}) {
  const normalizedBounds = normalizeBounds(bounds);
  if (!normalizedBounds) {
    return [];
  }

  const segments = Math.max(2, Math.round(options.segments ?? 8));
  const maxInset = Math.max(0, Math.min(normalizedBounds.width, normalizedBounds.height) / 2 - 1);
  const requestedInset = Math.max(0, Number(options.inset) || 0);
  const inset = Math.min(requestedInset, maxInset);
  const startX = normalizedBounds.x + inset;
  const startY = normalizedBounds.y + inset;
  const endX = normalizedBounds.x + normalizedBounds.width - inset;
  const endY = normalizedBounds.y + normalizedBounds.height - inset;
  const path = [];

  for (let index = 0; index < segments; index += 1) {
    const progress = segments === 1 ? 1 : index / (segments - 1);
    path.push({
      x: Math.round(startX + (endX - startX) * progress),
      y: Math.round(startY + (endY - startY) * progress),
    });
  }

  return path;
}

function computeBoundsCoverage(expectedBounds, actualBounds) {
  const expected = normalizeBounds(expectedBounds);
  const actual = normalizeBounds(actualBounds);
  if (!expected || !actual) {
    return 0;
  }

  const overlap = intersectBounds(expected, actual);
  if (!overlap) {
    return 0;
  }

  return getBoundsArea(overlap) / getBoundsArea(expected);
}

module.exports = {
  FIELD_LIKE_AX_ROLES,
  FALLBACK_INTERACTIVE_AX_ROLES,
  normalizeBounds,
  intersectBounds,
  unionBounds,
  deriveAxFormRegion,
  deriveWindowFormRegion,
  buildMouseDragPath,
  computeBoundsCoverage,
};
