use contact_graph::{protocol::parse_and_dispatch, store::Store};
use serde_json::{json, Value};

fn request(store: &Store, op: &str, payload: Value) -> Value {
    parse_and_dispatch(
        &serde_json::to_vec(&json!({"version":1,"request_id":"test","op":op,"payload":payload}))
            .unwrap(),
        store,
    )
}
fn proof(path: &str, value: Value) -> Value {
    json!({"field_path":path,"value":value,"source_type":"manual", "collected_at":"2026-09-26T00:00:00.000Z","locator_status":"not_applicable"})
}
fn create(store: &Store, op: &str, label: &str, name: &str) -> String {
    let result = request(
        store,
        "save_contact",
        json!({"operation_id":op,"actor":"tester","label":label,
        "set_properties":{"name":name},"evidence":[proof("properties.name",json!(name))]}),
    );
    assert_eq!(result["ok"], true, "{result}");
    result["result"]["entity_id"].as_str().unwrap().into()
}
fn works_for(store: &Store, op: &str, person: &str, org: &str, role: &str) -> String {
    let value = json!({"relation_type":"worksFor","source_id":person,"target_id":org});
    let result = request(
        store,
        "save_relation",
        json!({"operation_id":op,"actor":"tester","source_id":person,
        "target_id":org,"relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole","roleName":role}},
        "metadata":{},"evidence":[proof("$relation",value),proof("properties.role.roleName",json!(role))]}),
    );
    assert_eq!(result["ok"], true, "{result}");
    result["result"]["relation_id"].as_str().unwrap().into()
}

#[test]
fn archive_and_explicit_restore_hide_and_reveal_an_identity() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = create(&store, "person", "Person", "陈晓");
    let org = create(&store, "org", "Organization", "甲公司");
    works_for(&store, "job", &person, &org, "工程师");
    let loaded = request(&store, "get_contact", json!({"entity_id":person}));
    assert!(loaded["result"]["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["field_path"] == "$relation"));
    let archived = request(
        &store,
        "archive_contact",
        json!({"operation_id":"archive","actor":"tester",
        "entity_id":person,"expected_version":1}),
    );
    assert_eq!(archived["ok"], true, "{archived}");
    assert_eq!(
        request(&store, "get_contact", json!({"entity_id":person}))["result"],
        Value::Null
    );
    assert_eq!(
        request(&store, "list_relations", json!({"entity_id":org}))["result"],
        json!([])
    );
    let restored = request(
        &store,
        "restore_contact",
        json!({"operation_id":"restore","actor":"tester",
        "entity_id":person,"expected_version":2}),
    );
    assert_eq!(restored["ok"], true, "{restored}");
    assert_eq!(
        request(&store, "list_relations", json!({"entity_id":org}))["result"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn archive_relation_filters_history_without_deleting_it() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = create(&store, "person", "Person", "陈晓");
    let org = create(&store, "org", "Organization", "甲公司");
    let relation = works_for(&store, "job", &person, &org, "工程师");
    let response = request(
        &store,
        "archive_relation",
        json!({"operation_id":"archive-r","actor":"tester",
        "relation_id":relation,"expected_version":1}),
    );
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(
        request(&store, "list_relations", json!({"entity_id":person}))["result"],
        json!([])
    );
    let count: i64 = store
        .graph
        .connection()
        .query_row("SELECT COUNT(*) FROM kg_relations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn merge_redirects_source_mapping_and_preserves_two_employment_episodes() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let source = create(&store, "person-a", "Person", "陈晓");
    let target = create(&store, "person-b", "Person", "陈小");
    let org = create(&store, "org", "Organization", "甲公司");
    let first = works_for(&store, "job-a", &source, &org, "工程师");
    let second = works_for(&store, "job-b", &target, &org, "经理");
    store
        .graph
        .connection()
        .execute(
            "INSERT INTO source_mapping(source_key,entity_id) VALUES('legacy:7',?1)",
            [&source],
        )
        .unwrap();
    let merged = request(
        &store,
        "merge_contacts",
        json!({"operation_id":"merge","actor":"tester",
        "source_id":source,"target_id":target,"expected_source_version":1,"expected_target_version":1}),
    );
    assert_eq!(merged["ok"], true, "{merged}");
    let replay = request(
        &store,
        "merge_contacts",
        json!({"operation_id":"merge","actor":"tester",
        "source_id":source,"target_id":target,"expected_source_version":1,"expected_target_version":1}),
    );
    assert_eq!(replay["result"]["replayed"], true);
    assert_eq!(
        request(&store, "get_contact", json!({"entity_id":source}))["result"],
        Value::Null
    );
    let relations = request(&store, "list_relations", json!({"entity_id":target}));
    let ids: Vec<&str> = relations["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["relation_id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&first.as_str()) && ids.contains(&second.as_str()));
    let mapping: String = store
        .graph
        .connection()
        .query_row(
            "SELECT entity_id FROM source_mapping WHERE source_key='legacy:7'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(mapping, target);
}

#[test]
fn merge_drops_new_self_relations_and_keeps_symmetric_edges_canonical() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let source = create(&store, "person-a", "Person", "甲");
    let target = create(&store, "person-b", "Person", "乙");
    let third = create(&store, "person-c", "Person", "丙");
    let (a, b) = if source < target {
        (&source, &target)
    } else {
        (&target, &source)
    };
    let spouse = request(
        &store,
        "save_relation",
        json!({"operation_id":"spouse","actor":"tester",
        "source_id":a,"target_id":b,"relation_type":"spouse","properties":{},"metadata":{},
        "evidence":[proof("$relation",json!({"relation_type":"spouse","source_id":a,"target_id":b}))]}),
    );
    assert_eq!(spouse["ok"], true, "{spouse}");
    let (a, b) = if source < third {
        (&source, &third)
    } else {
        (&third, &source)
    };
    let colleague = request(
        &store,
        "save_relation",
        json!({"operation_id":"colleague","actor":"tester",
        "source_id":a,"target_id":b,"relation_type":"colleague","properties":{},"metadata":{},
        "evidence":[proof("$relation",json!({"relation_type":"colleague","source_id":a,"target_id":b}))]}),
    );
    assert_eq!(colleague["ok"], true, "{colleague}");
    let merged = request(
        &store,
        "merge_contacts",
        json!({"operation_id":"merge","actor":"tester",
        "source_id":source,"target_id":target,"expected_source_version":1,"expected_target_version":1}),
    );
    assert_eq!(merged["ok"], true, "{merged}");
    let relations = request(&store, "list_relations", json!({"entity_id":target}));
    let values = relations["result"].as_array().unwrap();
    assert_eq!(values.len(), 1, "{relations}");
    assert_eq!(values[0]["relation_type"], "colleague");
    assert_eq!(values[0]["metadata"]["version"], 2);
    assert!(
        values[0]["source_id"].as_str().unwrap() < values[0]["target_id"].as_str().unwrap(),
        "{relations}"
    );
    let existence = json!({"relation_type":"colleague","source_id":values[0]["source_id"],"target_id":values[0]["target_id"]});
    let evidence_count:i64 = store.graph.connection().query_row(
        "SELECT COUNT(*) FROM evidence WHERE subject_kind='relation' AND subject_id=?1 AND field_path='$relation' AND value_json=?2",
        rusqlite::params![values[0]["relation_id"].as_str(),existence.to_string()],|row|row.get(0)).unwrap();
    assert!(
        evidence_count > 0,
        "redirected relation needs proof matching its new endpoints"
    );
}

#[test]
fn merge_applies_an_explicit_source_field_choice_with_its_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let source = create(&store, "person-a", "Person", "甲");
    let target = create(&store, "person-b", "Person", "乙");
    let edited = request(
        &store,
        "save_contact",
        json!({"operation_id":"source-phone","actor":"tester",
        "entity_id":source,"label":"Person","expected_version":1,
        "set_properties":{"telephone":["13800000000"],"jobTitle":"经理"},
        "evidence":[proof("properties.telephone",json!("13800000000")),proof("properties.jobTitle",json!("经理"))]}),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    let merged = request(
        &store,
        "merge_contacts",
        json!({"operation_id":"merge-phone","actor":"tester",
        "source_id":source,"target_id":target,"expected_source_version":2,"expected_target_version":1,
        "field_choices":{"properties.telephone":"source","properties.jobTitle":"source"}}),
    );
    assert_eq!(merged["ok"], true, "{merged}");
    let loaded = request(&store, "get_contact", json!({"entity_id":target}));
    assert_eq!(
        loaded["result"]["entity"]["properties"]["telephone"],
        json!(["13800000000"])
    );
    assert_eq!(
        loaded["result"]["entity"]["properties"]["jobTitle"],
        json!("经理")
    );
    assert!(
        loaded["result"]["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["field_path"] == "properties.telephone"
                && item["value"] == "13800000000")
    );
}

#[test]
fn merge_database_failure_restores_both_contacts_and_operation_absence() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let source = create(&store, "person-a", "Person", "甲");
    let target = create(&store, "person-b", "Person", "乙");
    store
        .graph
        .connection()
        .execute(
            "INSERT INTO source_mapping(source_key,entity_id) VALUES('legacy:1',?1)",
            [&source],
        )
        .unwrap();
    store.graph.connection().execute_batch("CREATE TRIGGER fail_redirect BEFORE UPDATE ON source_mapping BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    let failed = request(
        &store,
        "merge_contacts",
        json!({"operation_id":"failed-merge","actor":"tester",
        "source_id":source,"target_id":target,"expected_source_version":1,"expected_target_version":1}),
    );
    assert_eq!(failed["ok"], false, "{failed}");
    assert_eq!(
        request(&store, "get_contact", json!({"entity_id":source}))["result"]["version"],
        1
    );
    assert_eq!(
        request(&store, "get_contact", json!({"entity_id":target}))["result"]["version"],
        1
    );
    let result_count: i64 = store
        .graph
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM operation_results WHERE operation_id='failed-merge'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(result_count, 0);
}

#[test]
fn merge_deduplicates_colleague_edges_and_keeps_both_proofs() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let source = create(&store, "person-a", "Person", "甲");
    let target = create(&store, "person-b", "Person", "乙");
    let third = create(&store, "person-c", "Person", "丙");
    for (op, left) in [("colleague-a", &source), ("colleague-b", &target)] {
        let (a, b) = if left < &third {
            (left, &third)
        } else {
            (&third, left)
        };
        let mut existence = proof(
            "$relation",
            json!({"relation_type":"colleague","source_id":a,"target_id":b}),
        );
        if op == "colleague-a" {
            existence["source_type"] = json!("file");
            existence["locator_status"] = json!("located");
            existence["file_name"] = json!("conference.pdf");
            existence["file_sha256"] = json!("a".repeat(64));
            existence["quote"] = json!("甲与丙共同参与项目");
        }
        let saved = request(
            &store,
            "save_relation",
            json!({"operation_id":op,"actor":"tester",
            "source_id":a,"target_id":b,"relation_type":"colleague","properties":{},"metadata":{},
            "evidence":[existence]}),
        );
        assert_eq!(saved["ok"], true, "{saved}");
    }
    let merged = request(
        &store,
        "merge_contacts",
        json!({"operation_id":"merge","actor":"tester",
        "source_id":source,"target_id":target,"expected_source_version":1,"expected_target_version":1}),
    );
    assert_eq!(merged["ok"], true, "{merged}");
    let listed = request(&store, "list_relations", json!({"entity_id":target}));
    let relations = listed["result"].as_array().unwrap();
    assert_eq!(relations.len(), 1, "{listed}");
    assert_eq!(relations[0]["metadata"]["version"], 2);
    let relation_id = relations[0]["relation_id"].as_str().unwrap();
    let count: i64 = store
        .graph
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM evidence WHERE subject_kind='relation' AND subject_id=?1",
            [relation_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        count >= 2,
        "both relation proofs should remain on the active edge"
    );
    let file_count:i64 = store.graph.connection().query_row(
        "SELECT COUNT(*) FROM evidence WHERE subject_kind='relation' AND subject_id=?1 AND json_extract(record_json,'$.source_type')='file'",
        [relation_id],|row|row.get(0)).unwrap();
    assert_eq!(
        file_count, 1,
        "file provenance from the retired edge must be retained"
    );
}
