use contact_graph::store::Store;
use serde_json::json;

#[test]
fn restart_fails_only_incomplete_jobs_and_replays_by_operation_id() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let first = store
        .put_import_job(&json!({"operation_id":"start-a","actor":"alice",
        "file_id":"file-a","status":"queued","data":{"candidates":[]}}))
        .unwrap();
    let second = store
        .put_import_job(&json!({"operation_id":"start-b","actor":"bob",
        "file_id":"file-b","status":"queued","data":{"candidates":[]}}))
        .unwrap();
    let third = store
        .put_import_job(&json!({"operation_id":"start-c","actor":"cora",
        "file_id":"file-c","status":"queued","data":{"candidates":[]}}))
        .unwrap();
    store
        .put_import_job(&json!({"operation_id":"work-b","actor":"system",
        "file_id":"file-b","import_id":second["import_id"],"expected_version":1,
        "status":"processing","data":{"candidates":[]}}))
        .unwrap();
    store
        .put_import_job(&json!({"operation_id":"ready-c","actor":"system",
        "file_id":"file-c","import_id":third["import_id"],"expected_version":1,
        "status":"ready_for_review","data":{"candidates":[]}}))
        .unwrap();

    let request = json!({"operation_id":"boot-1","actor":"system"});
    assert_eq!(store.recover_import_jobs(&request).unwrap()["recovered"], 2);
    assert_eq!(
        store.recover_import_jobs(&request).unwrap()["replayed"],
        true
    );
    assert_eq!(
        store
            .get_import_job(&json!({"import_id":first["import_id"]}))
            .unwrap()["status"],
        "failed"
    );
    assert_eq!(
        store
            .get_import_job(&json!({"import_id":second["import_id"]}))
            .unwrap()["status"],
        "failed"
    );
    assert_eq!(
        store
            .get_import_job(&json!({"import_id":third["import_id"]}))
            .unwrap()["status"],
        "ready_for_review"
    );
    assert_eq!(
        store
            .recover_import_jobs(&json!({"operation_id":"boot-2","actor":"system"}))
            .unwrap()["recovered"],
        0
    );
    assert_eq!(
        store
            .recover_import_jobs(&json!({"operation_id":"boot-1","actor":"alice"}))
            .unwrap_err()
            .code,
        "VALIDATION_ERROR"
    );
}
