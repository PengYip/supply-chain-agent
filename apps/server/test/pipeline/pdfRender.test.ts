import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, rgb } from 'pdf-lib';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPdfPages } from '../../src/pipeline/pdfRender.js';

let pdfPath: string;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 50, y: 50, width: 495, height: 742, color: rgb(0, 0, 0) });
  }
  pdfPath = join(mkdtempSync(join(tmpdir(), 'pdfrender-')), 'two-page.pdf');
  writeFileSync(pdfPath, await doc.save());
});

describe('renderPdfPages', () => {
  it('renders all pages as PNG buffers in order', async () => {
    const pages = await renderPdfPages(pdfPath);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.page).toBe(1);
    expect(pages[1]!.page).toBe(2);
    for (const p of pages) {
      expect(p.mime).toBe('image/png');
      expect(p.buffer.length).toBeGreaterThan(1000);
      expect(p.buffer.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
  });

  it('throws a clear error for a non-PDF file', async () => {
    await expect(renderPdfPages('no-such-file.txt')).rejects.toThrow(/pdf/i);
  });
});
