import { expect, it } from 'vitest';
import { splitContactMaterials, packContactMaterials } from '../src/upstream/ark/contact-materials.js';
import type { RankedWebResult } from '../src/contacts/contact-service.js';

function page(overrides: Partial<RankedWebResult> = {}): RankedWebResult {
  return { queryIndex: 0, position: 1, url: 'https://example.cn/a', title: '新闻', summary: null,
    content: '正文', originalPublisher: '发布方', originalDomain: 'example.cn', publishedAt: null, logId: null, ...overrides };
}

it('preserves Unicode and the last person in long material within actual request bytes', () => {
  const text = '😀开头无姓名。'.repeat(500) + '\n测试公司工程师赵六。';
  const chunks = splitContactMaterials([{ logId: null, queryIndex: 0, position: 1, url: 'https://example.cn', title: '新闻', summary: null, content: text, originalPublisher: null, originalDomain: 'example.cn', publishedAt: null }], 3000);
  expect(chunks.at(-1)?.text).toContain('赵六');
  expect(chunks.every(chunk => Buffer.byteLength(chunk.text) <= 3000)).toBe(true);
  expect(chunks.map(chunk => chunk.text).join('')).not.toContain('�');
  const measure = (batch: unknown[]) => Buffer.byteLength(JSON.stringify({ messages: batch }));
  const packed = packContactMaterials(chunks, 3500, measure);
  expect(packed.batches.every(batch => measure(batch) <= 3500)).toBe(true);
  expect(packed.unpackable).toEqual([]);
});

it('rotates queries before pages and assigns IDs from stable page order even for duplicate positions', () => {
  const chunks = splitContactMaterials([page({ url: 'https://example.cn/b' }), page(),
    page({ queryIndex: 1, url: 'https://example.cn/c' })], 3000);
  expect(chunks.map(x => x.id)).toEqual(['q0-p0-c0', 'q1-p0-c0', 'q0-p1-c0']);
});

it('merges repeated URLs and duplicate paragraphs while preserving new paragraphs', () => {
  const chunks = splitContactMaterials([page({ content: '第一段\n重复段' }),
    page({ queryIndex: 2, content: '重复段\n最后段有赵六' })], 3000);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.text).toBe('新闻\n第一段\n重复段\n最后段有赵六');
});

it('retains up to 120 Unicode characters of boundary context for affiliations', () => {
  const text = '无姓名。'.repeat(200) + '测试公司工程师赵六';
  const chunks = splitContactMaterials([page({ title: '', content: text })], 300);
  for (const chunk of chunks) expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
  expect(chunks.some(x => x.text.includes('测试公司工程师赵六'))).toBe(true);
  expect(chunks[1]!.start).toBeLessThan(chunks[0]!.end);
});

it('shrinks text for metadata without losing content or using noncanonical fragment IDs', () => {
  const chunks = splitContactMaterials([page({ content: '😀'.repeat(100) })], 3000);
  const measure = (batch: unknown[]) => Buffer.byteLength(JSON.stringify({ model: 'test', chunks: batch }));
  const packed = packContactMaterials(chunks, 500, measure);
  expect(packed.unpackable).toEqual([]);
  const fragments = packed.batches.flat();
  expect(fragments[0]!.start).toBe(0);
  expect(fragments.at(-1)!.end).toBe(chunks[0]!.end);
  for (let index = 0; index < fragments.length; index++) {
    const fragment = fragments[index]!;
    expect(fragment.text).toBe(chunks[0]!.text.slice(fragment.start, fragment.end));
    if (index) expect(fragment.start).toBeLessThanOrEqual(fragments[index - 1]!.end);
  }
  expect(packed.batches.flat().every(x => /^q\d+-p\d+-c\d+$/u.test(x.id))).toBe(true);
});
