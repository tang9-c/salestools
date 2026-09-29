import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UploadStore } from '../src/contacts/upload-store.js';
import { parseLocalDocument } from '../src/contacts/document-worker.js';
import { DocumentExtractor, type DocumentExtractorOptions } from '../src/contacts/document-extractor.js';
import { ContactGraphClient } from '../src/contacts/graph-client.js';
import { ContactImportService } from '../src/contacts/import-service.js';
import { ImportJobs } from '../src/contacts/import-jobs.js';
import type { ImportCandidate, ParsedBlock } from '../src/contracts/index.js';
export const root = fileURLToPath(new URL('../', import.meta.url));
export type Detail = { entity: { entity_id: string; label: string; metadata: { version: number }; properties: Record<string, any> }; relations: Array<{ relation_type: string; source_id: string; target_id: string; properties: any }>; evidence: any[]; unverified_claims: any[] };
// Only invented fixture facts. Locators are resolved against real Docling output.
export function fixtureProfile(blocks: ParsedBlock[], card = false) {
  const ref = (quote: string) => { const b = blocks.find(b => b.text.includes(quote)); if (!b) throw new Error(`Fixture quote missing: ${quote}`); return { block_id: b.block_id, quote }; };
  const fact = (field_path: string, value: unknown, quote: string, uncertain = false) => ({ field_path, value, evidence: [ref(quote)], uncertain });
  const link = (quote: string, uncertain = false) => ({ evidence: [ref(quote)], uncertain });
  const org = (name: string) => [fact('properties.name', name, name)];
  if (card) return { subject_status: 'single', person: [fact('properties.name', 'Robin Vale', 'Robin Vale')], education: [], employment: [], projects: [], organization_clues: [{ organization: org('Sample Studio'), association: link('Sample Studio', true) }] };
  return { subject_status: 'single', person: [fact('properties.name', 'Riley Example', 'Riley Example'),
    ...['+15550100999', '+15550100888'].map(v => fact('properties.telephone', v, v)),
    ...['riley@example.test', 'riley.work@example.test'].map(v => fact('properties.email', v, v)),
    fact('properties.skills', 'Python', 'Python'), fact('properties.skills', 'Python', 'Python'),
    fact('properties.skills', 'Linux operations', 'Linux maintenance'),
    fact('properties.jobTitle', 'Solutions Architect', 'Solutions Architect', true)],
    education: ['Willow Example Academy', 'Birch Example University'].map((name, i) => ({ local_id: `edu${i}`, organization: org(name), attendance: link(name) })),
    employment: ['2020-2022', '2022-2023'].map((date, i) => ({ local_id: `job${i}`, organization: org('Cedar Example Labs'), employment: link('Cedar Example Labs'), role: [fact('properties.role.startDate', date.slice(0, 4), date), fact('properties.role.endDate', date.slice(5), date)] })),
    projects: [['Project Aurora', 'Maple Example Client'], ['Project Beacon', 'Ash Example Client']].map(([name, client], i) => ({ local_id: `project${i}`, project: [fact('properties.name', name, name)], participation: link(name), role: [], clients: [{ organization: org(client), client: link(client, i === 1) }] })),
    organization_clues: [{ organization: org('Spruce Example Network'), association: link('Spruce Example Network', true) }] };
}
export async function acceptanceHarness(filePath: string, model: Pick<DocumentExtractorOptions, 'url' | 'model' | 'credential' | 'fetchFn'>) {
  const directory = await mkdtemp(join(tmpdir(), 'contact-acceptance-'));
  const graph = new ContactGraphClient({ command: join(root, 'rust/contact-graph/target/debug/contact-graph'), dbPath: join(directory, 'graph.sqlite') });
  const uploads = new UploadStore({ directory: join(directory, 'uploads'), maxPendingFiles: 3, maxFileBytes: 20_000_000, maxTempBytes: 60_000_000 });
  const jobs = new ImportJobs({ concurrency: 1, timeoutMs: 900_000, release: id => uploads.release(id) });
  let parsed: ParsedBlock[] = [];
  const service = new ContactImportService({ graph, uploads, jobs,
    parse: async (file, signal) => parsed = await parseLocalDocument({ pythonBin: join(root, 'python/.venv/bin/python'), projectDir: join(root, 'python'), filePath: file.tempPath, fileType: filePath.endsWith('.png') ? 'png' : 'pdf', documentId: file.fileId, limits: {} }, signal),
    extract: (blocks, file, signal) => new DocumentExtractor({ ...model, fileName: 'acceptance-input' + (filePath.endsWith('.png') ? '.png' : '.pdf'), fileSha256: file.sha256, collectedAt: file.uploadedAt }).extract(blocks, signal),
  });
  const close = async () => { await jobs.recover(); await uploads.close(); await graph.close(); await rm(directory, { recursive: true, force: true }); };
  try {
    const fileId = await uploads.reserve();
    const file = await uploads.receive(fileId, createReadStream(filePath), basename(filePath));
    await uploads.preflight(file);
    const started = await service.start({ file_id: fileId, operation_id: 'acceptance-start' }, 'acceptance');
    let preview = await service.get(started.import_id, 'acceptance');
    const until = Date.now() + 900_000;
    while (preview?.status !== 'ready_for_review' && preview?.status !== 'failed' && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 100)); preview = await service.get(started.import_id, 'acceptance');
    }
    const commitInput = { import_id: started.import_id, preview_version: preview!.version as number, operation_id: `contact-import:${started.import_id}`, auto_create: true };
    return { graph, uploads, service, close, preview: preview!, parsed, commitInput, candidates: (preview!.candidates ?? []) as ImportCandidate[],
      commit: () => service.commit(commitInput, 'acceptance') as Promise<{ results: Array<{ candidate_id: string; entity_id: string }> }> };
  } catch (error) { await close(); throw error; }
}
