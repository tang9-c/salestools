use chrono::{SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

use crate::store::{AppError, Store};
use crate::validation::{ensure_value_evidence, normalize_extensions, normalize_properties};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveInput {
    operation_id: String,
    actor: String,
    #[serde(default)]
    entity_id: Option<String>,
    #[serde(default)]
    relation_id: Option<String>,
    expected_version: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MergeInput {
    operation_id: String,
    actor: String,
    source_id: String,
    target_id: String,
    expected_source_version: u64,
    expected_target_version: u64,
    #[serde(default)]
    field_choices: BTreeMap<String, String>,
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
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn hash(raw: &Value) -> Result<String, AppError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(raw).map_err(internal)?)
    ))
}
fn replay(
    store: &Store,
    op: &str,
    operation_id: &str,
    actor: &str,
    hash: &str,
) -> Result<Option<Value>, AppError> {
    let row: Option<(String, String, String, String)> = store
        .graph
        .connection()
        .query_row(
            "SELECT actor,op,request_hash,result_json FROM operation_results WHERE operation_id=?1",
            [operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(internal)?;
    let Some((old_actor, old_op, old_hash, old_result)) = row else {
        return Ok(None);
    };
    if old_actor != actor || old_op != op || old_hash != hash {
        return Err(AppError {
            code: "OPERATION_CONFLICT",
            message: "Operation ID reused".into(),
        });
    }
    let mut result: Value = serde_json::from_str(&old_result).map_err(internal)?;
    result["replayed"] = json!(true);
    Ok(Some(result))
}
#[allow(clippy::too_many_arguments)] // Audit and idempotency rows must share one transaction and operation identity.
fn save_result(
    tx: &Transaction<'_>,
    raw: &Value,
    operation_id: &str,
    actor: &str,
    op: &str,
    subject_id: &str,
    request_hash: &str,
    result: &Value,
    changed_at: &str,
) -> Result<(), AppError> {
    tx.execute("INSERT INTO audit_log(operation_id,actor,op,subject_id,changed_at,change_json) VALUES(?1,?2,?3,?4,?5,?6)",
        params![operation_id,actor,op,subject_id,changed_at,raw.to_string()]).map_err(internal)?;
    tx.execute("INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,?2,?3,?4,?5)",
        params![operation_id,actor,op,request_hash,result.to_string()]).map_err(internal)?;
    Ok(())
}

impl Store {
    fn set_archive(
        &self,
        raw: &Value,
        op: &str,
        restore: bool,
        relation: bool,
    ) -> Result<Value, AppError> {
        let input: ArchiveInput =
            serde_json::from_value(raw.clone()).map_err(|error| invalid(error.to_string()))?;
        if input.operation_id.trim().is_empty() || input.actor.trim().is_empty() {
            return Err(invalid("operation_id and actor are required"));
        }
        let id = if relation {
            input.relation_id.as_deref()
        } else {
            input.entity_id.as_deref()
        }
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| invalid("Subject ID is required"))?;
        let request_hash = hash(raw)?;
        if let Some(result) = replay(self, op, &input.operation_id, &input.actor, &request_hash)? {
            return Ok(result);
        }
        let table = if relation {
            "relation_meta"
        } else {
            "entity_meta"
        };
        let column = if relation { "relation_id" } else { "entity_id" };
        let sql = format!("SELECT metadata_json FROM {table} WHERE {column}=?1");
        let tx = self.graph.transaction().map_err(internal)?;
        let meta_json: Option<String> = tx
            .query_row(&sql, [id], |row| row.get(0))
            .optional()
            .map_err(internal)?;
        let mut meta: Value = serde_json::from_str(&meta_json.ok_or_else(|| AppError {
            code: "NOT_FOUND",
            message: "Subject not found".into(),
        })?)
        .map_err(internal)?;
        if meta["version"].as_u64() != Some(input.expected_version) {
            return Err(AppError {
                code: "VERSION_CONFLICT",
                message: "Subject version changed".into(),
            });
        }
        if !relation && meta.get("merged_into").is_some() {
            return Err(invalid("Merged identity cannot be restored"));
        }
        let is_archived = meta.get("archived_at").is_some();
        if is_archived != restore {
            return Err(invalid("Archive state does not match operation"));
        }
        let changed_at = now();
        if restore {
            meta.as_object_mut().unwrap().remove("archived_at");
        } else {
            meta["archived_at"] = json!(changed_at);
        }
        meta["updated_at"] = json!(changed_at);
        meta["version"] = json!(input.expected_version + 1);
        let update = format!("UPDATE {table} SET metadata_json=?1 WHERE {column}=?2");
        tx.execute(&update, params![meta.to_string(), id])
            .map_err(internal)?;
        let mut indexed_source: Option<String> = None;
        if relation {
            let source: Option<String> = tx.query_row(
                "SELECT source.entity_id FROM relation_ids ids JOIN kg_relations r ON r.id=ids.kg_id
                 JOIN entity_ids source ON source.kg_id=r.source_id JOIN entity_meta sm ON sm.entity_id=source.entity_id
                 WHERE ids.relation_id=?1 AND r.rel_type='worksFor'
                 AND json_extract(sm.metadata_json,'$.archived_at') IS NULL
                 AND json_extract(sm.metadata_json,'$.merged_into') IS NULL",
                [id], |row| row.get(0),
            ).optional().map_err(internal)?;
            if let Some(source) = source {
                crate::vectors::invalidate_vector(&tx, &source)?;
                indexed_source = Some(source);
            }
        } else if restore {
            crate::vectors::invalidate_vector(&tx, id)?;
        } else {
            crate::vectors::retire_vector(&tx, id)?;
        }
        let result = if relation {
            json!({"relation_id":id,"version":meta["version"],"replayed":false,
                "indexed_source_id": indexed_source})
        } else {
            json!({"entity_id":id,"version":meta["version"],"replayed":false})
        };
        save_result(
            &tx,
            raw,
            &input.operation_id,
            &input.actor,
            op,
            id,
            &request_hash,
            &result,
            &changed_at,
        )?;
        tx.commit().map_err(internal)?;
        Ok(result)
    }

    pub fn archive_contact(&self, raw: &Value) -> Result<Value, AppError> {
        self.set_archive(raw, "archive_contact", false, false)
    }
    pub fn restore_contact(&self, raw: &Value) -> Result<Value, AppError> {
        self.set_archive(raw, "restore_contact", true, false)
    }
    pub fn archive_relation(&self, raw: &Value) -> Result<Value, AppError> {
        self.set_archive(raw, "archive_relation", false, true)
    }

    pub fn merge_contacts(&self, raw: &Value) -> Result<Value, AppError> {
        let input: MergeInput =
            serde_json::from_value(raw.clone()).map_err(|error| invalid(error.to_string()))?;
        if input.operation_id.trim().is_empty()
            || input.actor.trim().is_empty()
            || input.source_id == input.target_id
        {
            return Err(invalid("Invalid merge identity or operation"));
        }
        let request_hash = hash(raw)?;
        if let Some(result) = replay(
            self,
            "merge_contacts",
            &input.operation_id,
            &input.actor,
            &request_hash,
        )? {
            return Ok(result);
        }
        let tx = self.graph.transaction().map_err(internal)?;
        let lookup = |id: &str| -> Result<(i64, String, Value), AppError> {
            let row:Option<(i64,String,String)> = tx.query_row(
                "SELECT i.kg_id,e.entity_type,m.metadata_json FROM entity_ids i JOIN kg_entities e ON e.id=i.kg_id JOIN entity_meta m USING(entity_id) WHERE i.entity_id=?1",
                [id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            ).optional().map_err(internal)?;
            let (kg, label, meta) = row.ok_or_else(|| AppError {
                code: "NOT_FOUND",
                message: "Contact not found".into(),
            })?;
            Ok((kg, label, serde_json::from_str(&meta).map_err(internal)?))
        };
        let (source_kg, source_label, mut source_meta) = lookup(&input.source_id)?;
        let (target_kg, target_label, mut target_meta) = lookup(&input.target_id)?;
        if source_label != target_label
            || source_meta.get("archived_at").is_some()
            || source_meta.get("merged_into").is_some()
            || target_meta.get("archived_at").is_some()
            || target_meta.get("merged_into").is_some()
        {
            return Err(invalid("Contacts cannot be merged"));
        }
        if source_meta["version"] != input.expected_source_version
            || target_meta["version"] != input.expected_target_version
        {
            return Err(AppError {
                code: "VERSION_CONFLICT",
                message: "Contact version changed".into(),
            });
        }
        let changed_at = now();
        let source_entity = self.graph.get_entity(source_kg).map_err(internal)?;
        let mut target_entity = self.graph.get_entity(target_kg).map_err(internal)?;
        let source_props = serde_json::to_value(&source_entity.properties).map_err(internal)?;
        let mut target_props = serde_json::to_value(&target_entity.properties).map_err(internal)?;
        let source_ext_json: Option<String> = tx
            .query_row(
                "SELECT extensions_json FROM entity_meta WHERE entity_id=?1",
                [&input.source_id],
                |row| row.get(0),
            )
            .map_err(internal)?;
        let target_ext_json: Option<String> = tx
            .query_row(
                "SELECT extensions_json FROM entity_meta WHERE entity_id=?1",
                [&input.target_id],
                |row| row.get(0),
            )
            .map_err(internal)?;
        let source_ext: Option<Value> = source_ext_json
            .map(|value| serde_json::from_str(&value).map_err(internal))
            .transpose()?;
        let mut target_ext: Option<Value> = target_ext_json
            .map(|value| serde_json::from_str(&value).map_err(internal))
            .transpose()?;
        let mut copied_evidence = Vec::new();
        for (path, choice) in &input.field_choices {
            if choice != "source" && choice != "target" {
                return Err(invalid("Field choice must be source or target"));
            }
            let (source_value, target_fields, key) =
                if let Some(key) = path.strip_prefix("properties.") {
                    (source_props.get(key), &mut target_props, key)
                } else if let Some(key) = path.strip_prefix("extensions.") {
                    (
                        source_ext.as_ref().and_then(|value| value.get(key)),
                        target_ext
                            .as_mut()
                            .ok_or_else(|| invalid("Target has no extensions"))?,
                        key,
                    )
                } else {
                    return Err(invalid("Invalid field choice path"));
                };
            let source_value = source_value
                .ok_or_else(|| invalid("Source field choice does not exist"))?
                .clone();
            if choice == "target" {
                continue;
            }
            target_fields
                .as_object_mut()
                .unwrap()
                .insert(key.to_owned(), source_value.clone());
            let mut statement = tx.prepare("SELECT record_json FROM evidence WHERE subject_kind='entity' AND subject_id=?1 AND field_path=?2")
                .map_err(internal)?;
            let rows = statement
                .query_map(params![input.source_id, path], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(internal)?;
            for row in rows {
                let mut record: Value =
                    serde_json::from_str(&row.map_err(internal)?).map_err(internal)?;
                let selected = match &source_value {
                    Value::Array(items) => items.contains(&record["value"]),
                    other => other == &record["value"],
                };
                if !selected {
                    continue;
                }
                record["evidence_id"] = json!(format!("ev_{}", Uuid::new_v4().as_simple()));
                record["subject_id"] = json!(input.target_id);
                record["confirmed_by"] = json!(input.actor);
                record["confirmed_at"] = json!(changed_at);
                copied_evidence.push(record);
            }
        }
        if !input.field_choices.is_empty() {
            target_props =
                normalize_properties(&target_label, &target_props, true).map_err(invalid)?;
            if let Some(ref mut extensions) = target_ext {
                *extensions = normalize_extensions(extensions, true).map_err(invalid)?;
            }
            let mut all_evidence = copied_evidence.clone();
            let mut statement = tx.prepare("SELECT record_json FROM evidence WHERE subject_kind='entity' AND subject_id=?1")
                .map_err(internal)?;
            let rows = statement
                .query_map([&input.target_id], |row| row.get::<_, String>(0))
                .map_err(internal)?;
            for row in rows {
                all_evidence.push(serde_json::from_str(&row.map_err(internal)?).map_err(internal)?);
            }
            ensure_value_evidence(&target_props, target_ext.as_ref(), &all_evidence)
                .map_err(invalid)?;
            target_entity.properties =
                serde_json::from_value(target_props.clone()).map_err(internal)?;
            target_entity.name = target_props["name"].as_str().unwrap().to_owned();
            self.graph.update_entity(&target_entity).map_err(internal)?;
            for record in copied_evidence {
                tx.execute("INSERT INTO evidence(evidence_id,subject_kind,subject_id,field_path,value_json,record_json) VALUES(?1,'entity',?2,?3,?4,?5)",
                    params![record["evidence_id"].as_str(),input.target_id,record["field_path"].as_str(),record["value"].to_string(),record.to_string()]).map_err(internal)?;
            }
        }
        source_meta["archived_at"] = json!(changed_at);
        source_meta["merged_into"] = json!(input.target_id);
        source_meta["updated_at"] = json!(changed_at);
        source_meta["version"] = json!(input.expected_source_version + 1);
        target_meta["updated_at"] = json!(changed_at);
        target_meta["version"] = json!(input.expected_target_version + 1);
        tx.execute(
            "UPDATE entity_meta SET metadata_json=?1 WHERE entity_id=?2",
            params![source_meta.to_string(), input.source_id],
        )
        .map_err(internal)?;
        tx.execute(
            "UPDATE entity_meta SET metadata_json=?1,extensions_json=?2 WHERE entity_id=?3",
            params![
                target_meta.to_string(),
                target_ext.as_ref().map(Value::to_string),
                input.target_id
            ],
        )
        .map_err(internal)?;
        tx.execute(
            "UPDATE source_mapping SET entity_id=?1 WHERE entity_id=?2",
            params![input.target_id, input.source_id],
        )
        .map_err(internal)?;
        let affected: Vec<(String, i64, i64, i64, String)> = {
            let mut statement = tx
                .prepare(
                    "SELECT ids.relation_id,r.id,r.source_id,r.target_id,r.rel_type
                FROM relation_ids ids JOIN kg_relations r ON r.id=ids.kg_id
                JOIN relation_meta m USING(relation_id)
                WHERE (r.source_id=?1 OR r.target_id=?1)
                AND json_extract(m.metadata_json,'$.archived_at') IS NULL",
                )
                .map_err(internal)?;
            let rows = statement
                .query_map([source_kg], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })
                .map_err(internal)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(internal)?
        };
        for (relation_id, kg_id, old_source, old_target, kind) in affected {
            let mut edge_source = if old_source == source_kg {
                target_kg
            } else {
                old_source
            };
            let mut edge_target = if old_target == source_kg {
                target_kg
            } else {
                old_target
            };
            let mut retire = edge_source == edge_target;
            if ["spouse", "colleague"].contains(&kind.as_str()) {
                let source_app: String = tx
                    .query_row(
                        "SELECT entity_id FROM entity_ids WHERE kg_id=?1",
                        [edge_source],
                        |row| row.get(0),
                    )
                    .map_err(internal)?;
                let target_app: String = tx
                    .query_row(
                        "SELECT entity_id FROM entity_ids WHERE kg_id=?1",
                        [edge_target],
                        |row| row.get(0),
                    )
                    .map_err(internal)?;
                if source_app > target_app {
                    std::mem::swap(&mut edge_source, &mut edge_target);
                }
            }
            let duplicate: Option<String> = if kind != "worksFor" && !retire {
                tx.query_row(
                    "SELECT ids.relation_id FROM kg_relations r JOIN relation_ids ids ON ids.kg_id=r.id JOIN relation_meta m USING(relation_id)
                     WHERE r.id<>?1 AND r.rel_type=?2 AND r.source_id=?3 AND r.target_id=?4
                     AND json_extract(m.metadata_json,'$.archived_at') IS NULL LIMIT 1",
                    params![kg_id,kind,edge_source,edge_target],|row|row.get(0),
                ).optional().map_err(internal)?
            } else {
                None
            };
            retire |= duplicate.is_some();
            if retire {
                let meta_json: String = tx
                    .query_row(
                        "SELECT metadata_json FROM relation_meta WHERE relation_id=?1",
                        [&relation_id],
                        |row| row.get(0),
                    )
                    .map_err(internal)?;
                let mut meta: Value = serde_json::from_str(&meta_json).map_err(internal)?;
                meta["archived_at"] = json!(changed_at);
                meta["updated_at"] = json!(changed_at);
                meta["version"] = json!(meta["version"].as_u64().unwrap_or(0) + 1);
                tx.execute(
                    "UPDATE relation_meta SET metadata_json=?1 WHERE relation_id=?2",
                    params![meta.to_string(), relation_id],
                )
                .map_err(internal)?;
                if let Some(active_id) = duplicate {
                    let source_app: String = tx
                        .query_row(
                            "SELECT entity_id FROM entity_ids WHERE kg_id=?1",
                            [edge_source],
                            |row| row.get(0),
                        )
                        .map_err(internal)?;
                    let target_app: String = tx
                        .query_row(
                            "SELECT entity_id FROM entity_ids WHERE kg_id=?1",
                            [edge_target],
                            |row| row.get(0),
                        )
                        .map_err(internal)?;
                    let selected =
                        json!({"relation_type":kind,"source_id":source_app,"target_id":target_app});
                    let mut statement = tx.prepare("SELECT record_json FROM evidence WHERE subject_kind='relation' AND subject_id=?1")
                        .map_err(internal)?;
                    let rows = statement
                        .query_map([&relation_id], |row| row.get::<_, String>(0))
                        .map_err(internal)?;
                    for row in rows {
                        let mut record: Value =
                            serde_json::from_str(&row.map_err(internal)?).map_err(internal)?;
                        record["evidence_id"] = json!(format!("ev_{}", Uuid::new_v4().as_simple()));
                        record["subject_id"] = json!(active_id);
                        if record["field_path"] == "$relation" {
                            record["value"] = selected.clone();
                        }
                        record["confirmed_by"] = json!(input.actor);
                        record["confirmed_at"] = json!(changed_at);
                        tx.execute("INSERT INTO evidence(evidence_id,subject_kind,subject_id,field_path,value_json,record_json) VALUES(?1,'relation',?2,?3,?4,?5)",
                            params![record["evidence_id"].as_str(),active_id,record["field_path"].as_str(),record["value"].to_string(),record.to_string()]).map_err(internal)?;
                    }
                    let active_meta_json: String = tx
                        .query_row(
                            "SELECT metadata_json FROM relation_meta WHERE relation_id=?1",
                            [&active_id],
                            |row| row.get(0),
                        )
                        .map_err(internal)?;
                    let mut active_meta: Value =
                        serde_json::from_str(&active_meta_json).map_err(internal)?;
                    active_meta["updated_at"] = json!(changed_at);
                    active_meta["version"] =
                        json!(active_meta["version"].as_u64().unwrap_or(0) + 1);
                    tx.execute(
                        "UPDATE relation_meta SET metadata_json=?1 WHERE relation_id=?2",
                        params![active_meta.to_string(), active_id],
                    )
                    .map_err(internal)?;
                }
            } else {
                tx.execute(
                    "UPDATE kg_relations SET source_id=?1,target_id=?2 WHERE id=?3",
                    params![edge_source, edge_target, kg_id],
                )
                .map_err(internal)?;
                let source_app: String = tx
                    .query_row(
                        "SELECT entity_id FROM entity_ids WHERE kg_id=?1",
                        [edge_source],
                        |row| row.get(0),
                    )
                    .map_err(internal)?;
                let target_app: String = tx
                    .query_row(
                        "SELECT entity_id FROM entity_ids WHERE kg_id=?1",
                        [edge_target],
                        |row| row.get(0),
                    )
                    .map_err(internal)?;
                let relation_value =
                    json!({"relation_type":kind,"source_id":source_app,"target_id":target_app});
                let evidence_id = format!("ev_{}", Uuid::new_v4().as_simple());
                let record = json!({"evidence_id":evidence_id,"subject_kind":"relation","subject_id":relation_id,
                    "field_path":"$relation","value":relation_value,"source_type":"manual",
                    "locator_status":"not_applicable","collected_at":changed_at,
                    "confirmed_by":input.actor,"confirmed_at":changed_at});
                tx.execute("INSERT INTO evidence(evidence_id,subject_kind,subject_id,field_path,value_json,record_json) VALUES(?1,'relation',?2,'$relation',?3,?4)",
                    params![evidence_id,relation_id,relation_value.to_string(),record.to_string()]).map_err(internal)?;
                let meta_json: String = tx
                    .query_row(
                        "SELECT metadata_json FROM relation_meta WHERE relation_id=?1",
                        [&relation_id],
                        |row| row.get(0),
                    )
                    .map_err(internal)?;
                let mut meta: Value = serde_json::from_str(&meta_json).map_err(internal)?;
                meta["updated_at"] = json!(changed_at);
                meta["version"] = json!(meta["version"].as_u64().unwrap_or(0) + 1);
                tx.execute(
                    "UPDATE relation_meta SET metadata_json=?1 WHERE relation_id=?2",
                    params![meta.to_string(), relation_id],
                )
                .map_err(internal)?;
            }
        }
        crate::vectors::retire_vector(&tx, &input.source_id)?;
        crate::vectors::invalidate_vector(&tx, &input.target_id)?;
        let result = json!({"source_id":input.source_id,"target_id":input.target_id,
            "source_version":source_meta["version"],"target_version":target_meta["version"],"replayed":false});
        save_result(
            &tx,
            raw,
            &input.operation_id,
            &input.actor,
            "merge_contacts",
            &input.target_id,
            &request_hash,
            &result,
            &changed_at,
        )?;
        tx.commit().map_err(internal)?;
        Ok(result)
    }
}
