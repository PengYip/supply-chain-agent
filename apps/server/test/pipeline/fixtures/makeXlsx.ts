// Test helper: build .xlsx fixtures in-process via exceljs (prod dep), with
// optional merged ranges (A1 notation) for irregular-header coverage.
import ExcelJS from 'exceljs';

export interface XlsxFixtureSheet {
  name: string;
  /** Row-major cell values ('' for empty cells). */
  rows: unknown[][];
  /** Merged ranges in A1 notation, e.g. ['A1:C1', 'B2:B3']. */
  merges?: string[];
}

export async function writeXlsxFixture(filePath: string, sheets: XlsxFixtureSheet[]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.addRows(s.rows);
    for (const m of s.merges ?? []) ws.mergeCells(m);
  }
  await wb.xlsx.writeFile(filePath);
}
