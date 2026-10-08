import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp } from '../src/mcp/http-app.js';
import { UploadStore } from '../src/contacts/upload-store.js';

const pdf = readFileSync(new URL('./fixtures/contact-documents/synthetic-resume.pdf', import.meta.url));
const png = readFileSync(new URL('./fixtures/contact-documents/synthetic-card.png', import.meta.url));
const directories: string[] = [];
const stores: UploadStore[] = [];
const servers: import('node:http').Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('cleans restart orphans and expires only unsubmitted files after one hour', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'contact-upload-test-'));
  directories.push(directory);
  writeFileSync(join(directory, 'orphan'), pdf);
  const store = new UploadStore({ directory, maxPendingFiles: 10, maxFileBytes: 20_971_520,
    maxTempBytes: 1_073_741_824 });
  stores.push(store);
  await store.cleanupOrphans();
  expect(readdirSync(directory)).toEqual([]);
  vi.useFakeTimers();
  const unsubmittedId = await store.reserve('reviewer');
  await store.receive(unsubmittedId, Readable.from([pdf]), 'resume.pdf');
  const submittedId = await store.reserve('reviewer');
  await store.receive(submittedId, Readable.from([pdf]), 'resume.pdf');
  store.markSubmitted(submittedId);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(store.get(submittedId)).not.toBeNull();
  expect(store.get(unsubmittedId)).toBeNull();
});

it('enforces the configured aggregate temporary-byte budget while streaming', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'contact-upload-test-'));
  directories.push(directory);
  const store = new UploadStore({ directory, maxPendingFiles: 10, maxFileBytes: 20_971_520,
    maxTempBytes: pdf.length - 1 });
  stores.push(store);
  const id = await store.reserve('reviewer');
  await expect(store.receive(id, Readable.from([pdf]), 'resume.pdf')).rejects.toThrow('TEMP_CAPACITY_FULL');
  expect(store.pendingCount).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
});

async function setup(maxPendingFiles = 10, maxFileBytes = 20 * 1024 * 1024,
  maxImagePixels = 25_000_000, maxPdfPages = 50) {
  const directory = mkdtempSync(join(tmpdir(), 'contact-upload-test-'));
  directories.push(directory);
  const store = new UploadStore({ directory, maxPendingFiles, maxFileBytes, maxImagePixels, maxPdfPages,
    maxTempBytes: 1024 * 1024 * 1024 });
  stores.push(store);
  const app = createHttpApp({ publicMcpHost: '127.0.0.1', allowedOriginUrls: new Set(['https://ok.example']),
    allowedOriginHostnames: new Set(['ok.example']) }, token => ['good', 'another-token'].includes(token) ? { userId: 'owner' } as never : null,
  () => ({} as never), store);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/contact-files`;
  const upload = async (content = pdf, headers: Record<string, string> = { Authorization: 'Bearer good' }) => {
    const body = new FormData();
    body.append('file', new Blob([new Uint8Array(content)]), 'resume.pdf');
    return fetch(url, { method: 'POST', headers, body });
  };
  return { store, upload, url, directory };
}

it('accepts one authenticated stream and returns only opaque id, name and digest', async () => {
  const { store, upload } = await setup();
  const response = await upload();
  expect(response.status).toBe(201);
  const result = await response.json() as Record<string, string>;
  expect(result).toEqual({ file_id: expect.stringMatching(/^[0-9a-f-]{36}$/), filename: 'resume.pdf',
    sha256: createHash('sha256').update(pdf).digest('hex') });
  expect(store.get(result.file_id)?.tempPath).toBeTruthy();
});

it.each([
  ['filename="合成简历.pdf"', '合成简历.pdf'],
  ['filename="resume.pdf"', 'resume.pdf'],
  ["filename=\"fallback.pdf\"; filename*=UTF-8''%E5%90%88%E6%88%90%E7%AE%80%E5%8E%86.pdf", '合成简历.pdf'],
  ['filename="folder/合成简历.pdf"', '合成简历.pdf'],
])('preserves multipart filename %s through the upload endpoint', async (disposition, filename) => {
  const { store, url } = await setup();
  const body = Buffer.concat([
    Buffer.from(`--filename-test\r\nContent-Disposition: form-data; name="file"; ${disposition}\r\nContent-Type: application/pdf\r\n\r\n`),
    pdf, Buffer.from('\r\n--filename-test--\r\n'),
  ]);
  const response = await fetch(url, { method: 'POST', headers: {
    Authorization: 'Bearer good', 'Content-Type': 'multipart/form-data; boundary=filename-test',
  }, body });
  expect(response.status).toBe(201);
  const result = await response.json() as Record<string, string>;
  expect(result.filename).toBe(filename);
  expect(store.get(result.file_id)?.fileName).toBe(filename);
});

it('reserves all ten slots before reading another body', async () => {
  const { store, upload, directory } = await setup();
  await Promise.all(Array.from({ length: 10 }, (_, index) => store.reserve(`reviewer-${index}`)));
  const response = await upload();
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ code: 'CAPACITY_FULL' });
  expect(readdirSync(directory)).toEqual([]);
});

it('limits authenticated upload attempts even when rejected bodies release their slots', async () => {
  const { upload, store } = await setup();
  for (let n = 0; n < 5; n++) expect((await upload(Buffer.from('bad'))).status).toBe(415);
  const response = await upload(pdf, { Authorization: 'Bearer another-token' });
  expect(response.status).toBe(429);
  expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(await response.json()).toMatchObject({ code: 'CONTACT_RATE_LIMITED', retry_after_seconds: expect.any(Number) });
  expect(store.pendingCount).toBe(0);
});

it('rejects unauthorized requests, invalid content and a configured byte limit without artifacts', async () => {
  const { store, upload, directory } = await setup(10, 8);
  expect((await upload(pdf, {})).status).toBe(401);
  expect((await upload(pdf, { Authorization: 'Bearer bad' })).status).toBe(401);
  expect((await upload(pdf, { Authorization: 'Bearer good', Origin: 'https://evil.example' })).status).toBe(403);
  expect((await upload(pdf)).status).toBe(413);
  expect((await upload(Buffer.from('bad'))).status).toBe(415);
  expect(store.pendingCount).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
});

it('runs Python preflight before accepting malformed PDF or overlarge image', async () => {
  const { store, upload, directory } = await setup(10, 20 * 1024 * 1024, 1);
  const malformed = Buffer.from('%PDF-1.4\ntrailer <<>>\n%%EOF\n');
  const brokenResponse = await upload(malformed);
  expect(brokenResponse.status).toBe(422);
  expect(await brokenResponse.json()).toEqual({ code: 'INVALID_DOCUMENT' });
  const pixelResponse = await upload(png);
  expect(pixelResponse.status).toBe(422);
  expect(await pixelResponse.json()).toEqual({ code: 'IMAGE_PIXELS_EXCEEDED' });
  expect(store.pendingCount).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
});

it('rejects encrypted PDFs and configured page limits before returning a file id', async () => {
  const { store, upload, directory } = await setup(10, 20 * 1024 * 1024, 25_000_000, 1);
  const pagesResponse = await upload(pdf);
  expect(pagesResponse.status).toBe(422);
  expect(await pagesResponse.json()).toEqual({ code: 'PDF_PAGE_LIMIT' });
  const encryptedPath = join(directory, 'encrypted.pdf');
  const script = 'from pypdf import PdfReader,PdfWriter; import sys; w=PdfWriter(); w.append_pages_from_reader(PdfReader(sys.argv[1])); w.encrypt("secret"); w.write(sys.argv[2])';
  const created = spawnSync(new URL('../python/.venv/bin/python', import.meta.url).pathname,
    ['-c', script, new URL('./fixtures/contact-documents/synthetic-resume.pdf', import.meta.url).pathname, encryptedPath]);
  expect(created.status).toBe(0);
  const encrypted = readFileSync(encryptedPath);
  rmSync(encryptedPath);
  const encryptedResponse = await upload(encrypted);
  expect(encryptedResponse.status).toBe(422);
  expect(await encryptedResponse.json()).toEqual({ code: 'ENCRYPTED_PDF' });
  expect(store.pendingCount).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
});

it('removes a partially disconnected upload', async () => {
  const { store, url, directory } = await setup();
  let reserved = false;
  await new Promise<void>(resolve => {
    const request = httpRequest(url, { method: 'POST', headers: {
      Authorization: 'Bearer good', 'Content-Type': 'multipart/form-data; boundary=broken',
    } });
    request.on('error', () => resolve());
    request.write('--broken\r\nContent-Disposition: form-data; name="file"; filename="resume.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-');
    setTimeout(() => { reserved = store.pendingCount === 1; request.destroy(); }, 20);
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(reserved).toBe(true);
  expect(store.pendingCount).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
});

it('rejects an unapproved Host before accepting an upload', async () => {
  const { store, url, directory } = await setup();
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers: {
      Authorization: 'Bearer good', Host: 'evil.example',
      'Content-Type': 'multipart/form-data; boundary=bad',
    } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
    request.once('error', reject);
    request.end('--bad--\r\n');
  });
  expect(status).toBe(403);
  expect(store.pendingCount).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
});
