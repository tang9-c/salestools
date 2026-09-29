use chrono::{SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlite_knowledge_graph::KnowledgeGraph;
use std::path::Path;
use uuid::Uuid;

use crate::validation::{
    allowed_entity_evidence_path, ensure_value_evidence, has_substantive_person_data,
    normalize_extensions, normalize_properties,
};

#[derive(Debug)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub(crate) fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "VALIDATION_ERROR",
            message: message.into(),
        }
    }
    pub(crate) fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            code: "INTERNAL_ERROR",
            message: error.to_string(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveContactInput {
    operation_id: String,
    actor: String,
    label: String,
    entity_id: Option<String>,
    expected_version: Option<u64>,
    set_properties: Option<Value>,
    unset_properties: Option<Vec<String>>,
    set_extensions: Option<Value>,
    unset_extensions: Option<Vec<String>>,
    #[serde(default)]
    evidence: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PutImportJobInput {
    operation_id: String,
    actor: String,
    file_id: String,
    import_id: Option<String>,
    expected_version: Option<u64>,
    status: String,
    data: Value,
}

pub(crate) fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn canonical_hash(value: &Value) -> Result<String, AppError> {
    let bytes = serde_json::to_vec(value).map_err(AppError::internal)?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

fn as_object(value: &Value) -> Result<&Map<String, Value>, AppError> {
    value
        .as_object()
        .ok_or_else(|| AppError::validation("Expected object"))
}

fn contact_page(raw: &Value, prefix: &str) -> Result<(usize, usize), AppError> {
    let offset_key = format!("{prefix}_offset");
    let limit_key = format!("{prefix}_limit");
    let offset = raw
        .get(&offset_key)
        .map_or(Some(0), Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| AppError::validation(format!("Invalid {offset_key}")))?;
    let limit = raw
        .get(&limit_key)
        .map_or(Some(if prefix == "claim" { 10 } else { 50 }), Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| (1..=50).contains(value) || (prefix == "claim" && *value == 0))
        .ok_or_else(|| AppError::validation(format!("Invalid {limit_key}")))?;
    Ok((offset, limit))
}

pub(crate) fn collect_evidence(
    input: &[Value],
    subject_id: &str,
    label: &str,
    actor: &str,
    timestamp: &str,
) -> Result<Vec<Value>, AppError> {
    let allowed = [
        "field_path",
        "value",
        "value_path",
        "source_type",
        "collected_at",
        "locator_status",
        "file_name",
        "file_sha256",
        "source_url",
        "quote",
        "page",
        "evidence_id",
        "subject_kind",
        "subject_id",
        "confirmed_by",
        "confirmed_at",
    ];
    let mut output = Vec::new();
    for item in input {
        let fields = as_object(item)?;
        if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(AppError::validation("Unknown evidence field"));
        }
        let path = fields
            .get("field_path")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("Missing evidence field_path"))?;
        if !allowed_entity_evidence_path(label, path) {
            return Err(AppError::validation("Invalid entity evidence path"));
        }
        let value = fields
            .get("value")
            .filter(|value| !value.is_null())
            .ok_or_else(|| AppError::validation("Missing evidence value"))?;
        let source = fields
            .get("source_type")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("Missing evidence source_type"))?;
        let locator = fields
            .get("locator_status")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("Missing evidence locator_status"))?;
        let collected = fields
            .get("collected_at")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("Missing evidence collected_at"))?;
        let evidence_id = match fields.get("evidence_id") {
            Some(Value::String(id)) if !id.trim().is_empty() => id.clone(),
            Some(_) => return Err(AppError::validation("Invalid evidence_id")),
            None => format!("ev_{}", Uuid::new_v4().as_simple()),
        };
        if fields
            .get("subject_kind")
            .is_some_and(|kind| kind != "entity")
            || fields
                .get("subject_id")
                .is_some_and(|id| id.as_str().is_none_or(|id| id.trim().is_empty()))
            || fields
                .get("confirmed_by")
                .is_some_and(|actor| actor.as_str().is_none_or(|actor| actor.trim().is_empty()))
            || fields.get("confirmed_at").is_some_and(|date| {
                date.as_str()
                    .is_none_or(|date| chrono::DateTime::parse_from_rfc3339(date).is_err())
            })
        {
            return Err(AppError::validation(
                "Invalid evidence subject or confirmation",
            ));
        }
        if chrono::DateTime::parse_from_rfc3339(collected).is_err() {
            return Err(AppError::validation("Invalid collected_at"));
        }
        match source {
            "manual" if locator == "not_applicable" => {}
            "file"
                if fields.get("file_name").and_then(Value::as_str).is_some()
                    && fields.get("file_sha256").and_then(Value::as_str).is_some()
                    && ["located", "unavailable"].contains(&locator) => {}
            "web"
                if fields.get("source_url").and_then(Value::as_str).is_some()
                    && ["located", "unavailable"].contains(&locator) => {}
            _ => return Err(AppError::validation("Invalid evidence source or locator")),
        }
        let mut record = fields.clone();
        record.insert("evidence_id".into(), Value::String(evidence_id));
        record.insert("subject_kind".into(), Value::String("entity".into()));
        record.insert("subject_id".into(), Value::String(subject_id.into()));
        record.insert("confirmed_by".into(), Value::String(actor.into()));
        record.insert("confirmed_at".into(), Value::String(timestamp.into()));
        record.insert("value".into(), value.clone());
        output.push(Value::Object(record));
    }
    Ok(output)
}

fn selected_value<'a>(
    properties: &'a Value,
    extensions: Option<&'a Value>,
    path: &str,
) -> Option<&'a Value> {
    if let Some(key) = path.strip_prefix("properties.") {
        properties.get(key)
    } else if let Some(key) = path.strip_prefix("extensions.") {
        extensions.and_then(|value| value.get(key))
    } else {
        None
    }
}

fn valid_import_data(value: &Value) -> Result<(), AppError> {
    let data = as_object(value)?;
    let allowed = [
        "candidates",
        "warnings",
        "source",
        "processed_block_ids",
        "unprocessed_block_ids",
    ];
    if data.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(AppError::validation("Import job contains unsupported data"));
    }
    fn check(value: &Value) -> Result<(), AppError> {
        match value {
            Value::Object(fields) => {
                for (key, item) in fields {
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
                        return Err(AppError::validation(
                            "Import job cannot store raw document content",
                        ));
                    }
                    if key == "quote"
                        && item
                            .as_str()
                            .is_some_and(|quote| quote.chars().count() > 500)
                    {
                        return Err(AppError::validation("Import evidence quote is too long"));
                    }
                    check(item)?;
                }
            }
            Value::Array(items) => {
                for item in items {
                    check(item)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    check(value)
}

pub struct Store {
    pub graph: KnowledgeGraph,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Box<dyn std::error::Error>> {
        let graph = KnowledgeGraph::open(path)?;
        graph.connection().execute_batch(
            "
            CREATE TABLE IF NOT EXISTS entity_ids (
                entity_id TEXT PRIMARY KEY,
                kg_id INTEGER NOT NULL UNIQUE REFERENCES kg_entities(id)
            );
            CREATE TABLE IF NOT EXISTS relation_ids (
                relation_id TEXT PRIMARY KEY,
                kg_id INTEGER NOT NULL UNIQUE REFERENCES kg_relations(id)
            );
            CREATE TABLE IF NOT EXISTS entity_meta (
                entity_id TEXT PRIMARY KEY REFERENCES entity_ids(entity_id),
                metadata_json TEXT NOT NULL,
                extensions_json TEXT
            );
            CREATE TABLE IF NOT EXISTS relation_meta (
                relation_id TEXT PRIMARY KEY REFERENCES relation_ids(relation_id),
                metadata_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS evidence (
                evidence_id TEXT PRIMARY KEY,
                subject_kind TEXT NOT NULL CHECK(subject_kind IN ('entity','relation')),
                subject_id TEXT NOT NULL,
                field_path TEXT NOT NULL,
                value_json TEXT NOT NULL,
                record_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS evidence_subject ON evidence(subject_kind, subject_id);
            CREATE TABLE IF NOT EXISTS source_mapping (
                source_key TEXT PRIMARY KEY,
                entity_id TEXT NOT NULL REFERENCES entity_ids(entity_id),
                relation_id TEXT REFERENCES relation_ids(relation_id),
                source_json TEXT
            );
            CREATE INDEX IF NOT EXISTS source_mapping_entity ON source_mapping(entity_id);
            CREATE TABLE IF NOT EXISTS contact_claims (
                claim_id TEXT PRIMARY KEY,
                subject_id TEXT NOT NULL REFERENCES entity_ids(entity_id),
                kind TEXT NOT NULL CHECK(kind IN ('field','relation')),
                field_path TEXT,
                relation_type TEXT,
                target_id TEXT REFERENCES entity_ids(entity_id),
                value_json TEXT NOT NULL CHECK(length(CAST(value_json AS BLOB)) <= 2048),
                source_json TEXT NOT NULL CHECK(length(CAST(source_json AS BLOB)) <= 2048),
                status TEXT NOT NULL CHECK(status IN ('unverified','confirmed','rejected')),
                reason TEXT NOT NULL,
                import_id TEXT NOT NULL REFERENCES import_jobs(import_id),
                candidate_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS contact_claims_subject_status
                ON contact_claims(subject_id,status,claim_id);
            CREATE TABLE IF NOT EXISTS operation_results (
                operation_id TEXT PRIMARY KEY,
                actor TEXT NOT NULL,
                op TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                result_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
                operation_id TEXT NOT NULL UNIQUE,
                actor TEXT NOT NULL,
                op TEXT NOT NULL,
                subject_id TEXT NOT NULL,
                changed_at TEXT NOT NULL,
                change_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS audit_subject ON audit_log(subject_id, audit_id);
            CREATE TABLE IF NOT EXISTS import_jobs (
                import_id TEXT PRIMARY KEY,
                file_id TEXT NOT NULL UNIQUE,
                actor TEXT NOT NULL,
                status TEXT NOT NULL,
                version INTEGER NOT NULL,
                data_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS import_jobs_status ON import_jobs(status);
            CREATE TABLE IF NOT EXISTS sync_cursor (
                id INTEGER PRIMARY KEY CHECK(id=1),
                last_snapshot_id INTEGER NOT NULL,
                initialized INTEGER NOT NULL CHECK(initialized IN (0,1))
            );
            CREATE TABLE IF NOT EXISTS vector_meta (
                entity_id TEXT PRIMARY KEY REFERENCES entity_ids(entity_id),
                model TEXT,
                dimension INTEGER,
                content_version INTEGER NOT NULL,
                status TEXT NOT NULL
            );
            ",
        )?;
        let source_columns = graph
            .connection()
            .prepare("PRAGMA table_info(source_mapping)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if !source_columns.iter().any(|column| column == "source_json") {
            graph
                .connection()
                .execute("ALTER TABLE source_mapping ADD COLUMN source_json TEXT", [])?;
        }
        Ok(Self { graph })
    }

    pub fn save_contact(&self, raw: &Value) -> Result<Value, AppError> {
        let input: SaveContactInput = serde_json::from_value(raw.clone())
            .map_err(|error| AppError::validation(error.to_string()))?;
        crate::validation::reject_caller_file_evidence(&input.evidence)
            .map_err(AppError::validation)?;
        if input.operation_id.trim().is_empty() || input.actor.trim().is_empty() {
            return Err(AppError::validation("operation_id and actor are required"));
        }
        if input.label != "Person" && input.label != "Organization" && input.label != "Project" {
            return Err(AppError::validation("Unknown entity label"));
        }
        let hash = canonical_hash(raw)?;
        let conn = self.graph.connection();
        let prior: Option<(String, String, String, String)> = conn.query_row(
            "SELECT actor,op,request_hash,result_json FROM operation_results WHERE operation_id=?1",
            [&input.operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(AppError::internal)?;
        if let Some((actor, op, request_hash, result_json)) = prior {
            if actor != input.actor || op != "save_contact" || request_hash != hash {
                return Err(AppError {
                    code: "OPERATION_CONFLICT",
                    message: "Operation ID was used for different content or actor".into(),
                });
            }
            let mut result: Value =
                serde_json::from_str(&result_json).map_err(AppError::internal)?;
            result["replayed"] = Value::Bool(true);
            return Ok(result);
        }

        let is_create = input.entity_id.is_none();
        let entity_id = input.entity_id.clone().unwrap_or_else(|| {
            let prefix = match input.label.as_str() {
                "Person" => "p",
                "Organization" => "o",
                _ => "j",
            };
            format!("{prefix}_{}", Uuid::new_v4().as_simple())
        });
        let now = now_utc();
        let tx = self.graph.transaction().map_err(AppError::internal)?;
        let (kg_id, mut properties, mut extensions, mut metadata, existing_evidence) = if is_create
        {
            if input.expected_version.is_some()
                || input
                    .unset_properties
                    .as_ref()
                    .is_some_and(|items| !items.is_empty())
                || input
                    .unset_extensions
                    .as_ref()
                    .is_some_and(|items| !items.is_empty())
            {
                return Err(AppError::validation(
                    "Create cannot use expected_version or unset fields",
                ));
            }
            (
                None,
                Value::Object(Map::new()),
                if input.label == "Person" {
                    Some(Value::Object(Map::new()))
                } else {
                    None
                },
                json!({"version":1,"created_at":now,"updated_at":now}),
                vec![],
            )
        } else {
            let found: Option<(i64, String, Option<String>)> = tx.query_row(
                "SELECT i.kg_id,m.metadata_json,m.extensions_json FROM entity_ids i JOIN entity_meta m USING(entity_id) WHERE i.entity_id=?1",
                [&entity_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).optional().map_err(AppError::internal)?;
            let (kg_id, meta_json, extensions_json) = found.ok_or(AppError {
                code: "NOT_FOUND",
                message: "Contact not found".into(),
            })?;
            let entity = self.graph.get_entity(kg_id).map_err(AppError::internal)?;
            if entity.entity_type != input.label {
                return Err(AppError::validation("Entity label cannot change"));
            }
            let metadata: Value = serde_json::from_str(&meta_json).map_err(AppError::internal)?;
            if metadata.get("archived_at").is_some() || metadata.get("merged_into").is_some() {
                return Err(AppError::validation(
                    "Archived or merged contact cannot be edited",
                ));
            }
            if input.expected_version != metadata["version"].as_u64() {
                return Err(AppError {
                    code: "VERSION_CONFLICT",
                    message: "Contact version changed".into(),
                });
            }
            let old_evidence = self.read_evidence(&entity_id)?;
            (
                Some(kg_id),
                serde_json::to_value(entity.properties).map_err(AppError::internal)?,
                extensions_json
                    .map(|value| serde_json::from_str(&value).map_err(AppError::internal))
                    .transpose()?,
                metadata,
                old_evidence,
            )
        };

        let set_properties = normalize_properties(
            &input.label,
            input
                .set_properties
                .as_ref()
                .unwrap_or(&Value::Object(Map::new())),
            is_create,
        )
        .map_err(AppError::validation)?;
        for (key, value) in as_object(&set_properties)? {
            properties[key] = value.clone();
        }
        let unset = input.unset_properties.unwrap_or_default();
        for key in &unset {
            if (key == "name" && input.label != "Project") || set_properties.get(key).is_some() {
                return Err(AppError::validation(
                    "Cannot unset name or set and unset one field",
                ));
            }
            if properties.as_object_mut().unwrap().remove(key).is_none() {
                return Err(AppError::validation(format!(
                    "Unknown or absent property: {key}"
                )));
            }
        }
        properties =
            normalize_properties(&input.label, &properties, true).map_err(AppError::validation)?;

        if input.label == "Person" {
            let set_extensions = normalize_extensions(
                input
                    .set_extensions
                    .as_ref()
                    .unwrap_or(&Value::Object(Map::new())),
                false,
            )
            .map_err(AppError::validation)?;
            let value = extensions.get_or_insert_with(|| Value::Object(Map::new()));
            for (key, item) in as_object(&set_extensions)? {
                value[key] = item.clone();
            }
            for key in input.unset_extensions.unwrap_or_default() {
                if !["nativePlace", "maritalStatus"].contains(&key.as_str())
                    || set_extensions.get(&key).is_some()
                {
                    return Err(AppError::validation("Invalid extension unset"));
                }
                value.as_object_mut().unwrap().remove(&key);
            }
            *value = normalize_extensions(value, true).map_err(AppError::validation)?;
        } else if input.set_extensions.is_some() || input.unset_extensions.is_some() {
            return Err(AppError::validation(
                "Organization and Project have no extensions",
            ));
        }

        let new_evidence = collect_evidence(
            &input.evidence,
            &entity_id,
            &input.label,
            &input.actor,
            &now,
        )?;
        let all_evidence: Vec<Value> = existing_evidence
            .iter()
            .chain(new_evidence.iter())
            .cloned()
            .collect();
        ensure_value_evidence(&properties, extensions.as_ref(), &all_evidence)
            .map_err(AppError::validation)?;
        if input.label == "Person"
            && properties.get("name").is_none()
            && !has_substantive_person_data(&properties, extensions.as_ref())
        {
            return Err(AppError::validation(
                "Unnamed Person needs supported information",
            ));
        }
        let name = properties["name"].as_str().unwrap_or(&entity_id);
        if let Some(kg_id) = kg_id {
            let mut entity = self.graph.get_entity(kg_id).map_err(AppError::internal)?;
            entity.name = name.to_owned();
            entity.properties =
                serde_json::from_value(properties.clone()).map_err(AppError::internal)?;
            self.graph
                .update_entity(&entity)
                .map_err(AppError::internal)?;
            metadata["version"] = json!(metadata["version"].as_u64().unwrap() + 1);
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
            let mut entity = sqlite_knowledge_graph::Entity::new(&input.label, name);
            entity.properties =
                serde_json::from_value(properties.clone()).map_err(AppError::internal)?;
            let kg_id = self
                .graph
                .insert_entity(&entity)
                .map_err(AppError::internal)?;
            tx.execute(
                "INSERT INTO entity_ids(entity_id,kg_id) VALUES(?1,?2)",
                params![entity_id, kg_id],
            )
            .map_err(AppError::internal)?;
            tx.execute(
                "INSERT INTO entity_meta(entity_id,metadata_json,extensions_json) VALUES(?1,?2,?3)",
                params![
                    entity_id,
                    metadata.to_string(),
                    extensions.as_ref().map(Value::to_string)
                ],
            )
            .map_err(AppError::internal)?;
        }
        crate::vectors::invalidate_vector(&tx, &entity_id)?;
        for record in new_evidence {
            tx.execute("INSERT INTO evidence(evidence_id,subject_kind,subject_id,field_path,value_json,record_json) VALUES(?1,'entity',?2,?3,?4,?5)",
                params![record["evidence_id"].as_str(), entity_id, record["field_path"].as_str(), record["value"].to_string(), record.to_string()])
                .map_err(AppError::internal)?;
        }
        let result = json!({"entity_id":entity_id,"version":metadata["version"],"replayed":false});
        tx.execute("INSERT INTO audit_log(operation_id,actor,op,subject_id,changed_at,change_json) VALUES(?1,?2,'save_contact',?3,?4,?5)",
            params![input.operation_id, input.actor, entity_id, now, raw.to_string()])
            .map_err(AppError::internal)?;
        tx.execute("INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,?2,'save_contact',?3,?4)",
            params![input.operation_id, input.actor, hash, result.to_string()])
            .map_err(AppError::internal)?;
        tx.commit().map_err(AppError::internal)?;
        Ok(result)
    }

    pub(crate) fn read_evidence(&self, entity_id: &str) -> Result<Vec<Value>, AppError> {
        let mut statement = self.graph.connection().prepare(
            "SELECT record_json FROM evidence WHERE subject_kind='entity' AND subject_id=?1 ORDER BY rowid",
        ).map_err(AppError::internal)?;
        let rows = statement
            .query_map([entity_id], |row| row.get::<_, String>(0))
            .map_err(AppError::internal)?;
        rows.map(|row| {
            let json = row.map_err(AppError::internal)?;
            serde_json::from_str(&json).map_err(AppError::internal)
        })
        .collect()
    }

    pub fn get_contact(&self, raw: &Value) -> Result<Value, AppError> {
        let (evidence_offset, evidence_limit) = contact_page(raw, "evidence")?;
        let (relation_offset, relation_limit) = contact_page(raw, "relation")?;
        let (claim_offset, claim_limit) = contact_page(raw, "claim")?;
        let entity_id = raw
            .get("entity_id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("entity_id is required"))?;
        let found: Option<(i64, String, Option<String>)> = self.graph.connection().query_row(
            "SELECT i.kg_id,m.metadata_json,m.extensions_json FROM entity_ids i JOIN entity_meta m USING(entity_id) WHERE i.entity_id=?1",
            [entity_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(AppError::internal)?;
        let Some((kg_id, metadata_json, extensions_json)) = found else {
            return Ok(Value::Null);
        };
        let metadata: Value = serde_json::from_str(&metadata_json).map_err(AppError::internal)?;
        if metadata.get("archived_at").is_some() || metadata.get("merged_into").is_some() {
            return Ok(Value::Null);
        }
        let entity = self.graph.get_entity(kg_id).map_err(AppError::internal)?;
        let properties = serde_json::to_value(entity.properties).map_err(AppError::internal)?;
        let entity_evidence = self.read_evidence(entity_id)?;
        let mut entity_json = json!({
            "entity_id":entity_id,"label":entity.entity_type,"properties":properties,
            "metadata":metadata
        });
        if let Some(extensions_json) = extensions_json {
            entity_json["extensions"] =
                serde_json::from_str(&extensions_json).map_err(AppError::internal)?;
        }
        let version = entity_json["metadata"]["version"].clone();
        let vector: Option<(u64, String)> = self
            .graph
            .connection()
            .query_row(
                "SELECT content_version,status FROM vector_meta WHERE entity_id=?1",
                [entity_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(AppError::internal)?;
        let (index_content_version, index_status) =
            vector.unwrap_or((version.as_u64().unwrap_or(1), "unindexed".into()));
        let relations = self.list_relations(&json!({"entity_id":entity_id}))?;
        let mut evidence = entity_evidence;
        for relation in relations.as_array().unwrap() {
            let relation_id = relation["relation_id"].as_str().unwrap();
            let mut statement = self.graph.connection().prepare(
                "SELECT record_json FROM evidence WHERE subject_kind='relation' AND subject_id=?1 ORDER BY rowid",
            ).map_err(AppError::internal)?;
            let rows = statement
                .query_map([relation_id], |row| row.get::<_, String>(0))
                .map_err(AppError::internal)?;
            for row in rows {
                evidence.push(
                    serde_json::from_str(&row.map_err(AppError::internal)?)
                        .map_err(AppError::internal)?,
                );
            }
        }
        let evidence_total = evidence.len();
        let evidence: Vec<Value> = evidence
            .into_iter()
            .skip(evidence_offset)
            .take(evidence_limit)
            .collect();
        let mut conflicts = Vec::new();
        for record in &evidence {
            if record["subject_kind"] != "entity" {
                continue;
            }
            if let Some(path) = record["field_path"].as_str() {
                let selected = selected_value(&properties, entity_json.get("extensions"), path);
                let matches = selected.is_some_and(|current| match current {
                    Value::Array(values) => values.contains(&record["value"]),
                    other => other == &record["value"],
                });
                if !matches {
                    conflicts.push(record.clone());
                }
            }
        }
        let relations = relations.as_array().unwrap();
        let relation_total = relations.len();
        let relation_page: Vec<Value> = relations
            .iter()
            .skip(relation_offset)
            .take(relation_limit)
            .cloned()
            .collect();
        let evidence_next = (evidence_offset.saturating_add(evidence.len()) < evidence_total)
            .then_some(evidence_offset.saturating_add(evidence.len()));
        let relation_next = (relation_offset.saturating_add(relation_page.len()) < relation_total)
            .then_some(relation_offset.saturating_add(relation_page.len()));
        let claim_total: usize = self
            .graph
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM contact_claims WHERE subject_id=?1 AND status='unverified'",
                [entity_id],
                |row| row.get(0),
            )
            .map_err(AppError::internal)?;
        let mut statement = self.graph.connection().prepare(
            "SELECT claim_id,subject_id,kind,field_path,relation_type,target_id,value_json,source_json,
                status,reason,import_id,candidate_id,created_at,updated_at
             FROM contact_claims WHERE subject_id=?1 AND status='unverified'
             ORDER BY claim_id LIMIT ?2 OFFSET ?3",
        ).map_err(AppError::internal)?;
        let rows = statement.query_map(params![entity_id, claim_limit as i64,
            claim_offset.min(i64::MAX as usize) as i64], |row| {
            Ok(json!({"claim_id":row.get::<_,String>(0)?,"subject_id":row.get::<_,String>(1)?,
                "kind":row.get::<_,String>(2)?,"field_path":row.get::<_,Option<String>>(3)?,
                "relation_type":row.get::<_,Option<String>>(4)?,"target_id":row.get::<_,Option<String>>(5)?,
                "value":row.get::<_,String>(6)?,"source":row.get::<_,String>(7)?,
                "status":row.get::<_,String>(8)?,"reason":row.get::<_,String>(9)?,
                "import_id":row.get::<_,String>(10)?,"candidate_id":row.get::<_,String>(11)?,
                "created_at":row.get::<_,String>(12)?,"updated_at":row.get::<_,String>(13)?}))
        }).map_err(AppError::internal)?;
        let mut claims = Vec::new();
        for row in rows {
            let mut claim = row.map_err(AppError::internal)?;
            for key in ["value", "source"] {
                claim[key] = serde_json::from_str(claim[key].as_str().unwrap())
                    .map_err(AppError::internal)?;
            }
            claims.push(claim);
        }
        let claim_next = (claim_limit > 0
            && claim_offset.saturating_add(claims.len()) < claim_total)
            .then_some(claim_offset.saturating_add(claims.len()));
        Ok(
            json!({"entity":entity_json,"evidence":evidence,"relations":relation_page,"conflicts":conflicts,
            "unverified_claims":claims,"pagination":{"unverified_claims":{"offset":claim_offset,
                "limit":claim_limit,"total":claim_total,"next_offset":claim_next},"evidence":{"offset":evidence_offset,"limit":evidence_limit,
                "total":evidence_total,"next_offset":evidence_next},
                "relations":{"offset":relation_offset,"limit":relation_limit,
                "total":relation_total,"next_offset":relation_next}},
            "version":version,"index_content_version":index_content_version,"index_status":index_status}),
        )
    }

    pub fn put_import_job(&self, raw: &Value) -> Result<Value, AppError> {
        let input: PutImportJobInput = serde_json::from_value(raw.clone())
            .map_err(|error| AppError::validation(error.to_string()))?;
        if input.operation_id.trim().is_empty()
            || input.actor.trim().is_empty()
            || input.file_id.trim().is_empty()
        {
            return Err(AppError::validation(
                "operation_id, actor and file_id are required",
            ));
        }
        if ![
            "queued",
            "processing",
            "ready_for_review",
            "committed",
            "failed",
            "cancelled",
        ]
        .contains(&input.status.as_str())
        {
            return Err(AppError::validation("Invalid import status"));
        }
        valid_import_data(&input.data)?;
        let hash = canonical_hash(raw)?;
        let prior: Option<(String, String, String, String)> = self.graph.connection().query_row(
            "SELECT actor,op,request_hash,result_json FROM operation_results WHERE operation_id=?1",
            [&input.operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(AppError::internal)?;
        if let Some((actor, op, request_hash, result_json)) = prior {
            if actor != input.actor || op != "put_import_job" || request_hash != hash {
                return Err(AppError {
                    code: "OPERATION_CONFLICT",
                    message: "Operation ID was used for different content or actor".into(),
                });
            }
            let mut result: Value =
                serde_json::from_str(&result_json).map_err(AppError::internal)?;
            result["replayed"] = Value::Bool(true);
            return Ok(result);
        }
        let tx = self.graph.transaction().map_err(AppError::internal)?;
        let (import_id, version) = if let Some(import_id) = input.import_id {
            let found: Option<(String, u64, String)> = tx
                .query_row(
                    "SELECT file_id,version,status FROM import_jobs WHERE import_id=?1",
                    [&import_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(AppError::internal)?;
            let (file_id, old_version, old_status) = found.ok_or(AppError {
                code: "NOT_FOUND",
                message: "Import job not found".into(),
            })?;
            if file_id != input.file_id || input.expected_version != Some(old_version) {
                return Err(AppError {
                    code: "VERSION_CONFLICT",
                    message: "Import job version or file changed".into(),
                });
            }
            let next_allowed = match old_status.as_str() {
                "queued" => ["processing", "ready_for_review", "failed", "cancelled"]
                    .contains(&input.status.as_str()),
                "processing" => ["processing", "ready_for_review", "failed", "cancelled"]
                    .contains(&input.status.as_str()),
                "ready_for_review" => {
                    ["ready_for_review", "failed", "cancelled"].contains(&input.status.as_str())
                }
                _ => false,
            };
            if !next_allowed {
                return Err(AppError::validation("Invalid import status transition"));
            }
            let version = old_version + 1;
            tx.execute(
                "UPDATE import_jobs SET status=?1,version=?2,data_json=?3 WHERE import_id=?4",
                params![input.status, version, input.data.to_string(), import_id],
            )
            .map_err(AppError::internal)?;
            (import_id, version)
        } else {
            if input.status != "queued" || input.expected_version.is_some() {
                return Err(AppError::validation("New import job must be queued"));
            }
            let existing: Option<String> = tx
                .query_row(
                    "SELECT import_id FROM import_jobs WHERE file_id=?1",
                    [&input.file_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(AppError::internal)?;
            if existing.is_some() {
                return Err(AppError {
                    code: "FILE_ALREADY_USED",
                    message: "File is already bound to an import job".into(),
                });
            }
            let import_id = format!("ci_{}", Uuid::new_v4().as_simple());
            tx.execute("INSERT INTO import_jobs(import_id,file_id,actor,status,version,data_json) VALUES(?1,?2,?3,?4,1,?5)",
                params![import_id, input.file_id, input.actor, input.status, input.data.to_string()])
                .map_err(AppError::internal)?;
            (import_id, 1)
        };
        let result =
            json!({"import_id":import_id,"status":input.status,"version":version,"replayed":false});
        tx.execute("INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,?2,'put_import_job',?3,?4)",
            params![input.operation_id, input.actor, hash, result.to_string()]).map_err(AppError::internal)?;
        tx.commit().map_err(AppError::internal)?;
        Ok(result)
    }

    pub fn get_import_job(&self, raw: &Value) -> Result<Value, AppError> {
        let import_id = raw
            .get("import_id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("import_id is required"))?;
        let found: Option<(String, String, String, u64, String)> = self
            .graph
            .connection()
            .query_row(
                "SELECT file_id,actor,status,version,data_json FROM import_jobs WHERE import_id=?1",
                [import_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(AppError::internal)?;
        let Some((file_id, actor, status, version, data_json)) = found else {
            return Ok(Value::Null);
        };
        Ok(
            json!({"import_id":import_id,"file_id":file_id,"actor":actor,"status":status,"version":version,
            "data":serde_json::from_str::<Value>(&data_json).map_err(AppError::internal)?}),
        )
    }
}
