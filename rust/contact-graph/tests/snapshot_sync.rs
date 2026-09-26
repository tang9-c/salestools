use contact_graph::{protocol::parse_and_dispatch, store::Store};
use serde_json::{json, Value};

fn request(store: &Store, op: &str, payload: Value) -> Value {
    parse_and_dispatch(
        &serde_json::to_vec(&json!({
            "version": 1, "request_id": "sync-test", "op": op, "payload": payload
        }))
        .unwrap(),
        store,
    )
}

fn snapshot(id: u64, title: &str, cache_key: &str) -> Value {
    json!({
        "snapshot_id": id,
        "cache_key": cache_key,
        "normalized_query": "甲公司",
        "normalized_region_hint": null,
        "collected_at": "2026-09-26T00:00:00.000Z",
        "stored_at": "2026-09-26T00:00:00.000Z",
        "companies": [{
            "company_name": "甲公司",
            "contacts": [{
                "name": "张明",
                "title": title,
                "source_url": format!("https://example.com/{id}"),
                "published_at": "2026-09-20T00:00:00.000Z"
            }]
        }]
    })
}

fn initialize(store: &Store) {
    let result = request(
        store,
        "sync_snapshots",
        json!({
            "operation_id": "snapshot-sync:initialize",
            "actor": "system",
            "initialize": true,
            "snapshots": []
        }),
    );
    assert_eq!(result["ok"], true, "{result}");
}

fn sync(store: &Store, first: u64, last: u64, snapshots: Vec<Value>) -> Value {
    request(
        store,
        "sync_snapshots",
        json!({
            "operation_id": format!("snapshot-sync:{first}-{last}"),
            "actor": "system",
            "snapshots": snapshots
        }),
    )
}

fn count(store: &Store, table: &str) -> i64 {
    store
        .graph
        .connection()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn snapshot_sync_reuses_identity_within_query_but_keeps_changed_title_separate() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    assert_eq!(
        request(&store, "get_sync_cursor", json!({}))["result"],
        json!({"initialized": false, "last_snapshot_id": 0})
    );
    initialize(&store);
    let result = sync(
        &store,
        1,
        3,
        vec![
            snapshot(1, "总监", "query-a"),
            snapshot(2, "总监", "query-a"),
            snapshot(3, "经理", "query-a"),
        ],
    );
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["last_snapshot_id"], 3);
    assert_eq!(count(&store, "entity_ids"), 3);
    assert_eq!(count(&store, "relation_ids"), 2);
    let observations: i64 = store.graph.connection().query_row(
        "SELECT COUNT(*) FROM evidence WHERE subject_kind='entity' AND field_path='properties.jobTitle'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(observations, 3);
    let raw_sources: i64 = store.graph.connection().query_row(
        "SELECT COUNT(*) FROM source_mapping WHERE source_key LIKE 'snapshot-observation:%' AND source_json LIKE '%2026-09-20%'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(raw_sources, 3);
    assert_eq!(
        request(&store, "get_sync_cursor", json!({}))["result"],
        json!({"initialized": true, "last_snapshot_id": 3})
    );
    let distinct_entities: i64 = store.graph.connection().query_row(
        "SELECT COUNT(DISTINCT entity_id) FROM source_mapping WHERE source_key LIKE 'snapshot-observation:%'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(distinct_entities, 2);
    let first_two: Vec<String> = {
        let mut query = store.graph.connection().prepare(
            "SELECT entity_id FROM source_mapping WHERE source_key IN ('snapshot-observation:1:0:0','snapshot-observation:2:0:0') ORDER BY source_key"
        ).unwrap();
        query
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(first_two.len(), 2);
    assert_eq!(first_two[0], first_two[1]);
}

#[test]
fn snapshot_sync_replay_survives_restart_without_duplicate_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.sqlite");
    {
        let store = Store::open(&path).unwrap();
        initialize(&store);
        assert_eq!(
            sync(&store, 1, 1, vec![snapshot(1, "总监", "query-a")])["ok"],
            true
        );
    }
    let store = Store::open(&path).unwrap();
    let replay = sync(&store, 1, 1, vec![snapshot(1, "总监", "query-a")]);
    assert_eq!(replay["ok"], true, "{replay}");
    assert_eq!(replay["result"]["replayed"], true);
    assert_eq!(count(&store, "entity_ids"), 2);
    assert_eq!(count(&store, "relation_ids"), 1);
    assert_eq!(count(&store, "source_mapping"), 3);
    assert_eq!(
        sync(&store, 1, 1, vec![snapshot(1, "经理", "query-a")])["error"]["code"],
        "OPERATION_CONFLICT"
    );
}

#[test]
fn snapshot_sync_retains_archived_source_and_does_not_globally_dedupe_names() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    initialize(&store);
    assert_eq!(
        sync(&store, 1, 1, vec![snapshot(1, "总监", "query-a")])["ok"],
        true
    );
    let source_id: String = store
        .graph
        .connection()
        .query_row(
            "SELECT entity_id FROM source_mapping WHERE source_key='snapshot-observation:1:0:0'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let archived = request(
        &store,
        "archive_contact",
        json!({
            "operation_id": "archive-legacy", "actor": "user-a",
            "entity_id": source_id, "expected_version": 1
        }),
    );
    assert_eq!(archived["ok"], true, "{archived}");
    assert_eq!(
        sync(&store, 2, 2, vec![snapshot(2, "总监", "query-a")])["ok"],
        true
    );
    assert_eq!(count(&store, "entity_ids"), 2);
    assert_eq!(count(&store, "relation_ids"), 1);
    assert_eq!(
        sync(&store, 3, 3, vec![snapshot(3, "总监", "query-b")])["ok"],
        true
    );
    assert_eq!(count(&store, "entity_ids"), 4);
    assert_eq!(
        request(&store, "get_contact", json!({"entity_id":source_id}))["result"],
        Value::Null
    );
}

#[test]
fn archived_snapshot_source_stays_hidden_when_its_title_changes() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    initialize(&store);
    let original = snapshot(1, "总监", "query-a");
    assert_eq!(sync(&store, 1, 1, vec![original.clone()])["ok"], true);
    let person_id: String = store
        .graph
        .connection()
        .query_row(
            "SELECT entity_id FROM source_mapping WHERE source_key='snapshot-observation:1:0:0'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        request(
            &store,
            "archive_contact",
            json!({
                "operation_id":"archive-before-role-change", "actor":"user-a",
                "entity_id":person_id, "expected_version":1
            })
        )["ok"],
        true
    );

    let mut changed = snapshot(2, "经理", "query-a");
    changed["companies"][0]["contacts"][0]["source_url"] =
        original["companies"][0]["contacts"][0]["source_url"].clone();
    let result = sync(&store, 2, 2, vec![changed]);
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(
        count(&store, "entity_ids"),
        2,
        "archived Person must not be recreated"
    );
    assert_eq!(
        count(&store, "relation_ids"),
        1,
        "new title must not revive employment"
    );
    let mapped_id: String = store
        .graph
        .connection()
        .query_row(
            "SELECT entity_id FROM source_mapping WHERE source_key='snapshot-observation:2:0:0'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(mapped_id, person_id);
    let mapped_relation: Option<String> = store
        .graph
        .connection()
        .query_row(
            "SELECT relation_id FROM source_mapping WHERE source_key='snapshot-observation:2:0:0'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        mapped_relation, None,
        "changed title is not attached to the old role"
    );
    let source: String = store
        .graph
        .connection()
        .query_row(
            "SELECT source_json FROM source_mapping WHERE source_key='snapshot-observation:2:0:0'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&source).unwrap()["role_name"],
        "经理"
    );
    assert_eq!(
        request(&store, "get_contact", json!({"entity_id":person_id}))["result"],
        Value::Null
    );

    let mut other_query = snapshot(3, "经理", "query-b");
    other_query["companies"][0]["contacts"][0]["source_url"] =
        original["companies"][0]["contacts"][0]["source_url"].clone();
    assert_eq!(sync(&store, 3, 3, vec![other_query])["ok"], true);
    assert_eq!(
        count(&store, "entity_ids"),
        4,
        "a different query scope remains independent"
    );
}

#[test]
fn active_snapshot_source_preserves_separate_title_observations() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    initialize(&store);
    let original = snapshot(1, "总监", "query-a");
    let mut changed = snapshot(2, "经理", "query-a");
    changed["companies"][0]["contacts"][0]["source_url"] =
        original["companies"][0]["contacts"][0]["source_url"].clone();
    assert_eq!(sync(&store, 1, 2, vec![original, changed])["ok"], true);
    assert_eq!(count(&store, "entity_ids"), 3);
    assert_eq!(count(&store, "relation_ids"), 2);
    let distinct: i64 = store
        .graph
        .connection()
        .query_row(
            "SELECT COUNT(DISTINCT entity_id) FROM source_mapping WHERE source_key IN \
         ('snapshot-observation:1:0:0','snapshot-observation:2:0:0')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(distinct, 2);
}

#[test]
fn snapshot_sync_rolls_back_facts_and_cursor_on_invalid_batch() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    initialize(&store);
    let mut invalid = snapshot(2, "总监", "query-a");
    invalid["companies"][0]["contacts"][0]["name"] = json!("");
    let response = sync(&store, 1, 2, vec![snapshot(1, "总监", "query-a"), invalid]);
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(count(&store, "entity_ids"), 0);
    assert_eq!(count(&store, "evidence"), 0);
    assert_eq!(
        request(&store, "get_sync_cursor", json!({}))["result"],
        json!({"initialized": true, "last_snapshot_id": 0})
    );
}

#[test]
fn snapshot_sync_follows_merged_source_without_creating_another_person() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    initialize(&store);
    assert_eq!(
        sync(
            &store,
            1,
            2,
            vec![
                snapshot(1, "总监", "query-a"),
                snapshot(2, "总监", "query-b"),
            ]
        )["ok"],
        true
    );
    let ids: Vec<String> = {
        let mut query = store.graph.connection().prepare(
            "SELECT entity_id FROM source_mapping WHERE source_key IN ('snapshot-observation:1:0:0','snapshot-observation:2:0:0') ORDER BY source_key"
        ).unwrap();
        query
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let merged = request(
        &store,
        "merge_contacts",
        json!({
            "operation_id":"merge-legacy","actor":"user-a",
            "source_id":ids[0],"target_id":ids[1],
            "expected_source_version":1,"expected_target_version":1
        }),
    );
    assert_eq!(merged["ok"], true, "{merged}");
    let replay = sync(&store, 3, 3, vec![snapshot(3, "总监", "query-a")]);
    assert_eq!(replay["ok"], true, "{replay}");
    let mapped_id: String = store
        .graph
        .connection()
        .query_row(
            "SELECT entity_id FROM source_mapping WHERE source_key='snapshot-observation:3:0:0'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(mapped_id, ids[1]);
    let people: i64 = store
        .graph
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM kg_entities WHERE entity_type='Person'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(people, 2);
}
