use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::Store;

pub const MAX_FRAME_BYTES: usize = 256 * 1024;

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

fn bounded_response(response: Value, request_id: Value) -> Value {
    // Include the newline written by main so Node never sees an oversized frame.
    if serde_json::to_vec(&response).is_ok_and(|frame| frame.len() < MAX_FRAME_BYTES) {
        response
    } else {
        error(
            request_id,
            "RESPONSE_TOO_LARGE",
            "Response frame exceeds 256 KiB",
        )
    }
}

pub fn parse_and_dispatch(line: &[u8], store: &Store) -> Value {
    let request: Request = match serde_json::from_slice(line) {
        Ok(request) => request,
        Err(_) => return error(Value::Null, "BAD_REQUEST", "Malformed request frame"),
    };
    let request_id = Value::String(request.request_id.clone());
    if request.version != 1 || request.request_id.trim().is_empty() || !request.payload.is_object()
    {
        return error(request_id, "BAD_REQUEST", "Invalid request envelope");
    }
    let response_id = request_id.clone();
    let response = match request.op.as_str() {
        "health" => json!({
            "version": 1, "request_id": request_id, "ok": true,
            "result": { "nonce": request.payload.get("nonce").cloned().unwrap_or(Value::Null) }
        }),
        "save_contact" => match store.save_contact(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "get_contact" => match store.get_contact(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "put_import_job" => match store.put_import_job(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "get_import_job" => match store.get_import_job(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "save_relation" => match store.save_relation(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "list_relations" => match store.list_relations(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "archive_contact" => match store.archive_contact(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "restore_contact" => match store.restore_contact(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "archive_relation" => match store.archive_relation(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "merge_contacts" => match store.merge_contacts(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "commit_import" => match store.commit_import(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "recover_import_jobs" => match store.recover_import_jobs(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "sync_snapshots" => match store.sync_snapshots(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "get_sync_cursor" => match store.get_sync_cursor() {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "search_keyword" => match crate::search::search_keyword(store, &request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "find_identity_candidates" => {
            match crate::search::find_identity_candidates(store, &request.payload) {
                Ok(result) => {
                    json!({"version":1,"request_id":request_id,"ok":true,"result":result})
                }
                Err(err) => error(request_id, err.code, &err.message),
            }
        }
        "search_vector" => match store.search_vector(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "put_vector" => match store.put_vector(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "set_vector_state" => match store.set_vector_state(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        _ => error(request_id, "UNKNOWN_OPERATION", "Unknown graph operation"),
    };
    bounded_response(response, response_id)
}

pub fn frame_too_large() -> Value {
    error(
        Value::Null,
        "FRAME_TOO_LARGE",
        "Request frame exceeds 256 KiB",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_result_is_a_short_error_with_the_same_request_id() {
        let result = bounded_response(
            json!({"request_id":"req", "result":"x".repeat(MAX_FRAME_BYTES)}),
            json!("req"),
        );
        assert_eq!(result["request_id"], "req");
        assert_eq!(result["error"]["code"], "RESPONSE_TOO_LARGE");
        assert!(serde_json::to_vec(&result).unwrap().len() < MAX_FRAME_BYTES);
    }
}
