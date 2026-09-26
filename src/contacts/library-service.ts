import type { GraphClient, GraphOp } from './graph-client.js';

type Payload = Record<string, unknown>;

/** The authenticated MCP caller owns every write; callers cannot supply an actor. */
export class ContactLibraryService {
  constructor(private readonly graph: GraphClient) {}

  private async write<T>(op: GraphOp, input: Payload, actor: string): Promise<T> {
    if (!actor.trim()) throw new Error('Authenticated client is required');
    return this.graph.request<T>(op, { ...input, actor });
  }

  get(entityId: string): Promise<Record<string, unknown> | null> {
    return this.graph.request('get_contact', { entity_id: entityId });
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
