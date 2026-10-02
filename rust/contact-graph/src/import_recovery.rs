use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::store::{canonical_hash, AppError, Store};

impl Store {
    /// Files live only in the Node process. After a restart queued/processing jobs
    /// cannot be resumed from their old temporary paths; previews are retained.
    pub fn recover_import_jobs(&self, raw: &Value) -> Result<Value, AppError> {
        let operation_id = raw
            .get("operation_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::validation("operation_id is required"))?;
        if raw.as_object().is_none_or(|fields| fields.len() != 2)
            || raw.get("actor").and_then(Value::as_str) != Some("system")
        {
            return Err(AppError::validation("Only system may recover import jobs"));
        }
        let hash = canonical_hash(raw)?;
        let prior: Option<(String, String, String, String)> = self.graph.connection().query_row(
            "SELECT actor,op,request_hash,result_json FROM operation_results WHERE operation_id=?1",
            [operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(AppError::internal)?;
        if let Some((actor, op, old_hash, result)) = prior {
            if actor != "system" || op != "recover_import_jobs" || old_hash != hash {
                return Err(AppError {
                    code: "OPERATION_CONFLICT",
                    message: "Operation ID was used for different content or actor".into(),
                });
            }
            let mut result: Value = serde_json::from_str(&result).map_err(AppError::internal)?;
            result["replayed"] = json!(true);
            return Ok(result);
        }
        let tx = self.graph.transaction().map_err(AppError::internal)?;
        let recovered = tx.execute(
            "UPDATE import_jobs SET status='failed',version=version+1,
             data_json=json_set(data_json,'$.warnings',json_insert(COALESCE(json_extract(data_json,'$.warnings'),'[]'),'$[#]','IMPORT_INTERRUPTED'))
             WHERE status IN ('queued','processing')",
            [],
        ).map_err(AppError::internal)?;
        let result = json!({"recovered":recovered,"replayed":false});
        tx.execute(
            "INSERT INTO operation_results(operation_id,actor,op,request_hash,result_json) VALUES(?1,'system','recover_import_jobs',?2,?3)",
            params![operation_id, hash, result.to_string()],
        ).map_err(AppError::internal)?;
        tx.commit().map_err(AppError::internal)?;
        Ok(result)
    }
}
