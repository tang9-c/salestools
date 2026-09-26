import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, it, expect } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Rk0AAAAASUVORK5CYII=', 'base64');

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  })));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function files(count: number, data = validPng): Promise<string[]> {
  const directory = await mkdtemp(resolve(tmpdir(), 'contact-upload-cli-'));
  temporaryDirectories.push(directory);
  const paths = Array.from({ length: count }, (_, index) => resolve(directory, `card-${index + 1}.png`));
  await Promise.all(paths.map(path => writeFile(path, data)));
  return paths;
}

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function testServer(options: { capacity?: number; reject?: number; secret: string }) {
  const received: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const server = createServer(async (request, response) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      if (request.url !== '/contact-files' || request.method !== 'POST') {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${options.secret}`) {
        response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'UNAUTHORIZED' }));
        return;
      }
      if (options.reject !== undefined) {
        response.writeHead(options.reject, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'REJECTED', message: options.secret }));
        return;
      }
      if (received.length >= (options.capacity ?? Infinity)) {
        response.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'CAPACITY_FULL', message: options.secret }));
        return;
      }
      const contentType = request.headers['content-type'] ?? '';
      const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
      const body = await bodyOf(request);
      const headerEnd = body.indexOf('\r\n\r\n');
      const firstPart = headerEnd < 0 ? '' : body.subarray(0, headerEnd).toString();
      const filename = /filename="([^"]+)"/.exec(firstPart)?.[1];
      const isMultipart = contentType.startsWith('multipart/form-data;') && boundary !== undefined && firstPart.includes('name="file"');
      const hasPngSignature = body.subarray(headerEnd + 4, headerEnd + 12).equals(validPng.subarray(0, 8));
      if (!isMultipart || !filename || !hasPngSignature) {
        response.writeHead(415, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'INVALID_FILE', message: options.secret }));
        return;
      }
      received.push(filename);
      response.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ file_id: `file-${received.length}`, filename, sha256: 'synthetic' }));
    } finally {
      inFlight -= 1;
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return { url: `http://127.0.0.1:${address.port}/contact-files`, received, peakInFlight: () => peakInFlight };
}

async function runUploadCli(paths: string[], url: string, secret = 'test-secret') {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/contact-upload.ts', ...paths], {
    cwd: projectRoot,
    env: { ...process.env, CONTACT_UPLOAD_URL: url, CONTACT_UPLOAD_TOKEN: secret },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [exitCode] = await once(child, 'close') as [number];
  if (!stdout) throw new Error(`CLI did not produce a summary: ${stderr}`);
  return { exitCode, stdout, stderr, summary: JSON.parse(stdout) as { accepted: Array<{ path: string; file_id: string }>; unuploaded: string[]; exitCode: number } };
}

it('uploads one file at a time and reports accepted IDs and remaining paths at capacity', async () => {
  const input = await files(11);
  const server = await testServer({ capacity: 10, secret: 'test-secret' });
  const result = await runUploadCli(input, server.url);
  expect(result.exitCode).not.toBe(0);
  expect(result.summary.accepted).toEqual(input.slice(0, 10).map((path, index) => ({ path, file_id: `file-${index + 1}` })));
  expect(result.summary.unuploaded).toEqual(input.slice(10));
  expect(server.received).toEqual(input.slice(0, 10).map(path => path.split('/').at(-1)));
  expect(server.peakInFlight()).toBe(1);
  expect(result.stdout + result.stderr).not.toContain('test-secret');
});

it('returns only accepted IDs after a successful batch', async () => {
  const input = await files(2);
  const server = await testServer({ secret: 'test-secret' });
  const result = await runUploadCli(input, server.url);
  expect(result.exitCode).toBe(0);
  expect(result.summary).toEqual({ accepted: [{ path: input[0], file_id: 'file-1' }, { path: input[1], file_id: 'file-2' }], unuploaded: [], exitCode: 0 });
  expect(result.stderr).toBe('');
});

it.each([401, 403])('does not treat HTTP %i as an accepted upload or leak the token', async status => {
  const input = await files(2);
  const secret = 'never-print-this-token';
  const server = await testServer({ reject: status, secret });
  const result = await runUploadCli(input, server.url, secret);
  expect(result.exitCode).not.toBe(0);
  expect(result.summary.accepted).toEqual([]);
  expect(result.summary.unuploaded).toEqual(input);
  expect(server.received).toEqual([]);
  expect(result.stdout + result.stderr).not.toContain(secret);
});

it('does not accept a damaged file and stops before later files', async () => {
  const input = await files(2);
  await writeFile(input[0], 'corrupt');
  const server = await testServer({ secret: 'test-secret' });
  const result = await runUploadCli(input, server.url);
  expect(result.exitCode).not.toBe(0);
  expect(result.summary.accepted).toEqual([]);
  expect(result.summary.unuploaded).toEqual(input);
  expect(server.received).toEqual([]);
});

it('rejects an oversized local file before sending a request', async () => {
  const input = await files(1, Buffer.alloc(20 * 1024 * 1024 + 1));
  const server = await testServer({ secret: 'test-secret' });
  const result = await runUploadCli(input, server.url);
  expect(result.exitCode).not.toBe(0);
  expect(result.summary.unuploaded).toEqual(input);
  expect(server.received).toEqual([]);
});
