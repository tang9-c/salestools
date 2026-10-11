use contact_graph::store::Store;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[test]
fn text_import_keeps_original_and_commits_located_employment_without_current_claim() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let text = "林知远，云杉测试科技有限公司研发经理";
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let proof = |path: &str, value: Value| {
        json!({"field_path":path,"value":value,
        "source_type":"text","text_sha256":hash,"quote":text,"locator_status":"located",
        "collected_at":"2026-10-11T00:00:00Z"})
    };
    let source = json!({"source_type":"text","original_text":text,"text_sha256":hash,
        "collected_at":"2026-10-11T00:00:00Z"});
    let person = json!({"candidate_id":"p","label":"Person","properties":{"name":"林知远"},
        "extensions":{"hobbies":[],"instantMessaging":[]},
        "evidence":[proof("properties.name",json!("林知远"))],"warnings":[],"can_commit":true,
        "relation_suggestions":[{"source_candidate_id":"p","target_candidate_id":"o","relation_type":"worksFor",
        "properties":{"role":{"@type":"OrganizationRole","roleName":"研发经理"}},"uncertain":false,
        "evidence":[proof("$relation",json!({"relation_type":"worksFor","source_id":"p","target_id":"o"})),
        proof("properties.role.roleName",json!("研发经理"))]}]});
    let organization = json!({"candidate_id":"o","label":"Organization","properties":{"name":"云杉测试科技有限公司"},
        "evidence":[proof("properties.name",json!("云杉测试科技有限公司"))],"warnings":[],"can_commit":true,"relation_suggestions":[]});
    let job = store
        .put_import_job(
            &json!({"operation_id":"text-start","actor":"alice","file_id":"text_source",
        "status":"queued","data":{"candidates":[],"source":source}}),
        )
        .unwrap();
    let id = job["import_id"].as_str().unwrap();
    store
        .put_import_job(
            &json!({"operation_id":"text-ready","actor":"system","file_id":"text_source",
        "import_id":id,"expected_version":1,"status":"ready_for_review",
        "data":{"candidates":[person,organization],"source":source}}),
        )
        .unwrap();
    store.commit_import(&json!({"operation_id":format!("contact-import:{id}"),"actor":"alice","import_id":id,
        "expected_version":2,"auto_selected_relations":true,
        "choices":[{"candidate_id":"p","action":"create"},{"candidate_id":"o","action":"create"}],
        "relation_choices":[{"source_candidate_id":"p","target_candidate_id":"o","relation_type":"worksFor",
        "properties":{"role":{"@type":"OrganizationRole","roleName":"研发经理"}}}]})).unwrap();
    let stored = store.get_import_job(&json!({"import_id":id})).unwrap();
    assert_eq!(stored["data"]["source"]["original_text"], text);
    assert_eq!(
        store
            .get_import_start(
                &json!({"operation_id":"text-start","actor":"alice","file_id":"text_source"})
            )
            .unwrap()["import_id"],
        id
    );
    assert_eq!(
        store
            .get_import_start(
                &json!({"operation_id":"text-start","actor":"alice","file_id":"text_other"})
            )
            .unwrap_err()
            .code,
        "OPERATION_CONFLICT"
    );
    let entity_id: String = store.graph.connection().query_row("SELECT subject_id FROM evidence WHERE subject_kind='entity' AND json_extract(record_json,'$.value')='林知远'", [], |row| row.get(0)).unwrap();
    let contact = store.get_contact(&json!({"entity_id":entity_id})).unwrap();
    assert_eq!(contact["evidence"][0]["source_type"], "text");
    assert_eq!(contact["evidence"][0]["text_sha256"], hash);
    assert_eq!(
        contact["relations"][0]["metadata"]["employment_status"],
        "unknown"
    );
    assert_eq!(
        contact["relations"][0]["properties"]["role"],
        json!({"@type":"OrganizationRole","roleName":"研发经理"})
    );
    let found = contact_graph::search::search_keyword(
        &store,
        &json!({"query":"云杉测试科技有限公司","limit":20}),
    )
    .unwrap();
    assert!(found.to_string().contains("林知远"));
}

#[test]
fn text_import_rejects_hash_and_quote_mismatch_and_public_provenance_forgery() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let hash = format!("{:x}", Sha256::digest("林知远".as_bytes()));
    for (index, quote) in ["不存在", "林知远"].iter().enumerate() {
        let bad_hash = if index == 1 {
            "a".repeat(64)
        } else {
            hash.clone()
        };
        let proof = json!({"field_path":"properties.name","value":"林知远","source_type":"text",
            "text_sha256":bad_hash,"quote":quote,"locator_status":"located","collected_at":"2026-10-11T00:00:00Z"});
        let error = store.put_import_job(&json!({"operation_id":format!("bad-{index}"),"actor":"alice","file_id":"text-source",
            "status":"queued","data":{"source":{"source_type":"text","original_text":"林知远","text_sha256":hash},
            "candidates":[{"candidate_id":"p","label":"Person","properties":{"name":"林知远"},
            "extensions":{"hobbies":[],"instantMessaging":[]},"evidence":[proof],"relation_suggestions":[],"warnings":[],"can_commit":true}]}})).unwrap_err();
        assert_eq!(error.code, "VALIDATION_ERROR");
        let error = store
            .save_contact(
                &json!({"operation_id":format!("forged-{index}"),"actor":"alice","label":"Person",
            "set_properties":{"name":"林知远"},"evidence":[proof]}),
            )
            .unwrap_err();
        assert_eq!(error.code, "VALIDATION_ERROR");
    }
}
