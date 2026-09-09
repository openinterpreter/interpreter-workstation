# PII-Aware Redacted Content System

## Destination

A system where extracted documents are stored as redacted markdown in LanceDB (no PII in vectors), displayed to users as Tiptap editors with colored inline PII labels that can be clicked to reveal originals via vault decrypt, and where the composer detects PII in real-time (regex instantly, NER on submit) so LLM-bound text is always redacted.

---

## Architecture

### The Three Flows

#### Flow 1: Extraction → Redacted LanceDB

```
Document enters system
  → basemind scan (existing pipeline)
  → xberg::redact(text, config)  [already implemented]
  → produces: redacted_markdown + rehydration_map
  → rehydration_map encrypted via vault tool → stored {appData}/vaults/{docId}.enc
  → redacted_markdown → LanceDB documents table (text column)
  → embedding computed on redacted text (no PII in vectors)
  → original.md stays on disk (never indexed)
```

Gap to close: Wire `basemind redact` into `main.rs`, add extraction config to enable redaction per-document-type, add `rehydration_ref` column to LanceDB documents schema.

#### Flow 2: Composer Real-Time PII

```
User types in BaseTiptapComposer
  → RegexDetector: instant, zero-cost (email, phone, IBAN, IPv4, credit card)
  → colored inline decorations on every keystroke
  → On submit/blur:
    → IPC to main process PiiDetectionService (181 MB GLiNER PII model)
    → receives full detections (names, orgs, locations)
    → updates decorations with proper labels
    → serializes redacted text for LLM
    → rehydration_map encrypted → vault store
```

#### Flow 3: Viewer Redacted Document

```
User opens document
  → MarkdownViewer loads redacted.md (from LanceDB or disk)
  → markdownToTiptap(redactedBody) → TipTap JSON
  → PiiLabelExtension (mode: view) activates
  → Scans for [TYPE_N] tokens in text
  → Renders colored inline decorations
  → User clicks label → IPC → main → vault.decrypt → show original
  → User can toggle "Show Originals" to reveal all
  → User can edit label text → saves to redacted.md
```

### System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  BASEMIND (Rust subprocess)                                      │
│                                                                  │
│  Extraction pipeline:                                            │
│    xberg::extract → xberg::redact → redacted markdown            │
│    rehydration_map → vault encrypt → {appData}/vaults/           │
│                                                                  │
│  673 MB GLiNER model (gliner_small-v2.5) for extraction NER      │
│  MCP tools: vault (encrypt/decrypt/find/forget/inspect)          │
│  New: redact_text MCP tool (wraps xberg::redact)                │
│  New: rehydration_ref column in LanceDB documents table          │
└──────────┬──────────────────────────────────────────────────────┘
           │ MCP stdio (50-500ms, batch only)
           │
┌──────────▼──────────────────────────────────────────────────────┐
│  MAIN PROCESS (Node.js)                                         │
│                                                                  │
│  PiiDetectionService                                             │
│    onnxruntime-node + gliner-pii-edge (181 MB, lazy singleton)  │
│    Loads from basemind cache (no duplicate download)             │
│    detectPii(text) → [{category, start, end, confidence}]       │
│    Fallback: if model unavailable → MCP to basemind              │
│                                                                  │
│  Vault decrypt (existing MCP → basemind vault tool)              │
│  Smart Turn, Silero VAD, TTS (existing pattern)                  │
└──────────┬──────────────────────────────────────────────────────┘
           │ IPC (~1ms)
           │
┌──────────▼──────────────────────────────────────────────────────┐
│  RENDERER (Electron Chromium)                                    │
│                                                                  │
│  PiiLabelExtension (shared Tiptap extension)                     │
│    mode: view — scans [TYPE_N] tokens, colored decorations       │
│    mode: compose — regex instant + IPC NER on submit             │
│                                                                  │
│  PiiRegexDetector (instant, zero-cost)                           │
│    email, phone, IBAN, IPv4, credit card regex patterns          │
│                                                                  │
│  PiiColorConfig — category → CSS variable mapping                │
│                                                                  │
│  MarkdownViewer (viewer mode)                                    │
│  BaseTiptapComposer (compose mode)                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. PiiDetectionService (`server/services/piiDetection.ts`)

Main process service wrapping a 181 MB PII-specific GLiNER model (`gliner-pii-edge-v1.0`) via `onnxruntime-node`.

**Pattern**: Lazy singleton, same as `smartTurnService.ts`.

```typescript
// Loads from basemind's model cache — no duplicate download
const modelPath = path.join(
  app.getPath('home'),
  '.local/share/basemind/hub/models--xberg-io--gliner-pii-models/snapshots/<rev>/model.onnx'
);

interface PiiDetection {
  category: string;     // 'email' | 'person_full_name' | 'phone' | etc.
  start: number;
  end: number;
  text: string;
  confidence: number;
}

async function detectPii(text: string, options?: {
  categories?: string[];
  minConfidence?: number;
}): Promise<PiiDetection[]>;
```

**Key behaviors**:
- Lazy load on first call, then kept in memory
- Concurrency guard (no double-load)
- Error recovery (reset loadPromise on failure)
- Fallback to MCP `redact_text` tool if model not available
- Configurable confidence thresholds per category (same as basemind's `pii/pipeline.rs`)

### 2. PiiLabelExtension (`src/extensions/PiiLabel.ts`)

Shared Tiptap extension with two modes. Uses ProseMirror `Plugin` + `Decoration.inline()` — same pattern as `UnlinkedMentionSuggestions.ts`.

**View mode** (MarkdownViewer):
- Scans document text for `[TYPE_N]` tokens (regex: `/\[(EMAIL|NAME|IBAN|PHONE|...)_(\d+)\]/g`)
- Renders colored inline decorations per category
- Click handler: IPC to main → vault.decrypt(rehydrationRef) → show original value
- Toggle "Show Originals": replaces all decorations with decrypted values
- Edit: user changes label text → saves back to disk

**Compose mode** (BaseTiptapComposer):
- ProseMirror plugin fires on document changes
- Phase 1 (instant): PiiRegexDetector scans for structured PII → colored decorations
- Phase 2 (on submit): IPC to PiiDetectionService → full NER detections → update decorations
- On send: serialize redacted version of text for LLM

**Shared**:
- PiiCategory → color mapping (CSS variables, supports light/dark theme)
- Decoration spec (consistent across modes)
- Click handler pattern

### 3. PiiRegexDetector (`src/lib/pii/regex-detector.ts`)

Lightweight regex detector for instant feedback in the composer. Zero model dependency.

```typescript
const PATTERNS: { category: string; regex: RegExp }[] = [
  { category: 'email', regex: /[\w.+-]+@[\w-]+\.[\w.]+/g },
  { category: 'phone', regex: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g },
  { category: 'ipv4', regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { category: 'credit_card', regex: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g },
  { category: 'iban', regex: /\b[A-Z]{2}\d{2}[\s]?[\dA-Z]{4}[\s]?(?:[\dA-Z]{4}[\s]?){1,7}[\dA-Z]{1,4}\b/g },
];

function detectRegex(text: string): PiiDetection[];
```

### 4. PiiColorConfig (`src/lib/pii/colors.ts`)

Category → color mapping. Uses CSS custom properties for light/dark theme support.

```typescript
const PII_COLORS: Record<string, { light: string; dark: string; label: string }> = {
  email:              { light: '#3b82f6', dark: '#60a5fa', label: 'Email' },
  person_full_name:   { light: '#10b981', dark: '#34d399', label: 'Name' },
  phone:              { light: '#8b5cf6', dark: '#a78bfa', label: 'Phone' },
  iban:               { light: '#ef4444', dark: '#f87171', label: 'IBAN' },
  credit_card:        { light: '#f59e0b', dark: '#fbbf24', label: 'Card' },
  address:            { light: '#ec4899', dark: '#f472b6', label: 'Address' },
  organization:       { light: '#06b6d4', dark: '#22d3ee', label: 'Org' },
  ipv4:               { light: '#6366f1', dark: '#818cf8', label: 'IP' },
  // ... all 40+ categories from PiiCategory enum
};
```

### 5. IPC Channels

**New channels in `src/ipc.ts`:**

```typescript
interface PiiIpc {
  detectPii(text: string, options?: { categories?: string[] }): Promise<PiiDetection[]>;
  decryptRehydration(docId: string, passphrase: string): Promise<Record<string, string>>;
}

export const pii: PiiIpc = client.pii;
```

**New handlers in `server/routes/ipc.ts`:**

```typescript
pii: {
  detectPii: async ([text, options]) => piiDetectionService.detectPii(text, options),
  decryptRehydration: async ([docId, passphrase]) => vaultManager.decrypt(docId, passphrase),
}
```

### 6. LanceDB Schema Update (`basemind/src/lance/schema.rs`)

Add `rehydration_ref` column to `documents` table:

```rust
// New column in documents schema
Field::new("rehydration_ref", DataType::Utf8, true), // nullable, vault key
```

### 7. Basemind `redact` CLI Wiring (`basemind/src/main.rs`)

Add `Redact` variant to `Cmd` enum. The implementation already exists in `cli/redact.rs`.

### 8. `redact_text` MCP Tool (`basemind/src/mcp/tools_redact.rs`)

New MCP tool wrapping `xberg::text::redaction::redact()`:

```rust
#[rmcp::tool_router]
pub fn tool_redact_text(
    TextRedactArgs { text, strategy, categories, custom_patterns }: TextRedactArgs,
) -> Result<McpContent, McpError> {
    let config = RedactionConfig::from_args(strategy, categories, custom_patterns);
    let result = xberg::text::redaction::redact(&text, &config.to_xberg())?;
    Ok(McpContent::json(serde_json::json!({
        "redacted_text": result.redacted_text,
        "rehydration_map": result.rehydration_map,
        "detections": result.detections,
    })))
}
```

---

## Data Flow Details

### Extraction (dual artifact)

```
basemind scan
  → extract_doc() → DocChunk[] with original text
  → redact(original_text, config) → { redacted_text, rehydration_map }
  → encrypted_map = vault.encrypt(rehydration_map, passphrase)
  → persist encrypted_map → {appData}/vaults/{docId}.enc
  → store in LanceDB:
      text: redacted_text          (for embedding + search)
      rehydration_ref: docId       (vault key for decrypt)
  → original.md stays on disk
  → redacted.md optionally saved as .redacted/ shadow file
```

### Composer (regex + NER)

```
Keystroke → PiiRegexDetector(text) → regex detections → colored decorations
           (instant, zero latency)

Submit → serializeEditorWithAttachments() → raw text
       → IPC detectPii(text) → main process
       → onnxruntime GLiNER inference (181 MB model, ~50-200ms)
       → returns: [{category, start, end, text, confidence}]
       → merge with regex detections (regex as fallback for missed items)
       → update decorations
       → serialize redacted version: replace PII spans with [TYPE_N]
       → send redacted text to LLM
       → vault.encrypt(rehydrationMap) → persist
```

### Viewer (label display + revert)

```
MarkdownViewer loads document
  → if from LanceDB: redacted text already in query result
  → if from disk: read .redacted/ shadow or original
  → markdownToTiptap(redactedBody) → TipTap JSON
  → PiiLabelExtension (mode: view)
    → scan for [TYPE_N] tokens
    → render colored inline decorations
  → user clicks [EMAIL_0]
    → IPC decryptRehydration(docId, passphrase)
    → main → basemind vault.decrypt(encryptedBlob, passphrase)
    → returns: "[EMAIL_0]" → "john@example.com"
    → decoration updates to show "john@example.com"
  → toggle "Show Originals"
    → decrypt all tokens → replace decorations with original values
  → edit label → save redacted.md back to disk
```

---

## Model Strategy

| Model | Size | Location | Purpose |
|---|---|---|---|
| `gliner_small-v2.5` | 673 MB | basemind process | Extraction NER (runs once per document) |
| `gliner-pii-edge-v1.0` | 181 MB | Electron main process | Real-time PII detection (composer) |

- Both downloaded via basemind's model download flow
- Electron reads from basemind's cache directory (`~/.local/share/basemind/hub/`)
- No duplicate downloads — same cache, different processes
- Fallback: if PII edge model not available, composer falls back to MCP `redact_text` tool

---

## Testing Strategy

- Unit: PiiRegexDetector (test regex patterns against known PII strings)
- Unit: PiiColorConfig (category → color mapping)
- Integration: PiiDetectionService (load model, run detection, verify output shape)
- Integration: PiiLabelExtension (mount editor, inject [TYPE_N] tokens, verify decorations render)
- E2E: Composer flow (type PII → see labels → submit → verify redacted text sent)
- E2E: Viewer flow (open redacted doc → see labels → click → see original)

---

## Out of Scope

- Custom PII patterns per-user (future: extend PiiDetectionService config)
- PII detection in code files (extraction handles this, not real-time)
- Cross-document PII correlation
- PII audit dashboard (uses existing GDPR audit trail in PiiEntity)
