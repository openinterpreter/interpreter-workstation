export interface BrowserPageTargetIdentityInput {
  tabRef: string;
  chromeTabId: number;
  browserWindowId: number | null;
  browserProfilePolicyId: string;
  origin: string | null;
  frameId: number;
  chromeDocumentId: string | null;
  documentRevision: string;
  url: string;
}

export interface BrowserPageTargetIdentity {
  tabRef: string;
  frameId: number;
}

export const browserPageTargetIdentityInputSchema = {
  type: 'object',
  description: 'The browser-page target_identity object copied from browser page element refs in whole-computer state or browser page inspect output.',
  properties: {
    kind: { type: 'string' },
    browser_profile_policy_id: { type: 'string' },
    tab_ref: { type: 'string' },
    chrome_tab_id: { type: 'number' },
    browser_window_id: { type: ['number', 'null'] },
    frame_id: { type: 'number' },
    chrome_document_id: { type: ['string', 'null'] },
    document_revision: { type: 'string' },
    origin: { type: ['string', 'null'] },
    url: { type: 'string' },
    coordinate_space: { type: 'string' },
    ref_lifetime: { type: 'string' },
    ref_invalidation_rules: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: [
    'kind',
    'browser_profile_policy_id',
    'tab_ref',
    'chrome_tab_id',
    'frame_id',
    'document_revision',
    'coordinate_space',
    'ref_lifetime',
  ],
} as const;

export function buildBrowserPageTargetIdentity(input: BrowserPageTargetIdentityInput): Record<string, unknown> {
  return {
    kind: 'browser-page',
    browser_profile_policy_id: input.browserProfilePolicyId,
    tab_ref: input.tabRef,
    chrome_tab_id: input.chromeTabId,
    browser_window_id: input.browserWindowId,
    frame_id: input.frameId,
    chrome_document_id: input.chromeDocumentId,
    document_revision: input.documentRevision,
    origin: input.origin,
    url: input.url,
    coordinate_space: 'browser-viewport-css-px',
    ref_lifetime: 'current_document_revision',
    ref_invalidation_rules: [
      'browser_profile_mismatch',
      'browser_tab_mismatch',
      'browser_frame_mismatch',
      'browser_document_revision_mismatch',
    ],
  };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`target_identity.${key} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`target_identity.${key} must be a non-negative integer.`);
  }
  return value;
}

export function parseBrowserPageTargetIdentityArg(value: unknown): BrowserPageTargetIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('target_identity must be a browser-page object copied from a current browser page ref.');
  }

  const record = value as Record<string, unknown>;
  if (record.kind !== 'browser-page') {
    throw new Error('target_identity.kind must be "browser-page".');
  }
  requiredString(record, 'browser_profile_policy_id');
  const tabRef = requiredString(record, 'tab_ref');
  requiredNonNegativeInteger(record, 'chrome_tab_id');
  const frameId = requiredNonNegativeInteger(record, 'frame_id');
  requiredString(record, 'document_revision');
  if (record.coordinate_space !== 'browser-viewport-css-px') {
    throw new Error('target_identity.coordinate_space must be "browser-viewport-css-px".');
  }
  if (record.ref_lifetime !== 'current_document_revision') {
    throw new Error('target_identity.ref_lifetime must be "current_document_revision".');
  }

  return { tabRef, frameId };
}
