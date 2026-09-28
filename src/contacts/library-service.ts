import type { GraphClient, GraphOp } from './graph-client.js';

type Payload = Record<string, unknown>;

/** The authenticated MCP caller owns every write; callers cannot supply an actor. */
export class ContactLibraryService {
  constructor(private readonly graph: GraphClient,
    private readonly onChanged?: (entityId: string, contentVersion: number) => void) {}

  private async schedule(entityId: unknown): Promise<void> {
    if (!this.onChanged || typeof entityId !== 'string') return;
    try {
      const detail = await this.get(entityId);
      const entity = detail?.entity as { label?: string } | undefined;
      const version = detail?.index_content_version;
      if (entity?.label === 'Person' && detail?.index_status === 'unindexed'
        && typeof version === 'number' && version > 0) {
        this.onChanged(entityId, version);
      }
    } catch { /* Indexing is independent of the committed graph write. */ }
  }

  private async write<T>(op: GraphOp, input: Payload, actor: string): Promise<T> {
    if (!actor.trim()) throw new Error('Authenticated client is required');
    const result = await this.graph.request<T>(op, { ...input, actor });
    const output = result as Payload;
    if (op === 'save_contact' || op === 'restore_contact' || op === 'merge_contacts') {
      void this.schedule(op === 'merge_contacts' ? output.target_id : output.entity_id);
    } else if (op === 'save_relation' && output.relation_type === 'worksFor') {
      void this.schedule(output.source_id);
    } else if (op === 'archive_relation') {
      void this.schedule(output.indexed_source_id);
    }
    return result;
  }

  get(entityId: string, page: {
    evidence_offset?: number; evidence_limit?: number;
    claim_offset?: number; claim_limit?: number;
    relation_offset?: number; relation_limit?: number;
  } = {}): Promise<Record<string, unknown> | null> {
    return this.graph.request('get_contact', { entity_id: entityId, ...page });
  }

  relations(entityId: string): Promise<unknown[]> {
    return this.graph.request('list_relations', { entity_id: entityId });
  }

  save(input: Payload, actor: string): Promise<Payload> {
    return this.write('save_contact', input, actor);
  }

  restore(input: Payload, actor: string): Promise<Payload> {
    return this.write('restore_contact', input, actor);
  }

  merge(input: Payload, actor: string): Promise<Payload> {
    return this.write('merge_contacts', input, actor);
  }

  delete(input: Payload, actor: string): Promise<Payload> {
    return this.write('archive_contact', input, actor);
  }

  saveRelation(input: Payload, actor: string): Promise<Payload> {
    return this.write('save_relation', input, actor);
  }

  deleteRelation(input: Payload, actor: string): Promise<Payload> {
    return this.write('archive_relation', input, actor);
  }
}
