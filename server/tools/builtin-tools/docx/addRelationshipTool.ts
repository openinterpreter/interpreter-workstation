/**
 * Add DOCX Relationship Tool
 *
 * This tool helps add relationships to OOXML packages (.docx files).
 *
 * WHY THIS TOOL EXISTS:
 * Adding a hyperlink, image, header, or footer to a Word document requires editing
 * MULTIPLE files in a specific way:
 *   1. The .rels file (to declare the relationship and get an rId)
 *   2. The [Content_Types].xml file (to declare file types)
 *   3. The document.xml file (to use the rId)
 *
 * This tool handles steps 1-2 automatically and returns the rId you need for step 3.
 *
 * EXAMPLE USAGE:
 * To add a hyperlink to "https://example.com":
 *   1. Call this tool with type="hyperlink", target="https://example.com", is_external=true
 *   2. Tool returns rId (e.g., "rId5")
 *   3. In document.xml, add: <w:hyperlink r:id="rId5"><w:r><w:t>Click here</w:t></w:r></w:hyperlink>
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { addRelationship, RELATIONSHIP_TYPES } from './ooxmlPackage';

export const addDocxRelationshipTool: BuiltinToolDefinition = {
  name: 'add_docx_relationship',
  description: `Add a relationship to an extracted DOCX package (hyperlink, image, header, footer, etc.).

**WHAT THIS DOES:**
When you need to add a hyperlink, image, header, or footer to a Word document, you must:
1. Add an entry to the .rels file (this tool does this)
2. Update [Content_Types].xml if needed (this tool does this)
3. Use the returned rId in your XML (you do this manually)

This tool handles steps 1-2 and returns the rId you need for step 3.

**WHEN TO USE:**
- Adding a hyperlink: type="hyperlink", target="https://...", is_external=true
- Adding an image: type="image", target="media/image1.png", is_external=false
- Adding a header: type="header", target="header1.xml", is_external=false
- Adding a footer: type="footer", target="footer1.xml", is_external=false

**EXAMPLE - Adding a hyperlink:**
1. Call: add_docx_relationship(folder="/path/to/.ooxml", type="hyperlink", target="https://example.com", is_external=true)
2. Returns: { success: true, rId: "rId5" }
3. In word/document.xml, add:
   <w:hyperlink r:id="rId5">
     <w:r><w:t>Click here</w:t></w:r>
   </w:hyperlink>

**EXAMPLE - Adding an image:**
1. First, copy the image file to the word/media/ folder
2. Call: add_docx_relationship(folder="/path/to/.ooxml", type="image", target="media/image1.png", is_external=false)
3. Returns: { success: true, rId: "rId6" }
4. In word/document.xml, add drawing with r:embed="rId6"

**RELATIONSHIP TYPES:**
- hyperlink: External URL link
- image: Embedded image in word/media/
- header: Header XML file (header1.xml, header2.xml, etc.)
- footer: Footer XML file (footer1.xml, footer2.xml, etc.)
- styles: Styles definition file
- numbering: List numbering definitions
- comments: Document comments`,
  inputSchema: {
    type: 'object',
    properties: {
      extracted_folder: {
        type: 'string',
        description: 'Path to the extracted DOCX folder (the .ooxml folder). This is the folder containing word/, _rels/, [Content_Types].xml, etc.'
      },
      type: {
        type: 'string',
        description: 'Type of relationship. Common values: "hyperlink", "image", "header", "footer", "styles", "numbering", "comments". Can also be a full URI like "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"'
      },
      target: {
        type: 'string',
        description: 'The target of the relationship. For hyperlinks: the URL (e.g., "https://example.com"). For images: relative path from word/ folder (e.g., "media/image1.png"). For headers/footers: the filename (e.g., "header1.xml").'
      },
      source_file: {
        type: 'string',
        description: 'Which XML file this relationship is FROM. Default: "word/document.xml". For package-level relationships, use "_rels/.rels".'
      },
      is_external: {
        type: 'boolean',
        description: 'Whether this is an external link (like a hyperlink to a URL) vs an internal file reference (like an image). Set to true for hyperlinks, false for images/headers/footers.'
      }
    },
    required: ['extracted_folder', 'type', 'target', 'is_external']
  },
  mode: 'write',
  fileTypes: ['.xml', '.rels'],
  fileAccess: {
    mode: 'write',
    pathArg: 'extracted_folder'
  },
  handler: async (args: Record<string, any>) => {
    try {
      const extractedFolder = args.extracted_folder as string;
      const relType = args.type as string;
      const target = args.target as string;
      const sourceFile = (args.source_file as string) || 'word/document.xml';
      const isExternal = args.is_external as boolean;

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

      if (!relType) {
        return {
          content: [{
            type: 'text',
            text: `Error: type is required. Common values: ${Object.keys(RELATIONSHIP_TYPES).join(', ')}`
          }],
          isError: true
        };
      }

      if (!target) {
        return {
          content: [{
            type: 'text',
            text: 'Error: target is required. For hyperlinks: the URL. For images: "media/image1.png". For headers: "header1.xml".'
          }],
          isError: true
        };
      }

      // Call the addRelationship function
      const result = await addRelationship(
        extractedFolder,
        relType,
        target,
        sourceFile,
        isExternal
      );

      if (!result.success) {
        return {
          content: [{
            type: 'text',
            text: `Error adding relationship: ${result.error}`
          }],
          isError: true
        };
      }

      // Build helpful response
      const typeShorthand = Object.entries(RELATIONSHIP_TYPES).find(([, v]) => v === relType)?.[0] || relType;
      let usageExample = '';

      if (typeShorthand === 'hyperlink' || relType.includes('hyperlink')) {
        usageExample = `
**How to use this rId in document.xml:**
\`\`\`xml
<w:hyperlink r:id="${result.rId}">
  <w:r>
    <w:rPr><w:color w:val="0000FF"/><w:u w:val="single"/></w:rPr>
    <w:t>Link Text</w:t>
  </w:r>
</w:hyperlink>
\`\`\``;
      } else if (typeShorthand === 'image' || relType.includes('image')) {
        usageExample = `
**How to use this rId in document.xml:**
\`\`\`xml
<w:drawing>
  <wp:inline>
    <a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic>
          <pic:blipFill>
            <a:blip r:embed="${result.rId}"/>
          </pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
\`\`\``;
      } else if (typeShorthand === 'header' || relType.includes('header')) {
        usageExample = `
**How to use this rId in document.xml:**
Add to the <w:sectPr> section:
\`\`\`xml
<w:headerReference w:type="default" r:id="${result.rId}"/>
\`\`\``;
      } else if (typeShorthand === 'footer' || relType.includes('footer')) {
        usageExample = `
**How to use this rId in document.xml:**
Add to the <w:sectPr> section:
\`\`\`xml
<w:footerReference w:type="default" r:id="${result.rId}"/>
\`\`\``;
      }

      return {
        content: [{
          type: 'text',
          text: `Successfully added relationship!

**Result:**
- rId: ${result.rId}
- Type: ${typeShorthand}
- Target: ${target}
- Source: ${sourceFile}
- External: ${isExternal}

The .rels file and [Content_Types].xml have been updated automatically.
${usageExample}

**Next step:** Use r:id="${result.rId}" in your XML where you reference this ${typeShorthand}.`
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
