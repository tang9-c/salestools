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
    if kind == "alumniOf" {
        for (key, value) in properties.as_object().unwrap() {
            proofs.push(evidence(&format!("properties.{key}"), value.clone()));
        }
    }
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
fn education_details_are_sourced_and_distinct_episodes_share_only_the_school() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let person = entity(&store, "Person", "本人", "education-person");
    let school = entity(&store, "Organization", "学校", "education-school");
    let first = relation(
        &store,
        "education-one",
        &person,
        &school,
        "alumniOf",
        json!({"major":"软件工程","educationLevel":"本科","startDate":"2022","endDate":"2026"}),
        json!({}),
    );
    assert_eq!(first["ok"], true, "{first}");
    let second = relation(
        &store,
        "education-two",
        &person,
        &school,
        "alumniOf",
        json!({"major":"计算机科学","startDate":"2027"}),
        json!({}),
    );
    assert_eq!(second["ok"], true, "{second}");
    assert_ne!(
        first["result"]["relation_id"],
        second["result"]["relation_id"]
    );
    let saved = request(&store, "get_contact", json!({"entity_id":person}));
    assert_eq!(saved["ok"], true, "{saved}");
    let relations = saved["result"]["relations"].as_array().unwrap();
    let first_saved = relations
        .iter()
        .find(|r| r["relation_id"] == first["result"]["relation_id"])
        .unwrap();
    let second_saved = relations
        .iter()
        .find(|r| r["relation_id"] == second["result"]["relation_id"])
        .unwrap();
    assert_eq!(
        first_saved["properties"],
        json!({"major":"软件工程","educationLevel":"本科","startDate":"2022","endDate":"2026"})
    );
    assert_eq!(
        second_saved["properties"],
        json!({"major":"计算机科学","startDate":"2027"})
    );
    let wrong = request(
        &store,
        "save_relation",
        json!({"operation_id":"bad-major","actor":"tester",
        "source_id":person,"target_id":school,"relation_type":"alumniOf","properties":{"major":"软件工程"},"metadata":{},
        "evidence":[evidence("$relation",json!({"source_id":person,"target_id":school,"relation_type":"alumniOf"})),
                    evidence("properties.major",json!("其他专业"))]}),
    );
    assert_eq!(wrong["ok"], false, "{wrong}");
    let reversed = relation(
        &store,
        "education-reversed",
        &person,
        &school,
        "alumniOf",
        json!({"startDate":"2026","endDate":"2022"}),
        json!({}),
    );
    assert_eq!(reversed["ok"], false, "{reversed}");
}

#[test]
fn project_participation_and_client_path_have_typed_endpoints_and_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = entity(&store, "Person", "陈晓", "project-person");
    let project = entity(&store, "Project", "PLM 升级", "project");
    let client = entity(&store, "Organization", "乙公司", "project-client");
    let participation = relation(
        &store,
        "participation",
        &person,
        &project,
        "memberOf",
        json!({"role":{"@type":"OrganizationRole","roleName":"顾问"}}),
        json!({}),
    );
    assert_eq!(participation["ok"], true, "{participation}");
    let customer = relation(
        &store,
        "customer",
        &project,
        &client,
        "clientOrganization",
        json!({}),
        json!({}),
    );
    assert_eq!(customer["ok"], true, "{customer}");
    let legacy_membership = relation(
        &store,
        "legacy-membership",
        &person,
        &client,
        "memberOf",
        json!({}),
        json!({}),
    );
    assert_eq!(legacy_membership["ok"], true, "{legacy_membership}");
    let listed = request(&store, "list_relations", json!({"entity_id":project}));
    assert_eq!(listed["result"].as_array().unwrap().len(), 2, "{listed}");
    assert_eq!(
        relation(
            &store,
            "wrong-person-client",
            &person,
            &client,
            "clientOrganization",
            json!({}),
            json!({})
        )["error"]["code"],
        "VALIDATION_ERROR"
    );
    assert_eq!(
        relation(
            &store,
            "wrong-project-work",
            &person,
            &project,
            "worksFor",
            json!({"role":{"@type":"OrganizationRole"}}),
            json!({})
        )["error"]["code"],
        "VALIDATION_ERROR"
    );
    assert_eq!(
        relation(
            &store,
            "wrong-member-role",
            &person,
            &client,
            "memberOf",
            json!({"role":{"@type":"OrganizationRole","roleName":"顾问"}}),
            json!({})
        )["error"]["code"],
        "VALIDATION_ERROR"
    );
    let missing_role_proof = request(
        &store,
        "save_relation",
        json!({
            "operation_id":"missing-project-role-proof","actor":"tester","source_id":person,
            "target_id":project,"relation_type":"memberOf",
            "properties":{"role":{"@type":"OrganizationRole","roleName":"顾问"}},
            "evidence":[evidence("$relation", json!({"relation_type":"memberOf","source_id":person,"target_id":project}))]
        }),
    );
    assert_eq!(missing_role_proof["error"]["code"], "VALIDATION_ERROR");
    let no_evidence = request(
        &store,
        "save_contact",
        json!({"operation_id":"no-evidence-project",
        "actor":"tester","label":"Project","set_properties":{"description":"实施项目"}}),
    );
    assert_eq!(no_evidence["error"]["code"], "VALIDATION_ERROR");
    let empty = request(
        &store,
        "save_contact",
        json!({"operation_id":"empty-project",
        "actor":"tester","label":"Project","set_properties":{}}),
    );
    assert_eq!(empty["error"]["code"], "VALIDATION_ERROR");
    let described = request(
        &store,
        "save_contact",
        json!({"operation_id":"described-project",
        "actor":"tester","label":"Project","set_properties":{"description":"实施项目"},
        "evidence":[evidence("properties.description", json!("实施项目"))]}),
    );
    assert_eq!(described["ok"], true, "{described}");
    assert!(described["result"]["entity_id"]
        .as_str()
        .unwrap()
        .starts_with("j_"));
    let project_id = described["result"]["entity_id"].as_str().unwrap();
    let fetched = request(&store, "get_contact", json!({"entity_id":project_id}));
    assert_eq!(
        fetched["result"]["entity"]["properties"]["description"], "实施项目",
        "{fetched}"
    );
    let invented = request(
        &store,
        "save_contact",
        json!({"operation_id":"invented-project",
        "actor":"tester","label":"Project","set_properties":{"name":"项目", "jobTitle":"顾问"},
        "evidence":[evidence("properties.name", json!("项目"))]}),
    );
    assert_eq!(invented["error"]["code"], "VALIDATION_ERROR");
    assert_eq!(
        relation(
            &store,
            "missing-client",
            &project,
            "o_missing",
            "clientOrganization",
            json!({}),
            json!({})
        )["error"]["code"],
        "VALIDATION_ERROR"
    );
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
