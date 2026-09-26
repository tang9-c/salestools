use chrono::DateTime;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlite_knowledge_graph::{Entity, Relation};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::store::{canonical_hash, now_utc, AppError, Store};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Contact {
    name: String,
    title: String,
    source_url: String,
    published_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Company {
    company_name: String,
    contacts: Vec<Contact>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    snapshot_id: u64,
    cache_key: String,
    normalized_query: String,
    normalized_region_hint: Option<String>,
    collected_at: String,
    stored_at: String,
    companies: Vec<Company>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncInput {
    operation_id: String,
    actor: String,
    #[serde(default)]
    initialize: bool,
    snapshots: Vec<Snapshot>,
}

fn normalized(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn source_key(kind: &str, parts: &[&str]) -> String {
    let bytes = serde_json::to_vec(parts).expect("strings serialize");
    format!("{kind}:{:x}", Sha256::digest(bytes))
}

fn cursor(tx: &rusqlite::Connection) -> Result<(u64, bool), AppError> {
    let row: Option<(i64, i64)> = tx
        .query_row(
            "SELECT last_snapshot_id,initialized FROM sync_cursor WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(AppError::internal)?;
    Ok(row.map_or((0, false), |(id, initialized)| {
        (id as u64, initialized != 0)
    }))
}

fn validate(input: &SyncInput) -> Result<(), AppError> {
    if input.actor != "system" {
        return Err(AppError::validation("Snapshot sync requires system actor"));
    }
    if input.initialize {
        if input.operation_id != "snapshot-sync:initialize" || !input.snapshots.is_empty() {
            return Err(AppError::validation("Invalid sync initialization"));
        }
        return Ok(());
    }
    if input.snapshots.is_empty() || input.snapshots.len() > 100 {
        return Err(AppError::validation("Invalid snapshot batch size"));
    }
    let first = input.snapshots.first().unwrap().snapshot_id;
    let last = input.snapshots.last().unwrap().snapshot_id;
    if first == 0 || input.operation_id != format!("snapshot-sync:{first}-{last}") {
        return Err(AppError::validation("Invalid snapshot operation ID"));
    }
    let mut previous = 0;
    for snapshot in &input.snapshots {
        if snapshot.snapshot_id <= previous
            || snapshot.cache_key.trim().is_empty()
            || snapshot.normalized_query.trim().is_empty()
            || DateTime::parse_from_rfc3339(&snapshot.collected_at).is_err()
            || DateTime::parse_from_rfc3339(&snapshot.stored_at).is_err()
        {
            return Err(AppError::validation("Invalid snapshot metadata"));
        }
        previous = snapshot.snapshot_id;
        for company in &snapshot.companies {
            if company.company_name.trim().is_empty() {
                return Err(AppError::validation("Invalid snapshot company"));
            }
            for contact in &company.contacts {
                if contact.name.trim().is_empty()
                    || contact.title.trim().is_empty()
                    || !(contact.source_url.starts_with("https://")
                        || contact.source_url.starts_with("http://"))
                    || contact
                        .published_at
                        .as_ref()
                        .is_some_and(|value| DateTime::parse_from_rfc3339(value).is_err())
                {
                    return Err(AppError::validation("Invalid snapshot contact"));
                }
            }
        }
    }
    Ok(())
}

fn mapped(tx: &Transaction<'_>, key: &str) -> Result<Option<(String, Option<String>)>, AppError> {
    tx.query_row(
        "SELECT entity_id,relation_id FROM source_mapping WHERE source_key=?1",
        [key],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(AppError::internal)
}

fn resolved_entity(tx: &Transaction<'_>, initial: &str) -> Result<(String, bool), AppError> {
    let mut id = initial.to_owned();
    for _ in 0..32 {
        let raw: String = tx
            .query_row(
                "SELECT metadata_json FROM entity_meta WHERE entity_id=?1",
                [&id],
                |row| row.get(0),
            )
            .map_err(AppError::internal)?;
        let meta: Value = serde_json::from_str(&raw).map_err(AppError::internal)?;
        if let Some(target) = meta.get("merged_into").and_then(Value::as_str) {
            id = target.to_owned();
        } else {
            return Ok((id, meta.get("archived_at").is_some()));
        }
    }
    Err(AppError::validation("Merged contact chain is too deep"))
}

fn new_entity(
    store: &Store,
    tx: &Transaction<'_>,
    label: &str,
    name: &str,
    properties: Value,
    now: &str,
) -> Result<(String, i64), AppError> {
    let id = format!(
        "{}_{}",
        if label == "Person" { "p" } else { "o" },
        Uuid::new_v4().as_simple()
    );
    let mut entity = Entity::new(label, name);
    entity.properties = serde_json::from_value(properties).map_err(AppError::internal)?;
    let kg_id = store
        .graph
        .insert_entity(&entity)
        .map_err(AppError::internal)?;
    tx.execute(
        "INSERT INTO entity_ids(entity_id,kg_id) VALUES(?1,?2)",
        params![id, kg_id],
    )
    .map_err(AppError::internal)?;
    let extensions = if label == "Person" {
        Some(json!({}).to_string())
    } else {
        None
    };
    tx.execute(
        "INSERT INTO entity_meta(entity_id,metadata_json,extensions_json) VALUES(?1,?2,?3)",
        params![
            id,
            json!({"version":1,"created_at":now,"updated_at":now}).to_string(),
            extensions
        ],
    )
    .map_err(AppError::internal)?;
    Ok((id, kg_id))
}

fn entity_kg_id(tx: &Transaction<'_>, id: &str) -> Result<i64, AppError> {
    tx.query_row(
        "SELECT kg_id FROM entity_ids WHERE entity_id=?1",
        [id],
        |row| row.get(0),
    )
    .map_err(AppError::internal)
}

fn new_relation(
    store: &Store,
    tx: &Transaction<'_>,
    person_kg: i64,
    organization_kg: i64,
    title: &str,
    now: &str,
) -> Result<String, AppError> {
    let id = format!("r_{}", Uuid::new_v4().as_simple());
    let mut relation =
        Relation::new(person_kg, organization_kg, "worksFor", 1.0).map_err(AppError::internal)?;
    relation.set_property("role", json!({"@type":"OrganizationRole","roleName":title}));
    let kg_id = store
        .graph
        .insert_relation(&relation)
        .map_err(AppError::internal)?;
    tx.execute(
        "INSERT INTO relation_ids(relation_id,kg_id) VALUES(?1,?2)",
        params![id, kg_id],
    )
    .map_err(AppError::internal)?;
    tx.execute(
        "INSERT INTO relation_meta(relation_id,metadata_json) VALUES(?1,?2)",
        params![
            id,
            json!({"version":1,"created_at":now,"updated_at":now,
            "employment_status":"unknown"})
            .to_string()
        ],
    )
    .map_err(AppError::internal)?;
    Ok(id)
}

fn evidence(
    tx: &Transaction<'_>,
    subject_kind: &str,
    subject_id: &str,
    path: &str,
    value: &str,
    contact: &Contact,
    collected_at: &str,
    now: &str,
) -> Result<(), AppError> {
    let record = json!({
        "evidence_id":format!("ev_{}", Uuid::new_v4().as_simple()),
        "subject_kind":subject_kind,"subject_id":subject_id,
        "field_path":path,"value":value,"source_type":"web",
        "source_url":contact.source_url,"locator_status":"located",
        "collected_at":collected_at,"confirmed_by":"system","confirmed_at":now
    });
    tx.execute("INSERT INTO evidence(evidence_id,subject_kind,subject_id,field_path,value_json,record_json) VALUES(?1,?2,?3,?4,?5,?6)",
        params![record["evidence_id"].as_str(),subject_kind,subject_id,path,
            json!(value).to_string(),record.to_string()]).map_err(AppError::internal)?;
    Ok(())
}

fn apply_snapshot(
    store: &Store,
    tx: &Transaction<'_>,
    snapshot: &Snapshot,
    now: &str,
) -> Result<(), AppError> {
    for (company_index, company) in snapshot.companies.iter().enumerate() {
        let company_name = normalized(&company.company_name);
        let organization_key = source_key(
            "snapshot-organization",
            &[&snapshot.cache_key, &company_name],
        );
        for (contact_index, contact) in company.contacts.iter().enumerate() {
            let observation_key = format!(
                "snapshot-observation:{}:{company_index}:{contact_index}",
                snapshot.snapshot_id
            );
            if mapped(tx, &observation_key)?.is_some() {
                continue;
            }
            let person_name = normalized(&contact.name);
            let title = normalized(&contact.title);
            let identity_key = source_key(
                "snapshot-identity",
                &[&snapshot.cache_key, &company_name, &person_name, &title],
            );
            let known = mapped(tx, &identity_key)?;
            let (person_id, relation_id, archived) = if let Some((id, relation)) = known {
                let (resolved, archived) = resolved_entity(tx, &id)?;
                (resolved, relation, archived)
            } else {
                let organization = mapped(tx, &organization_key)?;
                let (organization_id, organization_kg) = if let Some((id, _)) = organization {
                    let kg_id = entity_kg_id(tx, &id)?;
                    (id, kg_id)
                } else {
                    let (id, kg_id) = new_entity(
                        store,
                        tx,
                        "Organization",
                        &company.company_name,
                        json!({"name":company.company_name}),
                        now,
                    )?;
                    tx.execute(
                        "INSERT INTO source_mapping(source_key,entity_id) VALUES(?1,?2)",
                        params![organization_key, id],
                    )
                    .map_err(AppError::internal)?;
                    evidence(
                        tx,
                        "entity",
                        &id,
                        "properties.name",
                        &company.company_name,
                        contact,
                        &snapshot.collected_at,
                        now,
                    )?;
                    (id, kg_id)
                };
                let _ = organization_id;
                let (id, person_kg) = new_entity(
                    store,
                    tx,
                    "Person",
                    &contact.name,
                    json!({"name":contact.name,"jobTitle":contact.title}),
                    now,
                )?;
                evidence(
                    tx,
                    "entity",
                    &id,
                    "properties.name",
                    &contact.name,
                    contact,
                    &snapshot.collected_at,
                    now,
                )?;
                let relation =
                    new_relation(store, tx, person_kg, organization_kg, &contact.title, now)?;
                tx.execute(
                    "INSERT INTO source_mapping(source_key,entity_id,relation_id) VALUES(?1,?2,?3)",
                    params![identity_key, id, relation],
                )
                .map_err(AppError::internal)?;
                (id, Some(relation), false)
            };
            if !archived {
                evidence(
                    tx,
                    "entity",
                    &person_id,
                    "properties.jobTitle",
                    &contact.title,
                    contact,
                    &snapshot.collected_at,
                    now,
                )?;
                if let Some(relation) = &relation_id {
                    evidence(
                        tx,
                        "relation",
                        relation,
                        "properties.role.roleName",
                        &contact.title,
                        contact,
                        &snapshot.collected_at,
                        now,
                    )?;
                }
            }
            let source = json!({
                "snapshot_id":snapshot.snapshot_id,"company_index":company_index,
                "contact_index":contact_index,"cache_key":snapshot.cache_key,
                "normalized_query":snapshot.normalized_query,
                "normalized_region_hint":snapshot.normalized_region_hint,
                "company_name":company.company_name,"name":contact.name,
                "role_name":contact.title,"source_url":contact.source_url,
                "published_at":contact.published_at,
                "collected_at":snapshot.collected_at,"stored_at":snapshot.stored_at
            });
            tx.execute("INSERT INTO source_mapping(source_key,entity_id,relation_id,source_json) VALUES(?1,?2,?3,?4)",
                params![observation_key,person_id,relation_id,source.to_string()])
                .map_err(AppError::internal)?;
        }
    }
    Ok(())
}

impl Store {
    pub fn get_sync_cursor(&self) -> Result<Value, AppError> {
        let (last_snapshot_id, initialized) = cursor(self.graph.connection())?;
        Ok(json!({"last_snapshot_id":last_snapshot_id,"initialized":initialized}))
    }

    pub fn sync_snapshots(&self, raw: &Value) -> Result<Value, AppError> {
        let input: SyncInput = serde_json::from_value(raw.clone())
            .map_err(|error| AppError::validation(error.to_string()))?;
        validate(&input)?;
        let hash = canonical_hash(raw)?;
        let conn = self.graph.connection();
        let prior: Option<(String,String,String,String)> = conn.query_row(
            "SELECT actor,op,request_hash,result_json FROM operation_results WHERE operation_id=?1",
            [&input.operation_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional().map_err(AppError::internal)?;
        if let Some((actor, op, prior_hash, result)) = prior {
            if actor != input.actor || op != "sync_snapshots" || prior_hash != hash {
                return Err(AppError {
                    code: "OPERATION_CONFLICT",
                    message: "Operation ID was used for different content or actor".into(),
                });
            }
            let mut result: Value = serde_json::from_str(&result).map_err(AppError::internal)?;
            result["replayed"] = json!(true);
            return Ok(result);
        }
        let (previous, initialized) = cursor(conn)?;
        if !input.initialize && !initialized {
            return Err(AppError::validation("Initial backup marker is required"));
        }
        if !input.initialize && input.snapshots[0].snapshot_id <= previous {
            return Err(AppError::validation("Snapshot batch is behind the cursor"));
        }
        let now = now_utc();
        let tx = self.graph.transaction().map_err(AppError::internal)?;
        // Facts, source mappings, operation result, and cursor commit as one unit.
        if input.initialize {
            tx.execute("INSERT INTO sync_cursor(id,last_snapshot_id,initialized) VALUES(1,?1,1) ON CONFLICT(id) DO UPDATE SET initialized=1",
                [previous as i64]).map_err(AppError::internal)?;
        } else {
            for snapshot in &input.snapshots {
                apply_snapshot(self, &tx, snapshot, &now)?;
            }
            tx.execute(
                "UPDATE sync_cursor SET last_snapshot_id=?1 WHERE id=1",
                [input.snapshots.last().unwrap().snapshot_id as i64],
            )
            .map_err(AppError::internal)?;
        }
        let last_snapshot_id = input
            .snapshots
            .last()
            .map_or(previous, |snapshot| snapshot.snapshot_id);
        let result =
            json!({"last_snapshot_id":last_snapshot_id,"initialized":true,"replayed":false});
        tx.execute("INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,?2,'sync_snapshots',?3,?4)",
            params![input.operation_id,input.actor,hash,result.to_string()])
            .map_err(AppError::internal)?;
        tx.execute("INSERT INTO audit_log(operation_id,actor,op,subject_id,changed_at,change_json) VALUES(?1,'system','sync_snapshots','sync_cursor',?2,?3)",
            params![input.operation_id,now,json!({"last_snapshot_id":last_snapshot_id}).to_string()])
            .map_err(AppError::internal)?;
        tx.commit().map_err(AppError::internal)?;
        Ok(result)
    }
}
