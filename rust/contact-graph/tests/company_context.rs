use contact_graph::{protocol::parse_and_dispatch, store::Store};
use serde_json::{json, Value};

fn request(store: &Store, op: &str, payload: Value) -> Value {
    parse_and_dispatch(
        &serde_json::to_vec(&json!({"version":1,"request_id":"company-test","op":op,"payload":payload})).unwrap(),
        store,
    )
}

fn evidence(path: &str, value: Value) -> Value {
    json!({"field_path":path,"value":value,"source_type":"manual",
        "collected_at":"2026-10-01T00:00:00.000Z","locator_status":"not_applicable"})
}

fn entity(store: &Store, label: &str, name: &str, operation: &str) -> String {
    let result = request(store, "save_contact", json!({"operation_id":operation,"actor":"tester","label":label,
        "set_properties":{"name":name},"evidence":[evidence("properties.name",json!(name))]}));
    assert_eq!(result["ok"], true, "{result}");
    result["result"]["entity_id"].as_str().unwrap().to_owned()
}

#[test]
fn empty_filter_cannot_scan_the_library() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let result = request(&store, "company_organizations", json!({
        "entity_ids":[],"credit_codes":[],"normalized_names":[],"offset":0,"limit":50
    }));
    assert_eq!(result["error"]["code"], "VALIDATION_ERROR", "{result}");
}

#[test]
fn explicit_missing_ids_are_an_empty_page() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let result = request(&store, "company_organizations", json!({
        "entity_ids":["o_missing"],"credit_codes":[],"normalized_names":[],"offset":0,"limit":50
    }));
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
    let ids = [page1["result"]["items"][0]["entity_id"].as_str().unwrap(),
        page2["result"]["items"][0]["entity_id"].as_str().unwrap()];
    assert!(ids.contains(&first.as_str()) && ids.contains(&second.as_str()));
    assert_eq!(page2["result"]["next_offset"], Value::Null);
}
