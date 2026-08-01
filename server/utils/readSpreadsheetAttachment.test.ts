import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import ExcelJS from 'exceljs';
import { readSpreadsheetAttachment } from './readSpreadsheetAttachment';

describe('readSpreadsheetAttachment', () => {
  test('extracts values and formulas from an xlsx file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'interpreter-spreadsheet-reader-'));
    const filePath = path.join(directory, 'report.xlsx');
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Summary');
      worksheet.getCell('A1').value = 'Revenue';
      worksheet.getCell('B1').value = 42;
      worksheet.getCell('B2').value = { formula: 'B1*2', result: 84 };
      await workbook.xlsx.writeFile(filePath);

      expect(JSON.parse(await readSpreadsheetAttachment(filePath))).toEqual({
        sheets: [{
          name: 'Summary',
          rows: [['Revenue', 42], [null, { formula: 'B1*2', result: 84 }]],
          truncated: false,
          dimensions: { rows: 2, columns: 2 },
        }],
        truncated: false,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

