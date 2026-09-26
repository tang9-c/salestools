use chrono::DateTime;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use crate::relations::{
    normalize_endpoints, persist_relation, relation_metadata, relation_properties, RelationWrite,
};
use crate::store::{canonical_hash, collect_evidence, now_utc, AppError, Store};
use crate::validation::{ensure_value_evidence, normalize_extensions, normalize_properties};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitInput {
    operation_id: String,
    actor: String,
    import_id: String,
    expected_version: u64,
    choices: Vec<Choice>,
    #[serde(default)]
    relation_choices: Vec<RelationChoice>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RelationChoice {
    source_candidate_id: String,
    target_candidate_id: String,
    relation_type: String,
    properties: Value,
    #[serde(default = "empty_object")]
    metadata: Value,
}

fn empty_object() -> Value {
    json!({})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Choice {
    candidate_id: String,
    action: String,
    target_id: Option<String>,
    expected_target_version: Option<u64>,
    keep_name: Option<bool>,
    set_properties: Option<Value>,
    unset_properties: Option<Vec<String>>,
    set_extensions: Option<Value>,
    unset_extensions: Option<Vec<String>>,
    #[serde(default)]
    evidence: Vec<Value>,
}

fn validation(message: impl Into<String>) -> AppError {
    AppError::validation(message)
}

fn reject_raw_content(value: &Value) -> Result<(), AppError> {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if [
                    "ocr_text",
                    "raw_text",
                    "full_text",
                    "document_text",
                    "page_image",
                    "file_bytes",
                    "block_text",
                ]
                .contains(&key.as_str())
                {
                    return Err(validation("Raw document content is not allowed"));
                }
                if key == "quote"
                    && child
                        .as_str()
                        .is_some_and(|text| text.chars().count() > 500)
                {
                    return Err(validation("Evidence quote is too long"));
                }
                reject_raw_content(child)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_raw_content(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn object(value: &Value) -> Result<&Map<String, Value>, AppError> {
    value
        .as_object()
        .ok_or_else(|| validation("Expected an object"))
}

type CandidateView<'a> = (&'a str, &'a Value, Option<&'a Value>, &'a [Value]);

fn candidate<'a>(value: &'a Value, id: &str) -> Result<CandidateView<'a>, AppError> {
    let fields = object(value)?;
    let allowed = [
        "candidate_id",
        "label",
        "properties",
        "extensions",
        "evidence",
        "relation_suggestions",
        "warnings",
        "can_commit",
    ];
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(validation("Unsupported candidate field"));
    }
    if fields.get("candidate_id").and_then(Value::as_str) != Some(id) {
        return Err(validation("Candidate ID mismatch"));
    }
    let label = fields
        .get("label")
        .and_then(Value::as_str)
        .ok_or_else(|| validation("Candidate label is required"))?;
    if label != "Person" && label != "Organization" {
        return Err(validation("Invalid candidate label"));
    }
    let properties = fields
        .get("properties")
        .ok_or_else(|| validation("Candidate properties are required"))?;
    object(properties)?;
    let extensions = fields.get("extensions");
    if label == "Organization" && extensions.is_some() {
        return Err(validation("Organization has no extensions"));
    }
    let evidence = fields
        .get("evidence")
        .and_then(Value::as_array)
        .ok_or_else(|| validation("Candidate evidence is required"))?;
    if fields.get("can_commit").and_then(Value::as_bool).is_none() {
        return Err(validation("Candidate can_commit flag is required"));
    }
    Ok((label, properties, extensions, evidence))
}

fn apply_properties(
    base: &mut Value,
    set: Option<&Value>,
    unset: Option<&[String]>,
    label: &str,
) -> Result<(), AppError> {
    if let Some(set) = set {
        let normalized = normalize_properties(label, set, false).map_err(validation)?;
        for (key, value) in object(&normalized)? {
            base[key] = value.clone();
        }
    }
    for key in unset.unwrap_or_default() {
        if key == "name" || set.is_some_and(|set| set.get(key).is_some()) {
            return Err(validation(
                "Cannot unset name or set and unset one property",
            ));
        }
        if base
            .as_object_mut()
            .and_then(|fields| fields.remove(key))
            .is_none()
        {
            return Err(validation(format!("Unknown or absent property: {key}")));
        }
    }
    *base = normalize_properties(label, base, true).map_err(validation)?;
    Ok(())
}

fn merge_candidate_field(base: &mut Value, key: &str, candidate: &Value) {
    if let Value::Array(incoming) = candidate {
        if incoming.is_empty() {
            return;
        }
        if let Some(existing) = base.get_mut(key).and_then(Value::as_array_mut) {
            for item in incoming {
                if !existing.contains(item) {
                    existing.push(item.clone());
                }
            }
            return;
        }
    }
    base[key] = candidate.clone();
}

fn apply_extensions(
    base: &mut Option<Value>,
    set: Option<&Value>,
    unset: Option<&[String]>,
    label: &str,
) -> Result<(), AppError> {
    if label == "Organization" {
        if set.is_some() || unset.is_some() {
            return Err(validation("Organization has no extensions"));
        }
        return Ok(());
    }
    let value = base.get_or_insert_with(|| json!({}));
    if let Some(set) = set {
        let normalized = normalize_extensions(set, false).map_err(validation)?;
        for (key, item) in object(&normalized)? {
            value[key] = item.clone();
        }
    }
    for key in unset.unwrap_or_default() {
        if !["nativePlace", "maritalStatus"].contains(&key.as_str())
            || set.is_some_and(|set| set.get(key).is_some())
        {
            return Err(validation("Invalid extension unset"));
        }
        value.as_object_mut().unwrap().remove(key);
    }
    *value = normalize_extensions(value, true).map_err(validation)?;
    Ok(())
}

fn read_existing_evidence(store: &Store, entity_id: &str) -> Result<Vec<Value>, AppError> {
    let mut statement = store.graph.connection().prepare(
        "SELECT record_json FROM evidence WHERE subject_kind='entity' AND subject_id=?1 ORDER BY rowid"
    ).map_err(AppError::internal)?;
    let records = statement
        .query_map([entity_id], |row| row.get::<_, String>(0))
        .map_err(AppError::internal)?
        .map(|row| {
            serde_json::from_str(&row.map_err(AppError::internal)?).map_err(AppError::internal)
        })
        .collect();
    records
}

fn insert_evidence(
    tx: &rusqlite::Transaction<'_>,
    entity_id: &str,
    records: &[Value],
) -> Result<(), AppError> {
    for record in records {
        tx.execute("INSERT INTO evidence(evidence_id,subject_kind,subject_id,field_path,value_json,record_json) VALUES(?1,'entity',?2,?3,?4,?5)",
            params![record["evidence_id"].as_str(), entity_id, record["field_path"].as_str(), record["value"].to_string(), record.to_string()])
            .map_err(AppError::internal)?;
    }
    Ok(())
}

fn commit_relations(
    store: &Store,
    tx: &rusqlite::Transaction<'_>,
    choices: &[RelationChoice],
    candidates: &[Value],
    landed: &HashMap<String, String>,
    actor: &str,
    now: &str,
) -> Result<Vec<Value>, AppError> {
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for choice in choices {
        let source_id = landed
            .get(&choice.source_candidate_id)
            .ok_or_else(|| validation("Relation source candidate was not committed"))?;
        let target_id = landed
            .get(&choice.target_candidate_id)
            .ok_or_else(|| validation("Relation target candidate was not committed"))?;
        let key = format!(
            "{}:{}:{}:{}:{}",
            choice.source_candidate_id,
            choice.target_candidate_id,
            choice.relation_type,
            choice.properties,
            choice.metadata
        );
        if !seen.insert(key) {
            return Err(validation("Duplicate relation choice"));
        }
        let suggestion = candidates
            .iter()
            .flat_map(|candidate| {
                candidate
                    .get("relation_suggestions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .find(|suggestion| {
                suggestion
                    .get("source_candidate_id")
                    .and_then(Value::as_str)
                    == Some(choice.source_candidate_id.as_str())
                    && suggestion
                        .get("target_candidate_id")
                        .and_then(Value::as_str)
                        == Some(choice.target_candidate_id.as_str())
                    && suggestion.get("relation_type").and_then(Value::as_str)
                        == Some(choice.relation_type.as_str())
                    && suggestion.get("properties") == Some(&choice.properties)
            })
            .ok_or_else(|| validation("Relation choice is not in the reviewed suggestions"))?;
        let (kind, source, target) =
            normalize_endpoints(&choice.relation_type, source_id, target_id)?;
        let properties = relation_properties(&kind, &choice.properties)?;
        let selected_meta = relation_metadata(&kind, &choice.metadata, &properties)?;
        let mut proof = vec![json!({"field_path":"$relation",
            "value":{"relation_type":kind,"source_id":source,"target_id":target},
            "source_type":"manual","collected_at":now,"locator_status":"not_applicable"})];
        if kind == "worksFor" {
            for (field, value) in properties["role"].as_object().unwrap() {
                if field != "@type" {
                    proof.push(json!({"field_path":format!("properties.role.{field}"),"value":value,
                        "source_type":"manual","collected_at":now,"locator_status":"not_applicable"}));
                }
            }
            for field in ["employment_status", "status_as_of"] {
                if let Some(value) = selected_meta.get(field) {
                    if field != "employment_status" || value != "unknown" {
                        proof.push(json!({"field_path":format!("metadata.{field}"),"value":value,
                            "source_type":"manual","collected_at":now,"locator_status":"not_applicable"}));
                    }
                }
            }
        }
        if let Some(original) = suggestion.get("evidence").and_then(Value::as_array) {
            for item in original {
                let path = item.get("field_path").and_then(Value::as_str);
                if path == Some("$relation") {
                    let candidate_value = json!({"relation_type":choice.relation_type,
                        "source_id":choice.source_candidate_id,"target_id":choice.target_candidate_id});
                    let quote = item.get("quote").and_then(Value::as_str);
                    if item.get("source_type").and_then(Value::as_str) == Some("file")
                        && item.get("locator_status").and_then(Value::as_str) == Some("located")
                        && item.get("value") == Some(&candidate_value)
                        && quote.is_some_and(|quote| {
                            !quote.trim().is_empty() && quote.chars().count() <= 500
                        })
                    {
                        let mut located = item.clone();
                        located["value"] =
                            json!({"relation_type":kind,"source_id":source,"target_id":target});
                        proof.push(located);
                    }
                    continue;
                }
                let selected = path
                    .and_then(|path| {
                        path.strip_prefix("properties.role.")
                            .map(|field| properties["role"].get(field))
                            .or_else(|| {
                                path.strip_prefix("metadata.")
                                    .map(|field| selected_meta.get(field))
                            })
                    })
                    .flatten();
                let quote_matches = match (item.get("quote").and_then(Value::as_str), selected) {
                    (Some(quote), Some(Value::String(value))) => quote.contains(value),
                    (Some(_), Some(_)) => false,
                    (None, _) => item.get("source_type").and_then(Value::as_str) == Some("manual"),
                    (Some(_), None) => false,
                };
                let located = item.get("source_type").and_then(Value::as_str) == Some("manual")
                    || item.get("locator_status").and_then(Value::as_str) == Some("located");
                if selected.is_some() && selected == item.get("value") && quote_matches && located {
                    proof.push(item.clone());
                }
            }
        }
        let saved = persist_relation(
            store,
            tx,
            RelationWrite {
                relation_type: &choice.relation_type,
                source_id,
                target_id,
                properties: &choice.properties,
                metadata: &choice.metadata,
                evidence: &proof,
                actor,
                now,
            },
        )?;
        results.push(saved);
    }
    Ok(results)
}

impl Store {
    pub fn commit_import(&self, raw: &Value) -> Result<Value, AppError> {
        reject_raw_content(raw)?;
        let input: CommitInput =
            serde_json::from_value(raw.clone()).map_err(|error| validation(error.to_string()))?;
        if input.actor.trim().is_empty()
            || input.import_id.trim().is_empty()
            || input.operation_id != format!("contact-import:{}", input.import_id)
        {
            return Err(validation(
                "A prefixed operation_id, actor and import_id are required",
            ));
        }
        let hash = canonical_hash(raw)?;
        let conn = self.graph.connection();
        let prior: Option<(String, String, String, String)> = conn.query_row(
            "SELECT actor,op,request_hash,result_json FROM operation_results WHERE operation_id=?1",
            [&input.operation_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional().map_err(AppError::internal)?;
        if let Some((actor, op, old_hash, result_json)) = prior {
            if actor != input.actor || op != "commit_import" || old_hash != hash {
                return Err(AppError {
                    code: "OPERATION_CONFLICT",
                    message: "Operation ID was used for different content or actor".into(),
                });
            }
            let mut result: Value =
                serde_json::from_str(&result_json).map_err(AppError::internal)?;
            result["replayed"] = json!(true);
            return Ok(result);
        }

        let tx = self.graph.transaction().map_err(AppError::internal)?;
        let job: Option<(String, String, u64, String)> = tx
            .query_row(
                "SELECT actor,status,version,data_json FROM import_jobs WHERE import_id=?1",
                [&input.import_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(AppError::internal)?;
        let (job_actor, status, version, data_json) = job.ok_or(AppError {
            code: "NOT_FOUND",
            message: "Import job not found".into(),
        })?;
        if status != "ready_for_review" {
            return Err(validation("Import job is not ready for review"));
        }
        if version != input.expected_version {
            return Err(AppError {
                code: "VERSION_CONFLICT",
                message: "Import preview version changed".into(),
            });
        }
        if job_actor != input.actor {
            return Err(validation("Import actor does not match job owner"));
        }
        let data: Value = serde_json::from_str(&data_json).map_err(AppError::internal)?;
        let candidates = data
            .get("candidates")
            .and_then(Value::as_array)
            .ok_or_else(|| validation("Import job has no candidate list"))?;
        let mut indexed = HashMap::new();
        for candidate in candidates {
            let id = candidate
                .get("candidate_id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| validation("Candidate ID is required"))?;
            if indexed.insert(id, candidate).is_some() {
                return Err(validation("Duplicate candidate ID"));
            }
        }
        if indexed.len() != input.choices.len() {
            return Err(validation("Exactly one choice per candidate is required"));
        }
        let mut seen = HashSet::new();
        for choice in &input.choices {
            if !seen.insert(choice.candidate_id.as_str())
                || !indexed.contains_key(choice.candidate_id.as_str())
            {
                return Err(validation("Unknown or duplicate candidate choice"));
            }
        }

        let now = now_utc();
        DateTime::parse_from_rfc3339(&now).map_err(AppError::internal)?;
        let mut results = Vec::new();
        let mut landed = HashMap::new();
        for choice in &input.choices {
            if choice.action == "skip" {
                if choice.target_id.is_some()
                    || choice.expected_target_version.is_some()
                    || choice.keep_name.is_some()
                    || choice.set_properties.is_some()
                    || choice.unset_properties.is_some()
                    || choice.set_extensions.is_some()
                    || choice.unset_extensions.is_some()
                    || !choice.evidence.is_empty()
                {
                    return Err(validation("Skip choice cannot contain edits"));
                }
                results.push(json!({"candidate_id":choice.candidate_id,"action":"skip"}));
                continue;
            }
            let candidate_value = indexed[choice.candidate_id.as_str()];
            let (label, candidate_properties, candidate_extensions, candidate_evidence) =
                candidate(candidate_value, &choice.candidate_id)?;
            let entity_id;
            let entity_version;
            let mut properties;
            let mut extensions;
            let mut metadata;
            let kg_id;
            let mut old_evidence = Vec::new();
            let mut renamed_old_name = None;
            match choice.action.as_str() {
                "create" => {
                    if choice.target_id.is_some()
                        || choice.expected_target_version.is_some()
                        || choice.keep_name.is_some()
                    {
                        return Err(validation("Create choice cannot specify a target"));
                    }
                    entity_id = format!(
                        "{}_{}",
                        if label == "Person" { "p" } else { "o" },
                        Uuid::new_v4().as_simple()
                    );
                    properties = candidate_properties.clone();
                    extensions = candidate_extensions.cloned();
                    metadata = json!({"version":1,"created_at":now,"updated_at":now});
                    kg_id = None;
                    entity_version = 1;
                }
                "merge" => {
                    let target_id = choice
                        .target_id
                        .as_deref()
                        .filter(|id| !id.trim().is_empty())
                        .ok_or_else(|| validation("Merge target_id is required"))?;
                    entity_id = target_id.to_owned();
                    let found: Option<(i64,String,Option<String>)> = tx.query_row(
                        "SELECT i.kg_id,m.metadata_json,m.extensions_json FROM entity_ids i JOIN entity_meta m USING(entity_id) WHERE i.entity_id=?1",
                        [target_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
                    ).optional().map_err(AppError::internal)?;
                    let (id, meta_json, extensions_json) = found.ok_or(AppError {
                        code: "NOT_FOUND",
                        message: "Merge target not found".into(),
                    })?;
                    let entity = self.graph.get_entity(id).map_err(AppError::internal)?;
                    if entity.entity_type != label {
                        return Err(validation("Merge target label mismatch"));
                    }
                    metadata = serde_json::from_str(&meta_json).map_err(AppError::internal)?;
                    if metadata.get("archived_at").is_some()
                        || metadata.get("merged_into").is_some()
                    {
                        return Err(validation("Archived or merged target cannot be edited"));
                    }
                    if choice.expected_target_version != metadata["version"].as_u64() {
                        return Err(AppError {
                            code: "VERSION_CONFLICT",
                            message: "Merge target version changed".into(),
                        });
                    }
                    old_evidence = read_existing_evidence(self, target_id)?;
                    properties =
                        serde_json::to_value(entity.properties).map_err(AppError::internal)?;
                    let old_name = properties["name"].clone();
                    for (key, value) in object(candidate_properties)? {
                        if key != "name" || choice.keep_name == Some(false) {
                            merge_candidate_field(&mut properties, key, value);
                        }
                    }
                    renamed_old_name = Some(old_name);
                    extensions = extensions_json
                        .map(|value| serde_json::from_str(&value).map_err(AppError::internal))
                        .transpose()?;
                    if let Some(candidate_extensions) = candidate_extensions {
                        for (key, value) in object(candidate_extensions)? {
                            merge_candidate_field(
                                extensions.get_or_insert_with(|| json!({})),
                                key,
                                value,
                            );
                        }
                    }
                    entity_version = metadata["version"].as_u64().unwrap() + 1;
                    kg_id = Some(id);
                }
                _ => return Err(validation("Unknown import choice action")),
            }
            apply_properties(
                &mut properties,
                choice.set_properties.as_ref(),
                choice.unset_properties.as_deref(),
                label,
            )?;
            if let Some(old_name) = renamed_old_name.as_ref() {
                if properties["name"] != *old_name {
                    let alternate = properties["alternateName"]
                        .as_array_mut()
                        .ok_or_else(|| validation("alternateName must be an array"))?;
                    if !alternate.contains(old_name) {
                        alternate.push(old_name.clone());
                    }
                } else {
                    renamed_old_name = None;
                }
            }
            apply_extensions(
                &mut extensions,
                choice.set_extensions.as_ref(),
                choice.unset_extensions.as_deref(),
                label,
            )?;
            let mut evidence_input: Vec<Value> = candidate_evidence
                .iter()
                .chain(choice.evidence.iter())
                .cloned()
                .collect();
            if let Some(old_name) = renamed_old_name {
                evidence_input.push(
                    json!({"field_path":"properties.alternateName","value":old_name,
                    "source_type":"manual","collected_at":now,"locator_status":"not_applicable"}),
                );
            }
            let new_evidence =
                collect_evidence(&evidence_input, &entity_id, label, &input.actor, &now)?;
            let all_evidence: Vec<Value> = old_evidence
                .iter()
                .chain(new_evidence.iter())
                .cloned()
                .collect();
            ensure_value_evidence(&properties, extensions.as_ref(), &all_evidence)
                .map_err(validation)?;
            let name = properties["name"]
                .as_str()
                .ok_or_else(|| validation("Name is required"))?;
            if let Some(id) = kg_id {
                let mut entity = self.graph.get_entity(id).map_err(AppError::internal)?;
                entity.name = name.to_owned();
                entity.properties =
                    serde_json::from_value(properties.clone()).map_err(AppError::internal)?;
                self.graph
                    .update_entity(&entity)
                    .map_err(AppError::internal)?;
                metadata["version"] = json!(entity_version);
                metadata["updated_at"] = json!(now);
                tx.execute(
                    "UPDATE entity_meta SET metadata_json=?1,extensions_json=?2 WHERE entity_id=?3",
                    params![
                        metadata.to_string(),
                        extensions.as_ref().map(Value::to_string),
                        entity_id
                    ],
                )
                .map_err(AppError::internal)?;
            } else {
                let mut entity = sqlite_knowledge_graph::Entity::new(label, name);
                entity.properties =
                    serde_json::from_value(properties.clone()).map_err(AppError::internal)?;
                let id = self
                    .graph
                    .insert_entity(&entity)
                    .map_err(AppError::internal)?;
                tx.execute(
                    "INSERT INTO entity_ids(entity_id,kg_id) VALUES(?1,?2)",
                    params![entity_id, id],
                )
                .map_err(AppError::internal)?;
                tx.execute("INSERT INTO entity_meta(entity_id,metadata_json,extensions_json) VALUES(?1,?2,?3)",
                    params![entity_id,metadata.to_string(),extensions.as_ref().map(Value::to_string)]).map_err(AppError::internal)?;
            }
            insert_evidence(&tx, &entity_id, &new_evidence)?;
            crate::vectors::invalidate_vector(&tx, &entity_id)?;
            tx.execute(
                "INSERT INTO source_mapping(source_key,entity_id) VALUES(?1,?2)",
                params![
                    format!("import:{}:{}", input.import_id, choice.candidate_id),
                    entity_id
                ],
            )
            .map_err(AppError::internal)?;
            landed.insert(choice.candidate_id.clone(), entity_id.clone());
            results.push(
                json!({"candidate_id":choice.candidate_id,"action":choice.action,
                "entity_id":entity_id,"version":entity_version}),
            );
        }
        let relations = commit_relations(
            self,
            &tx,
            &input.relation_choices,
            candidates,
            &landed,
            &input.actor,
            &now,
        )?;
        let new_version = version + 1;
        tx.execute(
            "UPDATE import_jobs SET status='committed',version=?1 WHERE import_id=?2",
            params![new_version, input.import_id],
        )
        .map_err(AppError::internal)?;
        let result = json!({"import_id":input.import_id,"status":"committed","version":new_version,
            "results":results,"relations":relations,"replayed":false});
        tx.execute("INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,?2,'commit_import',?3,?4)",
            params![input.operation_id,input.actor,hash,result.to_string()]).map_err(AppError::internal)?;
        tx.execute("INSERT INTO audit_log(operation_id,actor,op,subject_id,changed_at,change_json) VALUES(?1,?2,'commit_import',?3,?4,?5)",
            params![input.operation_id,input.actor,input.import_id,now,json!({"results":results,"relations":relations}).to_string()]).map_err(AppError::internal)?;
        tx.commit().map_err(AppError::internal)?;
        Ok(result)
    }
}
