use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::{canonical_hash, AppError, Store};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::validation(message)
}

fn conflict(message: impl Into<String>) -> AppError {
    AppError {
        code: "VERSION_CONFLICT",
        message: message.into(),
    }
}

fn positive(value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        Err(invalid("Required vector field is empty"))
    } else {
        Ok(())
    }
}

fn unit_vector(values: &[f64]) -> Result<Vec<f32>, AppError> {
    let cast: Vec<f32> = values.iter().map(|value| *value as f32).collect();
    if cast.iter().any(|value| !value.is_finite()) {
        return Err(invalid("Vector contains nonfinite values"));
    }
    let squared: f64 = cast.iter().map(|value| f64::from(*value).powi(2)).sum();
    if !squared.is_finite() || squared <= 0.0 {
        return Err(invalid("Vector has invalid magnitude"));
    }
    let norm = squared.sqrt();
    Ok(cast
        .iter()
        .map(|value| (f64::from(*value) / norm) as f32)
        .collect())
}

fn active_entity(tx: &Transaction<'_>, entity_id: &str) -> Result<(i64, u64), AppError> {
    let row: Option<(i64, String)> = tx.query_row(
        "SELECT i.kg_id,m.metadata_json FROM entity_ids i JOIN entity_meta m USING(entity_id) WHERE i.entity_id=?1",
        [entity_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(AppError::internal)?;
    let (kg_id, metadata) = row.ok_or_else(|| invalid("Contact not found"))?;
    let metadata: Value = serde_json::from_str(&metadata).map_err(AppError::internal)?;
    if metadata.get("archived_at").is_some() || metadata.get("merged_into").is_some() {
        return Err(invalid("Contact is archived or merged"));
    }
    let version = metadata["version"]
        .as_u64()
        .ok_or_else(|| invalid("Invalid contact version"))?;
    Ok((kg_id, version))
}

/// Called within the same transaction as a factual change. The old vector cannot
/// remain searchable while a new description or relation is waiting for embedding.
pub(crate) fn invalidate_vector(tx: &Transaction<'_>, entity_id: &str) -> Result<u64, AppError> {
    let (kg_id, entity_version) = active_entity(tx, entity_id)?;
    let previous: Option<u64> = tx
        .query_row(
            "SELECT content_version FROM vector_meta WHERE entity_id=?1",
            [entity_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppError::internal)?;
    let next = previous.map_or(entity_version, |version| (version + 1).max(entity_version));
    tx.execute(
        "INSERT INTO vector_meta(entity_id,model,dimension,content_version,status) VALUES(?1,NULL,NULL,?2,'unindexed')
         ON CONFLICT(entity_id) DO UPDATE SET model=NULL,dimension=NULL,content_version=excluded.content_version,status='unindexed'",
        params![entity_id, next],
    ).map_err(AppError::internal)?;
    tx.execute("DELETE FROM kg_vectors WHERE entity_id=?1", [kg_id])
        .map_err(AppError::internal)?;
    Ok(next)
}

pub(crate) fn retire_vector(tx: &Transaction<'_>, entity_id: &str) -> Result<(), AppError> {
    let kg_id: i64 = tx
        .query_row(
            "SELECT kg_id FROM entity_ids WHERE entity_id=?1",
            [entity_id],
            |row| row.get(0),
        )
        .map_err(AppError::internal)?;
    tx.execute("DELETE FROM kg_vectors WHERE entity_id=?1", [kg_id])
        .map_err(AppError::internal)?;
    tx.execute("UPDATE vector_meta SET model=NULL,dimension=NULL,status='archived',content_version=content_version+1 WHERE entity_id=?1",
        [entity_id]).map_err(AppError::internal)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PutVector {
    operation_id: String,
    actor: String,
    entity_id: String,
    content_version: u64,
    model: String,
    dimension: usize,
    vector: Vec<f64>,
}

fn replay(
    store: &Store,
    raw: &Value,
    operation_id: &str,
    actor: &str,
    op: &str,
) -> Result<Option<Value>, AppError> {
    let hash = canonical_hash(raw)?;
    let prior: Option<(String, String, String, String)> = store
        .graph
        .connection()
        .query_row(
            "SELECT actor,op,request_hash,result_json FROM operation_results WHERE operation_id=?1",
            [operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(AppError::internal)?;
    let Some((old_actor, old_op, old_hash, result)) = prior else {
        return Ok(None);
    };
    if old_actor != actor || old_op != op || old_hash != hash {
        return Err(AppError {
            code: "OPERATION_CONFLICT",
            message: "Operation ID was used for different content or actor".into(),
        });
    }
    let mut result: Value = serde_json::from_str(&result).map_err(AppError::internal)?;
    result["replayed"] = json!(true);
    Ok(Some(result))
}

fn record(
    tx: &Transaction<'_>,
    raw: &Value,
    operation_id: &str,
    actor: &str,
    op: &str,
    result: &Value,
) -> Result<(), AppError> {
    let hash = canonical_hash(raw)?;
    tx.execute(
        "INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,?2,?3,?4,?5)",
        params![operation_id, actor, op, hash, result.to_string()],
    ).map_err(AppError::internal)?;
    Ok(())
}

impl Store {
    pub fn set_vector_state(&self, raw: &Value) -> Result<Value, AppError> {
        let action = raw
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Vector action is required"))?;
        let operation_id = raw
            .get("operation_id")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("operation_id is required"))?;
        let actor = raw
            .get("actor")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("actor is required"))?;
        positive(operation_id)?;
        positive(actor)?;
        if let Some(result) = replay(self, raw, operation_id, actor, "set_vector_state")? {
            return Ok(result);
        }
        if action == "recover_interrupted" {
            if actor != "system" || raw.as_object().is_none_or(|fields| fields.len() != 3) {
                return Err(invalid("Only system may recover vector state"));
            }
            let tx = self.graph.transaction().map_err(AppError::internal)?;
            let recovered = tx
                .execute(
                    "UPDATE vector_meta SET status='failed' WHERE status='pending'",
                    [],
                )
                .map_err(AppError::internal)?;
            let result = json!({"recovered":recovered,"replayed":false});
            record(&tx, raw, operation_id, actor, "set_vector_state", &result)?;
            tx.commit().map_err(AppError::internal)?;
            return Ok(result);
        }
        if action != "set" || raw.as_object().is_none_or(|fields| fields.len() != 6) {
            return Err(invalid("Invalid vector state action"));
        }
        let entity_id = raw
            .get("entity_id")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("entity_id is required"))?;
        let content_version = raw
            .get("content_version")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("content_version is required"))?;
        let state = raw
            .get("state")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("state is required"))?;
        if !["pending", "failed"].contains(&state) {
            return Err(invalid("Invalid vector state"));
        }
        let tx = self.graph.transaction().map_err(AppError::internal)?;
        let (_, entity_version) = active_entity(&tx, entity_id)?;
        let current: Option<(u64, String)> = tx
            .query_row(
                "SELECT content_version,status FROM vector_meta WHERE entity_id=?1",
                [entity_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(AppError::internal)?;
        let (current_version, old_status) = current.unwrap_or((entity_version, "unindexed".into()));
        if current_version != content_version {
            return Err(conflict("Stale vector content version"));
        }
        let allowed = (state == "pending"
            && ["unindexed", "failed"].contains(&old_status.as_str()))
            || (state == "failed" && old_status == "pending");
        if !allowed {
            return Err(invalid("Invalid vector state transition"));
        }
        tx.execute(
            "INSERT INTO vector_meta(entity_id,model,dimension,content_version,status) VALUES(?1,NULL,NULL,?2,?3)
             ON CONFLICT(entity_id) DO UPDATE SET status=excluded.status",
            params![entity_id, content_version, state],
        ).map_err(AppError::internal)?;
        let result = json!({"entity_id":entity_id,"content_version":content_version,"index_status":state,"replayed":false});
        record(&tx, raw, operation_id, actor, "set_vector_state", &result)?;
        tx.commit().map_err(AppError::internal)?;
        Ok(result)
    }

    pub fn put_vector(&self, raw: &Value) -> Result<Value, AppError> {
        let input: PutVector =
            serde_json::from_value(raw.clone()).map_err(|error| invalid(error.to_string()))?;
        for value in [
            &input.operation_id,
            &input.actor,
            &input.entity_id,
            &input.model,
        ] {
            positive(value)?;
        }
        if input.actor != "system"
            || input.dimension == 0
            || input.dimension != input.vector.len()
            || input.dimension > 8192
        {
            return Err(invalid("Invalid vector payload"));
        }
        let vector = unit_vector(&input.vector)?;
        if let Some(result) = replay(self, raw, &input.operation_id, &input.actor, "put_vector")? {
            return Ok(result);
        }
        let tx = self.graph.transaction().map_err(AppError::internal)?;
        let (kg_id, _) = active_entity(&tx, &input.entity_id)?;
        let state: Option<(u64, String)> = tx
            .query_row(
                "SELECT content_version,status FROM vector_meta WHERE entity_id=?1",
                [&input.entity_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(AppError::internal)?;
        if state != Some((input.content_version, "pending".into())) {
            return Err(conflict("Vector is stale or not pending"));
        }
        let other: Option<(String, usize)> = tx.query_row(
            "SELECT model,dimension FROM vector_meta WHERE entity_id<>?1 AND status='ready' LIMIT 1",
            [&input.entity_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(AppError::internal)?;
        if other
            .is_some_and(|(model, dimension)| model != input.model || dimension != input.dimension)
        {
            return Err(invalid(
                "Vector model or dimension differs from existing index",
            ));
        }
        self.graph
            .insert_vector(kg_id, vector)
            .map_err(AppError::internal)?;
        tx.execute(
            "UPDATE vector_meta SET model=?1,dimension=?2,status='ready' WHERE entity_id=?3",
            params![input.model, input.dimension, input.entity_id],
        )
        .map_err(AppError::internal)?;
        let result = json!({"entity_id":input.entity_id,"content_version":input.content_version,
            "index_status":"ready","model":input.model,"dimension":input.dimension,"replayed":false});
        record(
            &tx,
            raw,
            &input.operation_id,
            &input.actor,
            "put_vector",
            &result,
        )?;
        tx.commit().map_err(AppError::internal)?;
        Ok(result)
    }

    pub fn search_vector(&self, raw: &Value) -> Result<Value, AppError> {
        let model = raw
            .get("model")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("model is required"))?;
        let dimension = raw
            .get("dimension")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("dimension is required"))? as usize;
        let query = raw
            .get("vector")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("vector is required"))?;
        let limit = raw.get("limit").and_then(Value::as_u64).unwrap_or(10) as usize;
        let offset = raw.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        if model.trim().is_empty()
            || dimension == 0
            || dimension != query.len()
            || dimension > 8192
            || !(1..=50).contains(&limit)
            || offset > 100_000
        {
            return Err(invalid("Invalid vector search input"));
        }
        let raw_vector: Vec<f64> = query
            .iter()
            .map(|item| item.as_f64().unwrap_or(f64::NAN))
            .collect();
        let vector = unit_vector(&raw_vector)?;
        let conn = self.graph.connection();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM kg_vectors", [], |row| row.get(0))
            .map_err(AppError::internal)?;
        let ranked = self
            .graph
            .search_vectors(vector, count as usize)
            .map_err(AppError::internal)?;
        let mut visible = Vec::new();
        for hit in ranked {
            let row: Option<String> = conn
                .query_row(
                    "SELECT i.entity_id FROM entity_ids i JOIN entity_meta m USING(entity_id)
                 JOIN vector_meta v USING(entity_id) WHERE i.kg_id=?1 AND v.status='ready'
                 AND v.model=?2 AND v.dimension=?3
                 AND json_extract(m.metadata_json,'$.archived_at') IS NULL
                 AND json_extract(m.metadata_json,'$.merged_into') IS NULL",
                    params![hit.entity_id, model, dimension],
                    |row| row.get(0),
                )
                .optional()
                .map_err(AppError::internal)?;
            if let Some(entity_id) = row {
                visible.push(json!({"entity_id":entity_id,"score":hit.similarity}));
            }
        }
        let total = visible.len();
        let items: Vec<Value> = visible.into_iter().skip(offset).take(limit).collect();
        let mut result = json!({"items":items,"total":total});
        if offset + items.len() < total {
            result["next_offset"] = json!(offset + items.len());
        }
        Ok(result)
    }
}
