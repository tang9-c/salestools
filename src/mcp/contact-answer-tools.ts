import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ContactAnswerService } from '../contacts/contact-answer.js';

const askInput = z.object({
  question: z.string().trim().min(1).max(500),
  entity_id: z.string().trim().min(1).max(128).optional(),
}).strict();

const citation = z.object({
  entity_id: z.string().min(1), relation_id: z.string().min(1).optional(),
  evidence_id: z.string().min(1), quote: z.string().min(1).max(500),
  page: z.int().positive().optional(), file_name: z.string().min(1).optional(),
  source_url: z.url().optional(),
}).strict();
const fact = z.object({
  subject_id: z.string().min(1), predicate: z.string().min(1),
  object: z.string().min(1), evidence_id: z.string().min(1),
}).strict();
const answerOutput = z.object({
  status: z.enum(['answered', 'clarify', 'insufficient', 'failed']),
  answer: z.string().min(1),
  citations: z.array(citation).max(20),
  candidates: z.array(z.object({ entity_id: z.string().min(1), name: z.string().min(1) }).strict()).max(50).optional(),
  facts: z.array(fact).max(20).optional(),
}).strict().superRefine((value, context) => {
  if (!value.facts) return;
  const cited = new Set(value.citations.map(item => item.evidence_id));
  const factual = new Set(value.facts.map(item => item.evidence_id));
  if (value.facts.some(item => !cited.has(item.evidence_id))
    || value.citations.some(item => !factual.has(item.evidence_id))) {
    context.addIssue({ code: 'custom', message: 'Facts and citations must refer to the same selected evidence' });
  }
});

/** Register separately so application wiring can enable it only with the graph-backed service. */
export function registerContactAnswerTools(server: McpServer, answers: Pick<ContactAnswerService, 'ask'>): void {
  server.registerTool('ask_contacts', {
    description: '基于共享联系人图谱和可核实的短证据回答人物关系与任职问题；同名或证据不足时明确说明，不推断当前婚姻或毕业状态。',
    inputSchema: askInput,
  }, async input => {
    const output = answerOutput.parse(await answers.ask(input));
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
  });
}
