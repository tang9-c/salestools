use contact_graph::{protocol::parse_and_dispatch, store::Store};
use serde_json::{json, Value};

fn request(store: &Store, op: &str, payload: Value) -> Value {
    parse_and_dispatch(
        &serde_json::to_vec(&json!({
            "version": 1, "request_id": "test", "op": op, "payload": payload
        }))
        .unwrap(),
        store,
    )
}

fn evidence(field: &str, value: Value) -> Value {
    json!({"field_path":field,"value":value,"source_type":"manual",
        "collected_at":"2026-09-26T00:00:00.000Z","locator_status":"not_applicable"})
}

fn entity(store: &Store, label: &str, name: &str, operation: &str) -> String {
    let result = request(
        store,
        "save_contact",
        json!({
            "operation_id":operation,"actor":"tester","label":label,
            "set_properties":{"name":name},"evidence":[evidence("properties.name", json!(name))]
        }),
    );
    assert_eq!(result["ok"], true, "{result}");
    result["result"]["entity_id"].as_str().unwrap().to_owned()
}

fn relation(
    store: &Store,
    operation: &str,
    source: &str,
    target: &str,
    kind: &str,
    properties: Value,
    metadata: Value,
) -> Value {
    let normalized = if kind == "children" {
        json!({"relation_type":"parent","source_id":target,"target_id":source})
    } else if ["spouse", "colleague"].contains(&kind) && source > target {
        json!({"relation_type":kind,"source_id":target,"target_id":source})
    } else {
        json!({"relation_type":kind,"source_id":source,"target_id":target})
    };
    let mut proofs = vec![evidence("$relation", normalized)];
    if let Some(role) = properties.get("role") {
        if let Some(fields) = role.as_object() {
            for (key, value) in fields {
                if key != "@type" {
                    proofs.push(evidence(&format!("properties.role.{key}"), value.clone()));
                }
            }
        }
    }
    if let Some(status) = metadata.get("employment_status") {
        proofs.push(evidence("metadata.employment_status", status.clone()));
    }
    if let Some(as_of) = metadata.get("status_as_of") {
        proofs.push(evidence("metadata.status_as_of", as_of.clone()));
    }
    request(
        store,
        "save_relation",
        json!({
            "operation_id":operation,"actor":"tester","source_id":source,"target_id":target,
            "relation_type":kind,"properties":properties,"metadata":metadata,"evidence":proofs
        }),
    )
}

#[test]
fn promotions_are_two_edges_and_survive_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.sqlite");
    let (person, org) = {
        let store = Store::open(&path).unwrap();
        let person = entity(&store, "Person", "陈晓", "person");
        let org = entity(&store, "Organization", "甲公司", "org");
        for (op, title, start, end) in [
            ("r1", "工程师", "2020", "2022"),
            ("r2", "经理", "2022", "2024"),
        ] {
            let saved = relation(
                &store,
                op,
                &person,
                &org,
                "worksFor",
                json!({"role":{"@type":"OrganizationRole","roleName":title,"startDate":start,"endDate":end}}),
                json!({"employment_status":"ended"}),
            );
            assert_eq!(saved["ok"], true, "{saved}");
        }
        (person, org)
    };
    let store = Store::open(&path).unwrap();
    let listed = request(&store, "list_relations", json!({"entity_id":person}));
    assert_eq!(listed["ok"], true, "{listed}");
    assert_eq!(listed["result"].as_array().unwrap().len(), 2);
    assert!(listed["result"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["target_id"] == org));
}

#[test]
fn parent_direction_and_symmetric_lookup_are_normalized() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let child = entity(&store, "Person", "子女", "child");
    let parent = entity(&store, "Person", "父母", "parent");
    let spouse = entity(&store, "Person", "配偶", "spouse");
    let saved = relation(
        &store,
        "children",
        &parent,
        &child,
        "children",
        json!({}),
        json!({}),
    );
    assert_eq!(saved["ok"], true, "{saved}");
    let saved = relation(
        &store,
        "spouse-rel",
        &parent,
        &spouse,
        "spouse",
        json!({}),
        json!({}),
    );
    assert_eq!(saved["ok"], true, "{saved}");
    let child_relations = request(&store, "list_relations", json!({"entity_id":child}));
    assert_eq!(child_relations["result"][0]["relation_type"], "parent");
    assert_eq!(child_relations["result"][0]["source_id"], child);
    let spouse_relations = request(&store, "list_relations", json!({"entity_id":spouse}));
    assert_eq!(spouse_relations["result"][0]["relation_type"], "spouse");
}

#[test]
fn invalid_endpoint_and_current_without_as_of_or_with_end_date_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = entity(&store, "Person", "陈晓", "person");
    let other = entity(&store, "Person", "陈工", "other");
    let org = entity(&store, "Organization", "甲公司", "org");
    assert_eq!(
        relation(
            &store,
            "wrong",
            &person,
            &other,
            "worksFor",
            json!({"role":{"@type":"OrganizationRole"}}),
            json!({})
        )["error"]["code"],
        "VALIDATION_ERROR"
    );
    assert_eq!(
        relation(
            &store,
            "current-no-date",
            &person,
            &org,
            "worksFor",
            json!({"role":{"@type":"OrganizationRole"}}),
            json!({"employment_status":"current"})
        )["error"]["code"],
        "VALIDATION_ERROR"
    );
    assert_eq!(
        relation(
            &store,
            "current-ended",
            &person,
            &org,
            "worksFor",
            json!({"role":{"@type":"OrganizationRole","endDate":"2024"}}),
            json!({"employment_status":"current","status_as_of":"2026-09-26"})
        )["error"]["code"],
        "VALIDATION_ERROR"
    );
}

#[test]
fn relation_existence_and_current_status_require_distinct_proofs() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = entity(&store, "Person", "陈晓", "person");
    let org = entity(&store, "Organization", "甲公司", "org");
    let payload = json!({"operation_id":"missing-proof","actor":"tester", "source_id":person,
        "target_id":org,"relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole"}},
        "metadata":{"employment_status":"current","status_as_of":"2026-09-26"},"evidence":[]});
    assert_eq!(
        request(&store, "save_relation", payload)["error"]["code"],
        "VALIDATION_ERROR"
    );
}

#[test]
fn unlocated_file_claim_cannot_confirm_current_employment() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = entity(&store, "Person", "陈晓", "person");
    let org = entity(&store, "Organization", "甲公司", "org");
    let mut status = evidence("metadata.employment_status", json!("current"));
    status["source_type"] = json!("file");
    status["locator_status"] = json!("unavailable");
    status["file_name"] = json!("resume.pdf");
    status["file_sha256"] = json!("a".repeat(64));
    let payload = json!({"operation_id":"unlocated-current","actor":"tester","source_id":person,
        "target_id":org,"relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole"}},
        "metadata":{"employment_status":"current","status_as_of":"2026-09-26"},
        "evidence":[evidence("$relation",json!({"relation_type":"worksFor","source_id":person,"target_id":org})),
            status,evidence("metadata.status_as_of",json!("2026-09-26"))]});
    assert_eq!(
        request(&store, "save_relation", payload)["error"]["code"],
        "VALIDATION_ERROR"
    );
}

#[test]
fn original_children_and_reversed_spouse_proofs_are_normalized_with_the_edge() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let a = entity(&store, "Person", "甲", "a");
    let b = entity(&store, "Person", "乙", "b");
    let children = request(
        &store,
        "save_relation",
        json!({"operation_id":"children-original","actor":"tester",
        "source_id":a,"target_id":b,"relation_type":"children","properties":{},"metadata":{},
        "evidence":[evidence("$relation",json!({"relation_type":"children","source_id":a,"target_id":b}))]}),
    );
    assert_eq!(children["ok"], true, "{children}");
    let (higher, lower) = if a > b { (&a, &b) } else { (&b, &a) };
    let spouse = request(
        &store,
        "save_relation",
        json!({"operation_id":"spouse-original","actor":"tester",
        "source_id":higher,"target_id":lower,"relation_type":"spouse","properties":{},"metadata":{},
        "evidence":[evidence("$relation",json!({"relation_type":"spouse","source_id":higher,"target_id":lower}))]}),
    );
    assert_eq!(spouse["ok"], true, "{spouse}");
}
