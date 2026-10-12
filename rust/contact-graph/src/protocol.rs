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

// Budget the complete envelope, including conflicts (which repeat evidence), IDs,
// metadata and the newline. Counts alone cannot bound UTF-8 response frames.
fn trim_contact_response(response: &mut Value) {
    while serde_json::to_vec(response).is_ok_and(|frame| frame.len() >= MAX_FRAME_BYTES) {
        let result = &mut response["result"];
        let pages = ["evidence", "relations", "unverified_claims"];
        let removable = |minimum: usize| {
            pages
                .iter()
                .filter_map(|key| {
                    let items = result[key].as_array()?;
                    if items.len() <= minimum {
                        return None;
                    }
                    let last = items.last()?;
                    let mut bytes = last.to_string().len();
                    if *key == "evidence" {
                        bytes += result["conflicts"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|item| item["evidence_id"] == last["evidence_id"])
                            .map(|item| item.to_string().len())
                            .sum::<usize>();
                    }
                    Some((*key, bytes))
                })
                .max_by_key(|(_, bytes)| *bytes)
        };
        // Trim claims first, but keep at least one item in every enabled nonempty
        // stream. An irreducible joint page must error, never stall a cursor.
        let claim_count = result["unverified_claims"].as_array().map_or(0, Vec::len);
        let candidate = if claim_count > 1 {
            Some(("unverified_claims", 0))
        } else {
            removable(1)
        };
        let Some((key, _)) = candidate else {
            break;
        };
        let removed = result[key].as_array_mut().unwrap().pop().unwrap();
        if key == "evidence" {
            if let Some(conflicts) = result["conflicts"].as_array_mut() {
                conflicts.retain(|item| item["evidence_id"] != removed["evidence_id"]);
            }
        }
        let count = result[key].as_array().unwrap().len() as u64;
        let page = &mut result["pagination"][key];
        let next = page["offset"].as_u64().unwrap().saturating_add(count);
        page["next_offset"] = if next < page["total"].as_u64().unwrap() {
            json!(next)
        } else {
            Value::Null
        };
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
    let mut response = match request.op.as_str() {
        "health" => json!({
            "version": 1, "request_id": request_id, "ok": true,
            "result": { "nonce": request.payload.get("nonce").cloned().unwrap_or(Value::Null) }
        }),
        "company_organizations" => {
            match crate::company_context::organizations(store, &request.payload) {
                Ok(result) => {
                    json!({"version":1,"request_id":request_id,"ok":true,"result":result})
                }
                Err(err) => error(request_id, err.code, &err.message),
            }
        }
        "company_relations" => match crate::company_context::relations(store, &request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
        "company_recent_records" => {
            match crate::company_context::recent_records(store, &request.payload) {
                Ok(result) => {
                    json!({"version":1,"request_id":request_id,"ok":true,"result":result})
                }
                Err(err) => error(request_id, err.code, &err.message),
            }
        }
        "review_contact_claim" => match store.review_contact_claim(&request.payload) {
            Ok(result) => json!({"version":1,"request_id":request_id,"ok":true,"result":result}),
            Err(err) => error(request_id, err.code, &err.message),
        },
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
        "get_import_start" => match store.get_import_start(&request.payload) {
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
    if request.op == "get_contact" && response["ok"] == true {
        trim_contact_response(&mut response);
    }
    if request.op.starts_with("company_") && response["ok"] == true {
        while serde_json::to_vec(&response).is_ok_and(|frame| frame.len() >= MAX_FRAME_BYTES) {
            let result = &mut response["result"];
            let Some(items) = result["items"].as_array_mut() else {
                break;
            };
            if items.len() <= 1 {
                break;
            }
            items.pop();
            let count = items.len();
            let offset = request.payload["offset"].as_u64().unwrap_or(0) as usize;
            let total = result["total"].as_u64().unwrap_or(0) as usize;
            let next = (offset.saturating_add(count) < total).then_some(offset + count);
            result["next_offset"] = json!(next);
            result["complete"] = json!(next.is_none());
        }
        if request.op == "company_organizations" {
            while serde_json::to_vec(&response).is_ok_and(|frame| frame.len() >= MAX_FRAME_BYTES) {
                let Some(item) = response["result"]["items"]
                    .as_array_mut()
                    .and_then(|items| items.first_mut())
                else {
                    break;
                };
                let Some(evidence) = item["evidence"].as_array_mut() else {
                    break;
                };
                let Some(removed) = evidence.pop() else {
                    break;
                };
                let removed_id = removed["evidence_id"].clone();
                if let Some(conflicts) = item["conflicts"].as_array_mut() {
                    conflicts.retain(|record| record["evidence_id"] != removed_id);
                }
                item["identity_complete"] = json!(false);
            }
        }
    }
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
    fn contact_budget_shrinks_all_streams_and_keeps_offsets_and_conflicts_consistent() {
        let evidence: Vec<Value> = (0..50)
            .map(|id| json!({"evidence_id":id,"quote":"例".repeat(500)}))
            .collect();
        let relations: Vec<Value> = (0..50)
            .map(|id| json!({"relation_id":id,"data":"r".repeat(3000)}))
            .collect();
        let claims: Vec<Value> = (0..50)
            .map(|id| json!({"claim_id":id,"value":"例".repeat(500),"quote":"例".repeat(500)}))
            .collect();
        let mut response = json!({"version":1,"request_id":"request".repeat(1000),"ok":true,
            "result":{"entity":{},"evidence":evidence,"conflicts":evidence,"relations":relations,
                "unverified_claims":claims,"pagination":{
                    "evidence":{"offset":7,"limit":50,"total":100,"next_offset":57},
                    "relations":{"offset":3,"limit":50,"total":100,"next_offset":53},
                    "unverified_claims":{"offset":2,"limit":50,"total":100,"next_offset":52}}}});
        trim_contact_response(&mut response);
        assert!(serde_json::to_vec(&response).unwrap().len() < MAX_FRAME_BYTES);
        for (key, offset) in [("evidence", 7), ("relations", 3), ("unverified_claims", 2)] {
            let len = response["result"][key].as_array().unwrap().len();
            assert!(len > 0);
            assert_eq!(response["result"]["pagination"][key]["total"], 100);
            assert_eq!(
                response["result"]["pagination"][key]["next_offset"],
                offset + len
            );
        }
        assert_eq!(
            response["result"]["evidence"],
            response["result"]["conflicts"]
        );
        assert!(response["result"]["evidence"].as_array().unwrap().len() < 50);
        let mut relation_heavy = response.clone();
        relation_heavy["result"]["relations"] =
            json!((0..50).map(|id|
            json!({"relation_id":id,"properties":{"role":{"roleName":"r".repeat(10_000)}}}))
            .collect::<Vec<_>>());
        trim_contact_response(&mut relation_heavy);
        let relation_count = relation_heavy["result"]["relations"]
            .as_array()
            .unwrap()
            .len();
        assert!(relation_count > 0 && relation_count < 50);
        assert!(serde_json::to_vec(&relation_heavy).unwrap().len() < MAX_FRAME_BYTES);
        assert_eq!(
            relation_heavy["result"]["pagination"]["relations"]["next_offset"],
            3 + relation_count
        );
        assert_eq!(
            response["result"]["unverified_claims"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn contact_budget_preserves_errors_for_an_indivisible_formal_page_or_base() {
        let mut response = json!({"version":1,"request_id":"req","ok":true,"result":{
            "entity":{},"conflicts":[],"evidence":[{"evidence_id":"a","data":"x".repeat(150_000)}],
            "relations":[{"relation_id":"b","data":"x".repeat(140_000)}],"unverified_claims":[],
            "pagination":{"evidence":{"offset":0,"total":1,"next_offset":null},
                "relations":{"offset":0,"total":1,"next_offset":null}}}});
        trim_contact_response(&mut response);
        assert_eq!(
            bounded_response(response.clone(), json!("req"))["error"]["code"],
            "RESPONSE_TOO_LARGE"
        );
        assert_eq!(response["result"]["evidence"].as_array().unwrap().len(), 1);
        assert_eq!(response["result"]["relations"].as_array().unwrap().len(), 1);
        response["result"]["entity"] = json!({"data":"x".repeat(MAX_FRAME_BYTES)});
        trim_contact_response(&mut response);
        assert_eq!(
            bounded_response(response, json!("req"))["error"]["code"],
            "RESPONSE_TOO_LARGE"
        );
    }

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
