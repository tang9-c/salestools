use contact_graph::{protocol::parse_and_dispatch, store::Store};
use rusqlite::params;
use serde_json::{json, Value};

fn call(s: &Store, op: &str, payload: Value) -> Value {
    parse_and_dispatch(
        &serde_json::to_vec(
            &json!({"version":1,"request_id":"claim-test","op":op,"payload":payload}),
        )
        .unwrap(),
        s,
    )
}
fn proof(path: &str, value: Value) -> Value {
    json!({"field_path":path,"value":value,"source_type":"manual","locator_status":"not_applicable","collected_at":"2026-09-26T00:00:00Z"})
}
fn entity(s: &Store, label: &str, name: &str) -> String {
    s.save_contact(&json!({"operation_id":name,"actor":"tester","label":label,"set_properties":{"name":name},"evidence":[proof("properties.name",json!(name))]})).unwrap()["entity_id"].as_str().unwrap().into()
}
fn claim(s: &Store, id: &str, subject: &str, path: &str, value: Value) {
    let kind = if path.starts_with("properties.") || path.starts_with("extensions.") {
        "field"
    } else {
        "relation"
    };
    let job = s.put_import_job(&json!({"operation_id":format!("job-{id}"),"actor":"tester","file_id":id,"status":"queued","data":{}})).unwrap();
    s.graph.connection().execute("INSERT INTO contact_claims(claim_id,subject_id,kind,field_path,relation_type,value_json,source_json,status,reason,import_id,candidate_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'{\"quote\":\"weak source\"}','unverified','missing_evidence',?7,'synthetic','now','now')",params![id,subject,kind,if kind=="field" {Some(path)} else {None},if kind=="relation" {Some(path)} else {None},value.to_string(),job["import_id"].as_str()]).unwrap();
}
fn review(id: &str, action: &str, version: u64) -> Value {
    json!({"claim_id":id,"action":action,"operation_id":format!("review-{id}"),"actor":"tester","expected_entity_version":version,"confirmation_note":"Checked with subject"})
}
fn status(s: &Store, id: &str) -> String {
    s.graph
        .connection()
        .query_row(
            "SELECT status FROM contact_claims WHERE claim_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}
fn audit_count(s: &Store) -> i64 {
    s.graph
        .connection()
        .query_row(
            "SELECT count(*) FROM audit_log WHERE op='review_contact_claim'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}
fn detail(s: &Store, id: &str) -> Value {
    call(s, "get_contact", json!({"entity_id":id}))["result"].clone()
}

#[test]
fn confirmation_appends_dedupes_and_replays_with_manual_evidence() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    claim(&s, "skill", &person, "properties.skills", json!("Rust"));
    let input = review("skill", "confirm", 1);
    let out = call(&s, "review_contact_claim", input.clone());
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(out["result"]["version"], 2);
    assert_eq!(status(&s, "skill"), "confirmed");
    let doc = detail(&s, &person);
    assert_eq!(doc["entity"]["properties"]["skills"], json!(["Rust"]));
    let ev = doc["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["field_path"] == "properties.skills")
        .unwrap();
    assert_eq!(ev["source_type"], "manual");
    assert_eq!(ev["quote"], "Checked with subject");
    assert_eq!(ev["confirmed_by"], "tester");
    assert!(ev.get("file_name").is_none());
    assert_eq!(
        call(&s, "review_contact_claim", input.clone())["result"]["replayed"],
        true
    );
    assert_eq!(audit_count(&s), 1);
    let mut different = input;
    different["confirmation_note"] = json!("different");
    assert_eq!(
        call(&s, "review_contact_claim", different)["error"]["code"],
        "OPERATION_CONFLICT"
    );
    claim(
        &s,
        "skill2",
        &person,
        "properties.skills",
        json!(["Rust", "SQL"]),
    );
    assert_eq!(
        call(&s, "review_contact_claim", review("skill2", "confirm", 2))["ok"],
        true
    );
    assert_eq!(
        detail(&s, &person)["entity"]["properties"]["skills"],
        json!(["Rust", "SQL"])
    );
}

#[test]
fn invalid_confirmations_leave_claim_facts_and_audit_untouched() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    let other = entity(&s, "Person", "Synthetic Other");
    claim(&s, "skill", &person, "properties.skills", json!("Rust"));
    claim(
        &s,
        "work",
        &person,
        "worksFor",
        json!({"properties":{"role":{"@type":"OrganizationRole","roleName":"Engineer","startDate":"2020"}}}),
    );
    for (id, change, code) in [
        (
            "skill",
            json!({"confirmation_note":null}),
            "VALIDATION_ERROR",
        ),
        (
            "skill",
            json!({"confirmation_note":"   "}),
            "VALIDATION_ERROR",
        ),
        (
            "skill",
            json!({"confirmation_note":"x".repeat(501)}),
            "VALIDATION_ERROR",
        ),
        ("skill", json!({"corrected_value":7}), "VALIDATION_ERROR"),
        (
            "skill",
            json!({"expected_entity_version":5}),
            "VERSION_CONFLICT",
        ),
        ("work", json!({}), "VALIDATION_ERROR"),
        ("work", json!({"target_id":other}), "VALIDATION_ERROR"),
    ] {
        let mut input = review(id, "confirm", 1);
        for (k, v) in change.as_object().unwrap() {
            input[k] = v.clone();
        }
        let result = call(&s, "review_contact_claim", input);
        assert_eq!(result["error"]["code"], code, "{result}");
        assert_eq!(status(&s, id), "unverified");
        assert_eq!(audit_count(&s), 0);
        assert_eq!(
            detail(&s, &person)["entity"]["properties"]["skills"],
            json!([])
        );
        assert_eq!(
            call(&s, "list_relations", json!({"entity_id":person}))["result"],
            json!([])
        );
    }
}

#[test]
fn works_for_promotes_each_role_property_and_keeps_episodes_independent() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    let org = entity(&s, "Organization", "Synthetic Org");
    for (i, year) in [(1, "2020"), (2, "2024")] {
        let id = format!("work{i}");
        claim(
            &s,
            &id,
            &person,
            "worksFor",
            json!({"properties":{"role":{"@type":"OrganizationRole","roleName":"Engineer","startDate":year}}}),
        );
        let mut input = review(&id, "confirm", i);
        input["target_id"] = json!(org);
        let out = call(&s, "review_contact_claim", input);
        assert_eq!(out["ok"], true, "{out}");
    }
    let relations = call(&s, "list_relations", json!({"entity_id":person}))["result"].clone();
    assert_eq!(relations.as_array().unwrap().len(), 2);
    let count:i64=s.graph.connection().query_row("SELECT count(*) FROM evidence WHERE subject_kind='relation' AND json_extract(record_json,'$.source_type')='manual'",[],|r|r.get(0)).unwrap();
    assert_eq!(count, 6);
}

#[test]
fn reject_changes_version_and_search_but_not_facts_or_index() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    claim(&s, "skill", &person, "properties.skills", json!("Needle"));
    claim(&s, "next", &person, "properties.skills", json!("Other"));
    let before = detail(&s, &person);
    assert_eq!(
        call(
            &s,
            "search_keyword",
            json!({"query":"Needle","include_unverified":true})
        )["result"]["total"],
        1
    );
    let mut input = review("skill", "reject", 1);
    input.as_object_mut().unwrap().remove("confirmation_note");
    let out = call(&s, "review_contact_claim", input.clone());
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(out["result"]["version"], 2);
    assert_eq!(status(&s, "skill"), "rejected");
    assert_eq!(
        call(&s, "review_contact_claim", input)["result"]["replayed"],
        true
    );
    assert_eq!(
        call(&s, "review_contact_claim", review("next", "reject", 1))["error"]["code"],
        "VERSION_CONFLICT"
    );
    assert_eq!(
        call(&s, "review_contact_claim", review("next", "confirm", 1))["error"]["code"],
        "VERSION_CONFLICT"
    );
    let after = detail(&s, &person);
    assert_eq!(
        before["entity"]["properties"],
        after["entity"]["properties"]
    );
    assert_eq!(before["evidence"], after["evidence"]);
    assert_eq!(
        before["index_content_version"],
        after["index_content_version"]
    );
    assert_eq!(
        call(
            &s,
            "search_keyword",
            json!({"query":"Needle","include_unverified":true})
        )["result"]["total"],
        0
    );
}

#[test]
fn archived_subject_and_invalid_relation_shape_cannot_be_confirmed() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    let org = entity(&s, "Organization", "Synthetic Org");
    claim(
        &s,
        "work",
        &person,
        "worksFor",
        json!({"properties":{"bogus":"x"}}),
    );
    let mut input = review("work", "confirm", 1);
    input["target_id"] = json!(org);
    assert_eq!(
        call(&s, "review_contact_claim", input)["error"]["code"],
        "VALIDATION_ERROR"
    );
    assert_eq!(
        call(
            &s,
            "archive_contact",
            json!({"entity_id":person,"operation_id":"archive","actor":"tester","expected_version":1})
        )["ok"],
        true
    );
    for action in ["confirm", "reject"] {
        assert_eq!(
            call(&s, "review_contact_claim", review("work", action, 2))["error"]["code"],
            "VALIDATION_ERROR"
        );
    }
    assert_eq!(status(&s, "work"), "unverified");
    assert_eq!(audit_count(&s), 0);
}

#[test]
fn failure_after_promotion_rolls_back_every_write() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    claim(&s, "skill", &person, "properties.skills", json!("Rust"));
    s.graph.connection().execute_batch("CREATE TRIGGER fail_review BEFORE INSERT ON operation_results WHEN NEW.op='review_contact_claim' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    let before = detail(&s, &person);
    let out = call(&s, "review_contact_claim", review("skill", "confirm", 1));
    assert_eq!(out["error"]["code"], "INTERNAL_ERROR");
    assert_eq!(status(&s, "skill"), "unverified");
    assert_eq!(audit_count(&s), 0);
    assert_eq!(detail(&s, &person), before);
}

#[test]
fn explicit_corrections_obey_scalar_nested_extension_and_relation_validation() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    let org = entity(&s, "Organization", "Synthetic Org");
    for (i, path, original, corrected) in [
        (
            1,
            "properties.jobTitle",
            json!("Unverified"),
            json!("Confirmed"),
        ),
        (
            2,
            "properties.hasOccupation",
            json!({"bad":"shape"}),
            json!({"@type":"Occupation","name":"Engineer"}),
        ),
        (
            3,
            "extensions.hobbies",
            json!("Unverified"),
            json!(["Hiking"]),
        ),
        (
            4,
            "worksFor",
            json!({"properties":{"bad":"shape"}}),
            json!({"properties":{"role":{"@type":"OrganizationRole"}}}),
        ),
    ] {
        let id = format!("correct{i}");
        claim(&s, &id, &person, path, original);
        let mut input = review(&id, "confirm", i);
        input["corrected_value"] = corrected;
        if path == "worksFor" {
            input["target_id"] = json!(org);
        }
        let out = call(&s, "review_contact_claim", input);
        assert_eq!(out["ok"], true, "{out}");
    }
    let doc = detail(&s, &person);
    assert_eq!(doc["entity"]["properties"]["jobTitle"], "Confirmed");
    assert_eq!(
        doc["entity"]["properties"]["hasOccupation"],
        json!([{"@type":"Occupation","name":"Engineer"}])
    );
    assert_eq!(doc["entity"]["extensions"]["hobbies"], json!(["Hiking"]));
    assert_eq!(
        doc["relations"][0]["properties"]["role"],
        json!({"@type":"OrganizationRole"})
    );
    assert_eq!(audit_count(&s), 4);
    claim(&s, "bad-path", &person, "properties.unknown", json!("bad"));
    assert_eq!(
        call(&s, "review_contact_claim", review("bad-path", "confirm", 5))["error"]["code"],
        "VALIDATION_ERROR"
    );
    claim(&s, "null", &person, "properties.jobTitle", json!("bad"));
    let mut input = review("null", "confirm", 5);
    input["corrected_value"] = Value::Null;
    assert_eq!(
        call(&s, "review_contact_claim", input)["error"]["code"],
        "VALIDATION_ERROR"
    );
    assert_eq!(audit_count(&s), 4);
    assert_eq!(status(&s, "bad-path"), "unverified");
    assert_eq!(status(&s, "null"), "unverified");
}

fn ready_vector(s: &Store, person: &str) -> Value {
    let version = detail(s, person)["index_content_version"].clone();
    s.set_vector_state(
        &json!({"operation_id":"pending", "actor":"system", "action":"set",
        "entity_id":person,"content_version":version,"state":"pending"}),
    )
    .unwrap();
    s.put_vector(
        &json!({"operation_id":"vector", "actor":"system", "entity_id":person,
        "content_version":version,"model":"synthetic","dimension":2,"vector":[1.0,0.0]}),
    )
    .unwrap();
    version
}
fn vector_total(s: &Store) -> Value {
    s.search_vector(&json!({"model":"synthetic","dimension":2,"vector":[1.0,0.0]}))
        .unwrap()["total"]
        .clone()
}

#[test]
fn duplicate_skill_and_nonindexed_birth_date_preserve_ready_vector() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    s.save_contact(&json!({"operation_id":"skill","actor":"tester","label":"Person","entity_id":person,"expected_version":1,
        "set_properties":{"skills":["Rust"]},"evidence":[proof("properties.skills",json!("Rust"))]})).unwrap();
    let content_version = ready_vector(&s, &person);
    for (id, path, value, version) in [
        ("duplicate", "properties.skills", json!("Rust"), 2),
        ("birth", "properties.birthDate", json!("1990-01-01"), 3),
    ] {
        claim(&s, id, &person, path, value.clone());
        let out = call(&s, "review_contact_claim", review(id, "confirm", version));
        assert_eq!(out["ok"], true, "{out}");
        assert!(out["result"].get("indexed_entity_id").is_none());
        let doc = detail(&s, &person);
        assert_eq!(doc["index_status"], "ready");
        assert_eq!(doc["index_content_version"], content_version);
        assert_eq!(vector_total(&s), 1);
        assert_eq!(status(&s, id), "confirmed");
        assert_eq!(doc["version"], version + 1);
        assert!(doc["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|ev| ev["field_path"] == path
                && ev["value"] == value
                && ev["quote"] == "Checked with subject"));
    }
    assert_eq!(audit_count(&s), 2);
}

#[test]
fn changes_to_index_fields_or_privacy_inputs_invalidate_ready_vector() {
    for (path, value) in [
        ("properties.name", json!("New Name")),
        ("properties.description", json!("New Description")),
        ("properties.jobTitle", json!("Engineer")),
        ("properties.skills", json!("Rust")),
        (
            "properties.hasOccupation",
            json!({"@type":"Occupation","name":"Engineer","description":"Builds systems"}),
        ),
        (
            "properties.hasCredential",
            json!({"@type":"EducationalOccupationalCredential","name":"Synthetic Credential","credentialCategory":"Diploma"}),
        ),
        ("properties.email", json!("synthetic@example.test")),
        ("properties.telephone", json!("+15550000000")),
        ("properties.address", json!("Synthetic Address")),
        (
            "properties.contactPoint",
            json!({"@type":"ContactPoint","contactType":"work","url":"https://example.test"}),
        ),
        (
            "extensions.instantMessaging",
            json!({"platform":"synthetic","accountId":"synthetic-account"}),
        ),
    ] {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path().join("g.db")).unwrap();
        let person = entity(&s, "Person", "Synthetic Person");
        let before = ready_vector(&s, &person);
        claim(&s, "change", &person, path, value);
        let input = review("change", "confirm", 1);
        let out = call(&s, "review_contact_claim", input.clone());
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["result"]["indexed_entity_id"], person);
        let doc = detail(&s, &person);
        assert_eq!(doc["index_status"], "unindexed");
        assert!(doc["index_content_version"].as_u64().unwrap() > before.as_u64().unwrap());
        assert_eq!(vector_total(&s), 0);
        let replay = call(&s, "review_contact_claim", input);
        assert_eq!(replay["result"]["replayed"], true);
        assert_eq!(replay["result"]["indexed_entity_id"], person);
        assert_eq!(
            detail(&s, &person)["index_content_version"],
            doc["index_content_version"]
        );
    }
}

#[test]
fn repeated_privacy_value_after_another_scrub_input_invalidates_ready_vector() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    s.save_contact(&json!({"operation_id":"private-inputs","actor":"tester","label":"Person","entity_id":person,"expected_version":1,
        "set_properties":{"description":"SecXret","address":"Secret"},
        "set_extensions":{"instantMessaging":[{"platform":"synthetic","accountId":"X"}]},
        "evidence":[proof("properties.description",json!("SecXret")),proof("properties.address",json!("Secret")),proof("extensions.instantMessaging",json!({"platform":"synthetic","accountId":"X"}))]})).unwrap();
    let before = ready_vector(&s, &person);
    claim(
        &s,
        "private-duplicate",
        &person,
        "extensions.instantMessaging",
        json!({"platform":"synthetic","accountId":"Secret"}),
    );
    let input = review("private-duplicate", "confirm", 2);
    let out = call(&s, "review_contact_claim", input.clone());
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(out["result"]["indexed_entity_id"], person);
    let doc = detail(&s, &person);
    assert_eq!(doc["index_status"], "unindexed");
    assert!(doc["index_content_version"].as_u64().unwrap() > before.as_u64().unwrap());
    assert_eq!(vector_total(&s), 0);
    let replay = call(&s, "review_contact_claim", input);
    assert_eq!(replay["result"]["replayed"], true);
    assert_eq!(replay["result"]["indexed_entity_id"], person);
    assert_eq!(
        detail(&s, &person)["index_content_version"],
        doc["index_content_version"]
    );
}
