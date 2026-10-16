import type { ZohoContactsOutput, ZohoOwner } from '../contracts/zoho-contact.js';

/** Per-request projection; never persist caller-specific flags in the shared graph. */
export function annotateZohoOwners(result: ZohoContactsOutput,
  identity: { connectionId: string; userId: string } | null): ZohoContactsOutput {
  const owner = (value: ZohoOwner | null, connectionId: string): ZohoOwner | null => value && ({ ...value,
    is_current_user: identity?.connectionId === connectionId && value.id ? value.id === identity.userId : null });
  return { ...result,
    connections: result.connections.map(connection => ({ ...connection,
      candidates: connection.candidates.map(candidate => ({ ...candidate, account_owner: owner(candidate.account_owner, connection.connection_id) })) })),
    companies: result.companies.map(company => ({ ...company, account_owner: owner(company.account_owner, company.connection_id),
      contacts: company.contacts.map(contact => ({ ...contact, contact_owner: owner(contact.contact_owner, company.connection_id) })) })) };
}
