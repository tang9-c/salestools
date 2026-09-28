use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::relations::{persist_relation, relation_metadata, relation_properties, RelationWrite};
use crate::store::{canonical_hash, collect_evidence, now_utc, AppError, Store};
use crate::validation::{
    allowed_entity_evidence_path, ensure_value_evidence, has_substantive_person_data,
    normalize_extensions, normalize_properties,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewInput {
    claim_id: String,
    action: String,
    operation_id: String,
    actor: String,
    expected_entity_version: u64,
    target_id: Option<String>,
    corrected_value: Option<Value>,
    confirmation_note: Option<String>,
}

fn manual(path: &str, value: &Value, note: &str, now: &str) -> Value {
    json!({"field_path":path,"value":value,"source_type":"manual",
        "locator_status":"not_applicable","collected_at":now,"quote":note})
}

// Keep this projection aligned with buildEmbeddingText in vector-indexer.ts.
// Privacy values influence scrubbing even though they are never embedded themselves.
fn entity_index_inputs(
    properties: &Value,
    extensions: Option<&Value>,
) -> (Vec<String>, Vec<String>) {
    fn add(out: &mut Vec<String>, value: &Value) {
        if let Some(text) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            if !out.iter().any(|item| item == text) {
                out.push(text.to_owned());
            }
        }
    }
    // Each occurrence must survive: an earlier deletion can form a value that a
    // later repeated scrub input removes (e.g. Secret, X, Secret on SecXret).
    fn add_private(out: &mut Vec<String>, value: &Value) {
        if let Some(text) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            out.push(text.to_owned());
        }
    }
    fn items(value: &Value) -> &[Value] {
        value.as_array().map(Vec::as_slice).unwrap_or(&[])
    }
    let mut selected = Vec::new();
    for key in ["name", "description", "jobTitle"] {
        add(&mut selected, &properties[key]);
    }
    for skill in items(&properties["skills"]) {
        add(&mut selected, skill);
    }
    for occupation in items(&properties["hasOccupation"]) {
        for key in ["name", "description"] {
            add(&mut selected, &occupation[key]);
        }
    }
    for credential in items(&properties["hasCredential"]) {
        for key in ["name", "credentialCategory"] {
            add(&mut selected, &credential[key]);
        }
    }
    let mut private = Vec::new();
    for key in ["email", "telephone", "faxNumber"] {
        for value in items(&properties[key]) {
            add_private(&mut private, value);
        }
    }
    add_private(&mut private, &properties["address"]);
    for point in items(&properties["contactPoint"]) {
        for key in ["email", "telephone"] {
            for value in items(&point[key]) {
                add_private(&mut private, value);
            }
        }
        add_private(&mut private, &point["url"]);
    }
    if let Some(extensions) = extensions {
        for account in items(&extensions["instantMessaging"]) {
            add_private(&mut private, &account["accountId"]);
        }
    }
    (selected, private)
}

impl Store {
    pub fn review_contact_claim(&self, raw: &Value) -> Result<Value, AppError> {
        let input: ReviewInput =
            serde_json::from_value(raw.clone()).map_err(|e| AppError::validation(e.to_string()))?;
        if input.claim_id.trim().is_empty()
            || input.operation_id.trim().is_empty()
            || input.actor.trim().is_empty()
            || !["confirm", "reject"].contains(&input.action.as_str())
            || input.expected_entity_version == 0
        {
            return Err(AppError::validation("Invalid claim review input"));
        }
        let hash = canonical_hash(raw)?;
        let tx = self.graph.transaction().map_err(AppError::internal)?;
        let prior: Option<(String,String,String,String)> = tx.query_row(
            "SELECT actor,op,request_hash,result_json FROM operation_results WHERE operation_id=?1",
            [&input.operation_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))
            .optional().map_err(AppError::internal)?;
        if let Some((actor, op, old_hash, result)) = prior {
            if actor != input.actor || op != "review_contact_claim" || old_hash != hash {
                return Err(AppError {
                    code: "OPERATION_CONFLICT",
                    message: "Operation ID reused".into(),
                });
            }
            let mut result: Value = serde_json::from_str(&result).map_err(AppError::internal)?;
            result["replayed"] = json!(true);
            return Ok(result);
        }
        let row: Option<(String,String,Option<String>,Option<String>,Option<String>,String,String)> = tx.query_row(
            "SELECT subject_id,kind,field_path,relation_type,target_id,value_json,status FROM contact_claims WHERE claim_id=?1",
            [&input.claim_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)))
            .optional().map_err(AppError::internal)?;
        let (subject, kind, path, relation_type, target, value, status) = row.ok_or(AppError {
            code: "NOT_FOUND",
            message: "Claim not found".into(),
        })?;
        let (kg_id,meta,extensions): (i64,String,Option<String>) = tx.query_row(
            "SELECT i.kg_id,m.metadata_json,m.extensions_json FROM entity_ids i JOIN entity_meta m USING(entity_id) WHERE entity_id=?1",
            [&subject],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(AppError::internal)?;
        let mut meta: Value = serde_json::from_str(&meta).map_err(AppError::internal)?;
        if meta.get("archived_at").is_some() || meta.get("merged_into").is_some() {
            return Err(AppError::validation(
                "Archived or merged contact cannot be reviewed",
            ));
        }
        if meta["version"].as_u64() != Some(input.expected_entity_version) {
            return Err(AppError {
                code: "VERSION_CONFLICT",
                message: "Contact version changed".into(),
            });
        }
        if status != "unverified" {
            return Err(AppError::validation("Claim has already been reviewed"));
        }
        let now = now_utc();
        let mut entity = self.graph.get_entity(kg_id).map_err(AppError::internal)?;
        let mut result = json!({"claim_id":input.claim_id,"entity_id":subject,"version":input.expected_entity_version+1,"replayed":false});
        let new_status = if input.action == "confirm" {
            let note = input
                .confirmation_note
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty() && v.chars().count() <= 500)
                .ok_or_else(|| {
                    AppError::validation("Confirm requires a 1–500 character confirmation_note")
                })?;
            // Null is a supplied correction, not permission to silently use the original claim.
            let value: Value = raw
                .get("corrected_value")
                .cloned()
                .or(input.corrected_value)
                .unwrap_or(serde_json::from_str(&value).map_err(AppError::internal)?);
            if kind == "field" {
                let path = path
                    .as_deref()
                    .ok_or_else(|| AppError::validation("Missing field path"))?;
                if !allowed_entity_evidence_path(&entity.entity_type, path)
                    || input.target_id.is_some()
                {
                    return Err(AppError::validation("Invalid field claim"));
                }
                let mut properties =
                    serde_json::to_value(&entity.properties).map_err(AppError::internal)?;
                let mut extensions: Option<Value> = extensions
                    .map(|v| serde_json::from_str(&v).map_err(AppError::internal))
                    .transpose()?;
                let index_before = entity_index_inputs(&properties, extensions.as_ref());
                let (scope, key) = path
                    .split_once('.')
                    .ok_or_else(|| AppError::validation("Invalid field path"))?;
                let fields = if scope == "properties" {
                    &mut properties
                } else {
                    extensions.get_or_insert_with(|| json!({}))
                };
                let defaults = if scope == "properties" {
                    normalize_properties(&entity.entity_type, &json!({"name":"placeholder"}), true)
                } else {
                    normalize_extensions(&json!({}), true)
                }
                .map_err(AppError::validation)?;
                let array = defaults.get(key).is_some_and(Value::is_array);
                let supplied = if array && !value.is_array() {
                    json!([value])
                } else {
                    value
                };
                let partial = json!({key:supplied});
                let normalized = if scope == "properties" {
                    normalize_properties(&entity.entity_type, &partial, false)
                } else {
                    normalize_extensions(&partial, false)
                }
                .map_err(AppError::validation)?;
                let selected = &normalized[key];
                let values: Vec<Value> = if array {
                    selected.as_array().unwrap().clone()
                } else {
                    vec![selected.clone()]
                };
                if array {
                    let mut combined = fields
                        .get(key)
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    for item in &values {
                        if !combined.contains(item) {
                            combined.push(item.clone());
                        }
                    }
                    fields[key] = json!(combined);
                } else {
                    fields[key] = selected.clone();
                }
                properties = normalize_properties(&entity.entity_type, &properties, true)
                    .map_err(AppError::validation)?;
                if let Some(value) = extensions.as_mut() {
                    *value = normalize_extensions(value, true).map_err(AppError::validation)?;
                }
                let evidence = values
                    .iter()
                    .map(|v| manual(path, v, note, &now))
                    .collect::<Vec<_>>();
                let records =
                    collect_evidence(&evidence, &subject, &entity.entity_type, &input.actor, &now)?;
                let mut all = self.read_evidence(&subject)?;
                all.extend(records.iter().cloned());
                ensure_value_evidence(&properties, extensions.as_ref(), &all)
                    .map_err(AppError::validation)?;
                if entity.entity_type == "Person"
                    && properties.get("name").is_none()
                    && !has_substantive_person_data(&properties, extensions.as_ref())
                {
                    return Err(AppError::validation(
                        "Unnamed Person needs supported information",
                    ));
                }
                let index_changed =
                    index_before != entity_index_inputs(&properties, extensions.as_ref());
                entity.name = properties["name"].as_str().unwrap_or(&subject).to_owned();
                entity.properties =
                    serde_json::from_value(properties).map_err(AppError::internal)?;
                self.graph
                    .update_entity(&entity)
                    .map_err(AppError::internal)?;
                tx.execute(
                    "UPDATE entity_meta SET extensions_json=?1 WHERE entity_id=?2",
                    params![extensions.as_ref().map(Value::to_string), subject],
                )
                .map_err(AppError::internal)?;
                for record in records {
                    tx.execute("INSERT INTO evidence(evidence_id,subject_kind,subject_id,field_path,value_json,record_json) VALUES(?1,'entity',?2,?3,?4,?5)",
                        params![record["evidence_id"].as_str(),subject,path,record["value"].to_string(),record.to_string()]).map_err(AppError::internal)?;
                }
                if entity.entity_type == "Person" && index_changed {
                    crate::vectors::invalidate_vector(&tx, &subject)?;
                    result["indexed_entity_id"] = json!(subject);
                }
            } else {
                let target = input
                    .target_id
                    .as_deref()
                    .or(target.as_deref())
                    .filter(|v| !v.trim().is_empty())
                    .ok_or_else(|| {
                        AppError::validation("Relation confirmation requires target_id")
                    })?;
                let relation_type = relation_type
                    .as_deref()
                    .ok_or_else(|| AppError::validation("Missing relation type"))?;
                let fields = value.as_object().ok_or_else(|| {
                    AppError::validation("Relation claim value must be an object")
                })?;
                if fields.keys().any(|k| {
                    ![
                        "target_candidate_id",
                        "target_name",
                        "properties",
                        "metadata",
                    ]
                    .contains(&k.as_str())
                }) {
                    return Err(AppError::validation("Invalid relation claim value"));
                }
                let properties = relation_properties(
                    relation_type,
                    fields.get("properties").unwrap_or(&json!({})),
                )?;
                let metadata = relation_metadata(
                    relation_type,
                    fields.get("metadata").unwrap_or(&json!({})),
                    &properties,
                )?;
                let mut evidence = vec![manual(
                    "$relation",
                    &json!({"relation_type":relation_type,"source_id":subject,"target_id":target}),
                    note,
                    &now,
                )];
                if let Some(role) = properties.get("role").and_then(Value::as_object) {
                    for (key, value) in role {
                        if key != "@type" {
                            evidence.push(manual(
                                &format!("properties.role.{key}"),
                                value,
                                note,
                                &now,
                            ));
                        }
                    }
                }
                for (key, value) in metadata.as_object().unwrap() {
                    if value != "unknown" {
                        evidence.push(manual(&format!("metadata.{key}"), value, note, &now));
                    }
                }
                let fact = persist_relation(
                    self,
                    &tx,
                    RelationWrite {
                        relation_type,
                        source_id: &subject,
                        target_id: target,
                        properties: &properties,
                        metadata: &metadata,
                        evidence: &evidence,
                        actor: &input.actor,
                        now: &now,
                    },
                )?;
                result["relation_id"] = fact["relation_id"].clone();
                if relation_type == "worksFor" {
                    result["indexed_entity_id"] = json!(subject);
                }
            }
            "confirmed"
        } else {
            "rejected"
        };
        meta["version"] = result["version"].clone();
        meta["updated_at"] = json!(now);
        tx.execute(
            "UPDATE entity_meta SET metadata_json=?1 WHERE entity_id=?2",
            params![meta.to_string(), subject],
        )
        .map_err(AppError::internal)?;
        tx.execute(
            "UPDATE contact_claims SET status=?1,updated_at=?2 WHERE claim_id=?3",
            params![new_status, now, input.claim_id],
        )
        .map_err(AppError::internal)?;
        result["status"] = json!(new_status);
        tx.execute("INSERT INTO audit_log(operation_id,actor,op,subject_id,changed_at,change_json) VALUES(?1,?2,'review_contact_claim',?3,?4,?5)",params![input.operation_id,input.actor,subject,now,raw.to_string()]).map_err(AppError::internal)?;
        tx.execute("INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,?2,'review_contact_claim',?3,?4)",params![input.operation_id,input.actor,hash,result.to_string()]).map_err(AppError::internal)?;
        tx.commit().map_err(AppError::internal)?;
        Ok(result)
    }
}
