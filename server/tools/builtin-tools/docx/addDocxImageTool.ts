/**
 * Add DOCX Image Tool
 *
 * This tool helps add images to OOXML packages (.docx files).
 *
 * WHY THIS TOOL EXISTS:
 * Adding an image to a Word document requires:
 *   1. Copying the image file to word/media/
 *   2. Adding a relationship entry in word/_rels/document.xml.rels
 *   3. Adding content type in [Content_Types].xml
 *   4. Adding complex <w:drawing> XML in document.xml
 *
 * The drawing XML is verbose and error-prone. This tool handles ALL of it.
 *
 * EXAMPLE USAGE:
 * 1. Call: add_docx_image(extracted_folder="...", image_path="/path/to/photo.png")
 * 2. Returns: rId, media path, AND ready-to-paste <w:drawing> XML
 * 3. Just paste the XML into document.xml where you want the image
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { addRelationship } from './ooxmlPackage';
import * as fs from 'fs/promises';
import * as path from 'path';

// EMU (English Metric Units) conversions
// 1 inch = 914400 EMUs
// 1 pixel at 96 DPI = 914400 / 96 = 9525 EMUs
const EMU_PER_PIXEL = 9525;

// Default image size if we can't detect dimensions (4 inches = ~384 pixels at 96 DPI)
const DEFAULT_WIDTH_PX = 400;
const DEFAULT_HEIGHT_PX = 300;

/**
 * Try to get image dimensions from common image formats
 * Returns [width, height] in pixels, or null if can't determine
 */
async function getImageDimensions(imagePath: string): Promise<[number, number] | null> {
  try {
    const buffer = await fs.readFile(imagePath);

    // PNG: width at bytes 16-19, height at bytes 20-23 (big-endian)
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return [width, height];
    }

    // JPEG: more complex, need to find SOF0 marker
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] !== 0xFF) {
          offset++;
          continue;
        }
        const marker = buffer[offset + 1];
        // SOF0, SOF1, SOF2 markers contain dimensions
        if (marker >= 0xC0 && marker <= 0xC2) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return [width, height];
        }
        // Skip to next marker
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      }
    }

    // GIF: width at bytes 6-7, height at bytes 8-9 (little-endian)
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return [width, height];
    }

    // BMP: width at bytes 18-21, height at bytes 22-25 (little-endian, can be negative)
    if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
      const width = buffer.readInt32LE(18);
      const height = Math.abs(buffer.readInt32LE(22));
      return [width, height];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Generate the complete <w:drawing> XML for an inline image
 */
function generateDrawingXml(
  rId: string,
  widthEmu: number,
  heightEmu: number,
  altText: string = 'Image',
  imageId: number = 1
): string {
  // Generate unique IDs for this drawing
  const docPrId = imageId;
  const cNvPrId = imageId;

  return `<w:drawing>
  <wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
    <wp:extent cx="${widthEmu}" cy="${heightEmu}"/>
    <wp:effectExtent l="0" t="0" r="0" b="0"/>
    <wp:docPr id="${docPrId}" name="${altText}"/>
    <wp:cNvGraphicFramePr>
      <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
    </wp:cNvGraphicFramePr>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:nvPicPr>
            <pic:cNvPr id="${cNvPrId}" name="${altText}"/>
            <pic:cNvPicPr/>
          </pic:nvPicPr>
          <pic:blipFill>
            <a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
            <a:stretch>
              <a:fillRect/>
            </a:stretch>
          </pic:blipFill>
          <pic:spPr>
            <a:xfrm>
              <a:off x="0" y="0"/>
              <a:ext cx="${widthEmu}" cy="${heightEmu}"/>
            </a:xfrm>
            <a:prstGeom prst="rect">
              <a:avLst/>
            </a:prstGeom>
          </pic:spPr>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>`;
}

export const addDocxImageTool: BuiltinToolDefinition = {
  name: 'add_docx_image',
  description: `Add an image to an extracted DOCX package. This tool handles EVERYTHING:
1. Copies the image to word/media/
2. Adds the relationship to .rels
3. Updates [Content_Types].xml
4. Returns ready-to-paste <w:drawing> XML

**WHEN TO USE:**
When you need to insert an image into a Word document.

**EXAMPLE:**
1. Call: add_docx_image(extracted_folder="/path/to/.ooxml", image_path="/path/to/photo.png")
2. Returns the complete <w:drawing> XML
3. Paste the XML inside a <w:r> element in document.xml:
   <w:p>
     <w:r>
       [paste the <w:drawing> XML here]
     </w:r>
   </w:p>

**SIZING:**
- By default, uses the image's actual dimensions
- Use width_inches or height_inches to resize (maintains aspect ratio)
- Use max_width_inches to limit size while preserving aspect ratio

**PARAMETERS:**
- extracted_folder: Path to the .ooxml folder
- image_path: Path to the image file (PNG, JPEG, GIF, BMP)
- alt_text: Optional alt text for accessibility (default: filename)
- width_inches: Optional width in inches (auto-calculates height)
- height_inches: Optional height in inches (auto-calculates width)
- max_width_inches: Optional max width (scales down if larger)`,
  inputSchema: {
    type: 'object',
    properties: {
      extracted_folder: {
        type: 'string',
        description: 'Path to the extracted DOCX folder (the .ooxml folder)'
      },
      image_path: {
        type: 'string',
        description: 'Path to the image file to add (PNG, JPEG, GIF, or BMP)'
      },
      alt_text: {
        type: 'string',
        description: 'Alt text for the image (for accessibility). Defaults to filename.'
      },
      width_inches: {
        type: 'number',
        description: 'Desired width in inches. Height will be calculated to maintain aspect ratio.'
      },
      height_inches: {
        type: 'number',
        description: 'Desired height in inches. Width will be calculated to maintain aspect ratio.'
      },
      max_width_inches: {
        type: 'number',
        description: 'Maximum width in inches. Image will be scaled down if larger, maintaining aspect ratio.'
      }
    },
    required: ['extracted_folder', 'image_path']
  },
  mode: 'write',
  fileTypes: ['.xml', '.rels', '.png', '.jpg', '.jpeg', '.gif', '.bmp'],
  fileAccess: {
    mode: 'write',
    pathArg: ['extracted_folder', 'image_path'],
    pathArgModes: {
      extracted_folder: 'write',
      image_path: 'read',
    },
  },
  handler: async (args: Record<string, any>, _context) => {
    try {
      const extractedFolder = args.extracted_folder as string;
      const imagePath = args.image_path as string;
      const altText = (args.alt_text as string) || path.basename(imagePath, path.extname(imagePath));
      const widthInches = args.width_inches as number | undefined;
      const heightInches = args.height_inches as number | undefined;
      const maxWidthInches = args.max_width_inches as number | undefined;

      // Validate inputs
      if (!extractedFolder) {
        return {
          content: [{
            type: 'text',
            text: 'Error: extracted_folder is required. This should be the path to the .ooxml folder.'
          }],
          isError: true
        };
      }

      if (!imagePath) {
        return {
          content: [{
            type: 'text',
            text: 'Error: image_path is required. Provide the path to the image file.'
          }],
          isError: true
        };
      }

      // Check image exists
      try {
        await fs.access(imagePath);
      } catch {
        return {
          content: [{
            type: 'text',
            text: `Error: Image file not found at ${imagePath}`
          }],
          isError: true
        };
      }

      // Get image extension and validate
      const ext = path.extname(imagePath).toLowerCase();
      const validExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp'];
      if (!validExtensions.includes(ext)) {
        return {
          content: [{
            type: 'text',
            text: `Error: Unsupported image format "${ext}". Supported formats: ${validExtensions.join(', ')}`
          }],
          isError: true
        };
      }

      // Create word/media/ directory if it doesn't exist
      const mediaDir = path.join(extractedFolder, 'word', 'media');
      await fs.mkdir(mediaDir, { recursive: true });

      // Find next available image number
      let imageNum = 1;
      const existingFiles = await fs.readdir(mediaDir).catch(() => []);
      for (const file of existingFiles) {
        const match = file.match(/^image(\d+)\./);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num >= imageNum) imageNum = num + 1;
        }
      }

      // Copy image to media folder with standardized name
      const targetExt = ext === '.jpeg' ? '.jpg' : ext;
      const mediaFileName = `image${imageNum}${targetExt}`;
      const mediaPath = path.join(mediaDir, mediaFileName);
      await fs.copyFile(imagePath, mediaPath);

      // Get image dimensions
      let widthPx = DEFAULT_WIDTH_PX;
      let heightPx = DEFAULT_HEIGHT_PX;
      const dimensions = await getImageDimensions(imagePath);
      if (dimensions) {
        [widthPx, heightPx] = dimensions;
      }

      // Calculate EMU dimensions with optional resizing
      let widthEmu = widthPx * EMU_PER_PIXEL;
      let heightEmu = heightPx * EMU_PER_PIXEL;

      // Apply sizing options
      if (widthInches !== undefined) {
        // Scale to specific width, maintain aspect ratio
        const newWidthEmu = widthInches * 914400;
        const scale = newWidthEmu / widthEmu;
        widthEmu = newWidthEmu;
        heightEmu = Math.round(heightEmu * scale);
      } else if (heightInches !== undefined) {
        // Scale to specific height, maintain aspect ratio
        const newHeightEmu = heightInches * 914400;
        const scale = newHeightEmu / heightEmu;
        heightEmu = newHeightEmu;
        widthEmu = Math.round(widthEmu * scale);
      }

      // Apply max width constraint
      if (maxWidthInches !== undefined) {
        const maxWidthEmu = maxWidthInches * 914400;
        if (widthEmu > maxWidthEmu) {
          const scale = maxWidthEmu / widthEmu;
          widthEmu = maxWidthEmu;
          heightEmu = Math.round(heightEmu * scale);
        }
      }

      // Add relationship for the image
      const relResult = await addRelationship(
        extractedFolder,
        'image',
        `media/${mediaFileName}`,
        'word/document.xml',
        false
      );

      if (!relResult.success) {
        return {
          content: [{
            type: 'text',
            text: `Error adding image relationship: ${relResult.error}`
          }],
          isError: true
        };
      }

      // Generate the drawing XML
      const drawingXml = generateDrawingXml(
        relResult.rId,
        widthEmu,
        heightEmu,
        altText,
        imageNum
      );

      // Calculate display dimensions for user info
      const displayWidthIn = (widthEmu / 914400).toFixed(2);
      const displayHeightIn = (heightEmu / 914400).toFixed(2);

      return {
        content: [{
          type: 'text',
          text: `Successfully added image to document!

**Image Details:**
- Original: ${path.basename(imagePath)} (${widthPx}x${heightPx} px)
- Copied to: word/media/${mediaFileName}
- Relationship ID: ${relResult.rId}
- Display size: ${displayWidthIn}" × ${displayHeightIn}"

**Ready-to-paste XML:**
Wrap this in a \`<w:r>\` element inside a paragraph:

\`\`\`xml
<w:r>
${drawingXml}
</w:r>
\`\`\`

**Example - Add image to a new paragraph:**
\`\`\`xml
<w:p>
  <w:r>
${drawingXml}
  </w:r>
</w:p>
\`\`\`

**Next step:** Use apply_patch to insert this XML into word/document.xml where you want the image to appear.`
        }],
        isError: false
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
