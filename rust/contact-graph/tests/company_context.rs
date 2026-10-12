use contact_graph::{protocol::parse_and_dispatch, store::Store};
use serde_json::{json, Value};

fn request(store: &Store, op: &str, payload: Value) -> Value {
    parse_and_dispatch(
        &serde_json::to_vec(
            &json!({"version":1,"request_id":"company-test","op":op,"payload":payload}),
        )
        .unwrap(),
        store,
    )
}

fn evidence(path: &str, value: Value) -> Value {
    json!({"field_path":path,"value":value,"source_type":"manual",
        "collected_at":"2026-10-01T00:00:00.000Z","locator_status":"not_applicable"})
}

fn entity(store: &Store, label: &str, name: &str, operation: &str) -> String {
    let result = request(
        store,
        "save_contact",
        json!({"operation_id":operation,"actor":"tester","label":label,
        "set_properties":{"name":name},"evidence":[evidence("properties.name",json!(name))]}),
    );
    assert_eq!(result["ok"], true, "{result}");
    result["result"]["entity_id"].as_str().unwrap().to_owned()
}

#[test]
fn empty_filter_cannot_scan_the_library() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let result = request(
        &store,
        "company_organizations",
        json!({
            "entity_ids":[],"credit_codes":[],"normalized_names":[],"offset":0,"limit":50
        }),
    );
    assert_eq!(result["error"]["code"], "VALIDATION_ERROR", "{result}");
}

#[test]
fn explicit_missing_ids_are_an_empty_page() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let result = request(
        &store,
        "company_organizations",
        json!({
            "entity_ids":["o_missing"],"credit_codes":[],"normalized_names":[],"offset":0,"limit":50
        }),
    );
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["items"], json!([]));
    assert_eq!(result["result"]["next_offset"], Value::Null);
}

#[test]
fn name_query_selects_only_live_organizations_and_pages_stably() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let person = entity(&store, "Person", "测试 公司", "person");
    let first = entity(&store, "Organization", "测试 公司", "first");
    let second = entity(&store, "Organization", "测试 公司", "second");
    let filter = json!({"entity_ids":[],"credit_codes":[],"normalized_names":["测试公司"],"offset":0,"limit":1});
    let page1 = request(&store, "company_organizations", filter.clone());
    assert_eq!(page1["ok"], true, "{page1}");
    assert_eq!(page1["result"]["items"].as_array().unwrap().len(), 1);
    assert_ne!(page1["result"]["items"][0]["entity_id"], person);
    let mut next = filter;
    next["offset"] = page1["result"]["next_offset"].clone();
    let page2 = request(&store, "company_organizations", next);
    let ids = [
        page1["result"]["items"][0]["entity_id"].as_str().unwrap(),
        page2["result"]["items"][0]["entity_id"].as_str().unwrap(),
    ];
    assert!(ids.contains(&first.as_str()) && ids.contains(&second.as_str()));
    assert_eq!(page2["result"]["next_offset"], Value::Null);
}

#[test]
fn name_keys_follow_edits_and_archive_state() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let id = entity(&store, "Organization", "旧公司", "create");
    let edit = request(
        &store,
        "save_contact",
        json!({"operation_id":"rename","actor":"tester",
        "label":"Organization","entity_id":id,"expected_version":1,
        "set_properties":{"name":"新公司"},"evidence":[evidence("properties.name",json!("新公司"))]}),
    );
    assert_eq!(edit["ok"], true, "{edit}");
    let lookup = |name: &str| {
        request(
            &store,
            "company_organizations",
            json!({
        "entity_ids":[],"credit_codes":[],"normalized_names":[name],"offset":0,"limit":50}),
        )
    };
    assert_eq!(lookup("旧公司")["result"]["items"], json!([]));
    assert_eq!(lookup("新公司")["result"]["items"][0]["entity_id"], id);
    let archive = request(
        &store,
        "archive_contact",
        json!({"operation_id":"archive","actor":"tester",
        "entity_id":id,"expected_version":2}),
    );
    assert_eq!(archive["ok"], true, "{archive}");
    assert_eq!(lookup("新公司")["result"]["items"], json!([]));
}

#[test]
fn direct_work_edge_is_returned_without_unrelated_people() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let org = entity(&store, "Organization", "甲公司", "org");
    let person = entity(&store, "Person", "工程师", "person");
    let other = entity(&store, "Organization", "乙公司", "other");
    let edge = request(
        &store,
        "save_relation",
        json!({"operation_id":"work","actor":"tester",
        "source_id":person,"target_id":org,"relation_type":"worksFor",
        "properties":{"role":{"@type":"OrganizationRole","roleName":"工程师"}},"metadata":{},
        "evidence":[evidence("$relation",json!({"relation_type":"worksFor","source_id":person,"target_id":org})),
            evidence("properties.role.roleName",json!("工程师"))]}),
    );
    assert_eq!(edge["ok"], true, "{edge}");
    let page = request(
        &store,
        "company_relations",
        json!({"organization_ids":[org],"offset":0,"limit":50}),
    );
    assert_eq!(page["ok"], true, "{page}");
    assert_eq!(page["result"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        page["result"]["items"][0]["relation_id"],
        edge["result"]["relation_id"]
    );
    let unrelated = request(
        &store,
        "company_relations",
        json!({"organization_ids":[other],"offset":0,"limit":50}),
    );
    assert_eq!(unrelated["result"]["items"], json!([]));
}

#[test]
fn organization_key_lookup_uses_derived_index() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let detail: String = store.graph.connection().query_row(
        "EXPLAIN QUERY PLAN SELECT entity_id FROM company_organization_keys WHERE kind=?1 AND value=?2 ORDER BY entity_id",
        ["name", "测试公司"], |row| row.get(3),
    ).unwrap();
    assert!(
        detail.contains("company_organization_key_lookup"),
        "{detail}"
    );
}

fn work(store: &Store, op: &str, person: &str, org: &str) -> String {
    let result = request(
        store,
        "save_relation",
        json!({"operation_id":op,"actor":"tester",
        "source_id":person,"target_id":org,"relation_type":"worksFor",
        "properties":{"role":{"@type":"OrganizationRole","roleName":"工程师"}},"metadata":{},
        "evidence":[evidence("$relation",json!({"relation_type":"worksFor","source_id":person,"target_id":org})),
            evidence("properties.role.roleName",json!("工程师"))]}),
    );
    assert_eq!(result["ok"], true, "{result}");
    result["result"]["relation_id"].as_str().unwrap().into()
}

#[test]
fn relation_pages_are_distinct_stable_and_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let org = entity(&store, "Organization", "公司", "org");
    let person = entity(&store, "Person", "甲", "person");
    let first = work(&store, "first", &person, &org);
    let another = entity(&store, "Person", "乙", "another");
    let second = work(&store, "second", &another, &org);
    let page1 = request(
        &store,
        "company_relations",
        json!({"organization_ids":[org,org],"offset":0,"limit":1}),
    );
    assert_eq!(page1["ok"], true, "{page1}");
    assert_eq!(page1["result"]["items"].as_array().unwrap().len(), 1);
    let next = page1["result"]["next_offset"].as_u64().unwrap();
    let page2 = request(
        &store,
        "company_relations",
        json!({"organization_ids":[org],"offset":next,"limit":1}),
    );
    assert_eq!(page2["result"]["next_offset"], Value::Null);
    let ids = [
        page1["result"]["items"][0]["relation_id"].as_str().unwrap(),
        page2["result"]["items"][0]["relation_id"].as_str().unwrap(),
    ];
    assert!(ids.contains(&first.as_str()) && ids.contains(&second.as_str()));
}

#[test]
fn recent_pages_advance_and_include_person_job_title_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let org = entity(&store, "Organization", "公司", "org");
    let person = entity(&store, "Person", "甲", "person");
    work(&store, "work", &person, &org);
    let edit = request(
        &store,
        "save_contact",
        json!({"operation_id":"title","actor":"tester",
        "label":"Person","entity_id":person,"expected_version":1,
        "set_properties":{"jobTitle":"工程师"},"evidence":[evidence("properties.jobTitle",json!("工程师"))]}),
    );
    assert_eq!(edit["ok"], true, "{edit}");
    let base =
        json!({"organization_ids":[org],"since":"2026-09-01T00:00:00Z","limit":1,"offset":0});
    let page1 = request(&store, "company_recent_records", base.clone());
    assert_eq!(page1["ok"], true, "{page1}");
    let next = page1["result"]["next_offset"].as_u64().unwrap();
    let mut second_input = base;
    second_input["offset"] = json!(next);
    let page2 = request(&store, "company_recent_records", second_input);
    assert_eq!(page2["ok"], true, "{page2}");
    assert_ne!(
        page1["result"]["items"][0]["id"],
        page2["result"]["items"][0]["id"]
    );
    let all = request(
        &store,
        "company_recent_records",
        json!({"organization_ids":[org],"since":"2026-09-01T00:00:00Z","limit":20}),
    );
    assert!(
        all["result"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "evidence" && item["label"] == "职业身份依据"),
        "{all}"
    );
}
