/**
 * OOXML Package Utilities
 *
 * Handles extracting DOCX files to folder structure and repackaging back to DOCX.
 *
 * A .docx is a ZIP container (OPC package) that holds:
 * - Multiple XML files (document.xml, styles.xml, etc.)
 * - Relationship files (.rels) that wire parts together
 * - Binary content (images in word/media/)
 * - [Content_Types].xml that declares all parts
 *
 * DOCX = ZIP + multiple XML parts + .rels graphs
 */

import JSZip from 'jszip';
import * as fs from 'fs/promises';
import * as path from 'path';
import { formatXmlForModel } from './utils';

/**
 * Key XML files in a DOCX package that can be edited
 */
export const EDITABLE_OOXML_PARTS = [
  // Core document content
  'word/document.xml',
  'word/styles.xml',
  'word/settings.xml',
  'word/numbering.xml',

  // Headers and footers
  'word/header1.xml',
  'word/header2.xml',
  'word/header3.xml',
  'word/footer1.xml',
  'word/footer2.xml',
  'word/footer3.xml',

  // Comments and annotations
  'word/comments.xml',
  'word/commentsExtended.xml',
  'word/commentsExtensible.xml',
  'word/commentsIds.xml',

  // Footnotes and endnotes
  'word/footnotes.xml',
  'word/endnotes.xml',

  // People (for tracked changes)
  'word/people.xml',

  // Relationship files (XML format)
  '_rels/.rels',
  'word/_rels/document.xml.rels',

  // Content types
  '[Content_Types].xml',
];

/**
 * Result of extracting a DOCX to folder
 */
export interface ExtractedDocx {
  /** Path to the extracted folder */
  folderPath: string;
  /** All extracted XML files (relative paths) */
  xmlFiles: string[];
  /** All files in the package (including binaries) */
  allFiles: string[];
  /** Original DOCX path */
  originalPath: string;
  /** Whether this was a new (empty) document */
  isNew: boolean;
}

/**
 * Create an empty DOCX structure in a folder
 */
async function createEmptyDocxFolder(folderPath: string): Promise<string[]> {
  const files: string[] = [];

  // [Content_Types].xml
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  await fs.mkdir(folderPath, { recursive: true });
  await fs.writeFile(path.join(folderPath, '[Content_Types].xml'), contentTypes);
  files.push('[Content_Types].xml');

  // _rels/.rels
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  await fs.mkdir(path.join(folderPath, '_rels'), { recursive: true });
  await fs.writeFile(path.join(folderPath, '_rels', '.rels'), rels);
  files.push('_rels/.rels');

  // word/_rels/document.xml.rels
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;
  await fs.mkdir(path.join(folderPath, 'word', '_rels'), { recursive: true });
  await fs.writeFile(path.join(folderPath, 'word', '_rels', 'document.xml.rels'), docRels);
  files.push('word/_rels/document.xml.rels');

  // word/document.xml
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:r>
        <w:t></w:t>
      </w:r>
    </w:p>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  await fs.writeFile(path.join(folderPath, 'word', 'document.xml'), document);
  files.push('word/document.xml');

  return files;
}

/**
 * Extract a DOCX file to a folder structure
 *
 * @param docxPath - Path to the .docx file
 * @param destFolder - Destination folder (will be created)
 * @param formatXml - Whether to format XML for readability (default: true)
 * @returns Information about the extracted package
 */
export async function extractDocxToFolder(
  docxPath: string,
  destFolder: string,
  formatXml: boolean = true
): Promise<ExtractedDocx> {
  console.log(`[extractDocxToFolder] Extracting ${docxPath} to ${destFolder}`);

  let isNew = false;
  let zip: JSZip;

  // Check if source file exists
  try {
    await fs.access(docxPath);
    const docxData = await fs.readFile(docxPath);
    zip = await JSZip.loadAsync(docxData);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // File doesn't exist - create empty structure
      console.log(`[extractDocxToFolder] DOCX doesn't exist, creating empty structure`);
      isNew = true;
      const xmlFiles = await createEmptyDocxFolder(destFolder);
      return {
        folderPath: destFolder,
        xmlFiles,
        allFiles: xmlFiles,
        originalPath: docxPath,
        isNew: true,
      };
    }
    throw err;
  }

  // Create destination folder
  await fs.mkdir(destFolder, { recursive: true });

  const xmlFiles: string[] = [];
  const allFiles: string[] = [];

  // Extract all files from the ZIP
  const fileEntries = Object.entries(zip.files) as [string, JSZip.JSZipObject][];
  for (const [relativePath, zipEntry] of fileEntries) {
    if (zipEntry.dir) {
      // Create directory
      await fs.mkdir(path.join(destFolder, relativePath), { recursive: true });
      continue;
    }

    allFiles.push(relativePath);

    // Determine if this is an XML file we should format
    const isXml = relativePath.endsWith('.xml') || relativePath.endsWith('.rels');
    const destPath = path.join(destFolder, relativePath);

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    if (isXml) {
      // Extract and optionally format all XML/.rels files for better LLM editability.
      // If formatting fails for any part, fall back to raw content to preserve safety.
      let content = await zipEntry.async('string');

      if (formatXml) {
        try {
          content = formatXmlForModel(content);
        } catch (err) {
          console.warn(`[extractDocxToFolder] Could not format ${relativePath}, using raw XML`);
        }
      }

      await fs.writeFile(destPath, content, 'utf-8');
      xmlFiles.push(relativePath);
    } else {
      // Binary file - extract as-is
      const content = await zipEntry.async('nodebuffer');
      await fs.writeFile(destPath, content);
    }
  }

  console.log(`[extractDocxToFolder] Extracted ${allFiles.length} files (${xmlFiles.length} XML)`);

  return {
    folderPath: destFolder,
    xmlFiles,
    allFiles,
    originalPath: docxPath,
    isNew,
  };
}

/**
 * Repackage a folder back into a DOCX file
 *
 * @param folderPath - Path to the extracted folder
 * @param destDocxPath - Destination .docx file path
 * @returns Buffer of the created DOCX
 */
export async function repackageDocxFromFolder(
  folderPath: string,
  destDocxPath: string
): Promise<Buffer> {
  console.log(`[repackageDocxFromFolder] Repackaging ${folderPath} to ${destDocxPath}`);

  const zip = new JSZip();

  // Recursively add all files from the folder
  async function addFolderToZip(currentPath: string, zipPath: string = ''): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await addFolderToZip(fullPath, entryZipPath);
      } else {
        const content = await fs.readFile(fullPath);
        zip.file(entryZipPath, content);
      }
    }
  }

  await addFolderToZip(folderPath);

  // Generate the ZIP buffer
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  // Write to destination
  await fs.writeFile(destDocxPath, buffer);

  console.log(`[repackageDocxFromFolder] Created DOCX: ${destDocxPath} (${buffer.length} bytes)`);

  return buffer;
}

/**
 * Get a list of all XML files in an extracted DOCX folder that are relevant for editing
 *
 * @param folderPath - Path to the extracted folder
 * @returns List of XML file paths (absolute)
 */
export async function getEditableXmlFiles(folderPath: string): Promise<string[]> {
  const editableFiles: string[] = [];

  for (const relativePath of EDITABLE_OOXML_PARTS) {
    const fullPath = path.join(folderPath, relativePath);
    try {
      await fs.access(fullPath);
      editableFiles.push(fullPath);
    } catch {
      // File doesn't exist in this package - that's fine
    }
  }

  return editableFiles;
}

/**
 * Get folder name for extracting a DOCX
 *
 * @param docxPath - Path to the .docx file
 * @param sandboxDir - Sandbox directory
 * @returns Folder path for extraction
 */
export function getExtractedFolderPath(docxPath: string, sandboxDir: string): string {
  const baseName = path.basename(docxPath, '.docx');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(sandboxDir, `${baseName}-${timestamp}.ooxml`);
}

/**
 * OOXML Package Structure Reference (for prompts)
 */
export const OOXML_STRUCTURE_GUIDE = `
## OOXML Package Structure

A .docx file is a ZIP container holding multiple XML files connected by relationship (.rels) files.

### Key Files:

**[Content_Types].xml** - Declares all content types in the package
- Must list every part/extension used
- Add new entries when adding files

**_rels/.rels** - Package-level relationships
- Points to word/document.xml as the main document
- Points to core.xml for metadata

**word/document.xml** - Main document content
- <w:body> contains all content
- <w:p> = paragraph, <w:r> = run, <w:t> = text

**word/_rels/document.xml.rels** - Document relationships
- Links to styles, numbering, headers, footers, images
- rId values connect document.xml references to targets

**word/styles.xml** - Style definitions
- Paragraph styles, character styles, table styles
- Referenced by <w:pStyle> and <w:rStyle> elements

**word/numbering.xml** - List definitions
- <w:abstractNum> defines list formats
- <w:num> references abstract definitions
- Used by <w:numPr> in paragraphs

**word/header1.xml, footer1.xml, etc.** - Headers/footers
- Each section can have different headers/footers
- Must be declared in document.xml.rels

**word/comments.xml** - Comments
- <w:comment> elements with w:id
- Referenced in document.xml via <w:commentRangeStart/End>

**word/media/** - Embedded images and media
- Binary files referenced by relationships

### Relationship Pattern:
1. In document.xml: \`<w:drawing><a:blip r:embed="rId5"/></w:drawing>\`
2. In document.xml.rels: \`<Relationship Id="rId5" Target="media/image1.png"/>\`
3. In [Content_Types].xml: \`<Default Extension="png" ContentType="image/png"/>\`

### When Adding New Parts:
1. Create the XML file in the appropriate location
2. Add relationship in the parent .rels file
3. Add content type in [Content_Types].xml (if new type)

**TIP:** Use the add_docx_relationship tool to handle steps 2-3 automatically!

---

## Tracked Changes (Revisions)

Use "Claude" as the author for tracked changes unless the user explicitly requests a different name.

### Insertion:
\`\`\`xml
<w:ins w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>
\`\`\`

### Deletion:
\`\`\`xml
<w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
\`\`\`

**CRITICAL:** Inside \`<w:del>\`, use \`<w:delText>\` instead of \`<w:t>\`, and \`<w:delInstrText>\` instead of \`<w:instrText>\`.

### Minimal edits - only mark what changes:
\`\`\`xml
<!-- Change "30 days" to "60 days" -->
<w:r><w:t>The term is </w:t></w:r>
<w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t> days.</w:t></w:r>
\`\`\`

### Deleting entire paragraphs/list items:
When removing ALL content from a paragraph, also mark the paragraph mark as deleted so it merges with the next paragraph. Add \`<w:del/>\` inside \`<w:pPr><w:rPr>\`:

\`\`\`xml
<w:p>
  <w:pPr>
    <w:numPr>...</w:numPr>  <!-- list numbering if present -->
    <w:rPr>
      <w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>Entire paragraph content being deleted...</w:delText></w:r>
  </w:del>
</w:p>
\`\`\`

Without the \`<w:del/>\` in \`<w:pPr><w:rPr>\`, accepting changes leaves an empty paragraph/list item.

### Rejecting another author's insertion:
Nest deletion inside their insertion:
\`\`\`xml
<w:ins w:author="Jane" w:id="5">
  <w:del w:author="Claude" w:id="10">
    <w:r><w:delText>their inserted text</w:delText></w:r>
  </w:del>
</w:ins>
\`\`\`

### Restoring another author's deletion:
Add insertion after (don't modify their deletion):
\`\`\`xml
<w:del w:author="Jane" w:id="5">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
<w:ins w:author="Claude" w:id="10">
  <w:r><w:t>deleted text</w:t></w:r>
</w:ins>
\`\`\`

### Important Rules:
- **Replace entire \`<w:r>\` elements:** When adding tracked changes, replace the whole \`<w:r>...</w:r>\` block with \`<w:del>...<w:ins>...\` as siblings. Don't inject tracked change tags inside a run.
- **Preserve \`<w:rPr>\` formatting:** Copy the original run's \`<w:rPr>\` block into your tracked change runs to maintain bold, font size, etc.
- **RSIDs:** Must be 8-digit hex values (e.g., 00AB1234)
- **Unique IDs:** Each \`w:id\` must be unique across all tracked changes in the document

---

## Comments

Comments require entries in multiple files:

### 1. Add comment to word/comments.xml:
\`\`\`xml
<w:comment w:id="0" w:author="Claude" w:date="2025-01-01T00:00:00Z" w:initials="C">
  <w:p>
    <w:r><w:t>Comment text here</w:t></w:r>
  </w:p>
</w:comment>
\`\`\`

### 2. Add markers to document.xml:
**CRITICAL:** \`<w:commentRangeStart>\` and \`<w:commentRangeEnd>\` are siblings of \`<w:r>\`, never inside \`<w:r>\`.

\`\`\`xml
<!-- Comment markers are direct children of w:p, never inside w:r -->
<w:commentRangeStart w:id="0"/>
<w:r><w:t>text being commented on</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r>
  <w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>
  <w:commentReference w:id="0"/>
</w:r>
\`\`\`

### Comments with tracked changes:
\`\`\`xml
<w:commentRangeStart w:id="0"/>
<w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted</w:delText></w:r>
</w:del>
<w:r><w:t> more text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
\`\`\`

---

## Schema Compliance

- **Element order in \`<w:pPr>\`:** \`<w:pStyle>\`, \`<w:numPr>\`, \`<w:spacing>\`, \`<w:ind>\`, \`<w:jc>\`, \`<w:rPr>\` last
- **Whitespace:** Add \`xml:space="preserve"\` to \`<w:t>\` with leading/trailing spaces
- **RSIDs:** Must be 8-digit hex (e.g., 00AB1234)

## Smart Quotes

Use XML entities for professional typography:
\`\`\`xml
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
\`\`\`

| Entity | Character |
|--------|-----------|
| \`&#x2018;\` | ' (left single) |
| \`&#x2019;\` | ' (right single / apostrophe) |
| \`&#x201C;\` | " (left double) |
| \`&#x201D;\` | " (right double) |

---

## Images

To add an image manually (or use the add_docx_image tool which handles this automatically):

### 1. Add image file to word/media/

### 2. Add relationship to word/_rels/document.xml.rels:
\`\`\`xml
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
\`\`\`

### 3. Add content type to [Content_Types].xml:
\`\`\`xml
<Default Extension="png" ContentType="image/png"/>
\`\`\`

### 4. Reference in document.xml:
\`\`\`xml
<w:drawing>
  <wp:inline>
    <wp:extent cx="914400" cy="914400"/>  <!-- EMUs: 914400 = 1 inch -->
    <a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic>
          <pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
\`\`\`

**TIP:** Use the add_docx_image tool to handle all of this automatically!
`;

// ============================================================================
// RELATIONSHIP MANAGEMENT
// ============================================================================

/**
 * Common OOXML relationship types
 */
export const RELATIONSHIP_TYPES = {
  // Document relationships
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  footnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
  endnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes',
  comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  fontTable: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  // Package relationships
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProperties: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
} as const;

/**
 * Content types for common OOXML parts
 */
export const CONTENT_TYPES = {
  header: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  footer: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  footnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  endnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
  comments: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
  settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  fontTable: 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
} as const;

function normalizePartName(partName: string): string {
  return partName.replace(/\\/g, '/').replace(/^\/+/, '');
}

function resolveInternalPartName(sourceFile: string, target: string): string {
  if (target.startsWith('/')) {
    return normalizePartName(target);
  }

  const normalizedSource = sourceFile.replace(/\\/g, '/');
  const sourceDir = sourceFile === '_rels/.rels' || sourceFile === ''
    ? ''
    : path.posix.dirname(normalizedSource);
  const joined = sourceDir && sourceDir !== '.'
    ? path.posix.join(sourceDir, target)
    : target;

  return normalizePartName(path.posix.normalize(joined));
}

function getOverrideContentTypeForPart(partName?: string): string | null {
  if (!partName) {
    return null;
  }

  const normalizedPartName = normalizePartName(partName);

  if (/^word\/comments\.xml$/i.test(normalizedPartName)) return CONTENT_TYPES.comments;
  if (/^word\/header\d+\.xml$/i.test(normalizedPartName)) return CONTENT_TYPES.header;
  if (/^word\/footer\d+\.xml$/i.test(normalizedPartName)) return CONTENT_TYPES.footer;
  if (/^word\/styles\.xml$/i.test(normalizedPartName)) return CONTENT_TYPES.styles;
  if (/^word\/numbering\.xml$/i.test(normalizedPartName)) return CONTENT_TYPES.numbering;
  if (/^word\/footnotes\.xml$/i.test(normalizedPartName)) return CONTENT_TYPES.footnotes;
  if (/^word\/endnotes\.xml$/i.test(normalizedPartName)) return CONTENT_TYPES.endnotes;
  if (/^word\/settings\.xml$/i.test(normalizedPartName)) return CONTENT_TYPES.settings;
  if (/^word\/fontTable\.xml$/i.test(normalizedPartName)) return CONTENT_TYPES.fontTable;
  if (/^word\/theme\/[^/]+\.xml$/i.test(normalizedPartName)) return CONTENT_TYPES.theme;

  return null;
}

export interface AddRelationshipResult {
  success: boolean;
  rId: string;
  error?: string;
}

/**
 * Add a relationship to a .rels file and optionally update [Content_Types].xml
 *
 * This handles the complex task of:
 * 1. Parsing the existing .rels file
 * 2. Finding the next available rId
 * 3. Adding the new relationship
 * 4. Updating [Content_Types].xml if needed (for new file types)
 *
 * @param extractedFolderPath - Path to the extracted DOCX folder
 * @param relationshipType - The type of relationship (use RELATIONSHIP_TYPES constants or 'hyperlink', 'image', etc.)
 * @param target - The target path or URL (e.g., 'media/image1.png' or 'https://example.com')
 * @param sourceFile - Which file this relationship is FROM (e.g., 'word/document.xml')
 * @param isExternal - Whether this is an external link (like a hyperlink) vs internal file
 * @returns The rId to use in your XML, or error info
 */
export async function addRelationship(
  extractedFolderPath: string,
  relationshipType: string,
  target: string,
  sourceFile: string = 'word/document.xml',
  isExternal: boolean = false
): Promise<AddRelationshipResult> {
  try {
    // Resolve the relationship type if a shorthand was used
    const fullType = (RELATIONSHIP_TYPES as Record<string, string>)[relationshipType] || relationshipType;

    // Determine the .rels file path based on source file
    // word/document.xml -> word/_rels/document.xml.rels
    // _rels/.rels for package-level
    let relsPath: string;
    if (sourceFile === '_rels/.rels' || sourceFile === '') {
      relsPath = path.join(extractedFolderPath, '_rels', '.rels');
    } else {
      const sourceDir = path.dirname(sourceFile);
      const sourceBasename = path.basename(sourceFile);
      relsPath = path.join(extractedFolderPath, sourceDir, '_rels', `${sourceBasename}.rels`);
    }

    // Ensure _rels directory exists
    await fs.mkdir(path.dirname(relsPath), { recursive: true });

    // Read existing .rels or create new one
    let relsContent: string;
    try {
      relsContent = await fs.readFile(relsPath, 'utf-8');
    } catch {
      // Create new .rels file
      relsContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;
    }

    // Find existing rIds to determine next available
    const rIdMatches = relsContent.matchAll(/Id="(rId(\d+))"/g);
    let maxRId = 0;
    for (const match of rIdMatches) {
      const num = parseInt(match[2], 10);
      if (num > maxRId) maxRId = num;
    }
    const newRId = `rId${maxRId + 1}`;

    // Build the new relationship element
    const targetMode = isExternal ? ' TargetMode="External"' : '';
    const newRelationship = `  <Relationship Id="${newRId}" Type="${fullType}" Target="${target}"${targetMode}/>`;

    // Insert before closing </Relationships> tag
    relsContent = relsContent.replace(
      /<\/Relationships>/,
      `${newRelationship}\n</Relationships>`
    );

    // Write updated .rels
    await fs.writeFile(relsPath, relsContent, 'utf-8');
    console.log(`[addRelationship] Added ${newRId} -> ${target} in ${relsPath}`);

    // Update [Content_Types].xml if this is a new internal file type
    if (!isExternal && target.includes('.')) {
      const ext = target.split('.').pop()?.toLowerCase();
      if (ext) {
        const partName = resolveInternalPartName(sourceFile, target);
        await ensureContentType(extractedFolderPath, ext, partName);
      }
    }

    return { success: true, rId: newRId };
  } catch (error: any) {
    return { success: false, rId: '', error: error.message };
  }
}

/**
 * Ensure a content type is declared in [Content_Types].xml
 */
async function ensureContentType(
  extractedFolderPath: string,
  extension: string,
  partName?: string
): Promise<void> {
  const contentTypesPath = path.join(extractedFolderPath, '[Content_Types].xml');

  let content: string;
  try {
    content = await fs.readFile(contentTypesPath, 'utf-8');
  } catch {
    // Create minimal [Content_Types].xml
    content = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`;
  }

  const normalizedPartName = partName ? normalizePartName(partName) : undefined;
  const overrideContentType = getOverrideContentTypeForPart(normalizedPartName);

  // Check if part already has an Override entry
  if (normalizedPartName) {
    const overridePattern = new RegExp(`<Override[^>]+PartName="/?${normalizedPartName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i');
    if (overridePattern.test(content)) {
      return; // Already declared
    }
  }

  // Check if extension already has a Default entry
  const defaultPattern = new RegExp(`<Default[^>]+Extension="${extension}"`, 'i');
  if (!overrideContentType && defaultPattern.test(content)) {
    return; // Already declared
  }

  // Determine content type
  const contentType = overrideContentType ||
    (CONTENT_TYPES as Record<string, string>)[extension] ||
    `application/vnd.openxmlformats-officedocument.wordprocessingml.${extension}+xml`;

  // Add Default entry for common extensions, Override for specific parts
  let newEntry: string;
  if (overrideContentType && normalizedPartName) {
    newEntry = `  <Override PartName="/${normalizedPartName}" ContentType="${contentType}"/>`;
  } else if (['png', 'jpeg', 'jpg', 'gif', 'xml', 'rels'].includes(extension)) {
    newEntry = `  <Default Extension="${extension}" ContentType="${contentType}"/>`;
  } else if (normalizedPartName) {
    newEntry = `  <Override PartName="/${normalizedPartName}" ContentType="${contentType}"/>`;
  } else {
    newEntry = `  <Default Extension="${extension}" ContentType="${contentType}"/>`;
  }

  // Insert before closing </Types>
  content = content.replace(/<\/Types>/, `${newEntry}\n</Types>`);
  await fs.writeFile(contentTypesPath, content, 'utf-8');
  console.log(`[ensureContentType] Added content type for ${extension}`);
}

// ============================================================================
// VALIDATION
// ============================================================================

export interface ValidationError {
  type: 'missing_target' | 'missing_content_type' | 'orphan_relationship' | 'xml_error';
  file: string;
  message: string;
  details?: string;
  suggestedFix?: string;
  affectedElement?: string; // What element/rId is broken
  referencedIn?: string; // Where is this referenced
}

export interface PackageValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validate the integrity of an OOXML package
 *
 * Checks:
 * 1. All rId references in XML files have corresponding entries in .rels
 * 2. All relationship Targets point to files that exist (for internal refs)
 * 3. All parts are declared in [Content_Types].xml
 */
export async function validatePackageIntegrity(
  extractedFolderPath: string
): Promise<PackageValidationResult> {
  const errors: ValidationError[] = [];

  try {
    // 1. Parse all .rels files and collect relationships
    const relationships: Map<string, { type: string; target: string; external: boolean }> = new Map();
    const relsFiles = await findFilesRecursive(extractedFolderPath, '.rels');

    for (const relsFile of relsFiles) {
      const content = await fs.readFile(relsFile, 'utf-8');
      const relPattern = /<Relationship\s+Id="([^"]+)"\s+Type="([^"]+)"\s+Target="([^"]+)"([^>]*)/g;

      let match;
      while ((match = relPattern.exec(content)) !== null) {
        const [, rId, type, target, rest] = match;
        const isExternal = rest.includes('TargetMode="External"');
        relationships.set(`${relsFile}:${rId}`, { type, target, external: isExternal });

        // Check if target exists for internal relationships
        if (!isExternal) {
          const relsDir = path.dirname(relsFile);
          const parentDir = path.dirname(relsDir); // Go up from _rels
          const targetPath = path.resolve(parentDir, target);

          try {
            await fs.access(targetPath);
          } catch {
            errors.push({
              type: 'missing_target',
              file: relsFile,
              message: `Relationship ${rId} points to non-existent file`,
              details: `Target: ${target}\nResolved path: ${targetPath}\nRelationship type: ${type}`,
              affectedElement: rId,
              suggestedFix: `Either create the missing file at "${target}" or remove the relationship entry for ${rId} from ${path.relative(extractedFolderPath, relsFile)}`,
            });
          }
        }
      }
    }

    // 2. Check [Content_Types].xml declarations
    const contentTypesPath = path.join(extractedFolderPath, '[Content_Types].xml');
    let contentTypesContent = '';
    try {
      contentTypesContent = await fs.readFile(contentTypesPath, 'utf-8');
    } catch {
      errors.push({
        type: 'missing_content_type',
        file: '[Content_Types].xml',
        message: '[Content_Types].xml is missing',
      });
    }

    if (contentTypesContent) {
      // Find all XML files and check they have content type declarations
      const xmlFiles = await findFilesRecursive(extractedFolderPath, '.xml');
      for (const xmlFile of xmlFiles) {
        const relativePath = path.relative(extractedFolderPath, xmlFile);
        if (relativePath === '[Content_Types].xml') continue;

        // Check for Override or Default
        const partName = '/' + relativePath.replace(/\\/g, '/');
        const hasOverride = contentTypesContent.includes(`PartName="${partName}"`);
        const ext = path.extname(xmlFile).slice(1);
        const hasDefault = contentTypesContent.includes(`Extension="${ext}"`);

        if (!hasOverride && !hasDefault) {
          errors.push({
            type: 'missing_content_type',
            file: relativePath,
            message: `No content type declaration for ${relativePath}`,
            details: `This file exists in the package but is not declared in [Content_Types].xml`,
            affectedElement: relativePath,
            suggestedFix: `Add to [Content_Types].xml:\n<Override PartName="${partName}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${ext}+xml"/>\n\nOR add a default for all .${ext} files:\n<Default Extension="${ext}" ContentType="application/xml"/>`,
          });
        }
      }
    }

    // 3. Check for rId references in document.xml that don't exist in rels
    const documentXmlPath = path.join(extractedFolderPath, 'word', 'document.xml');
    try {
      const docContent = await fs.readFile(documentXmlPath, 'utf-8');
      const rIdRefs = docContent.matchAll(/r:(?:id|embed|link)="(rId\d+)"/gi);
      const docRelsPath = path.join(extractedFolderPath, 'word', '_rels', 'document.xml.rels');

      for (const match of rIdRefs) {
        const rId = match[1];
        const key = `${docRelsPath}:${rId}`;
        if (!relationships.has(key)) {
          // Find the line where this rId is used for better context
          const lines = docContent.split('\n');
          let lineNumber = 0;
          let contextLine = '';
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(rId)) {
              lineNumber = i + 1;
              contextLine = lines[i].trim();
              break;
            }
          }

          errors.push({
            type: 'orphan_relationship',
            file: 'word/document.xml',
            message: `Reference to ${rId} has no corresponding relationship`,
            details: `Line ${lineNumber}: ${contextLine.substring(0, 100)}${contextLine.length > 100 ? '...' : ''}`,
            affectedElement: rId,
            referencedIn: `word/document.xml:${lineNumber}`,
            suggestedFix: `Add a relationship entry to word/_rels/document.xml.rels:\n<Relationship Id="${rId}" Type="<type>" Target="<target>"/>\n\nOr remove the reference to ${rId} from word/document.xml if it's not needed.`,
          });
        }
      }
    } catch {
      // document.xml doesn't exist - that's a bigger problem but xmlValidation handles it
    }

  } catch (error: any) {
    errors.push({
      type: 'xml_error',
      file: 'package',
      message: `Validation error: ${error.message}`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Find all files with a given extension recursively
 */
async function findFilesRecursive(dir: string, extension: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findFilesRecursive(fullPath, extension));
    } else if (entry.name.endsWith(extension)) {
      results.push(fullPath);
    }
  }

  return results;
}
