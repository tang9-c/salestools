import type { RankedWebResult } from '../../contacts/contact-service.js';

export interface ContactMaterial {
  id: string;
  url: string;
  title: string;
  originalPublisher: string | null;
  publishedAt: string | null;
  text: string;
  start: number;
  end: number;
}

export function splitContactMaterials(items: readonly RankedWebResult[], maxTextBytes: number): ContactMaterial[] {
  if (maxTextBytes < 4) throw new RangeError('maxTextBytes must fit a Unicode character');
  const pages = [...items].sort((a, b) => a.queryIndex - b.queryIndex || a.position - b.position || a.url.localeCompare(b.url));
  const merged = new Map<string, { item: RankedWebResult; paragraphs: string[] }>();
  for (const item of pages) {
    let page = merged.get(item.url);
    if (!page) {
      page = { item, paragraphs: [] };
      merged.set(item.url, page);
    }
    for (const paragraph of [item.title, item.summary, item.content].filter((x): x is string => !!x).flatMap(x => x.split(/\n+/u))) {
      if (!page.paragraphs.includes(paragraph)) page.paragraphs.push(paragraph);
    }
  }
  const counts = new Map<number, number>();
  const buckets: ContactMaterial[][] = [];
  for (const { item, paragraphs } of merged.values()) {
    const pageIndex = counts.get(item.queryIndex) ?? 0;
    counts.set(item.queryIndex, pageIndex + 1);
    const text = paragraphs.join('\n');
    const chunks: ContactMaterial[] = [];
    let start = 0;
    while (start < text.length) {
      let end = start;
      let bytes = 0;
      let paragraphEnd = -1;
      for (const point of text.slice(start)) {
        const size = Buffer.byteLength(point);
        if (bytes + size > maxTextBytes) break;
        bytes += size;
        end += point.length;
        if (point === '\n') paragraphEnd = end;
      }
      if (end < text.length && paragraphEnd > start + (end - start) / 2) end = paragraphEnd;
      chunks.push({
        id: `q${item.queryIndex}-p${pageIndex}-c${chunks.length}`,
        url: item.url,
        title: item.title,
        originalPublisher: item.originalPublisher,
        publishedAt: item.publishedAt,
        text: text.slice(start, end),
        start,
        end,
      });
      if (end === text.length) break;
      const points = [...text.slice(start, end)];
      const overlap = points.slice(-Math.min(120, Math.floor(points.length / 2))).join('');
      start = end - overlap.length > start ? end - overlap.length : end;
    }
    if (chunks.length) buckets.push(chunks);
  }
  const pageBuckets = new Map<number, ContactMaterial[][]>();
  for (const bucket of buckets) {
    const query = Number(bucket[0]!.id.match(/^q(\d+)/u)![1]);
    const pages = pageBuckets.get(query) ?? [];
    pages.push(bucket);
    pageBuckets.set(query, pages);
  }
  const rotated: ContactMaterial[][] = [];
  for (let rank = 0; [...pageBuckets.values()].some(pages => rank < pages.length); rank++) {
    for (const pages of pageBuckets.values()) if (pages[rank]) rotated.push(pages[rank]!);
  }
  const output: ContactMaterial[] = [];
  for (let index = 0; rotated.some(bucket => index < bucket.length); index++) {
    for (const bucket of rotated) if (bucket[index]) output.push(bucket[index]!);
  }
  return output;
}

export function packContactMaterials(
  chunks: readonly ContactMaterial[],
  requestMaxBytes: number,
  measureBytes: (chunks: ContactMaterial[]) => number,
): { batches: ContactMaterial[][]; unpackable: Array<{ id: string; reason: 'INPUT_TOO_LARGE'; url: string }> } {
  const pending = chunks.map(chunk => ({ ...chunk }));
  const unpackable: Array<{ id: string; reason: 'INPUT_TOO_LARGE'; url: string }> = [];
  // Final IDs are part of the actual serialized byte measurement.
  for (let index = 0; index < pending.length;) {
    const counts = new Map<string, number>();
    for (const chunk of pending) {
      const page = chunk.id.replace(/-c.*$/u, '');
      const next = counts.get(page) ?? 0;
      chunk.id = `${page}-c${next}`;
      counts.set(page, next + 1);
    }
    const chunk = pending[index]!;
    if (measureBytes([chunk]) <= requestMaxBytes) {
      index++;
      continue;
    }
    const points = [...chunk.text];
    if (points.length < 2 || measureBytes([{ ...chunk, text: points[0]!, end: chunk.start + points[0]!.length }]) > requestMaxBytes) {
      unpackable.push({ id: chunk.id, reason: 'INPUT_TOO_LARGE', url: chunk.url });
      pending.splice(index, 1);
      continue;
    }
    const midpoint = Math.floor(points.length / 2);
    const left = points.slice(0, midpoint).join('');
    const overlap = Math.min(120, Math.floor(midpoint / 2));
    const rightStart = points.slice(0, midpoint - overlap).join('').length;
    pending.splice(index, 1,
      { ...chunk, text: left, end: chunk.start + left.length },
      { ...chunk, text: chunk.text.slice(rightStart), start: chunk.start + rightStart });
    index = 0;
  }
  const batches: ContactMaterial[][] = [];
  let batch: ContactMaterial[] = [];
  const byPage = new Map<string, ContactMaterial[]>();
  for (const chunk of pending) {
    const page = chunk.id.replace(/-c.*$/u, '');
    const fragments = byPage.get(page) ?? [];
    fragments.push(chunk);
    byPage.set(page, fragments);
  }
  const rotated: ContactMaterial[] = [];
  for (let index = 0; [...byPage.values()].some(fragments => index < fragments.length); index++) {
    for (const fragments of byPage.values()) if (fragments[index]) rotated.push(fragments[index]!);
  }
  for (const chunk of rotated) {
    if (batch.length && measureBytes([...batch, chunk]) > requestMaxBytes) {
      batches.push(batch);
      batch = [];
    }
    batch.push(chunk);
  }
  if (batch.length) batches.push(batch);
  return { batches, unpackable };
}
