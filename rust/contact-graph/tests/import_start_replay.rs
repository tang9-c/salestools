use contact_graph::store::Store;
use serde_json::json;

#[test]
fn durable_start_lookup_survives_restart_and_is_read_only() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("graph.sqlite");
    let input = json!({"operation_id":"start-a","actor":"alice","file_id":"file-a",
        "status":"queued","data":{"candidates":[]}});
    let lookup = json!({"operation_id":"start-a","actor":"alice","file_id":"file-a"});
    let original = {
        let store = Store::open(&database).unwrap();
        let original = store.put_import_job(&input).unwrap();
        store.put_import_job(&json!({"operation_id":"failed-a","actor":"system",
            "file_id":"file-a","import_id":original["import_id"],"expected_version":1,
            "status":"failed","data":{"candidates":[]}})).unwrap();
        original
    };
    let store = Store::open(&database).unwrap();
    let before = store.get_import_job(&json!({"import_id":original["import_id"]})).unwrap();
    let replay = store.get_import_start(&lookup).unwrap();
    assert_eq!(replay["import_id"], original["import_id"]);
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["version"], 1);
    assert_eq!(store.get_import_job(&json!({"import_id":original["import_id"]})).unwrap(), before);
    // The read must not claim the previously unused operation ID.
    let absent = json!({"operation_id":"unused","actor":"alice","file_id":"file-new"});
    assert_eq!(store.get_import_start(&absent).unwrap(), serde_json::Value::Null);
    assert_eq!(store.put_import_job(&json!({"operation_id":"unused","actor":"alice",
        "file_id":"file-new","status":"queued","data":{"candidates":[]}})).unwrap()["replayed"], false);
    for (actor, file) in [("bob", "file-a"), ("alice", "different-file")] {
        assert_eq!(store.get_import_start(&json!({"operation_id":"start-a","actor":actor,"file_id":file}))
            .unwrap_err().code, "OPERATION_CONFLICT");
    }
    assert_eq!(store.get_import_start(&json!({"operation_id":"second-start","actor":"alice","file_id":"file-a"}))
        .unwrap_err().code, "FILE_ALREADY_USED");
    assert_eq!(store.get_import_start(&json!({"operation_id":"second-start","actor":"bob","file_id":"file-a"}))
        .unwrap_err().code, "IMPORT_ACCESS_DENIED");
}
