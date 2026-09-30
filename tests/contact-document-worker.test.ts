import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLocalDocument } from '../src/contacts/document-worker.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = resolve(root, 'python/.venv/bin/python');
const pdf = resolve(root, 'tests/fixtures/contact-documents/synthetic-resume.pdf');

describe('Docling worker bridge', () => {
  it('parses a real local PDF and preserves parser block provenance', async () => {
    const blocks = await parseLocalDocument({ sandboxMode: 'test-only', pythonBin: python, projectDir: resolve(root, 'python'),
      filePath: pdf, fileType: 'pdf', documentId: 'test',
      limits: { max_pages: 50, max_file_bytes: 20 * 1024 * 1024 } }, new AbortController().signal);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every(block => block.block_id.length > 0 && block.text.length > 0)).toBe(true);
    expect(blocks.some(block => block.page === 1)).toBe(true);
  }, 120_000);

  it('rejects an already cancelled parse before spawning', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(parseLocalDocument({ sandboxMode: 'test-only', pythonBin: python, projectDir: resolve(root, 'python'),
      filePath: pdf, fileType: 'pdf', documentId: 'test', limits: {} }, controller.signal))
      .rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects aggregate parsed text even when every individual frame is valid', async () => {
    await expect(parseLocalDocument({ sandboxMode: 'test-only', pythonBin: python, projectDir: resolve(root, 'python'),
      filePath: pdf, fileType: 'pdf', documentId: 'test', limits: {}, maxTotalTextBytes: 1 },
    new AbortController().signal)).rejects.toMatchObject({ code: 'DOCUMENT_OUTPUT_TOO_LARGE' });
  }, 120_000);

  it('preserves the worker error code without echoing a local path', async () => {
    await expect(parseLocalDocument({ sandboxMode: 'test-only', pythonBin: python, projectDir: resolve(root, 'python'),
      filePath: resolve(root, 'tests/fixtures/contact-documents/missing.pdf'), fileType: 'pdf',
      documentId: 'test', limits: {} }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
  }, 120_000);
});
