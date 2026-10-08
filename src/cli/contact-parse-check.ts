import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseLocalDocument, type ParseLocalDocumentOptions } from '../contacts/document-worker.js';
import { importFailure } from '../contacts/import-diagnostics.js';

// Container-wide cumulative counters, not per-document usage. Missing cgroup v2 is valid.
function snapshot() {
  const result: Record<string, string> = {};
  for (const name of ['memory.max', 'memory.current', 'memory.peak', 'memory.events',
    'cpu.max', 'cpu.stat', 'pids.max', 'pids.current', 'pids.events']) {
    try { result[name] = readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim(); }
    catch { /* macOS and cgroup v1 may not expose these files. */ }
  }
  return result;
}

/** Parse only: no LLM, database, uploaded-file cleanup or document text in output. */
export async function checkDocumentParse(options: ParseLocalDocumentOptions) {
  const before = snapshot();
  const started = performance.now();
  try {
    const blocks = await parseLocalDocument(options, new AbortController().signal);
    return {outcome:'completed' as const, duration_ms:Math.round(performance.now() - started),
      block_count:blocks.length, cgroup_before:before, cgroup_after:snapshot()};
  } catch (error) {
    return {outcome:'failed' as const, duration_ms:Math.round(performance.now() - started),
      failure:importFailure('parse', error), cgroup_before:before, cgroup_after:snapshot()};
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const filePath = process.argv[2];
  const extension = extname(filePath ?? '').slice(1).toLowerCase();
  const fileType = extension === 'jpeg' ? 'jpg' : extension;
  if (!filePath || !['pdf', 'png', 'jpg'].includes(fileType)) {
    console.error('Usage: contact-parse-check <file.pdf|file.png|file.jpg>');
    process.exitCode = 2;
  } else {
    const result = await checkDocumentParse({
      pythonBin:resolve(process.env.CONTACT_PYTHON_BIN ?? 'python/.venv/bin/python'),
      projectDir:fileURLToPath(new URL('../../python', import.meta.url)),
      filePath:resolve(filePath), fileType:fileType as 'pdf' | 'png' | 'jpg',
      documentId:'parse-check', limits:{max_file_bytes:20 * 1024 ** 2, max_pages:50, max_page_pixels:25_000_000},
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.outcome === 'completed' ? 0 : 1;
  }
}
