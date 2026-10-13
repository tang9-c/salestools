use contact_graph::{protocol::parse_and_dispatch, store::Store};
use serde_json::{json, Value};

fn request(store: &Store, op: &str, payload: Value) -> Value {
    let line = serde_json::to_vec(&json!({
        "version": 1, "request_id": "test-request", "op": op, "payload": payload,
    }))
    .unwrap();
    parse_and_dispatch(&line, store)
}

fn manual(field_path: &str, value: Value) -> Value {
    json!({
        "field_path": field_path,
        "value": value,
        "source_type": "manual",
        "collected_at": "2026-09-26T00:00:00.000Z",
        "locator_status": "not_applicable"
    })
}

fn zoho(field_path: &str, value: Value, module: &str) -> Value {
    json!({"field_path":field_path,"value":value,"source_type":"zoho",
        "source_connection_id":"connection-a","source_module":module,"source_record_id":"record-a",
        "collected_at":"2026-10-13T00:00:00Z","locator_status":"not_applicable"})
}

#[test]
fn zoho_entity_and_relation_evidence_round_trips_without_a_fake_url() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let person = request(
        &store,
        "save_contact",
        json!({"operation_id":"crm-person","actor":"system","label":"Person",
        "set_properties":{"name":"CRM Person"},"evidence":[zoho("properties.name",json!("CRM Person"),"Contacts")]}),
    );
    assert_eq!(person["ok"], true, "{person}");
    let org = request(
        &store,
        "save_contact",
        json!({"operation_id":"crm-org","actor":"system","label":"Organization",
        "set_properties":{"name":"CRM Company"},"evidence":[zoho("properties.name",json!("CRM Company"),"Accounts")]}),
    );
    assert_eq!(org["ok"], true, "{org}");
    let p = person["result"]["entity_id"].as_str().unwrap();
    let o = org["result"]["entity_id"].as_str().unwrap();
    let relation = request(
        &store,
        "save_relation",
        json!({"operation_id":"crm-role","actor":"system",
        "source_id":p,"target_id":o,"relation_type":"worksFor",
        "properties":{"role":{"@type":"OrganizationRole","roleName":"经理"}},"metadata":{},
        "evidence":[zoho("$relation",json!({"relation_type":"worksFor","source_id":p,"target_id":o}),"Contacts"),
            zoho("properties.role.roleName",json!("经理"),"Contacts")]}),
    );
    assert_eq!(relation["ok"], true, "{relation}");
    let detail = request(&store, "get_contact", json!({"entity_id":p}));
    assert_eq!(detail["ok"], true, "{detail}");
    for evidence in detail["result"]["evidence"].as_array().unwrap() {
        assert_eq!(evidence["source_type"], "zoho");
        assert_eq!(evidence["source_connection_id"], "connection-a");
        assert!(evidence.get("source_url").is_none());
    }
    assert_eq!(
        detail["result"]["relations"][0]["metadata"]["employment_status"],
        "unknown"
    );
}

#[test]
fn zoho_evidence_rejects_missing_location_unknown_modules_and_extra_source_data() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let mut invalid = Vec::new();
    for key in ["source_connection_id", "source_module", "source_record_id"] {
        for value in [Value::Null, json!(" ")] {
            let mut proof = zoho("properties.name", json!("CRM Person"), "Contacts");
            proof[key] = value;
            invalid.push(proof);
        }
    }
    for (key, value) in [
        ("source_module", json!("Leads")),
        ("source_type", json!("crm")),
        ("source_url", json!("zoho://Contacts/record-a")),
        ("email", json!("private@example.test")),
    ] {
        let mut proof = zoho("properties.name", json!("CRM Person"), "Contacts");
        proof[key] = value;
        invalid.push(proof);
    }
    for (index, evidence) in invalid.into_iter().enumerate() {
        let result = request(
            &store,
            "save_contact",
            json!({"operation_id":format!("invalid-crm-{index}"),"actor":"system",
            "label":"Person","set_properties":{"name":"CRM Person"},"evidence":[evidence]}),
        );
        assert_eq!(result["error"]["code"], "VALIDATION_ERROR", "{result}");
    }
}

fn person_create(operation_id: &str) -> Value {
    json!({
        "operation_id": operation_id,
        "actor": "user-a",
        "label": "Person",
        "set_properties": {"name": "陈晓", "email": ["chen@example.com", "chen.work@example.com"]},
        "evidence": [
            manual("properties.name", json!("陈晓")),
            manual("properties.email", json!("chen@example.com")),
            manual("properties.email", json!("chen.work@example.com"))
        ]
    })
}

#[test]
fn unnamed_person_keeps_real_name_absent_and_can_be_named_later() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let created = request(
        &store,
        "save_contact",
        json!({
            "operation_id":"anonymous-create","actor":"reviewer","label":"Person",
            "set_properties":{"skills":["Python"]},
            "evidence":[manual("properties.skills",json!("Python"))]
        }),
    );
    assert_eq!(created["ok"], true, "{created}");
    let id = created["result"]["entity_id"].as_str().unwrap();
    let first = request(&store, "get_contact", json!({"entity_id":id}));
    assert_eq!(first["result"]["entity"]["properties"]["name"], Value::Null);
    let rejected = request(
        &store,
        "save_contact",
        json!({
            "operation_id":"name-without-proof","actor":"reviewer","entity_id":id,
            "label":"Person","expected_version":1,
            "set_properties":{"name":"陈晓"},"evidence":[]
        }),
    );
    assert_eq!(rejected["error"]["code"], "VALIDATION_ERROR");
    let named = request(
        &store,
        "save_contact",
        json!({
            "operation_id":"confirmed-name","actor":"reviewer","entity_id":id,
            "label":"Person","expected_version":1,
            "set_properties":{"name":"陈晓"},
            "evidence":[manual("properties.name",json!("陈晓"))]
        }),
    );
    assert_eq!(named["ok"], true, "{named}");
    assert_eq!(named["result"]["entity_id"], id);
}

#[test]
fn empty_unnamed_person_and_unnamed_organization_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    for (label, operation) in [("Person", "empty-person"), ("Organization", "empty-org")] {
        let result = request(
            &store,
            "save_contact",
            json!({
                "operation_id":operation,"actor":"reviewer","label":label,
                "set_properties":{},"evidence":[]
            }),
        );
        assert_eq!(result["error"]["code"], "VALIDATION_ERROR", "{result}");
    }
}

#[test]
fn save_contact_replays_original_result_before_version_check() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let payload = person_create("create-1");
    let first = request(&store, "save_contact", payload.clone());
    assert_eq!(first["ok"], true, "{first}");
    let replay = request(&store, "save_contact", payload);
    assert_eq!(replay["ok"], true, "{replay}");
    assert_eq!(replay["result"]["entity_id"], first["result"]["entity_id"]);
    assert_eq!(replay["result"]["version"], 1);
    assert_eq!(replay["result"]["replayed"], true);

    let id = first["result"]["entity_id"].as_str().unwrap();
    let contact = request(&store, "get_contact", json!({ "entity_id": id }));
    assert_eq!(
        contact["result"]["entity"]["properties"]["email"],
        json!(["chen@example.com", "chen.work@example.com"])
    );
    assert_eq!(contact["result"]["evidence"].as_array().unwrap().len(), 3);
}

#[test]
fn save_contact_rejects_missing_value_evidence_and_leaves_no_rows() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let mut payload = person_create("create-2");
    payload["evidence"].as_array_mut().unwrap().pop();
    let response = request(&store, "save_contact", payload);
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], "VALIDATION_ERROR");
    let count: i64 = store
        .graph
        .connection()
        .query_row("SELECT count(*) FROM kg_entities", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn save_contact_rejects_changed_payload_or_actor_for_same_operation_id() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    assert_eq!(
        request(&store, "save_contact", person_create("create-3"))["ok"],
        true
    );
    let mut changed = person_create("create-3");
    changed["set_properties"]["name"] = json!("其他姓名");
    assert_eq!(
        request(&store, "save_contact", changed)["error"]["code"],
        "OPERATION_CONFLICT"
    );
    let mut other_actor = person_create("create-3");
    other_actor["actor"] = json!("user-b");
    assert_eq!(
        request(&store, "save_contact", other_actor)["error"]["code"],
        "OPERATION_CONFLICT"
    );
}

#[test]
fn saved_operation_survives_restart_and_edit_checks_expected_version() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("contacts.sqlite");
    let first = {
        let store = Store::open(&path).unwrap();
        request(&store, "save_contact", person_create("create-restart"))
    };
    let store = Store::open(&path).unwrap();
    let replay = request(&store, "save_contact", person_create("create-restart"));
    assert_eq!(replay["result"]["entity_id"], first["result"]["entity_id"]);
    assert_eq!(replay["result"]["replayed"], true);
    let entity_id = first["result"]["entity_id"].as_str().unwrap();
    let edit = json!({
        "operation_id":"edit-1", "actor":"user-b", "entity_id":entity_id,
        "label":"Person", "expected_version":1,
        "set_properties":{"jobTitle":"销售经理"},
        "evidence":[manual("properties.jobTitle", json!("销售经理"))]
    });
    assert_eq!(
        request(&store, "save_contact", edit.clone())["result"]["version"],
        2
    );
    assert_eq!(
        request(&store, "save_contact", edit)["result"]["replayed"],
        true
    );
    let stale = json!({
        "operation_id":"edit-2", "actor":"user-a", "entity_id":entity_id,
        "label":"Person", "expected_version":1,
        "set_properties":{"jobTitle":"总监"},
        "evidence":[manual("properties.jobTitle", json!("总监"))]
    });
    assert_eq!(
        request(&store, "save_contact", stale)["error"]["code"],
        "VERSION_CONFLICT"
    );
}

#[test]
fn unknown_evidence_path_is_rejected_even_if_selected_values_have_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let mut payload = person_create("bad-evidence-path");
    payload["evidence"]
        .as_array_mut()
        .unwrap()
        .push(manual("properties.bio", json!("不是正式字段")));
    assert_eq!(
        request(&store, "save_contact", payload)["error"]["code"],
        "VALIDATION_ERROR"
    );
}

#[test]
fn one_credential_leaf_cannot_prove_a_different_leaf() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let credential = json!({"@type":"EducationalOccupationalCredential","name":"工商管理硕士","educationalLevel":"硕士"});
    let mut level_only = manual("properties.hasCredential", credential.clone());
    level_only["value_path"] = json!("educationalLevel");
    let payload = json!({
        "operation_id":"bad-credential-proof", "actor":"user-a", "label":"Person",
        "set_properties":{"name":"陈晓","hasCredential":[credential]},
        "evidence":[manual("properties.name", json!("陈晓")),level_only]
    });
    assert_eq!(
        request(&store, "save_contact", payload)["error"]["code"],
        "VALIDATION_ERROR"
    );
}

#[test]
fn file_evidence_for_an_entire_credential_requires_a_supporting_quote() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let credential = json!({"@type":"EducationalOccupationalCredential","name":"工商管理硕士","educationalLevel":"硕士"});
    let mut unlocated = manual("properties.hasCredential", credential.clone());
    unlocated["source_type"] = json!("file");
    unlocated["locator_status"] = json!("unavailable");
    unlocated["file_name"] = json!("resume.pdf");
    unlocated["file_sha256"] = json!("a".repeat(64));
    let payload = json!({
        "operation_id":"unsupported-credential", "actor":"user-a", "label":"Person",
        "set_properties":{"name":"陈晓","hasCredential":[credential]},
        "evidence":[manual("properties.name", json!("陈晓")),unlocated]
    });
    assert_eq!(
        request(&store, "save_contact", payload)["error"]["code"],
        "VALIDATION_ERROR"
    );
}

#[test]
fn evidence_value_path_must_name_an_actual_leaf() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let credential = json!({"@type":"EducationalOccupationalCredential","name":"工商管理硕士"});
    let mut proof = manual("properties.hasCredential", credential.clone());
    proof["value_path"] = json!("degree");
    let payload = json!({
        "operation_id":"invalid-leaf", "actor":"user-a", "label":"Person",
        "set_properties":{"name":"陈晓","hasCredential":[credential]},
        "evidence":[manual("properties.name", json!("陈晓")),manual("properties.hasCredential", credential),proof]
    });
    assert_eq!(
        request(&store, "save_contact", payload)["error"]["code"],
        "VALIDATION_ERROR"
    );
}

#[test]
fn import_job_creation_replays_after_restart_without_a_second_file_binding() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("contacts.sqlite");
    let payload = json!({
        "operation_id":"start-import-1", "actor":"user-a", "file_id":"file-1",
        "status":"queued", "data":{"candidates":[],"warnings":[]}
    });
    let first = {
        let store = Store::open(&path).unwrap();
        request(&store, "put_import_job", payload.clone())
    };
    assert_eq!(first["ok"], true, "{first}");
    let store = Store::open(&path).unwrap();
    let replay = request(&store, "put_import_job", payload);
    assert_eq!(replay["result"]["import_id"], first["result"]["import_id"]);
    assert_eq!(replay["result"]["replayed"], true);
    let other_operation = json!({
        "operation_id":"start-import-2", "actor":"user-a", "file_id":"file-1",
        "status":"queued", "data":{"candidates":[],"warnings":[]}
    });
    assert_eq!(
        request(&store, "put_import_job", other_operation)["error"]["code"],
        "FILE_ALREADY_USED"
    );
}

#[test]
fn import_job_rejects_raw_document_material() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let payload = json!({
        "operation_id":"start-import-raw", "actor":"user-a", "file_id":"file-2",
        "status":"ready_for_review", "data":{"candidates":[],"ocr_text":"full resume text"}
    });
    assert_eq!(
        request(&store, "put_import_job", payload)["error"]["code"],
        "VALIDATION_ERROR"
    );
}

#[test]
fn import_job_cannot_leave_committed_state_or_claim_commit_directly() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let started = request(
        &store,
        "put_import_job",
        json!({"operation_id":"job-start","actor":"user-a",
        "file_id":"file-committed","status":"queued","data":{"candidates":[]}}),
    );
    let import_id = started["result"]["import_id"].as_str().unwrap();
    let fake_commit = request(
        &store,
        "put_import_job",
        json!({"operation_id":"job-fake-commit","actor":"user-a",
        "file_id":"file-committed","import_id":import_id,"expected_version":1,
        "status":"committed","data":{"candidates":[]}}),
    );
    assert_eq!(fake_commit["error"]["code"], "VALIDATION_ERROR");
    store
        .graph
        .connection()
        .execute(
            "UPDATE import_jobs SET status='committed' WHERE import_id=?1",
            [import_id],
        )
        .unwrap();
    let reopen = request(
        &store,
        "put_import_job",
        json!({"operation_id":"job-reopen","actor":"user-a",
        "file_id":"file-committed","import_id":import_id,"expected_version":1,
        "status":"ready_for_review","data":{"candidates":[]}}),
    );
    assert_eq!(reopen["error"]["code"], "VALIDATION_ERROR");
}

#[test]
fn saved_contact_has_an_audit_row_with_the_actual_actor() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    let response = request(&store, "save_contact", person_create("audit-1"));
    assert_eq!(response["ok"], true, "{response}");
    let actor: String = store
        .graph
        .connection()
        .query_row(
            "SELECT actor FROM audit_log WHERE operation_id='audit-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(actor, "user-a");
}

#[test]
fn app_table_failure_rolls_back_the_library_entity_and_operation_result() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("contacts.sqlite")).unwrap();
    store.graph.connection().execute_batch(
        "CREATE TRIGGER fail_entity_meta BEFORE INSERT ON entity_meta BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    ).unwrap();
    let response = request(&store, "save_contact", person_create("rollback-1"));
    assert_eq!(response["ok"], false);
    let count: i64 = store
        .graph
        .connection()
        .query_row("SELECT count(*) FROM kg_entities", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    let operation_count: i64 = store
        .graph
        .connection()
        .query_row("SELECT count(*) FROM operation_results", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(operation_count, 0);
}
