use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::Store;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub request_id: String,
    pub op: String,
    pub payload: Value,
}

fn error(request_id: Value, code: &str, message: &str) -> Value {
    json!({
        "version": 1, "request_id": request_id, "ok": false,
        "error": { "code": code, "message": message }
    })
}

pub fn parse_and_dispatch(line: &[u8], _store: &Store) -> Value {
    let request: Request = match serde_json::from_slice(line) {
        Ok(request) => request,
        Err(_) => return error(Value::Null, "BAD_REQUEST", "Malformed request frame"),
    };
    let request_id = Value::String(request.request_id.clone());
    if request.version != 1 || request.request_id.trim().is_empty() || !request.payload.is_object() {
        return error(request_id, "BAD_REQUEST", "Invalid request envelope");
    }
    match request.op.as_str() {
        "health" => json!({
            "version": 1, "request_id": request_id, "ok": true,
            "result": { "nonce": request.payload.get("nonce").cloned().unwrap_or(Value::Null) }
        }),
        "get_contact" | "list_relations" | "save_contact" | "save_relation"
        | "merge_contacts" | "archive_contact" | "restore_contact" | "archive_relation"
        | "commit_import" | "sync_snapshots" | "get_sync_cursor" | "put_import_job"
        | "get_import_job" | "search_keyword" | "search_vector" | "put_vector"
        | "set_vector_state" => error(request_id, "UNAVAILABLE", "Operation is not implemented yet"),
        _ => error(request_id, "UNKNOWN_OPERATION", "Unknown graph operation"),
    }
}

pub fn frame_too_large() -> Value {
    error(Value::Null, "FRAME_TOO_LARGE", "Request frame exceeds 256 KiB")
}
