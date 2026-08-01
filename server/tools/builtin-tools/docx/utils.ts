import JSZip from 'jszip';
import mammoth from 'mammoth';
import { createHash } from 'crypto';
import format from 'xml-formatter';

export interface ParagraphInfo {
  index: number;
  originalText: string;
  originalXml: string;
}

export interface MarkedParagraph {
  text: string;
}

export function generateParagraphId(content: string, index: number): string {
  const hash = createHash('md5');
  hash.update(content);
  hash.update(index.toString());
  return hash.digest('hex').substring(0, 16);
}

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export async function injectMarkersIntoDocx(docxData: Buffer): Promise<{
  markedData: Buffer;
  paragraphIndex: Record<string, ParagraphInfo>;
}> {
  const zip = await JSZip.loadAsync(docxData);
  const documentXmlFile = zip.file('word/document.xml');
  if (!documentXmlFile) throw new Error('Invalid DOCX file: missing document.xml');

  const documentXml = await documentXmlFile.async('string');

  const paragraphIndex: Record<string, ParagraphInfo> = {};
  let paraCounter = 0;

  const modifiedXml = documentXml.replace(/<w:p\b([^>]*)>([\s\S]*?)<\/w:p>/g, (match: string, attrs: string, content: string) => {
    let textContent = '';
    const textMatches = content.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g);
    for (const textMatch of textMatches) {
      textContent += textMatch[1];
    }
    if (!textContent.trim()) return match;

    const paraId = generateParagraphId(textContent.trim(), paraCounter);

    paragraphIndex[paraId] = {
      index: paraCounter++,
      originalText: decodeXmlEntities(textContent.trim()),
      originalXml: match,
    };

    const markerRun = `<w:r><w:t>[DOCX-MARKER:${paraId}]</w:t></w:r>`;
    const insertPos = content.search(/<w:r\b/);
    if (insertPos === -1) {
      return `<w:p${attrs}>${content}${markerRun}</w:p>`;
    } else {
      return `<w:p${attrs}>${content.substring(0, insertPos)}${markerRun}${content.substring(insertPos)}</w:p>`;
    }
  });

  zip.file('word/document.xml', modifiedXml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return { markedData: buffer, paragraphIndex };
}

export async function convertDocxToPlaintext(docxData: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer: docxData });
  let html = result.value || '';

  // Normalize some block elements to newlines
  html = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|h[1-6]|li|ul|ol|section|article|header|footer|blockquote|pre|table|tr)>/gi, '\n')
    .replace(/<\s*(?:p|div|h[1-6]|ul|ol|section|article|header|footer|blockquote|pre|table|tr)\b[^>]*>/gi, '');

  // Strip remaining tags
  let text = html.replace(/<[^>]+>/g, '');

  // Decode entities and normalize whitespace
  text = decodeXmlEntities(text)
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[\t\v\f]/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

export function extractMarkedParagraphs(plainText: string): Record<string, MarkedParagraph> {
  const paragraphs: Record<string, MarkedParagraph> = {};
  const markerRegex = /\[DOCX-MARKER:([a-f0-9]{16})\]/g;
  
  // First, find all markers and their positions
  const markers: Array<{ id: string; index: number; fullMatch: string }> = [];
  let match: RegExpExecArray | null;
  
  while ((match = markerRegex.exec(plainText)) !== null) {
    markers.push({
      id: match[1],
      index: match.index,
      fullMatch: match[0]
    });
  }
  
  console.log(`[extractMarkedParagraphs] Found ${markers.length} paragraph markers`);
  
  // Now extract text for each marker
  for (let i = 0; i < markers.length; i++) {
    const currentMarker = markers[i];
    const nextMarker = markers[i + 1];
    
    // The paragraph starts right after the current marker
    const paraStart = currentMarker.index + currentMarker.fullMatch.length;
    
    // The paragraph ends either:
    // 1. Right before the next marker (if there is one)
    // 2. At the end of the document (if this is the last marker)
    let paraEnd: number;
    if (nextMarker) {
      // Look for the last newline before the next marker to avoid including it
      paraEnd = plainText.lastIndexOf('\n', nextMarker.index);
      if (paraEnd === -1 || paraEnd <= paraStart) {
        paraEnd = nextMarker.index;
      }
    } else {
      paraEnd = plainText.length;
    }
    
    // Extract the text and clean it up
    let paraText = plainText.substring(paraStart, paraEnd).trim();
    
    // Remove any other markers that might be in this text (shouldn't happen but just in case)
    paraText = paraText.replace(/\[DOCX-MARKER:[a-f0-9]{16}\]/g, '').trim();
    
    // Only add non-empty paragraphs
    if (paraText) {
      paragraphs[currentMarker.id] = { text: paraText };
      
      // Debug log for first few paragraphs
      if (i < 3) {
        console.log(`[extractMarkedParagraphs] Paragraph ${i + 1} (${currentMarker.id}): ${paraText.substring(0, 100)}${paraText.length > 100 ? '...' : ''} (${paraText.length} chars)`);
      }
    }
  }
  
  console.log(`[extractMarkedParagraphs] Extracted ${Object.keys(paragraphs).length} paragraphs`);
  
  return paragraphs;
}

export function removeMarkersFromText(text: string): string {
  return text.replace(/\[DOCX-MARKER:[a-f0-9]{16}\]/g, '').trim();
}

/**
 * Format XML for better readability while preserving text content exactly
 * Uses xml-formatter - purpose-built for XML formatting
 */
export function formatXmlForModel(xml: string): string {
  if (!xml) {
    throw new Error(`formatXmlForModel: xml parameter is ${xml === null ? 'null' : 'undefined'}`);
  }

  let xmlDeclaration = '';
  let xmlContent = xml;

  try {
    // WORKAROUND: xml-formatter has a bug processing XML declarations
    // Strip the declaration, format the rest, then add it back
    const declarationMatch = xml.match(/^<\?xml[^?]*\?>\n?/);
    if (declarationMatch) {
      xmlDeclaration = declarationMatch[0];
      xmlContent = xml.substring(declarationMatch[0].length);
    }

    // Trim leading/trailing whitespace that can confuse xml-formatter
    xmlContent = xmlContent.trim();

    // Check if XML is already formatted (has newlines indicating structure)
    const isAlreadyFormatted = xmlContent.includes('\n');
    if (isAlreadyFormatted) {
      return xmlDeclaration ? xmlDeclaration + xmlContent : xmlContent;
    }

    // Format with xml-formatter
    const formatted = format(xmlContent, {
      indentation: '  ',
      collapseContent: false,
      lineSeparator: '\n',
      whiteSpaceAtEndOfSelfclosingTag: false,
      strictMode: false,
      forceSelfClosingEmptyTag: false
    });

    return xmlDeclaration ? xmlDeclaration + formatted : formatted;
  } catch (error) {
    // Check if XML is already formatted - if so, just use it
    if (xml.includes('\n')) {
      return xml;
    }

    // If xml-formatter fails on unformatted XML, try basic manual formatting
    try {
      let manuallyFormatted = xmlContent
        .replace(/></g, '>\n<')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n');

      return xmlDeclaration ? xmlDeclaration + '\n' + manuallyFormatted : manuallyFormatted;
    } catch {
      return xml;
    }
  }
} 