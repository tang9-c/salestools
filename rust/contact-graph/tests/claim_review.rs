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

fn zoho_source() -> Value {
    json!({"source_type":"zoho","source_connection_id":"connection-a",
        "source_module":"Contacts","source_record_id":"contact-a"})
}

fn insert_crm_claim(
    s: &Store,
    id: &str,
    subject: &str,
    target: &str,
    source: &Value,
    relation: &str,
) -> rusqlite::Result<usize> {
    s.graph.connection().execute(
        "INSERT INTO contact_claims(claim_id,subject_id,target_id,kind,relation_type,value_json,source_json,status,reason,import_id,candidate_id,created_at,updated_at)
         VALUES(?1,?2,?3,'relation',?4,'{\"reasons\":[\"same_name\"]}',?5,'unverified','possible_duplicate',NULL,'contact-a','2026-10-13T00:00:00Z','2026-10-13T00:00:00Z')",
        params![id,subject,target,relation,source.to_string()],
    )
}

#[test]
fn zoho_duplicate_without_import_is_visible_on_both_sides_and_reviewable() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let a = entity(&s, "Person", "CRM甲");
    let b = entity(&s, "Person", "CRM乙");
    let inserted = insert_crm_claim(
        &s,
        "crm-reject",
        &a,
        &b,
        &zoho_source(),
        "possible_duplicate",
    );
    assert!(
        inserted.is_ok(),
        "CRM duplicate needs no import job: {inserted:?}"
    );
    for id in [&a, &b] {
        let response = call(&s, "get_contact", json!({"entity_id":id}));
        assert_eq!(response["ok"], true, "{response}");
        let claims = response["result"]["unverified_claims"].as_array().unwrap();
        assert_eq!(claims.len(), 1);
        assert!(claims[0]["import_id"].is_null());
        assert_eq!(claims[0]["source"], zoho_source());
    }
    assert_eq!(
        call(
            &s,
            "review_contact_claim",
            review("crm-reject", "confirm", 1)
        )["error"]["code"],
        "VALIDATION_ERROR"
    );
    assert_eq!(
        call(
            &s,
            "review_contact_claim",
            review("crm-reject", "reject", 1)
        )["ok"],
        true
    );
    assert_eq!(status(&s, "crm-reject"), "rejected");
    assert_eq!(audit_count(&s), 1);
    assert_eq!(
        s.graph
            .connection()
            .query_row("SELECT count(*) FROM import_jobs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn null_import_duplicate_can_be_closed_by_manual_merge() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let a = entity(&s, "Person", "合并甲");
    let b = entity(&s, "Person", "合并乙");
    let inserted = insert_crm_claim(
        &s,
        "crm-merge",
        &a,
        &b,
        &zoho_source(),
        "possible_duplicate",
    );
    assert!(inserted.is_ok(), "{inserted:?}");
    let result = call(
        &s,
        "merge_contacts",
        json!({"operation_id":"merge-crm","actor":"tester",
        "source_id":a,"target_id":b,"expected_source_version":1,"expected_target_version":1}),
    );
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(status(&s, "crm-merge"), "confirmed");
    assert_eq!(detail(&s, &b)["unverified_claims"], json!([]));
}

#[test]
fn null_import_rejects_file_unknown_or_unlocated_source_and_non_duplicate_relations() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let a = entity(&s, "Person", "校验甲");
    let b = entity(&s, "Person", "校验乙");
    let mut invalid = vec![
        json!({"source_type":"file","quote":"file excerpt"}),
        json!({"source_type":"crm"}),
        json!({}),
    ];
    for key in ["source_connection_id", "source_module", "source_record_id"] {
        let mut missing = zoho_source();
        missing.as_object_mut().unwrap().remove(key);
        invalid.push(missing);
        let mut blank = zoho_source();
        blank[key] = json!(" ");
        invalid.push(blank);
    }
    let mut module = zoho_source();
    module["source_module"] = json!("Leads");
    invalid.push(module);
    let mut private = zoho_source();
    private["email"] = json!("private@example.test");
    invalid.push(private);
    for (index, source) in invalid.iter().enumerate() {
        assert!(
            insert_crm_claim(
                &s,
                &format!("invalid-{index}"),
                &a,
                &b,
                source,
                "possible_duplicate"
            )
            .is_err(),
            "accepted {source}"
        );
    }
    assert!(insert_crm_claim(&s, "invalid-relation", &a, &b, &zoho_source(), "worksFor").is_err());
}

#[test]
fn legacy_claim_migration_preserves_rows_indexes_and_foreign_keys_after_reopen() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("legacy.db");
    let (a, b, old_import) = {
        let s = Store::open(&path).unwrap();
        // Materialize the actual pre-Zoho table shape, regardless of the current Store migration.
        s.graph.connection().execute_batch("DROP TABLE contact_claims;
            CREATE TABLE contact_claims (
                claim_id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES entity_ids(entity_id),
                kind TEXT NOT NULL CHECK(kind IN ('field','relation')),field_path TEXT,relation_type TEXT,
                target_id TEXT REFERENCES entity_ids(entity_id),value_json TEXT NOT NULL CHECK(length(CAST(value_json AS BLOB)) <= 2048),
                source_json TEXT NOT NULL CHECK(length(CAST(source_json AS BLOB)) <= 2048),
                status TEXT NOT NULL CHECK(status IN ('unverified','confirmed','rejected')),reason TEXT NOT NULL,
                import_id TEXT NOT NULL REFERENCES import_jobs(import_id),candidate_id TEXT NOT NULL,
                created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE INDEX contact_claims_subject_status ON contact_claims(subject_id,status,claim_id);
            CREATE INDEX legacy_claim_reason ON contact_claims(reason);").unwrap();
        let a = entity(&s, "Person", "旧文件甲");
        let b = entity(&s, "Person", "旧文件乙");
        claim(&s, "legacy", &a, "properties.skills", json!("Rust"));
        let import: String = s
            .graph
            .connection()
            .query_row(
                "SELECT import_id FROM contact_claims WHERE claim_id='legacy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        (a, b, import)
    };
    for _ in 0..2 {
        let s = Store::open(&path).unwrap();
        let legacy = detail(&s, &a);
        assert_eq!(legacy["unverified_claims"][0]["import_id"], old_import);
        assert_eq!(legacy["unverified_claims"][0]["value"], "Rust");
        for name in ["contact_claims_subject_status", "legacy_claim_reason"] {
            assert_eq!(
                s.graph
                    .connection()
                    .query_row(
                        "SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?1",
                        [name],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
        }
        assert_eq!(
            s.graph
                .connection()
                .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        assert!(s
            .graph
            .connection()
            .execute(
                "UPDATE contact_claims SET import_id=NULL WHERE claim_id='legacy'",
                []
            )
            .is_err());
        assert!(s
            .graph
            .connection()
            .execute(
                "UPDATE contact_claims SET import_id='missing-import' WHERE claim_id='legacy'",
                []
            )
            .is_err());
        assert!(s
            .graph
            .connection()
            .execute(
                "UPDATE contact_claims SET subject_id='missing-person' WHERE claim_id='legacy'",
                []
            )
            .is_err());
    }
    let s = Store::open(&path).unwrap();
    let inserted = insert_crm_claim(
        &s,
        "migrated-crm",
        &a,
        &b,
        &zoho_source(),
        "possible_duplicate",
    );
    assert!(
        inserted.is_ok(),
        "migrated table must accept CRM claims: {inserted:?}"
    );
    let reviewed = call(&s, "review_contact_claim", review("legacy", "confirm", 1));
    assert_eq!(reviewed["ok"], true, "{reviewed}");
    assert_eq!(
        detail(&s, &a)["entity"]["properties"]["skills"],
        json!(["Rust"])
    );
}

#[test]
fn duplicate_review_requires_merge_or_an_explained_rejection() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let a = entity(&s, "Person", "甲");
    let b = entity(&s, "Person", "乙");
    claim(
        &s,
        "duplicate",
        &a,
        "possible_duplicate",
        json!({"reasons":["same_name"]}),
    );
    s.graph
        .connection()
        .execute(
            "UPDATE contact_claims SET target_id=?1 WHERE claim_id='duplicate'",
            [&b],
        )
        .unwrap();
    let confirmed = call(
        &s,
        "review_contact_claim",
        review("duplicate", "confirm", 1),
    );
    assert_eq!(confirmed["ok"], false);
    assert!(confirmed.to_string().contains("merge_contacts"));
    assert_eq!(status(&s, "duplicate"), "unverified");
    assert_eq!(detail(&s, &a)["relations"], json!([]));
    let mut input = review("duplicate", "reject", 1);
    for note in [Value::Null, json!(" "), json!("字".repeat(501))] {
        input["confirmation_note"] = note;
        assert_eq!(call(&s, "review_contact_claim", input.clone())["ok"], false);
    }
    input["confirmation_note"] = json!("已核对，为不同人");
    let result = call(&s, "review_contact_claim", input.clone());
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(status(&s, "duplicate"), "rejected");
    assert_eq!(detail(&s, &a)["entity"]["metadata"]["version"], 2);
    assert_eq!(audit_count(&s), 1);
    assert_eq!(
        call(&s, "review_contact_claim", input)["result"]["replayed"],
        true
    );
    assert_eq!(audit_count(&s), 1);
}

#[test]
fn corrected_education_claim_writes_relation_details_with_manual_evidence() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "本人");
    let school = entity(&s, "Organization", "学校");
    claim(
        &s,
        "education",
        &person,
        "alumniOf",
        json!({"properties":{"major":"软件工程","startDate":"2026","endDate":"2022"}}),
    );
    let mut input = review("education", "confirm", 1);
    input["target_id"] = json!(school);
    input["corrected_value"] = json!({"properties":{"major":"软件工程","educationLevel":"本科","startDate":"2022","endDate":"2026"}});
    let result = call(&s, "review_contact_claim", input);
    assert_eq!(result["ok"], true, "{result}");
    let saved = detail(&s, &person);
    assert!(saved["relations"].as_array().unwrap().iter().any(|r| r["relation_type"] == "alumniOf"
        && r["properties"] == json!({"major":"软件工程","educationLevel":"本科","startDate":"2022","endDate":"2026"})),"{saved}");
    assert_eq!(status(&s, "education"), "confirmed");
    let mut person_detail = detail(&s, &school);
    assert!(person_detail["entity"]["properties"].get("major").is_none());
    // Insert a bounded unresolved field using the actual claim table; it must
    // never be promoted through the generic entity-field review path.
    claim(
        &s,
        "unassigned",
        &person,
        "properties.major",
        json!("未知专业"),
    );
    s.graph
        .connection()
        .execute(
            "UPDATE contact_claims SET field_path='$experience' WHERE claim_id='unassigned'",
            [],
        )
        .unwrap();
    let result = call(
        &s,
        "review_contact_claim",
        review("unassigned", "confirm", 2),
    );
    assert_eq!(result["ok"], false, "{result}");
    assert_eq!(status(&s, "unassigned"), "unverified");
    person_detail = detail(&s, &person);
    assert!(person_detail["entity"]["properties"].get("major").is_none());
}

#[test]
fn project_path_claims_can_be_reviewed_with_typed_targets() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    let project = entity(&s, "Project", "Synthetic Project");
    let client = entity(&s, "Organization", "Synthetic Client");
    claim(
        &s,
        "project-detail",
        &project,
        "properties.description",
        json!("PLM implementation"),
    );
    let detail_review = call(
        &s,
        "review_contact_claim",
        review("project-detail", "confirm", 1),
    );
    assert_eq!(detail_review["ok"], true, "{detail_review}");
    assert_eq!(
        detail(&s, &project)["entity"]["properties"]["description"],
        "PLM implementation"
    );
    claim(
        &s,
        "participation",
        &person,
        "memberOf",
        json!({
            "properties":{"role":{"@type":"OrganizationRole","roleName":"Consultant"}}
        }),
    );
    let mut participation_review = review("participation", "confirm", 1);
    participation_review["target_id"] = json!(project);
    let participation_result = call(&s, "review_contact_claim", participation_review);
    assert_eq!(participation_result["ok"], true, "{participation_result}");
    claim(
        &s,
        "customer",
        &project,
        "clientOrganization",
        json!({"properties":{}}),
    );
    let mut wrong = review("customer", "confirm", 2);
    wrong["target_id"] = json!(person);
    assert_eq!(
        call(&s, "review_contact_claim", wrong)["error"]["code"],
        "VALIDATION_ERROR"
    );
    let mut customer_review = review("customer", "confirm", 2);
    customer_review["target_id"] = json!(client);
    let customer_result = call(&s, "review_contact_claim", customer_review);
    assert_eq!(customer_result["ok"], true, "{customer_result}");
    assert_eq!(
        call(&s, "list_relations", json!({"entity_id":project}))["result"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
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

#[test]
fn claim_confirmation_cannot_supply_file_provenance() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("g.db")).unwrap();
    let person = entity(&s, "Person", "Synthetic Person");
    claim(&s, "skill", &person, "properties.skills", json!("Rust"));
    let mut input = review("skill", "confirm", 1);
    input["evidence"] = json!([{"field_path":"properties.skills","value":"Rust",
        "source_type":"file","locator_status":"located","file_name":"never-uploaded.pdf",
        "file_sha256":"abc","quote":"unrelated","collected_at":"2026-09-26T00:00:00Z"}]);
    assert_eq!(call(&s, "review_contact_claim", input)["ok"], false);
    assert_eq!(status(&s, "skill"), "unverified");
    assert_eq!(detail(&s, &person)["entity"]["metadata"]["version"], 1);
}
