use chrono::{SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlite_knowledge_graph::Relation;
use uuid::Uuid;

use crate::store::{AppError, Store};
use crate::validation::partial_date;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveRelationInput {
    operation_id: String,
    actor: String,
    source_id: String,
    target_id: String,
    relation_type: String,
    #[serde(default = "empty_object")]
    properties: Value,
    #[serde(default = "empty_object")]
    metadata: Value,
    #[serde(default)]
    evidence: Vec<Value>,
}

fn empty_object() -> Value {
    json!({})
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError {
        code: "VALIDATION_ERROR",
        message: message.into(),
    }
}

fn internal(error: impl std::fmt::Display) -> AppError {
    AppError {
        code: "INTERNAL_ERROR",
        message: error.to_string(),
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn text(value: &Value, name: &str) -> Result<String, AppError> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{name} must be nonempty text")))
}

fn object<'a>(value: &'a Value, name: &str) -> Result<&'a Map<String, Value>, AppError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("{name} must be an object")))
}

fn valid_role(raw: &Value) -> Result<Value, AppError> {
    let role = object(raw, "role")?;
    if role.get("@type").and_then(Value::as_str) != Some("OrganizationRole")
        || role
            .keys()
            .any(|key| !["@type", "roleName", "startDate", "endDate"].contains(&key.as_str()))
    {
        return Err(invalid("Invalid OrganizationRole"));
    }
    let mut output = Map::new();
    output.insert("@type".into(), json!("OrganizationRole"));
    for key in ["roleName", "startDate", "endDate"] {
        if let Some(value) = role.get(key) {
            let value = text(value, key)?;
            if key.ends_with("Date") {
                partial_date(&value).map_err(invalid)?;
            }
            output.insert(key.into(), json!(value));
        }
    }
    if let (Some(start), Some(end)) = (output.get("startDate"), output.get("endDate")) {
        let start = partial_date(start.as_str().unwrap()).map_err(invalid)?;
        let end = partial_date(end.as_str().unwrap()).map_err(invalid)?;
        if (start.0, start.1, start.2) > (end.0, end.3, end.4) {
            return Err(invalid("Role endDate precedes startDate"));
        }
    }
    Ok(Value::Object(output))
}

pub(crate) fn relation_properties(kind: &str, raw: &Value) -> Result<Value, AppError> {
    let fields = object(raw, "properties")?;
    if kind == "worksFor" {
        if fields.len() != 1 {
            return Err(invalid("worksFor requires only role"));
        }
        let role = fields
            .get("role")
            .ok_or_else(|| invalid("worksFor requires role"))?;
        Ok(json!({"role":valid_role(role)?}))
    } else if fields.is_empty() {
        Ok(json!({}))
    } else {
        Err(invalid("This relation has no properties"))
    }
}

pub(crate) fn relation_metadata(
    kind: &str,
    raw: &Value,
    properties: &Value,
) -> Result<Value, AppError> {
    let fields = object(raw, "metadata")?;
    if kind != "worksFor" {
        if fields.is_empty() {
            return Ok(json!({}));
        }
        return Err(invalid("This relation has no employment metadata"));
    }
    if fields
        .keys()
        .any(|key| !["employment_status", "status_as_of"].contains(&key.as_str()))
    {
        return Err(invalid("Unknown relation metadata"));
    }
    let status = fields
        .get("employment_status")
        .map(|value| text(value, "employment_status"))
        .transpose()?
        .unwrap_or_else(|| "unknown".into());
    if !["current", "ended", "unknown"].contains(&status.as_str()) {
        return Err(invalid("Invalid employment_status"));
    }
    let mut result = json!({"employment_status":status});
    if let Some(as_of) = fields.get("status_as_of") {
        let as_of = text(as_of, "status_as_of")?;
        partial_date(&as_of).map_err(invalid)?;
        result["status_as_of"] = json!(as_of);
    }
    if status == "current" {
        if result["status_as_of"]
            .as_str()
            .is_none_or(|value| value.len() != 10)
        {
            return Err(invalid("Current employment needs full status_as_of date"));
        }
        if properties["role"].get("endDate").is_some() {
            return Err(invalid("Current employment cannot have endDate"));
        }
    }
    Ok(result)
}

pub(crate) fn normalize_endpoints(
    kind: &str,
    source: &str,
    target: &str,
) -> Result<(String, String, String), AppError> {
    if source == target {
        return Err(invalid("Self relation is not allowed"));
    }
    let valid = [
        "worksFor",
        "alumniOf",
        "affiliation",
        "memberOf",
        "colleague",
        "spouse",
        "parent",
        "children",
    ];
    if !valid.contains(&kind) {
        return Err(invalid("Unknown relation type"));
    }
    if kind == "children" {
        return Ok(("parent".into(), target.into(), source.into()));
    }
    if ["spouse", "colleague"].contains(&kind) && source > target {
        return Ok((kind.into(), target.into(), source.into()));
    }
    Ok((kind.into(), source.into(), target.into()))
}

#[allow(clippy::too_many_arguments)] // A single evidence decision needs the complete selected relation fact.
pub(crate) fn collect_relation_evidence(
    input: &[Value],
    relation_id: &str,
    actor: &str,
    now: &str,
    kind: &str,
    source: &str,
    target: &str,
    properties: &Value,
    metadata: &Value,
) -> Result<Vec<Value>, AppError> {
    let expected = json!({"relation_type":kind,"source_id":source,"target_id":target});
    let mut result = Vec::new();
    let mut has_relation = false;
    for item in input {
        let fields = object(item, "evidence")?;
        if fields.keys().any(|key| {
            ![
                "field_path",
                "value",
                "source_type",
                "collected_at",
                "locator_status",
                "file_name",
                "file_sha256",
                "source_url",
                "quote",
                "page",
                "value_path",
            ]
            .contains(&key.as_str())
        }) {
            return Err(invalid("Unknown evidence field"));
        }
        let path = fields
            .get("field_path")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Missing field_path"))?;
        let value = fields
            .get("value")
            .ok_or_else(|| invalid("Missing evidence value"))?;
        let stored_value = if path == "$relation" {
            has_relation = true;
            let provided = object(value, "$relation.value")?;
            if provided.len() != 3 {
                return Err(invalid("Invalid relation evidence value"));
            }
            let original_type = provided
                .get("relation_type")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("Missing relation evidence type"))?;
            let original_source = provided
                .get("source_id")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("Missing relation evidence source"))?;
            let original_target = provided
                .get("target_id")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("Missing relation evidence target"))?;
            let (normalized_type, normalized_source, normalized_target) =
                normalize_endpoints(original_type, original_source, original_target)?;
            json!({"relation_type":normalized_type,"source_id":normalized_source,"target_id":normalized_target})
        } else if let Some(key) = path.strip_prefix("properties.role.") {
            if properties["role"].get(key).is_none() {
                return Err(invalid("Unknown role evidence path"));
            }
            value.clone()
        } else if let Some(key) = path.strip_prefix("metadata.") {
            if metadata.get(key).is_none() {
                return Err(invalid("Unknown relation metadata evidence path"));
            }
            value.clone()
        } else {
            return Err(invalid("Unknown relation evidence path"));
        };
        let selected = if path == "$relation" {
            &expected
        } else if let Some(key) = path.strip_prefix("properties.role.") {
            &properties["role"][key]
        } else {
            &metadata[path.strip_prefix("metadata.").unwrap()]
        };
        if &stored_value != selected {
            return Err(invalid(
                "Evidence value differs from selected relation value",
            ));
        }
        let source_type = fields
            .get("source_type")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Missing evidence source_type"))?;
        let locator = fields
            .get("locator_status")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Missing locator_status"))?;
        let source_valid = match source_type {
            "manual" => locator == "not_applicable",
            "file" => {
                ["located", "unavailable"].contains(&locator)
                    && fields.get("file_name").and_then(Value::as_str).is_some()
                    && fields.get("file_sha256").and_then(Value::as_str).is_some()
            }
            "web" => {
                ["located", "unavailable"].contains(&locator)
                    && fields.get("source_url").and_then(Value::as_str).is_some()
            }
            _ => false,
        };
        if !source_valid {
            return Err(invalid("Invalid evidence source"));
        }
        if source_type != "manual"
            && (locator != "located"
                || fields
                    .get("quote")
                    .and_then(Value::as_str)
                    .is_none_or(|quote| quote.trim().is_empty() || quote.chars().count() > 500))
        {
            return Err(invalid(
                "Selected relation fact needs a located short quote or manual confirmation",
            ));
        }
        if fields
            .get("page")
            .is_some_and(|page| page.as_u64().is_none_or(|page| page == 0))
        {
            return Err(invalid("Evidence page must be positive"));
        }
        if fields.get("value_path").is_some() {
            return Err(invalid("Relation evidence cannot use value_path"));
        }
        if fields
            .get("collected_at")
            .and_then(Value::as_str)
            .is_none_or(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
        {
            return Err(invalid("Invalid evidence collected_at"));
        }
        let mut record = fields.clone();
        record.insert("value".into(), stored_value);
        record.insert(
            "evidence_id".into(),
            json!(format!("ev_{}", Uuid::new_v4().as_simple())),
        );
        record.insert("subject_kind".into(), json!("relation"));
        record.insert("subject_id".into(), json!(relation_id));
        record.insert("confirmed_by".into(), json!(actor));
        record.insert("confirmed_at".into(), json!(now));
        result.push(Value::Object(record));
    }
    if !has_relation {
        return Err(invalid("Missing relation existence evidence"));
    }
    if kind == "worksFor" {
        for (key, value) in properties["role"].as_object().unwrap() {
            if key != "@type"
                && !result.iter().any(|item| {
                    item["field_path"] == format!("properties.role.{key}")
                        && item["value"] == *value
                })
            {
                return Err(invalid(format!("Missing role evidence for {key}")));
            }
        }
        for key in ["employment_status", "status_as_of"] {
            if let Some(value) = metadata.get(key) {
                if key == "employment_status" && value == "unknown" {
                    continue;
                }
                if !result.iter().any(|item| {
                    item["field_path"] == format!("metadata.{key}") && item["value"] == *value
                }) {
                    return Err(invalid(format!("Missing employment evidence for {key}")));
                }
            }
        }
    }
    Ok(result)
}

pub(crate) struct RelationWrite<'a> {
    pub relation_type: &'a str,
    pub source_id: &'a str,
    pub target_id: &'a str,
    pub properties: &'a Value,
    pub metadata: &'a Value,
    pub evidence: &'a [Value],
    pub actor: &'a str,
    pub now: &'a str,
}

pub(crate) fn persist_relation(
    store: &Store,
    tx: &Transaction<'_>,
    input: RelationWrite<'_>,
) -> Result<Value, AppError> {
    let (kind, source, target) =
        normalize_endpoints(input.relation_type, input.source_id, input.target_id)?;
    let properties = relation_properties(&kind, input.properties)?;
    let selected_meta = relation_metadata(&kind, input.metadata, &properties)?;
    let endpoint = |id: &str| -> Result<(i64, String), AppError> {
        let row: Option<(i64, String, String)> = tx.query_row(
            "SELECT i.kg_id,e.entity_type,m.metadata_json FROM entity_ids i JOIN kg_entities e ON e.id=i.kg_id JOIN entity_meta m USING(entity_id) WHERE i.entity_id=?1",
            [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(internal)?;
        let (kg_id, label, metadata) =
            row.ok_or_else(|| invalid("Relation endpoint does not exist"))?;
        let metadata: Value = serde_json::from_str(&metadata).map_err(internal)?;
        if metadata.get("archived_at").is_some() || metadata.get("merged_into").is_some() {
            return Err(invalid("Relation endpoint is archived or merged"));
        }
        Ok((kg_id, label))
    };
    let (source_kg, source_label) = endpoint(&source)?;
    let (target_kg, target_label) = endpoint(&target)?;
    let target_expected =
        if ["worksFor", "alumniOf", "affiliation", "memberOf"].contains(&kind.as_str()) {
            "Organization"
        } else {
            "Person"
        };
    if source_label != "Person" || target_label != target_expected {
        return Err(invalid("Invalid relation endpoint labels"));
    }
    let existing: Option<String> = if kind == "worksFor" {
        None
    } else {
        tx.query_row("SELECT ids.relation_id FROM relation_ids ids JOIN kg_relations r ON r.id=ids.kg_id JOIN relation_meta m USING(relation_id) WHERE r.rel_type=?1 AND r.source_id=?2 AND r.target_id=?3 AND json_extract(m.metadata_json,'$.archived_at') IS NULL LIMIT 1",
            params![kind,source_kg,target_kg], |row| row.get(0)).optional().map_err(internal)?
    };
    let relation_id = existing
        .clone()
        .unwrap_or_else(|| format!("r_{}", Uuid::new_v4().as_simple()));
    let records = collect_relation_evidence(
        input.evidence,
        &relation_id,
        input.actor,
        input.now,
        &kind,
        &source,
        &target,
        &properties,
        &selected_meta,
    )?;
    let version = if let Some(existing_id) = existing {
        let meta_json: String = tx
            .query_row(
                "SELECT metadata_json FROM relation_meta WHERE relation_id=?1",
                [&existing_id],
                |row| row.get(0),
            )
            .map_err(internal)?;
        let mut meta: Value = serde_json::from_str(&meta_json).map_err(internal)?;
        let next = meta["version"]
            .as_u64()
            .ok_or_else(|| invalid("Invalid relation version"))?
            + 1;
        meta["version"] = json!(next);
        meta["updated_at"] = json!(input.now);
        tx.execute(
            "UPDATE relation_meta SET metadata_json=?1 WHERE relation_id=?2",
            params![meta.to_string(), existing_id],
        )
        .map_err(internal)?;
        next
    } else {
        let mut relation = Relation::new(source_kg, target_kg, &kind, 1.0).map_err(internal)?;
        if kind == "worksFor" {
            relation.set_property("role", properties["role"].clone());
        }
        let kg_id = store.graph.insert_relation(&relation).map_err(internal)?;
        let mut meta = json!({"version":1,"created_at":input.now,"updated_at":input.now});
        if kind == "worksFor" {
            meta["employment_status"] = selected_meta["employment_status"].clone();
            if let Some(as_of) = selected_meta.get("status_as_of") {
                meta["status_as_of"] = as_of.clone();
            }
        }
        tx.execute(
            "INSERT INTO relation_ids(relation_id,kg_id) VALUES(?1,?2)",
            params![relation_id, kg_id],
        )
        .map_err(internal)?;
        tx.execute(
            "INSERT INTO relation_meta(relation_id,metadata_json) VALUES(?1,?2)",
            params![relation_id, meta.to_string()],
        )
        .map_err(internal)?;
        1
    };
    for record in records {
        tx.execute("INSERT INTO evidence(evidence_id,subject_kind,subject_id,field_path,value_json,record_json) VALUES(?1,'relation',?2,?3,?4,?5)",
            params![record["evidence_id"].as_str(),relation_id,record["field_path"].as_str(),record["value"].to_string(),record.to_string()]).map_err(internal)?;
    }
    Ok(
        json!({"relation_id":relation_id,"source_id":source,"target_id":target,"relation_type":kind,"version":version}),
    )
}

impl Store {
    pub fn save_relation(&self, raw: &Value) -> Result<Value, AppError> {
        let input: SaveRelationInput =
            serde_json::from_value(raw.clone()).map_err(|error| invalid(error.to_string()))?;
        if input.operation_id.trim().is_empty() || input.actor.trim().is_empty() {
            return Err(invalid("operation_id and actor are required"));
        }
        let hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(raw).map_err(internal)?)
        );
        let prior: Option<(String, String, String, String)> = self.graph.connection().query_row(
            "SELECT actor,op,request_hash,result_json FROM operation_results WHERE operation_id=?1",
            [&input.operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(internal)?;
        if let Some((actor, op, prior_hash, result)) = prior {
            if actor != input.actor || op != "save_relation" || prior_hash != hash {
                return Err(AppError {
                    code: "OPERATION_CONFLICT",
                    message: "Operation ID reused".into(),
                });
            }
            let mut result: Value = serde_json::from_str(&result).map_err(internal)?;
            result["replayed"] = json!(true);
            return Ok(result);
        }
        let now = timestamp();
        let tx = self.graph.transaction().map_err(internal)?;
        let fact = persist_relation(
            self,
            &tx,
            RelationWrite {
                relation_type: &input.relation_type,
                source_id: &input.source_id,
                target_id: &input.target_id,
                properties: &input.properties,
                metadata: &input.metadata,
                evidence: &input.evidence,
                actor: &input.actor,
                now: &now,
            },
        )?;
        let relation_id = fact["relation_id"].as_str().unwrap();
        let version = &fact["version"];
        let result = json!({"relation_id":relation_id,"version":version,"replayed":false});
        tx.execute("INSERT INTO audit_log(operation_id,actor,op,subject_id,changed_at,change_json) VALUES(?1,?2,'save_relation',?3,?4,?5)",
            params![input.operation_id,input.actor,relation_id,now,raw.to_string()]).map_err(internal)?;
        tx.execute("INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,?2,'save_relation',?3,?4)",
            params![input.operation_id,input.actor,hash,result.to_string()]).map_err(internal)?;
        tx.commit().map_err(internal)?;
        Ok(result)
    }

    pub fn list_relations(&self, raw: &Value) -> Result<Value, AppError> {
        let entity_id = raw
            .get("entity_id")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("entity_id is required"))?;
        let mut statement = self.graph.connection().prepare(
            "SELECT ids.relation_id,source.entity_id,target.entity_id,r.rel_type,r.properties,m.metadata_json
             FROM relation_ids ids JOIN kg_relations r ON r.id=ids.kg_id
             JOIN entity_ids source ON source.kg_id=r.source_id JOIN entity_ids target ON target.kg_id=r.target_id
             JOIN relation_meta m USING(relation_id)
             JOIN entity_meta sm ON sm.entity_id=source.entity_id JOIN entity_meta tm ON tm.entity_id=target.entity_id
             WHERE (source.entity_id=?1 OR target.entity_id=?1)
             AND json_extract(m.metadata_json,'$.archived_at') IS NULL
             AND json_extract(sm.metadata_json,'$.archived_at') IS NULL
             AND json_extract(tm.metadata_json,'$.archived_at') IS NULL
             AND json_extract(sm.metadata_json,'$.merged_into') IS NULL
             AND json_extract(tm.metadata_json,'$.merged_into') IS NULL ORDER BY ids.relation_id"
        ).map_err(internal)?;
        let rows = statement
            .query_map([entity_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(internal)?;
        let mut result = Vec::new();
        for row in rows {
            let (id, source, target, kind, properties, metadata) = row.map_err(internal)?;
            result.push(
                json!({"relation_id":id,"source_id":source,"target_id":target,"relation_type":kind,
                "properties":serde_json::from_str::<Value>(&properties).map_err(internal)?,
                "metadata":serde_json::from_str::<Value>(&metadata).map_err(internal)?}),
            );
        }
        Ok(Value::Array(result))
    }
}
