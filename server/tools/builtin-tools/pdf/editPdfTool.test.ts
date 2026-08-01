import { describe, expect, test } from 'bun:test';
import { editPdfTool } from './editPdfTool';

function getText(result: Awaited<ReturnType<typeof editPdfTool.handler>>): string {
  return result.content.map((part) => part.type === 'text' ? part.text : '').join('\n');
}

describe('fill_pdf_form tool validation', () => {
  test('rejects field-name maps with the required array shape', async () => {
    const result = await editPdfTool.handler({
      path: 'form.pdf',
      fields: {
        company_name: 'Acme',
      },
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('fields must be an array of {id,value} objects from read_pdf output');
    expect(getText(result)).toContain('Do not pass an object keyed by field name');
  });
});
