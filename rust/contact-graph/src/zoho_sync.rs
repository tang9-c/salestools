use chrono::{DateTime, FixedOffset};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::import_commit::{persist_duplicate, DuplicateWrite};
use crate::relations::{collect_relation_evidence, persist_relation, RelationWrite};
use crate::store::{
    canonical_hash, collect_evidence, now_utc, persist_entity, persist_evidence, AppError,
    EntityWrite, Store,
};
use crate::validation::{ensure_value_evidence, normalize_properties};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    #[serde(deserialize_with = "nullable")]
    id: Option<String>,
    #[serde(deserialize_with = "nullable")]
    name: Option<String>,
}

fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Contact {
    record_id: String,
    name: String,
    #[serde(deserialize_with = "nullable")]
    title: Option<String>,
    #[serde(deserialize_with = "nullable")]
    contact_owner: Option<Owner>,
    #[serde(deserialize_with = "nullable")]
    modified_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Company {
    connection_id: String,
    account_id: String,
    company_name: String,
    #[serde(deserialize_with = "nullable")]
    account_owner: Option<Owner>,
    contacts: Vec<Contact>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncInput {
    operation_id: String,
    actor: String,
    collected_at: String,
    companies: Vec<Company>,
}

fn date(value: &str) -> Result<DateTime<FixedOffset>, AppError> {
    DateTime::parse_from_rfc3339(value)
        .map_err(|_| AppError::validation("Invalid Zoho source timestamp"))
}

fn validate(input: &SyncInput) -> Result<(), AppError> {
    if input.operation_id.trim().is_empty() || input.actor.trim().is_empty() {
        return Err(AppError::validation("operation_id and actor are required"));
    }
    date(&input.collected_at)?;
    for company in &input.companies {
        let connection = company.connection_id.as_bytes();
        if !connection.first().is_some_and(u8::is_ascii_lowercase)
            || !connection
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
            || company.account_id.trim().is_empty()
            || company.company_name.trim().is_empty()
        {
            return Err(AppError::validation("Invalid Zoho company identity"));
        }
        for contact in &company.contacts {
            if contact.record_id.trim().is_empty() || contact.name.trim().is_empty() {
                return Err(AppError::validation("Invalid Zoho contact identity"));
            }
            if let Some(modified) = &contact.modified_at {
                date(modified)?;
            }
        }
    }
    Ok(())
}

fn key(kind: &str, parts: &[&str]) -> Result<String, AppError> {
    Ok(format!("zoho-{kind}:{}", canonical_hash(&json!(parts))?))
}

struct Mapping {
    entity_id: String,
    relation_id: Option<String>,
    source: Value,
}

fn mapping(tx: &Transaction<'_>, key: &str) -> Result<Option<Mapping>, AppError> {
    let row: Option<(String, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT entity_id,relation_id,source_json FROM source_mapping WHERE source_key=?1",
            [key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(AppError::internal)?;
    row.map(|(entity_id, relation_id, source)| {
        Ok(Mapping {
            entity_id,
            relation_id,
            source: source
                .map(|s| serde_json::from_str(&s).map_err(AppError::internal))
                .transpose()?
                .unwrap_or(Value::Null),
        })
    })
    .transpose()
}

fn put_mapping(
    tx: &Transaction<'_>,
    key: &str,
    entity: &str,
    relation: Option<&str>,
    source: &Value,
) -> Result<(), AppError> {
    let mut source = source.clone();
    if let Some(previous) = mapping(tx, key)? {
        if let (Some(incoming), Some(stored)) = (
            source["collected_at"].as_str(),
            previous.source["collected_at"].as_str(),
        ) {
            // A newer CRM modification can arrive in an older collection. Accept its
            // content without lowering the fallback clock for later undated records.
            if date(incoming)? < date(stored)? {
                source["collected_at"] = json!(stored);
            }
        }
    }
    tx.execute("INSERT INTO source_mapping(source_key,entity_id,relation_id,source_json) VALUES(?1,?2,?3,?4)
        ON CONFLICT(source_key) DO UPDATE SET entity_id=excluded.entity_id,relation_id=excluded.relation_id,source_json=excluded.source_json",
        params![key,entity,relation,source.to_string()]).map_err(AppError::internal)?;
    Ok(())
}

fn older(incoming: &Value, previous: &Value) -> Result<bool, AppError> {
    if let (Some(a), Some(b)) = (
        incoming["modified_at"].as_str(),
        previous["modified_at"].as_str(),
    ) {
        let order = date(a)?.cmp(&date(b)?);
        if order != std::cmp::Ordering::Equal {
            return Ok(order == std::cmp::Ordering::Less);
        }
    }
    incoming["collected_at"]
        .as_str()
        .zip(previous["collected_at"].as_str())
        .map(|(a, b)| Ok(date(a)? < date(b)?))
        .unwrap_or(Ok(false))
}

fn source_changed(a: &Value, b: &Value) -> bool {
    let without_collection = |value: &Value| {
        let mut value = value.clone();
        if let Some(fields) = value.as_object_mut() {
            fields.remove("collected_at");
        }
        value
    };
    without_collection(a) != without_collection(b)
}

struct EntityState {
    id: String,
    kg_id: i64,
    properties: Value,
    extensions: Option<Value>,
    metadata: Value,
}

impl EntityState {
    fn archived(&self) -> bool {
        self.metadata.get("archived_at").is_some()
    }
}

fn entity_state(
    store: &Store,
    tx: &Transaction<'_>,
    initial: &str,
) -> Result<EntityState, AppError> {
    let mut id = initial.to_owned();
    let mut seen = BTreeSet::new();
    loop {
        if !seen.insert(id.clone()) {
            return Err(AppError::validation("Zoho mapping has cyclic merge chain"));
        }
        let (kg_id,metadata,extensions): (i64,String,Option<String>) = tx.query_row(
            "SELECT i.kg_id,m.metadata_json,m.extensions_json FROM entity_ids i JOIN entity_meta m USING(entity_id) WHERE i.entity_id=?1",
            [&id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).map_err(AppError::internal)?;
        let metadata: Value = serde_json::from_str(&metadata).map_err(AppError::internal)?;
        if let Some(target) = metadata["merged_into"].as_str() {
            id = target.to_owned();
            continue;
        }
        let entity = store.graph.get_entity(kg_id).map_err(AppError::internal)?;
        return Ok(EntityState {
            id,
            kg_id,
            properties: serde_json::to_value(entity.properties).map_err(AppError::internal)?,
            extensions: extensions
                .map(|s| serde_json::from_str(&s).map_err(AppError::internal))
                .transpose()?,
            metadata,
        });
    }
}

fn proof(source: &Value, path: &str, value: Value) -> Value {
    json!({"source_type":"zoho","source_connection_id":source["source_connection_id"],
        "source_module":source["source_module"],"source_record_id":source["source_record_id"],
        "collected_at":source["collected_at"],"locator_status":"not_applicable","field_path":path,"value":value})
}

fn other_evidence(
    tx: &Transaction<'_>,
    kind: &str,
    id: &str,
    path: &str,
    source: &Value,
) -> Result<bool, AppError> {
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM evidence WHERE subject_kind=?1 AND subject_id=?2 AND field_path=?3
         AND NOT (json_extract(record_json,'$.source_type') IS 'zoho'
           AND json_extract(record_json,'$.source_connection_id') IS ?4
           AND json_extract(record_json,'$.source_module') IS ?5
           AND json_extract(record_json,'$.source_record_id') IS ?6)",
        params![kind,id,path,source["source_connection_id"].as_str(),source["source_module"].as_str(),source["source_record_id"].as_str()],
        |r| r.get(0),
    ).map_err(AppError::internal)?;
    Ok(count > 0)
}

struct EntitySync<'a> {
    key: &'a str,
    label: &'a str,
    source: &'a Value,
    fields: &'a [(&'a str, &'a str)],
}

struct EntityOutcome {
    state: EntityState,
    created: bool,
    changed: bool,
    content_changed: bool,
    stale: bool,
}

struct SyncContext<'a, 'conn> {
    store: &'a Store,
    tx: &'a Transaction<'conn>,
    actor: &'a str,
    now: &'a str,
}

impl SyncContext<'_, '_> {
    fn entity(&self, input: EntitySync<'_>) -> Result<EntityOutcome, AppError> {
        let previous = mapping(self.tx, input.key)?;
        let mut existing = previous
            .as_ref()
            .map(|m| entity_state(self.store, self.tx, &m.entity_id))
            .transpose()?;
        let stale = previous
            .as_ref()
            .map(|m| older(input.source, &m.source))
            .transpose()?
            .unwrap_or(false);
        let changed = previous
            .as_ref()
            .is_none_or(|m| source_changed(input.source, &m.source));
        if let Some(state) = &existing {
            if stale || state.archived() {
                if !stale {
                    put_mapping(self.tx, input.key, &state.id, None, input.source)?;
                }
                return Ok(EntityOutcome {
                    state: existing.take().unwrap(),
                    created: false,
                    changed: false,
                    content_changed: false,
                    stale,
                });
            }
        }
        let created = existing.is_none();
        let id = existing.as_ref().map(|s| s.id.clone()).unwrap_or_else(|| {
            format!(
                "{}_{}",
                if input.label == "Person" { "p" } else { "o" },
                Uuid::new_v4().as_simple()
            )
        });
        let mut properties = existing
            .as_ref()
            .map(|s| s.properties.clone())
            .unwrap_or(json!({}));
        let mut observations = Vec::new();
        for (source_field, property) in input.fields {
            let value = &input.source[*source_field];
            if !value.as_str().is_some_and(|s| !s.trim().is_empty()) {
                continue;
            }
            if previous
                .as_ref()
                .is_some_and(|m| m.source[*source_field] == *value)
            {
                continue;
            }
            let path = format!("properties.{property}");
            observations.push(proof(input.source, &path, value.clone()));
            if !other_evidence(self.tx, "entity", &id, &path, input.source)? {
                properties[*property] = value.clone();
            }
        }
        let records = collect_evidence(&observations, &id, input.label, self.actor, self.now)?;
        let content_changed = created || !records.is_empty();
        if content_changed {
            properties = normalize_properties(input.label, &properties, true)
                .map_err(AppError::validation)?;
            let extensions = existing
                .as_ref()
                .and_then(|s| s.extensions.clone())
                .or_else(|| (input.label == "Person").then(|| json!({})));
            let mut all_evidence = self.store.read_evidence(&id)?;
            all_evidence.extend(records.iter().cloned());
            ensure_value_evidence(&properties, extensions.as_ref(), &all_evidence)
                .map_err(AppError::validation)?;
            let mut metadata = existing
                .as_ref()
                .map(|s| s.metadata.clone())
                .unwrap_or(json!({"version":0,"created_at":self.now}));
            metadata["version"] = json!(metadata["version"].as_u64().unwrap_or(0) + 1);
            metadata["updated_at"] = json!(self.now);
            persist_entity(
                self.store,
                self.tx,
                EntityWrite {
                    entity_id: &id,
                    label: input.label,
                    kg_id: existing.as_ref().map(|s| s.kg_id),
                    properties: &properties,
                    extensions: extensions.as_ref(),
                    metadata: &metadata,
                },
            )?;
            persist_evidence(self.tx, &records)?;
        }
        put_mapping(self.tx, input.key, &id, None, input.source)?;
        Ok(EntityOutcome {
            state: entity_state(self.store, self.tx, &id)?,
            created,
            changed,
            content_changed,
            stale: false,
        })
    }

    fn employment(
        &self,
        key: &str,
        person: &EntityState,
        org: &EntityState,
        source: &Value,
    ) -> Result<(bool, bool), AppError> {
        let previous = mapping(self.tx, key)?;
        let relation = previous.as_ref().and_then(|m| m.relation_id.as_deref());
        let stored: Option<(i64,String,String)> = relation.map(|id| self.tx.query_row(
            "SELECT i.kg_id,r.properties,m.metadata_json FROM relation_ids i JOIN kg_relations r ON r.id=i.kg_id JOIN relation_meta m USING(relation_id) WHERE i.relation_id=?1",
            [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).map_err(AppError::internal)).transpose()?;
        let archived_relation = stored
            .as_ref()
            .map(|(_, _, m)| {
                serde_json::from_str::<Value>(m)
                    .map(|m| m.get("archived_at").is_some())
                    .map_err(AppError::internal)
            })
            .transpose()?
            .unwrap_or(false);
        if person.archived() || org.archived() || archived_relation {
            // Preserve an existing archived relation; an archived organization blocks first creation too.
            if relation.is_some()
                && !previous
                    .as_ref()
                    .map(|m| older(source, &m.source))
                    .transpose()?
                    .unwrap_or(false)
            {
                put_mapping(self.tx, key, &person.id, relation, source)?;
            }
            return Ok((false, true));
        }
        if previous
            .as_ref()
            .map(|m| older(source, &m.source))
            .transpose()?
            .unwrap_or(false)
        {
            return Ok((false, false));
        }
        let title = source["title"].as_str().filter(|s| !s.is_empty());
        let properties = title
            .map(|title| json!({"role":{"@type":"OrganizationRole","roleName":title}}))
            .unwrap_or(json!({"role":{"@type":"OrganizationRole"}}));
        let existence = proof(
            source,
            "$relation",
            json!({"relation_type":"worksFor","source_id":person.id,"target_id":org.id}),
        );
        let mut evidence = vec![existence];
        if let Some(title) = title {
            evidence.push(proof(source, "properties.role.roleName", json!(title)));
        }
        let relation_id;
        let mut changed = false;
        if let Some((kg_id, raw_properties, raw_meta)) = stored {
            relation_id = relation.unwrap().to_owned();
            if title.is_some()
                && previous
                    .as_ref()
                    .is_none_or(|m| m.source["title"] != source["title"])
            {
                let records = collect_relation_evidence(
                    &evidence,
                    &relation_id,
                    self.actor,
                    self.now,
                    "worksFor",
                    &person.id,
                    &org.id,
                    &properties,
                    &json!({"employment_status":"unknown"}),
                )?;
                let records: Vec<Value> = records
                    .into_iter()
                    .filter(|r| r["field_path"] != "$relation")
                    .collect();
                let mut selected: Value =
                    serde_json::from_str(&raw_properties).map_err(AppError::internal)?;
                if !other_evidence(
                    self.tx,
                    "relation",
                    &relation_id,
                    "properties.role.roleName",
                    source,
                )? {
                    if selected.get("role").is_none() {
                        selected["role"] = json!({"@type":"OrganizationRole"});
                    }
                    selected["role"]["roleName"] = source["title"].clone();
                }
                let mut meta: Value =
                    serde_json::from_str(&raw_meta).map_err(AppError::internal)?;
                meta["version"] = json!(meta["version"].as_u64().unwrap_or(0) + 1);
                meta["updated_at"] = json!(self.now);
                self.tx
                    .execute(
                        "UPDATE kg_relations SET properties=?1 WHERE id=?2",
                        params![selected.to_string(), kg_id],
                    )
                    .map_err(AppError::internal)?;
                self.tx
                    .execute(
                        "UPDATE relation_meta SET metadata_json=?1 WHERE relation_id=?2",
                        params![meta.to_string(), relation_id],
                    )
                    .map_err(AppError::internal)?;
                persist_evidence(self.tx, &records)?;
                changed = true;
            }
        } else {
            let result = persist_relation(
                self.store,
                self.tx,
                RelationWrite {
                    relation_type: "worksFor",
                    source_id: &person.id,
                    target_id: &org.id,
                    properties: &properties,
                    metadata: &json!({"employment_status":"unknown"}),
                    evidence: &evidence,
                    actor: self.actor,
                    now: self.now,
                },
            )?;
            relation_id = result["relation_id"].as_str().unwrap().to_owned();
            changed = true;
        }
        put_mapping(self.tx, key, &person.id, Some(&relation_id), source)?;
        Ok((changed, false))
    }

    fn duplicates(&self, person: &EntityState, source: &Value) -> Result<(), AppError> {
        let normalize = |s: &str| {
            s.nfkc()
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        };
        let name = person.properties["name"].as_str().unwrap_or("");
        let normalized = normalize(name);
        if normalized.is_empty() || normalized == "姓名未提供" {
            return Ok(());
        }
        let mut query = self.tx.prepare("SELECT i.entity_id,e.properties FROM entity_ids i JOIN kg_entities e ON e.id=i.kg_id JOIN entity_meta m USING(entity_id)
            WHERE e.entity_type='Person' AND i.entity_id<>?1 AND json_extract(m.metadata_json,'$.archived_at') IS NULL AND json_extract(m.metadata_json,'$.merged_into') IS NULL").map_err(AppError::internal)?;
        let rows = query
            .query_map([&person.id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(AppError::internal)?;
        let mut provenance = json!({"source_type":"zoho","source_connection_id":source["source_connection_id"],
            "source_module":"Contacts","source_record_id":source["source_record_id"],"collected_at":source["collected_at"]});
        if source["modified_at"].is_string() {
            provenance["modified_at"] = source["modified_at"].clone();
        }
        for row in rows {
            let (target, properties) = row.map_err(AppError::internal)?;
            let properties: Value =
                serde_json::from_str(&properties).map_err(AppError::internal)?;
            let other_name = properties["name"].as_str().unwrap_or("");
            if normalize(other_name) != normalized {
                continue;
            }
            persist_duplicate(
                self.tx,
                DuplicateWrite {
                    subject: &person.id,
                    target: &target,
                    value: json!({"reasons":["same_name"],"subject_name":name,"target_name":other_name}),
                    source: &provenance,
                    import_id: None,
                    candidate_id: source["source_record_id"].as_str().unwrap(),
                    now: self.now,
                },
            )?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct ContactCount {
    created: bool,
    updated: bool,
    archived: bool,
}

impl Store {
    pub fn sync_zoho_contacts(&self, raw: &Value) -> Result<Value, AppError> {
        let input: SyncInput =
            serde_json::from_value(raw.clone()).map_err(|e| AppError::validation(e.to_string()))?;
        validate(&input)?;
        let hash = canonical_hash(raw)?;
        let now = now_utc();
        let tx = self.graph.transaction().map_err(AppError::internal)?;
        let previous: Option<(String,String,String,String)> = tx.query_row(
            "SELECT actor,op,request_hash,result_json FROM operation_results WHERE operation_id=?1",[&input.operation_id],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).optional().map_err(AppError::internal)?;
        if let Some((actor, op, old_hash, result)) = previous {
            if actor != input.actor || op != "sync_zoho_contacts" || old_hash != hash {
                return Err(AppError {
                    code: "OPERATION_CONFLICT",
                    message: "Operation ID was used for different content or actor".into(),
                });
            }
            return serde_json::from_str(&result).map_err(AppError::internal);
        }
        let context = SyncContext {
            store: self,
            tx: &tx,
            actor: &input.actor,
            now: &now,
        };
        let mut counts: BTreeMap<String, ContactCount> = BTreeMap::new();
        let mut indexed = BTreeSet::new();
        for company in &input.companies {
            if company.contacts.is_empty() {
                continue;
            }
            let org_key = key(
                "organization",
                &[&company.connection_id, &company.account_id],
            )?;
            let org_source = json!({"source_type":"zoho","source_connection_id":company.connection_id,"source_module":"Accounts",
                "source_record_id":company.account_id,"company_name":company.company_name.trim(),"account_owner":company.account_owner,"collected_at":input.collected_at});
            let org = context.entity(EntitySync {
                key: &org_key,
                label: "Organization",
                source: &org_source,
                fields: &[("company_name", "name")],
            })?;
            if org.content_changed {
                crate::vectors::invalidate_vector(&tx, &org.state.id)?;
            }
            if org.content_changed && !org.created {
                let mut query = tx.prepare("SELECT DISTINCT i.entity_id FROM entity_ids i JOIN kg_relations r ON r.source_id=i.kg_id
                    JOIN entity_meta m USING(entity_id) JOIN relation_ids ri ON ri.kg_id=r.id JOIN relation_meta rm USING(relation_id)
                    WHERE r.rel_type='worksFor' AND r.target_id=?1 AND json_extract(m.metadata_json,'$.archived_at') IS NULL
                    AND json_extract(m.metadata_json,'$.merged_into') IS NULL AND json_extract(rm.metadata_json,'$.archived_at') IS NULL").map_err(AppError::internal)?;
                for row in query
                    .query_map([org.state.kg_id], |r| r.get::<_, String>(0))
                    .map_err(AppError::internal)?
                {
                    indexed.insert(row.map_err(AppError::internal)?);
                }
            }
            for contact in &company.contacts {
                let person_key = key("person", &[&company.connection_id, &contact.record_id])?;
                let title = contact
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let source = json!({"source_type":"zoho","source_connection_id":company.connection_id,"source_module":"Contacts",
                    "source_record_id":contact.record_id,"name":contact.name.trim(),"title":title,"contact_owner":contact.contact_owner,
                    "modified_at":contact.modified_at,"collected_at":input.collected_at});
                let person = context.entity(EntitySync {
                    key: &person_key,
                    label: "Person",
                    source: &source,
                    fields: &[("name", "name"), ("title", "jobTitle")],
                })?;
                let count = counts.entry(person_key).or_default();
                count.created |= person.created;
                count.archived |= person.state.archived() || org.state.archived();
                if person.state.archived() {
                    continue;
                }
                if person.stale {
                    continue;
                }
                count.updated |= (person.changed || org.changed) && !person.created;
                if person.content_changed {
                    indexed.insert(person.state.id.clone());
                }
                let employment_key = key(
                    "employment",
                    &[
                        &company.connection_id,
                        &contact.record_id,
                        &company.account_id,
                    ],
                )?;
                // The employment map has its own clock, independent of a contact's other accounts.
                let mut employment_source = source.clone();
                employment_source["account_id"] = json!(company.account_id);
                let (relation_changed, archived) = context.employment(
                    &employment_key,
                    &person.state,
                    &org.state,
                    &employment_source,
                )?;
                count.archived |= archived;
                count.updated |= relation_changed && !person.created;
                if relation_changed {
                    indexed.insert(person.state.id.clone());
                }
                context.duplicates(&person.state, &source)?;
            }
        }
        for entity in &indexed {
            crate::vectors::invalidate_vector(&tx, entity)?;
        }
        let result = json!({"created":counts.values().filter(|c| c.created).count(),
            "updated":counts.values().filter(|c| !c.created && c.updated).count(),
            "unchanged":counts.values().filter(|c| !c.created && !c.updated && !c.archived).count(),
            "archived":counts.values().filter(|c| c.archived).count(),"entity_ids":indexed.into_iter().collect::<Vec<_>>()});
        tx.execute("INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,?2,'sync_zoho_contacts',?3,?4)",
            params![input.operation_id,input.actor,hash,result.to_string()]).map_err(AppError::internal)?;
        tx.execute("INSERT INTO audit_log(operation_id,actor,op,subject_id,changed_at,change_json) VALUES(?1,?2,'sync_zoho_contacts','zoho',?3,?4)",
            params![input.operation_id,input.actor,now,result.to_string()]).map_err(AppError::internal)?;
        tx.commit().map_err(AppError::internal)?;
        Ok(result)
    }
}
