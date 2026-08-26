// Test helper: build a minimal but VALID .docx in-process via JSZip.
// mammoth only needs the OPC package skeleton ([Content_Types].xml, package
// rels) plus word/document.xml; relationships file is included empty so the
// docx reader does not trip on missing parts. Chinese text needs no special
// handling (docx XML is UTF-8), which is exactly what these fixtures assert.
import { writeFileSync } from 'node:fs';
import JSZip from 'jszip';

export interface DocxFixtureContent {
  /** Body paragraphs, in order. */
  paragraphs: string[];
  /** Optional single table as row-major cells (first row = header). */
  table?: string[][];
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paragraphXml(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function tableXml(rows: string[][]): string {
  const trs = rows
    .map(
      (cells) =>
        `<w:tr>${cells.map((c) => `<w:tc>${paragraphXml(c)}</w:tc>`).join('')}</w:tr>`,
    )
    .join('');
  const gridCols = (rows[0] ?? []).map(() => '<w:gridCol/>').join('');
  return `<w:tbl><w:tblPr/><w:tblGrid>${gridCols}</w:tblGrid>${trs}</w:tbl>`;
}

/** Write a minimal Chinese-content .docx to `filePath`. */
export async function writeDocxFixture(filePath: string, content: DocxFixtureContent): Promise<void> {
  const bodyParts = content.paragraphs.map(paragraphXml);
  if (content.table && content.table.length > 0) bodyParts.push(tableXml(content.table));

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );
  zip.file(
    'word/document.xml',
    `${XML_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyParts.join(
      '',
    )}</w:body></w:document>`,
  );
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(filePath, buf);
}
