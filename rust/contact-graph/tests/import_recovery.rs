use contact_graph::store::Store;
use serde_json::json;

#[test]
fn restart_fails_only_incomplete_jobs_and_replays_by_operation_id() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let first = store
        .put_import_job(&json!({"operation_id":"start-a","actor":"alice",
        "file_id":"file-a","status":"queued","data":{"candidates":[],"warnings":[]}}))
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
        "status":"processing","data":{"candidates":[],"warnings":["OCR_PARTIAL"],"processed_block_ids":["block-1"]}}))
        .unwrap();
    store
        .put_import_job(&json!({"operation_id":"ready-c","actor":"system",
        "file_id":"file-c","import_id":third["import_id"],"expected_version":1,
        "status":"ready_for_review","data":{"candidates":[]}}))
        .unwrap();

    let mut unchanged = Vec::new();
    for status in ["failed", "cancelled", "committed"] {
        let file_id = format!("file-{status}");
        let job = store.put_import_job(&json!({"operation_id":format!("start-{status}"),
            "actor":"alice","file_id":file_id,"status":"queued",
            "data":{"candidates":[],"warnings":["EXISTING_WARNING"]}})).unwrap();
        let connection = rusqlite::Connection::open(directory.path().join("graph.sqlite")).unwrap();
        connection.execute("UPDATE import_jobs SET status=?1 WHERE import_id=?2",
            rusqlite::params![status, job["import_id"].as_str().unwrap()]).unwrap();
        unchanged.push(store.get_import_job(&json!({"import_id":job["import_id"]})).unwrap());
    }
    unchanged.push(store.get_import_job(&json!({"import_id":third["import_id"]})).unwrap());

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
    for (job, version, warnings, blocks) in [
        (&first, 2, json!(["IMPORT_INTERRUPTED"]), json!(null)),
        (&second, 3, json!(["OCR_PARTIAL", "IMPORT_INTERRUPTED"]), json!(["block-1"])),
    ] {
        let recovered = store.get_import_job(&json!({"import_id":job["import_id"]})).unwrap();
        assert_eq!(recovered["version"], version);
        assert_eq!(recovered["data"]["warnings"], warnings);
        assert_eq!(recovered["data"]["candidates"], json!([]));
        assert_eq!(recovered["data"]["processed_block_ids"], blocks);
    }
    for before in unchanged {
        assert_eq!(store.get_import_job(&json!({"import_id":before["import_id"]})).unwrap(), before);
    }
    assert_eq!(
        store
            .recover_import_jobs(&json!({"operation_id":"boot-1","actor":"alice"}))
            .unwrap_err()
            .code,
        "VALIDATION_ERROR"
    );
}
