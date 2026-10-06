import { request } from 'node:http';
import { safeCode, safeDiagnostic } from './import-diagnostics.js';

export async function callWorkerSocket<T>(socketPath: string, route: string,
  payload: unknown, signal?: AbortSignal, maxResponseBytes = 20 * 1024 * 1024): Promise<T> {
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > 4096) throw new Error('WORKER_REQUEST_TOO_LARGE');
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    const outgoing = request({ socketPath, path: route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: 900_000 }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) {
          outgoing.destroy(new Error('WORKER_RESPONSE_TOO_LARGE')); return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { value?: T; code?: string; diagnostic?: unknown };
          if (response.statusCode !== 200) throw Object.assign(new Error(safeCode(result.code, 'WORKER_FAILED')), {
            diagnostic: safeDiagnostic(result.diagnostic),
          });
          finish(undefined, result.value);
        } catch (error) { finish(error as Error); }
      });
    });
    const abort = () => outgoing.destroy(new Error('ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    outgoing.once('timeout', () => outgoing.destroy(new Error('WORKER_TIMEOUT')));
    outgoing.once('error', error => finish(error));
    outgoing.end(body);
    if (signal?.aborted) abort();
  });
}
