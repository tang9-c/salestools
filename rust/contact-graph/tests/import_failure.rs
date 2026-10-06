use contact_graph::store::Store;
use serde_json::json;

#[test]
fn parse_failure_is_durable_and_does_not_remain_processing() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.sqlite");
    let store = Store::open(&path).unwrap();
    let job = store
        .put_import_job(&json!({"operation_id":"start","actor":"alice",
        "file_id":"file","status":"queued","data":{"candidates":[]}}))
        .unwrap();
    store
        .put_import_job(&json!({"operation_id":"processing","actor":"alice",
        "file_id":"file","import_id":job["import_id"],"expected_version":1,
        "status":"processing","data":{"candidates":[]}}))
        .unwrap();
    let data = json!({"candidates":[],"warnings":["IMPORT_FAILED"],"failure":{
        "stage":"parse","code":"CONVERSION_FAILED","message":"文档解析失败",
        "diagnostic":{"exceptions":[{"type":"RuntimeError","frames":[{
            "module":"pdf_parser.py","function":"has_tasks","line":1668}]}],
            "exit_code":null,"signal":"SIGKILL","root_code":"CONVERSION_FAILED"}}});
    store
        .put_import_job(&json!({"operation_id":"failed","actor":"alice",
        "file_id":"file","import_id":job["import_id"],"expected_version":2,
        "status":"failed","data":data}))
        .unwrap();
    drop(store);
    let loaded = Store::open(&path)
        .unwrap()
        .get_import_job(&json!({"import_id":job["import_id"]}))
        .unwrap();
    assert_eq!(loaded["status"], "failed");
    assert_eq!(loaded["version"], 3);
    assert_eq!(loaded["data"], data);
}

#[test]
fn failure_metadata_cannot_bypass_raw_document_storage_guard() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    for failure in [
        json!({"stage":"persist","code":"PRIVATE_DOCUMENT_NAME","message":"任务结果保存失败"}),
        json!({"stage":"parse","code":"CONVERSION_FAILED","message":"private resume"}),
        json!({"stage":"parse","code":"CONVERSION_FAILED","message":"文档解析失败",
            "diagnostic":{"exceptions":[{"type":"RuntimeError","frames":[],"message":"private resume"}]}}),
        json!({"stage":"parse","code":"CONVERSION_FAILED","message":"文档解析失败",
            "diagnostic":{"exceptions":[{"type":"RuntimeError","frames":[{
                "module":"/tmp/private.py","function":"parse","line":1}]}]}}),
    ] {
        let error = store
            .put_import_job(&json!({"operation_id":"unsafe","actor":"alice",
            "file_id":"file","status":"queued","data":{"candidates":[],"failure":failure}}))
            .unwrap_err();
        assert_eq!(error.code, "VALIDATION_ERROR");
    }
}
