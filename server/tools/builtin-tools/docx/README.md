# DOCX Edit Tool - Technical Documentation

## Table of Contents
- [Low-Level Technical Explanation](#low-level-technical-explanation)
  - [The Core Problem](#the-core-problem)
  - [Two-Pronged Solution Architecture](#two-pronged-solution-architecture)
  - [Simple Replacement Flow](#simple-replacement-flow)
  - [Smart AI-Powered Replacement Flow](#smart-ai-powered-replacement-flow)
  - [Verification System](#verification-system)
- [High-Level Abstraction](#high-level-abstraction)
  - [What This Tool Does](#what-this-tool-does)
  - [When to Use Each Mode](#when-to-use-each-mode)
  - [Architecture Overview](#architecture-overview)
  - [Key Design Decisions](#key-design-decisions)

---

## Low-Level Technical Explanation

### The Core Problem

Word documents (.docx files) are actually ZIP archives containing XML files. The main content lives in `word/document.xml`, but the text isn't stored as simple strings. Instead, it's fragmented across a complex hierarchy:

```xml
<w:p>  <!-- Paragraph -->
  <w:r>  <!-- Run 1 -->
    <w:rPr>  <!-- Run properties (bold, italic, etc.) -->
    <w:t>Hello </w:t>  <!-- Text fragment -->
  </w:r>
  <w:r>  <!-- Run 2 -->
    <w:rPr>  <!-- Different properties -->
    <w:t>world</w:t>  <!-- Another fragment -->
  </w:r>
</w:p>
```

A single sentence like "Hello world" might be split across multiple `<w:r>` (run) elements, each with different formatting properties. This makes find-and-replace operations incredibly complex because:
1. The text you're searching for might span multiple runs
2. Each run has its own formatting that needs to be preserved
3. XML entities (`&amp;`, `&lt;`, etc.) complicate text matching

### Two-Pronged Solution Architecture

The tool implements two distinct approaches:

#### 1. **Simple Replacement** (`simpleReplaceInDocx`)
- Used when no style instructions are provided
- Attempts direct XML manipulation
- Faster but limited to inheriting existing styles

#### 2. **Smart Replacement** (`smartReplaceInDocx`)
- Used when style instructions are provided
- Leverages AI (OpenAI GPT-4) to regenerate paragraph XML
- Slower but can apply complex formatting changes

### Simple Replacement Flow

The simple replacement algorithm (`simpleReplaceInDocx`) works through multiple strategies:

#### **Strategy 1: Single Run Replacement**
```javascript
// Looks for text contained entirely within a single <w:t> element
/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
```
1. Iterates through all `<w:t>` text elements
2. Decodes XML entities (`&amp;` → `&`, etc.)
3. Checks if the decoded text contains the search string
4. If found, replaces and re-encodes XML entities
5. Respects the `replaceMultiple` flag to control single vs. all replacements

#### **Strategy 2: Cross-Run Paragraph Reconstruction**
When text spans multiple runs:

1. **Extract all runs in a paragraph:**
   ```javascript
   const paragraphRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
   ```

2. **Build a text map:**
   - Concatenates all text from runs to get the full paragraph text
   - Maintains a position index for each run:
     ```javascript
     textRuns.push({
       start: fullText.length,
       end: fullText.length + decodedContent.length,
       content: textMatch[1],
     });
     ```

3. **Calculate replacement boundaries:**
   - Finds where the old text starts/ends in the concatenated string
   - Maps these positions back to individual runs
   - Handles edge cases where replacement spans partial runs

4. **Surgical XML updates:**
   - Modifies only the affected runs
   - Preserves all XML structure and attributes
   - Maintains formatting from the first character of replaced text

#### **Error Handling with Fuzzy Matching**
If text isn't found, the `findSimilarText` function:
1. Splits search text into words (> 3 characters)
2. Slides a window across the document
3. Calculates similarity scores based on word matches
4. Suggests similar text with confidence percentages
5. Returns top 5 matches to help users identify typos

### Smart AI-Powered Replacement Flow

The smart replacement system (`smartReplaceInDocx`) uses a sophisticated marker-based approach:

#### **Phase 1: Marker Injection** (`injectMarkersIntoDocx`)

1. **Generate unique IDs for each paragraph:**
   ```javascript
   const paraId = generateParagraphId(textContent.trim(), paraCounter);
   // Uses MD5 hash of content + index, truncated to 16 chars
   ```

2. **Inject markers into XML:**
   ```xml
   <w:p>
     <w:r><w:t>[DOCX-MARKER:a1b2c3d4e5f6g7h8]</w:t></w:r>
     <!-- Original paragraph content -->
   </w:p>
   ```

3. **Build paragraph index:**
   ```javascript
   paragraphIndex[paraId] = {
     index: paraCounter++,
     originalText: decodeXmlEntities(textContent.trim()),
     originalXml: match,  // Full <w:p>...</w:p> XML
   };
   ```

#### **Phase 2: Text Extraction** (`convertDocxToPlaintext`)

1. **Uses Mammoth.js for conversion:**
   - Converts DOCX to HTML (preserving structure)
   - Normalizes block elements to newlines
   - Strips HTML tags
   - Preserves paragraph markers

2. **Text normalization:**
   ```javascript
   text = decodeXmlEntities(text)
     .replace(/\r\n/g, '\n')
     .replace(/\u00A0/g, ' ')  // Non-breaking spaces
     .replace(/[\t\v\f]/g, ' ')  // Tabs, vertical tabs, form feeds
     .replace(/\s+\n/g, '\n')    // Trailing spaces
     .replace(/\n{3,}/g, '\n\n') // Multiple newlines
   ```

#### **Phase 3: Paragraph Extraction** (`extractMarkedParagraphs`)

1. **Locate all markers:**
   ```javascript
   const markerRegex = /\[DOCX-MARKER:([a-f0-9]{16})\]/g;
   ```

2. **Extract text between markers:**
   - Each paragraph's text starts after its marker
   - Ends before the next marker (or at document end)
   - Handles edge cases like markers at line boundaries

3. **Build paragraph map:**
   ```javascript
   paragraphs[currentMarker.id] = { text: paraText };
   ```

#### **Phase 4: Edit Distribution**

1. **Find which paragraphs contain the text to replace:**
   ```javascript
   for (const [paraId, markedPara] of Object.entries(markedParagraphs)) {
     if (markedPara.text.includes(oldText)) {
       editsByParagraph[paraId].push({ oldText, newText });
     }
   }
   ```

2. **Handle discrepancies:**
   - Detects when marked text doesn't match original XML
   - Searches for the correct paragraph
   - Logs warnings about paragraph extraction bugs

#### **Phase 5: AI-Powered XML Generation** (`generateAllParagraphXmls`)

1. **Prepare AI prompt:**
   ```javascript
   // Combines all paragraphs needing edits with their IDs
   <!-- ID: a1b2c3d4e5f6g7h8 -->
   <w:p>...</w:p>

   <!-- ID: i9j0k1l2m3n4o5p6 -->
   <w:p>...</w:p>
   ```

2. **AI instructions include:**
   - Specific text replacements to make
   - Optional style instructions
   - Directive to preserve XML structure
   - Warning against truncation

3. **Retry mechanism:**
   - Up to 5 attempts with exponential backoff
   - Validates all paragraph IDs are returned
   - Uses OpenAI's prediction feature for consistency

4. **Parse AI response:**
   ```javascript
   const sections = generatedXml.split(/<!-- ID: ([a-f0-9]{16}) -->/);
   ```

#### **Phase 6: Document Reconstruction**

1. **Replace paragraphs in original XML:**
   ```javascript
   documentXml.replace(/<w:p\b([^>]*)>([\s\S]*?)<\/w:p>/g, (fullMatch) => {
     const markerMatch = /\[DOCX-MARKER:([a-f0-9]{16})\]/.exec(fullMatch);
     const newXml = paragraphUpdates[paraId];
     return newXml || fullMatch;  // Use AI version or original
   });
   ```

2. **Clean up markers from unedited paragraphs**

3. **Generate final DOCX file:**
   ```javascript
   zip.file('word/document.xml', documentXml);
   return await zip.generateAsync({ type: 'nodebuffer' });
   ```

### Verification System

Both approaches include comprehensive verification:

1. **Re-read the saved file from disk**
2. **Convert to plaintext again**
3. **Verify each edit:**
   - Check new text exists
   - Check old text is gone (unless `allowMultiple`)
   - Extract context around changes
4. **Report any verification failures**

The verification catches issues like:
- AI hallucinations or truncations
- XML parsing errors
- File system write failures
- Complex formatting preventing edits

---

## High-Level Abstraction

### What This Tool Does

This tool is a sophisticated Word document editor that can make text replacements while preserving or modifying formatting. Think of it as "find and replace on steroids" for .docx files.

### When to Use Each Mode

**Simple Mode (No `styleInstructions`):**
- ✅ Basic find and replace
- ✅ Preserves existing formatting
- ✅ Fast operation (milliseconds)
- ❌ Can't change styles
- ❌ Limited with complex formatting

**Smart Mode (With `styleInstructions`):**
- ✅ Can apply new formatting
- ✅ Handles complex document structures
- ✅ AI understands context
- ❌ Slower (1-3 seconds per operation)
- ❌ Requires OpenAI API key
- ❌ Costs API credits

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     User Request                         │
│         (path, edits[], styleInstructions?)             │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │   Load DOCX as ZIP     │
        │   Extract document.xml  │
        └────────┬───────────────┘
                 │
    ┌────────────┴────────────┐
    │                          │
    ▼                          ▼
┌─────────────────┐    ┌──────────────────┐
│  Simple Replace │    │  Smart Replace   │
│   (No AI)       │    │   (AI-Powered)   │
└─────────────────┘    └──────────────────┘
    │                          │
    │                          ├─► Inject Markers
    │                          ├─► Extract Text
    │                          ├─► Find Paragraphs
    │                          ├─► Generate with AI
    │                          │
    └───────────┬──────────────┘
                │
                ▼
        ┌──────────────┐
        │   Verify     │
        │   Save File  │
        └──────────────┘
```

### Key Design Decisions

1. **Why Two Approaches?**
   - Simple operations shouldn't require AI (cost, latency)
   - Complex formatting needs intelligence
   - Graceful degradation when AI unavailable

2. **Why Paragraph-Level AI Processing?**
   - Maintains document structure integrity
   - Reduces AI token usage
   - Allows partial failure recovery
   - Preserves untouched content exactly

3. **Why Marker System?**
   - XML is modified during Mammoth conversion
   - Need stable paragraph identification
   - Enables accurate text-to-XML mapping
   - Allows verification of AI outputs

4. **Why Extensive Verification?**
   - Word documents are critical business assets
   - AI can hallucinate or truncate
   - Users need confidence in edits
   - Provides clear error messages

5. **Why Fuzzy Matching for Errors?**
   - Users often have typos or formatting variations
   - Whitespace differences are common
   - Helps users find the right text quickly
   - Reduces frustration with exact matching

### Performance Characteristics

**Simple Mode:**
- Time: 10-50ms for most documents
- Memory: ~2x document size
- CPU: Single-threaded, minimal
- Network: None

**Smart Mode:**
- Time: 1-3 seconds per edit batch
- Memory: ~3x document size
- CPU: Moderate (XML parsing)
- Network: OpenAI API calls
- Cost: ~$0.001-0.01 per operation

### Limitations & Edge Cases

1. **Cannot handle:**
   - Password-protected documents
   - Tracked changes/comments
   - Embedded objects (images, charts)
   - Complex tables with merged cells
   - Right-to-left languages

2. **May struggle with:**
   - Documents > 10MB
   - Heavily formatted text (multiple styles per word)
   - Mathematical equations
   - Custom XML namespaces
   - Non-standard DOCX generators

3. **Best practices:**
   - Test on a copy first
   - Use simple mode when possible
   - Provide clear, unique search text
   - Keep style instructions concise
   - Verify critical edits manually
