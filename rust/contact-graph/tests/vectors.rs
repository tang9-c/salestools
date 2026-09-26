use contact_graph::store::Store;
use serde_json::{json, Value};

fn proof(path: &str, value: Value) -> Value {
    json!({"field_path":path,"value":value,"source_type":"manual",
        "collected_at":"2026-09-26T00:00:00.000Z","locator_status":"not_applicable"})
}

fn person(store: &Store, name: &str, op: &str) -> String {
    store
        .save_contact(
            &json!({"operation_id":op,"actor":"reviewer","label":"Person",
        "set_properties":{"name":name},"evidence":[proof("properties.name",json!(name))]}),
        )
        .unwrap()["entity_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn stale_embedding_cannot_survive_a_contact_edit_and_retry_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let id = person(&store, "陈晓", "create");
    let loaded = store.get_contact(&json!({"entity_id":id})).unwrap();
    assert_eq!(loaded["index_content_version"], 1);
    assert_eq!(loaded["index_status"], "unindexed");
    let pending = json!({"action":"set","operation_id":"pending-1","actor":"system",
        "entity_id":id,"content_version":1,"state":"pending"});
    assert_eq!(
        store.set_vector_state(&pending).unwrap()["index_status"],
        "pending"
    );
    assert_eq!(store.set_vector_state(&pending).unwrap()["replayed"], true);
    let first = json!({"operation_id":"vector-1","actor":"system","entity_id":id,
        "content_version":1,"model":"embed-a","dimension":3,"vector":[1.0,0.0,0.0]});
    assert_eq!(store.put_vector(&first).unwrap()["index_status"], "ready");
    assert_eq!(store.put_vector(&first).unwrap()["replayed"], true);
    let search = json!({"model":"embed-a","dimension":3,"vector":[1.0,0.0,0.0],"limit":10});
    assert_eq!(store.search_vector(&search).unwrap()["total"], 1);
    assert_eq!(
        store
            .search_vector(&json!({"model":"embed-a","dimension":3,
        "vector":[0.0,0.0,0.0]}))
            .unwrap_err()
            .code,
        "VALIDATION_ERROR"
    );

    store
        .save_contact(
            &json!({"operation_id":"edit","actor":"reviewer","label":"Person",
        "entity_id":id,"expected_version":1,"set_properties":{"description":"研发经理"},
        "evidence":[proof("properties.description",json!("研发经理"))]}),
        )
        .unwrap();
    let loaded = store.get_contact(&json!({"entity_id":id})).unwrap();
    assert_eq!(loaded["index_content_version"], 2);
    assert_eq!(loaded["index_status"], "unindexed");
    assert_eq!(store.search_vector(&search).unwrap()["total"], 0);
    assert_eq!(
        store
            .put_vector(
                &json!({"operation_id":"stale","actor":"system","entity_id":id,
        "content_version":1,"model":"embed-a","dimension":3,"vector":[1.0,0.0,0.0]})
            )
            .unwrap_err()
            .code,
        "VERSION_CONFLICT"
    );
    let retry = json!({"action":"set","operation_id":"pending-2","actor":"system",
        "entity_id":id,"content_version":2,"state":"pending"});
    store.set_vector_state(&retry).unwrap();
    store
        .set_vector_state(
            &json!({"action":"set","operation_id":"failure-2","actor":"system",
        "entity_id":id,"content_version":2,"state":"failed"}),
        )
        .unwrap();
    let manual_retry = json!({"action":"set","operation_id":"retry-2","actor":"reviewer",
        "entity_id":id,"content_version":2,"state":"pending"});
    store.set_vector_state(&manual_retry).unwrap();
    assert_eq!(
        store.set_vector_state(&manual_retry).unwrap()["replayed"],
        true
    );
    assert_eq!(
        store
            .put_vector(
                &json!({"operation_id":"vector-2","actor":"system","entity_id":id,
        "content_version":2,"model":"embed-a","dimension":3,"vector":[0.0,1.0,0.0]})
            )
            .unwrap()["index_status"],
        "ready"
    );
}

#[test]
fn model_mismatch_is_rejected_and_restart_marks_pending_as_failed() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let a = person(&store, "甲", "a");
    let b = person(&store, "乙", "b");
    for (id, op) in [(&a, "pa"), (&b, "pb")] {
        store
            .set_vector_state(&json!({"action":"set","operation_id":op,"actor":"system",
            "entity_id":id,"content_version":1,"state":"pending"}))
            .unwrap();
    }
    store
        .put_vector(&json!({"operation_id":"va","actor":"system","entity_id":a,
        "content_version":1,"model":"embed-a","dimension":2,"vector":[1.0,0.0]}))
        .unwrap();
    assert_eq!(
        store
            .put_vector(&json!({"operation_id":"vb","actor":"system","entity_id":b,
        "content_version":1,"model":"embed-b","dimension":2,"vector":[0.0,1.0]}))
            .unwrap_err()
            .code,
        "VALIDATION_ERROR"
    );
    let recovery = json!({"action":"recover_interrupted","operation_id":"boot-1","actor":"system"});
    assert_eq!(store.set_vector_state(&recovery).unwrap()["recovered"], 1);
    assert_eq!(store.set_vector_state(&recovery).unwrap()["replayed"], true);
    assert_eq!(
        store.get_contact(&json!({"entity_id":b})).unwrap()["index_status"],
        "failed"
    );
    assert_eq!(
        store
            .search_vector(&json!({"model":"embed-b","dimension":2,
        "vector":[1.0,0.0]}))
            .unwrap()["total"],
        0
    );
}
