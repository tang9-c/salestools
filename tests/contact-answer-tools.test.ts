import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { registerContactAnswerTools } from '../src/mcp/contact-answer-tools.js';
import type { ContactAnswerResult, ContactAnswerService } from '../src/contacts/contact-answer.js';

async function connected(answer: (input: { question: string; entity_id?: string }) => Promise<ContactAnswerResult>) {
  const server = new McpServer({ name: 'contacts-test', version: '1.0.0' });
  registerContactAnswerTools(server, { ask: answer } as ContactAnswerService);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('ask_contacts MCP registration', () => {
  it('passes a bounded question and entity ID to the answer service with structured citations', async () => {
    const ask = vi.fn(async () => ({ status: 'answered' as const, answer: '陈晓的配偶关系记录指向王明。',
      citations: [{ entity_id: 'p1', relation_id: 'r1', evidence_id: 'e1', quote: '陈晓配偶王明',
        page: 1, file_name: 'resume.pdf' }],
      facts: [{ subject_id: 'p1', predicate: 'spouse', object: '王明', evidence_id: 'e1' }] }));
    const session = await connected(ask);
    try {
      expect((await session.client.listTools()).tools.map(tool => tool.name)).toContain('ask_contacts');
      const response = await session.client.callTool({ name: 'ask_contacts', arguments: {
        question: '陈晓的配偶是谁？', entity_id: 'p1',
      } });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ status: 'answered',
        citations: [{ evidence_id: 'e1', relation_id: 'r1', page: 1 }] });
      expect(ask).toHaveBeenCalledWith({ question: '陈晓的配偶是谁？', entity_id: 'p1' });
    } finally { await session.close(); }
  });

  it('preserves clarify, insufficient and failed status with structured facts on failure', async () => {
    for (const status of ['clarify', 'insufficient', 'failed'] as const) {
      const answer = vi.fn(async (): Promise<ContactAnswerResult> => ({ status, answer: '需要进一步确认',
        citations: status === 'failed' ? [{ entity_id: 'p1', evidence_id: 'e1', quote: '陈晓配偶王明' }] : [],
        ...(status === 'failed' ? { facts: [{ subject_id: 'p1', predicate: 'spouse', object: '王明', evidence_id: 'e1' }] } : {}),
        ...(status === 'clarify' ? { candidates: [{ entity_id: 'p1', name: '陈晓' }] } : {}) }));
      const session = await connected(answer);
      try {
        const response = await session.client.callTool({ name: 'ask_contacts', arguments: { question: '陈晓是谁？' } });
        expect(response.structuredContent).toMatchObject({ status });
        if (status === 'failed') expect(response.structuredContent).toMatchObject({ facts: [{ evidence_id: 'e1' }] });
      } finally { await session.close(); }
    }
  });

  it('rejects blank, overlong and unknown parameters before invoking the answer service', async () => {
    const ask = vi.fn(async (): Promise<ContactAnswerResult> => ({ status: 'insufficient', answer: '无证据', citations: [] }));
    const session = await connected(ask);
    try {
      for (const arguments_ of [{ question: ' ' }, { question: 'x'.repeat(501) },
        { question: '陈晓是谁？', actor: 'forged' }, { question: '陈晓是谁？', entity_id: '' }]) {
        const response = await session.client.callTool({ name: 'ask_contacts', arguments: arguments_ });
        expect(response.isError).toBe(true);
      }
      expect(ask).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });
});

it('preserves independently cited company context through MCP output validation',async()=>{
  const session=await connected(async()=>({status:'answered',answer:'已有任职记录，企业行业为装备制造。',citations:[],facts:[],
    context_citations:[{ref:'profile:one',source_type:'profile',subject_id:'company',value:'装备制造'}],context_warnings:['部分来源不可用']}));
  try {
    const response=await session.client.callTool({name:'ask_contacts',arguments:{question:'公司背景是什么？'}});
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({context_citations:[{ref:'profile:one'}],context_warnings:['部分来源不可用']});
  } finally {await session.close();}
});
