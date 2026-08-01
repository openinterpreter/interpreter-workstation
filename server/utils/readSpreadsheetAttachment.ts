import path from 'node:path';
import ExcelJS from 'exceljs';

const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 250;
const MAX_COLUMNS_PER_SHEET = 80;

function serializeCellValue(value: ExcelJS.CellValue): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === 'object') {
    if ('formula' in value) {
      return {
        formula: value.formula,
        result: value.result ?? null,
      };
    }
    if ('richText' in value) {
      return value.richText.map((part) => part.text).join('');
    }
    if ('text' in value) {
      return value.text;
    }
  }
  return value;
}

export async function readSpreadsheetAttachment(filePath: string): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== '.xlsx' && extension !== '.xlsm') {
    throw new Error(
      `Spreadsheet attachment format "${extension || 'unknown'}" is not supported. `
      + 'Save the file as .xlsx or .xlsm, or let the agent inspect it with a spreadsheet skill.',
    );
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheets = workbook.worksheets.slice(0, MAX_SHEETS).map((worksheet) => {
    const rows: unknown[][] = [];
    const maxRow = Math.min(worksheet.actualRowCount, MAX_ROWS_PER_SHEET);
    const maxColumn = Math.min(worksheet.actualColumnCount, MAX_COLUMNS_PER_SHEET);

    for (let rowIndex = 1; rowIndex <= maxRow; rowIndex += 1) {
      const values: unknown[] = [];
      for (let columnIndex = 1; columnIndex <= maxColumn; columnIndex += 1) {
        values.push(serializeCellValue(worksheet.getCell(rowIndex, columnIndex).value));
      }
      while (values.length > 0 && values[values.length - 1] === null) {
        values.pop();
      }
      rows.push(values);
    }

    return {
      name: worksheet.name,
      rows,
      truncated: worksheet.actualRowCount > maxRow || worksheet.actualColumnCount > maxColumn,
      dimensions: {
        rows: worksheet.actualRowCount,
        columns: worksheet.actualColumnCount,
      },
    };
  });

  return JSON.stringify({
    sheets,
    truncated: workbook.worksheets.length > MAX_SHEETS,
  });
}
