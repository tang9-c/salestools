use contact_graph::store::Store;
use serde_json::{json, Value};

fn proof(path: &str, value: Value) -> Value {
    json!({"field_path":path,"value":value,"source_type":"manual",
        "collected_at":"2026-09-26T00:00:00.000Z","locator_status":"not_applicable"})
}

fn candidate(id: &str, name: &str) -> Value {
    json!({"candidate_id":id,"label":"Person","properties":{"name":name},
        "extensions":{"hobbies":[],"instantMessaging":[]},
        "evidence":[proof("properties.name", json!(name))],
        "relation_suggestions":[],"warnings":[],"can_commit":true})
}

fn ready(store: &Store, candidates: Vec<Value>) -> String {
    let started = store
        .put_import_job(&json!({"operation_id":"start","actor":"reviewer",
        "file_id":"file-a","status":"queued","data":{"candidates":[]}}))
        .unwrap();
    let import_id = started["import_id"].as_str().unwrap().to_owned();
    store
        .put_import_job(&json!({"operation_id":"ready","actor":"system",
        "file_id":"file-a","import_id":import_id,"expected_version":1,
        "status":"ready_for_review","data":{"candidates":candidates}}))
        .unwrap();
    import_id
}

fn count(store: &Store, table: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    store
        .graph
        .connection()
        .query_row(&sql, [], |row| row.get(0))
        .unwrap()
}

fn duplicate_person(store: &Store, operation: &str, name: &str) -> String {
    store
        .save_contact(
            &json!({"operation_id":operation,"actor":"reviewer","label":"Person",
        "set_properties":{"name":name},"evidence":[proof("properties.name",json!(name))]}),
        )
        .unwrap()["entity_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn mark_merged(store: &Store, from: &str, to: Value) {
    let encoded: String = store
        .graph
        .connection()
        .query_row(
            "SELECT metadata_json FROM entity_meta WHERE entity_id=?1",
            [from],
            |r| r.get(0),
        )
        .unwrap();
    let mut metadata: Value = serde_json::from_str(&encoded).unwrap();
    metadata["merged_into"] = to;
    metadata["archived_at"] = json!("2026-10-11T00:00:00.000Z");
    store
        .graph
        .connection()
        .execute(
            "UPDATE entity_meta SET metadata_json=?1 WHERE entity_id=?2",
            rusqlite::params![metadata.to_string(), from],
        )
        .unwrap();
}

#[test]
fn duplicate_claims_save_independent_profiles_and_durable_warnings_with_stable_replay() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("graph.sqlite");
    let store = Store::open(&path).unwrap();
    let target = duplicate_person(&store, "target", "陈晓");
    let old = store.get_contact(&json!({"entity_id":target})).unwrap();
    let import_id = ready(&store, vec![candidate("c1", "陈晓")]);
    let mut data = store
        .get_import_job(&json!({"import_id":import_id}))
        .unwrap()["data"]
        .clone();
    data["warnings"] = json!(["已有提醒"]);
    data["source"] = json!({"source_type":"text","text_sha256":"abc","original_text":"secret original",
        "file_name":"长".repeat(2000),"collected_at":"2026-10-11T00:00:00.000Z"});
    store
        .graph
        .connection()
        .execute(
            "UPDATE import_jobs SET data_json=?1 WHERE import_id=?2",
            rusqlite::params![data.to_string(), import_id],
        )
        .unwrap();
    let raw = json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer","import_id":import_id,
        "expected_version":2,"choices":[{"candidate_id":"c1","action":"create"}],
        "duplicate_matches":[{"candidate_id":"c1","target_id":target,"reasons":["same_name","same_name"]}],
        "duplicate_match_incomplete":true});
    let saved = store.commit_import(&raw).unwrap();
    let new_id = saved["results"][0]["entity_id"].as_str().unwrap();
    assert_ne!(new_id, target);
    assert_eq!(
        store.get_contact(&json!({"entity_id":target})).unwrap()["entity"],
        old["entity"]
    );
    assert_eq!(count(&store, "kg_relations"), 0);
    let detail = store.get_contact(&json!({"entity_id":new_id})).unwrap();
    assert_eq!(detail["unverified_claims"].as_array().unwrap().len(), 1);
    assert_eq!(
        detail["unverified_claims"][0]["relation_type"],
        "possible_duplicate"
    );
    let (value, source): (String, String) = store
        .graph
        .connection()
        .query_row(
            "SELECT value_json,source_json FROM contact_claims",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&value).unwrap()["reasons"],
        json!(["same_name"])
    );
    assert!(source.len() <= 2048 && !source.contains("secret original"));
    assert_eq!(
        serde_json::from_str::<Value>(&source).unwrap()["truncated"],
        true
    );
    let warning = json!("本次入库的重复核对未完整完成，已保存资料及已获得的线索。");
    assert!(saved["warnings"].as_array().unwrap().contains(&warning));
    assert!(saved["warnings"]
        .as_array()
        .unwrap()
        .contains(&json!("已有提醒")));
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert!(reopened
        .get_import_job(&json!({"import_id":import_id}))
        .unwrap()["data"]["warnings"]
        .as_array()
        .unwrap()
        .contains(&warning));
    let mut replay = raw.clone();
    replay["duplicate_matches"] = json!([]);
    replay["duplicate_match_incomplete"] = json!(false);
    let receipt = reopened.commit_import(&replay).unwrap();
    assert_eq!(receipt["warnings"], saved["warnings"]);
    assert_eq!(receipt["replayed"], true);
    assert_eq!(count(&reopened, "contact_claims"), 1);
    assert_eq!(count(&reopened, "entity_ids"), 2);
    let mut changed = raw.clone();
    changed["actor"] = json!("another");
    assert_eq!(
        reopened.commit_import(&changed).unwrap_err().code,
        "OPERATION_CONFLICT"
    );
    changed = raw.clone();
    changed["choices"][0]["action"] = json!("skip");
    assert_eq!(
        reopened.commit_import(&changed).unwrap_err().code,
        "OPERATION_CONFLICT"
    );
}

#[test]
fn derived_duplicate_targets_follow_merge_chains_and_keep_archived_targets() {
    for mode in [
        "redirect",
        "multilevel",
        "self",
        "archived",
        "cycle",
        "missing",
        "invalid",
        "stale_explicit",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let a = duplicate_person(&store, "a", "陈晓");
        let b = duplicate_person(&store, "b", "另一个人");
        let c = duplicate_person(&store, "c", "最终档案");
        match mode {
            "redirect" | "self" | "stale_explicit" => mark_merged(&store, &a, json!(b)),
            "multilevel" => {
                mark_merged(&store, &a, json!(b));
                mark_merged(&store, &b, json!(c));
            }
            "cycle" => {
                mark_merged(&store, &a, json!(b));
                mark_merged(&store, &b, json!(a));
            }
            "missing" => mark_merged(&store, &a, json!("missing")),
            "invalid" => mark_merged(&store, &a, json!(42)),
            "archived" => {
                store.archive_contact(&json!({"operation_id":"archive","actor":"reviewer","entity_id":a,"expected_version":1})).unwrap();
            }
            _ => unreachable!(),
        }
        let import_id = ready(&store, vec![candidate("c1", "陈晓")]);
        let choice = if mode == "self" {
            json!({"candidate_id":"c1","action":"merge","target_id":b,"expected_target_version":1})
        } else if mode == "stale_explicit" {
            json!({"candidate_id":"c1","action":"merge","target_id":a,"expected_target_version":1})
        } else {
            json!({"candidate_id":"c1","action":"create"})
        };
        let result = store.commit_import(
            &json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
            "import_id":import_id,"expected_version":2,"choices":[choice],
            "duplicate_matches":[{"candidate_id":"c1","target_id":a,"reasons":["same_name"]}]}),
        );
        if ["cycle", "missing", "invalid", "stale_explicit"].contains(&mode) {
            assert!(result.is_err());
            assert_eq!(count(&store, "entity_ids"), 3);
            assert_eq!(count(&store, "contact_claims"), 0);
        } else if mode == "self" {
            assert!(result.is_ok());
            assert_eq!(count(&store, "contact_claims"), 0);
        } else {
            let saved = result.unwrap();
            let actual: String = store
                .graph
                .connection()
                .query_row("SELECT target_id FROM contact_claims", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                actual,
                if mode == "multilevel" {
                    c.clone()
                } else if mode == "redirect" {
                    b.clone()
                } else {
                    a.clone()
                }
            );
            let old_pending:i64=store.graph.connection().query_row("SELECT COUNT(*) FROM contact_claims WHERE target_id=?1 AND status='unverified'",[&a],|r|r.get(0)).unwrap();
            assert_eq!(old_pending, if mode == "archived" { 1 } else { 0 });
            assert_ne!(saved["results"][0]["entity_id"], json!(a));
        }
        assert_eq!(count(&store, "kg_relations"), 0);
    }
}

#[test]
fn merge_keeps_other_duplicate_matches_and_claim_failure_rolls_back_person() {
    for failure in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let a = duplicate_person(&store, "a", "陈晓");
        let b = duplicate_person(&store, "b", "陈晓");
        let import_id = ready(&store, vec![candidate("c1", "陈晓")]);
        if failure {
            store.graph.connection().execute_batch("CREATE TRIGGER fail_claim BEFORE INSERT ON contact_claims BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        }
        let choice = if failure {
            json!({"candidate_id":"c1","action":"create"})
        } else {
            json!({"candidate_id":"c1","action":"merge","target_id":a,"expected_target_version":1})
        };
        let result=store.commit_import(&json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer","import_id":import_id,
            "expected_version":2,"choices":[choice],"duplicate_matches":[
                {"candidate_id":"c1","target_id":a,"reasons":["same_name"]},{"candidate_id":"c1","target_id":b,"reasons":["email"]}]}));
        assert_eq!(count(&store, "entity_ids"), 2);
        if failure {
            assert!(result.is_err());
            assert_eq!(count(&store, "contact_claims"), 0);
            assert_eq!(
                store
                    .get_import_job(&json!({"import_id":import_id}))
                    .unwrap()["status"],
                "ready_for_review"
            );
        } else {
            assert!(result.is_ok());
            assert_eq!(count(&store, "contact_claims"), 1);
            let pair: (String, String) = store
                .graph
                .connection()
                .query_row("SELECT subject_id,target_id FROM contact_claims", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            assert_eq!(pair, (a, b));
        }
    }
}

#[test]
fn legacy_commit_hash_replays_with_new_derived_fields() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let import_id = ready(&store, vec![candidate("c1", "陈晓")]);
    let raw = json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer","import_id":import_id,
        "expected_version":2,"choices":[{"candidate_id":"c1","action":"create"}]});
    let first = store.commit_import(&raw).unwrap();
    let mut retry = raw;
    retry["duplicate_matches"] = json!([]);
    retry["duplicate_match_incomplete"] = json!(true);
    let replay = store.commit_import(&retry).unwrap();
    assert_eq!(replay["results"], first["results"]);
    assert_eq!(replay["warnings"], first["warnings"]);
    assert_eq!(replay["replayed"], true);
}

#[test]
fn duplicate_pair_deduplication_preserves_direction_source_and_processed_status() {
    for status in ["unverified", "rejected", "confirmed"] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let name = if status == "unverified" {
            "长".repeat(700)
        } else {
            "陈晓".to_owned()
        };
        let a = duplicate_person(&store, "a", &name);
        let b = duplicate_person(&store, "b", &name);
        let first_import = ready(&store, vec![candidate("c1", &name)]);
        store.commit_import(&json!({"operation_id":format!("contact-import:{first_import}"),"actor":"reviewer",
            "import_id":first_import,"expected_version":2,"choices":[{"candidate_id":"c1","action":"merge","target_id":a,"expected_target_version":1}],
            "duplicate_matches":[{"candidate_id":"c1","target_id":b,"reasons":["same_name"]}]})).unwrap();
        let original: (String, String) = store
            .graph
            .connection()
            .query_row("SELECT claim_id,source_json FROM contact_claims", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        store
            .graph
            .connection()
            .execute(
                "UPDATE contact_claims SET status=?1 WHERE claim_id=?2",
                rusqlite::params![status, original.0],
            )
            .unwrap();
        let next = store.put_import_job(&json!({"operation_id":"start2","actor":"reviewer","file_id":"file-b","status":"queued","data":{"candidates":[]}})).unwrap();
        let second_import = next["import_id"].as_str().unwrap();
        store.put_import_job(&json!({"operation_id":"ready2","actor":"system","file_id":"file-b","import_id":second_import,"expected_version":1,
            "status":"ready_for_review","data":{"candidates":[candidate("c2",&name)]}})).unwrap();
        store.commit_import(&json!({"operation_id":format!("contact-import:{second_import}"),"actor":"reviewer",
            "import_id":second_import,"expected_version":2,"choices":[{"candidate_id":"c2","action":"merge","target_id":b,"expected_target_version":1}],
            "duplicate_matches":[{"candidate_id":"c2","target_id":a,"reasons":["email"]}]})).unwrap();
        assert_eq!(count(&store, "contact_claims"), 1);
        let saved: (String, String, String, String, String) = store
            .graph
            .connection()
            .query_row(
                "SELECT subject_id,target_id,status,value_json,source_json FROM contact_claims",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(saved.0, a);
        assert_eq!(saved.1, b);
        assert_eq!(saved.2, status);
        assert_eq!(saved.4, original.1);
        assert!(saved.3.len() <= 2048);
        if status == "unverified" {
            assert_eq!(
                serde_json::from_str::<Value>(&saved.3).unwrap()["truncated"],
                true
            );
            assert!(saved.3.len() > 2000);
        }
        assert_eq!(
            serde_json::from_str::<Value>(&saved.3).unwrap()["reasons"],
            if status == "unverified" {
                json!(["email", "same_name"])
            } else {
                json!(["same_name"])
            }
        );
        let audit: String = store
            .graph
            .connection()
            .query_row(
                "SELECT change_json FROM audit_log WHERE operation_id=?1",
                [format!("contact-import:{second_import}")],
                |r| r.get(0),
            )
            .unwrap();
        let audit: Value = serde_json::from_str(&audit).unwrap();
        assert_eq!(
            audit["duplicate_discoveries"][0]["source"]["import_id"],
            second_import
        );
        assert_eq!(audit["duplicate_discoveries"][0]["claim_id"], original.0);
    }
}

#[test]
fn invalid_duplicate_inputs_roll_back_all_import_writes() {
    for mode in [
        "reason",
        "missing_candidate",
        "skipped_candidate",
        "organization_target",
        "empty_reasons",
        "unknown_field",
        "raw_content",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let target = if mode == "organization_target" {
            store.save_contact(&json!({"operation_id":"target","actor":"reviewer","label":"Organization","set_properties":{"name":"公司"},
                "evidence":[proof("properties.name",json!("公司"))]})).unwrap()["entity_id"].as_str().unwrap().to_owned()
        } else {
            duplicate_person(&store, "target", "陈晓")
        };
        let import_id = ready(&store, vec![candidate("c1", "陈晓")]);
        let mut matched = json!({"candidate_id":"c1","target_id":target,"reasons":["same_name"]});
        if mode == "reason" {
            matched["reasons"] = json!(["arbitrary private text"]);
        }
        if mode == "missing_candidate" {
            matched["candidate_id"] = json!("unknown");
        }
        if mode == "empty_reasons" {
            matched["reasons"] = json!([]);
        }
        if mode == "unknown_field" {
            matched["other"] = json!("private");
        }
        if mode == "raw_content" {
            matched["original_text"] = json!("private");
        }
        let result=store.commit_import(&json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer","import_id":import_id,
            "expected_version":2,"choices":[{"candidate_id":"c1","action":if mode=="skipped_candidate" {"skip"} else {"create"}}],
            "duplicate_matches":[matched]}));
        assert!(result.is_err());
        assert_eq!(count(&store, "entity_ids"), 1);
        assert_eq!(count(&store, "contact_claims"), 0);
        assert_eq!(
            store
                .get_import_job(&json!({"import_id":import_id}))
                .unwrap()["status"],
            "ready_for_review"
        );
    }
}

#[test]
fn import_merge_preserves_scalar_conflicts_and_appends_arrays_unless_explicitly_replaced() {
    for replace in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let old = store.save_contact(&json!({"operation_id":"target","actor":"reviewer","label":"Person",
            "set_properties":{"name":"陈晓","jobTitle":"工程师","skills":["Kubernetes"]},
            "evidence":[proof("properties.name",json!("陈晓")),proof("properties.jobTitle",json!("工程师")),
                proof("properties.skills",json!("Kubernetes"))]})).unwrap();
        let id = old["entity_id"].as_str().unwrap();
        let mut incoming = candidate("c1", "陈晓");
        incoming["properties"]["jobTitle"] = json!("经理");
        incoming["properties"]["skills"] = json!(["K8s", "Python"]);
        incoming["evidence"].as_array_mut().unwrap().extend([
            proof("properties.jobTitle", json!("经理")),
            proof("properties.skills", json!("K8s")),
            proof("properties.skills", json!("Python")),
        ]);
        let import_id = ready(&store, vec![incoming]);
        let mut choice = json!({"candidate_id":"c1","action":"merge","target_id":id,"expected_target_version":1});
        if replace {
            choice["set_properties"] = json!({"jobTitle":"经理"});
        }
        store
            .commit_import(
                &json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
            "import_id":import_id,"expected_version":2,"choices":[choice]}),
            )
            .unwrap();
        let saved = store.get_contact(&json!({"entity_id":id})).unwrap();
        assert_eq!(
            saved["entity"]["properties"]["jobTitle"],
            if replace { "经理" } else { "工程师" }
        );
        assert_eq!(
            saved["entity"]["properties"]["skills"],
            json!(["Kubernetes", "Python"])
        );
        assert_eq!(count(&store, "entity_ids"), 1);
        let quotes: i64 = store.graph.connection().query_row(
            "SELECT count(*) FROM evidence WHERE subject_id=?1 AND field_path='properties.jobTitle'",[id],|r|r.get(0)).unwrap();
        assert_eq!(quotes, 2);
    }
}

#[test]
fn import_merge_fills_missing_fields_but_never_clears_old_values_with_empty_input() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let old = store.save_contact(&json!({"operation_id":"target","actor":"reviewer","label":"Person",
        "set_properties":{"name":"陈晓","jobTitle":"工程师"},
        "evidence":[proof("properties.name",json!("陈晓")),proof("properties.jobTitle",json!("工程师"))]})).unwrap();
    let id = old["entity_id"].as_str().unwrap();
    let mut incoming = candidate("c1", "陈晓");
    incoming["properties"]["jobTitle"] = json!("");
    incoming["properties"]["email"] = json!(["chen@example.com"]);
    incoming["evidence"]
        .as_array_mut()
        .unwrap()
        .push(proof("properties.email", json!("chen@example.com")));
    let import_id = ready(&store, vec![incoming]);
    store
        .commit_import(
            &json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
        "import_id":import_id,"expected_version":2,"choices":[{"candidate_id":"c1","action":"merge",
            "target_id":id,"expected_target_version":1}]}),
        )
        .unwrap();
    let saved = store.get_contact(&json!({"entity_id":id})).unwrap();
    assert_eq!(saved["entity"]["properties"]["jobTitle"], "工程师");
    assert_eq!(
        saved["entity"]["properties"]["email"],
        json!(["chen@example.com"])
    );
}

#[test]
fn auto_selected_education_requires_each_field_quote_and_rolls_back_on_mismatch() {
    for wrong_major in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let file_proof = |path: &str, value: Value| {
            json!({"field_path":path,"value":value,"source_type":"file",
            "file_name":"resume.pdf","file_sha256":"abc","quote":"本人学校软件工程","locator_status":"located","collected_at":"2026-10-09T00:00:00Z"})
        };
        let mut person = candidate("person", "本人");
        person["relation_suggestions"] = json!([{"source_candidate_id":"person","target_candidate_id":"school","relation_type":"alumniOf",
            "properties":{"major":"软件工程"},"uncertain":false,"evidence":[
                file_proof("$relation",json!({"relation_type":"alumniOf","source_id":"person","target_id":"school"})),
                file_proof("properties.major",json!(if wrong_major {"错误专业"} else {"软件工程"}))]}]);
        let school = json!({"candidate_id":"school","label":"Organization","properties":{"name":"学校"},
            "evidence":[proof("properties.name",json!("学校"))],"can_commit":true,"relation_suggestions":[],"warnings":[]});
        let import_id = ready(&store, vec![person, school]);
        let input = json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer","import_id":import_id,"expected_version":2,
            "auto_selected_relations":true,"choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"school","action":"create"}],
            "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"school","relation_type":"alumniOf","properties":{"major":"软件工程"}}]});
        let result = store.commit_import(&input);
        assert_eq!(result.is_ok(), !wrong_major, "{result:?}");
        assert_eq!(count(&store, "entity_ids"), if wrong_major { 0 } else { 2 });
        if !wrong_major {
            let stored: String = store
                .graph
                .connection()
                .query_row(
                    "SELECT record_json FROM evidence WHERE field_path='properties.major'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(stored.contains("软件工程"), "{stored}");
            let saved_properties: String = store
                .graph
                .connection()
                .query_row(
                    "SELECT properties FROM kg_relations WHERE rel_type='alumniOf'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&saved_properties).unwrap(),
                json!({"major":"软件工程"})
            );
        }
    }
}

#[test]
fn optional_education_claims_do_not_pollute_the_school_or_block_commit() {
    for create_school in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let mut person = candidate("person", "本人");
        person["review_items"] = json!([{"kind":"relation","source_candidate_id":"person","target_candidate_id":"school",
        "relation_type":"alumniOf","properties":{"major":"软件工程","startDate":"2026","endDate":"2022"},"reason":"invalid_shape"},
        {"kind":"field","field_path":"$experience","value":{"kind":"unassigned","original_field_path":"properties.major","value":"未知专业"},"reason":"invalid_shape"}]);
        let school = json!({"candidate_id":"school","label":"Organization","properties":{"name":"学校"},
        "evidence":[proof("properties.name",json!("学校"))],"can_commit":true,"warnings":[],"relation_suggestions":[],
        "review_items":[{"kind":"field","field_path":"properties.major","value":"软件工程","reason":"invalid_shape"}]});
        let import_id = ready(&store, vec![person, school]);
        let input = json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer","import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"school","action":if create_school {"create"} else {"skip"}}],"relation_choices":[]});
        let result = store.commit_import(&input).unwrap();
        assert!(result.to_string().contains("机构待核实项"), "{result}");
        assert_eq!(
            count(&store, "entity_ids"),
            if create_school { 2 } else { 1 }
        );
        assert_eq!(count(&store, "contact_claims"), 2);
        let invalid: i64 = store
            .graph
            .connection()
            .query_row(
                "SELECT count(*) FROM contact_claims WHERE field_path='properties.major'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(invalid, 0);
        let saved: String = store
            .graph
            .connection()
            .query_row(
                "SELECT value_json FROM contact_claims WHERE kind='relation'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(saved.contains("学校"), "{saved}");
        let target: Option<String> = store
            .graph
            .connection()
            .query_row(
                "SELECT target_id FROM contact_claims WHERE kind='relation'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(target.is_some(), create_school);
        assert_eq!(
            serde_json::from_str::<Value>(&saved).unwrap()["target_candidate_id"],
            "school"
        );
        let replay = store.commit_import(&input).unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(count(&store, "contact_claims"), 2);
    }
}

#[test]
fn auto_selected_relation_keeps_only_located_file_provenance() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let mut person = candidate("person", "林晓");
    person["relation_suggestions"] = json!([{
        "source_candidate_id":"person","target_candidate_id":"company",
        "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole","roleName":"顾问"}},
        "uncertain":false,
        "evidence":[
            {"field_path":"$relation","value":{"relation_type":"worksFor","source_id":"person","target_id":"company"},
             "source_type":"file","file_name":"resume.pdf","file_sha256":"abc","quote":"林晓任职甲公司",
             "page":1,"locator_status":"located","collected_at":"2026-09-26T00:00:00.000Z"},
            {"field_path":"properties.role.roleName","value":"顾问","source_type":"file",
             "file_name":"resume.pdf","file_sha256":"abc","quote":"顾问",
             "page":1,"locator_status":"located","collected_at":"2026-09-26T00:00:00.000Z"}
        ]
    }]);
    let company = json!({"candidate_id":"company","label":"Organization",
        "properties":{"name":"甲公司"},"evidence":[proof("properties.name",json!("甲公司"))],
        "relation_suggestions":[],"warnings":[],"can_commit":true});
    let import_id = ready(&store, vec![person, company]);
    let input = json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
        "import_id":import_id,"expected_version":2,"auto_selected_relations":true,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"company","action":"create"}],
        "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"company",
            "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole","roleName":"顾问"}}}]});
    let saved = store.commit_import(&input).unwrap();
    let relation_id = saved["relations"][0]["relation_id"].as_str().unwrap();
    let evidence: Vec<String> = store.graph.connection().prepare(
        "SELECT json_extract(record_json,'$.source_type') FROM evidence WHERE subject_kind='relation' AND subject_id=?1"
    ).unwrap().query_map([relation_id], |row| row.get(0)).unwrap()
        .map(Result::unwrap).collect();
    assert_eq!(evidence, vec!["file", "file"]);
    let replay = store.commit_import(&input).unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(count(&store, "kg_relations"), 1);
}

#[test]
fn auto_selected_relation_without_located_file_proof_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let mut person = candidate("person", "林晓");
    person["relation_suggestions"] = json!([{
        "source_candidate_id":"person","target_candidate_id":"company",
        "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole"}},
        "uncertain":false,"evidence":[]
    }]);
    let company = json!({"candidate_id":"company","label":"Organization",
        "properties":{"name":"甲公司"},"evidence":[proof("properties.name",json!("甲公司"))],
        "relation_suggestions":[],"warnings":[],"can_commit":true});
    let import_id = ready(&store, vec![person, company]);
    let result = store.commit_import(&json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,"auto_selected_relations":true,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"company","action":"create"}],
        "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"company",
            "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole"}}}]}));
    assert_eq!(result.unwrap_err().code, "VALIDATION_ERROR");
    assert_eq!(count(&store, "kg_entities"), 0);
}

#[test]
fn unnamed_employment_accepts_located_cross_block_file_assessments() {
    for (target_name, should_commit) in [("甲公司", true), ("乙公司", true)] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let person = json!({"candidate_id":"person","label":"Person","properties":{},
            "extensions":{"hobbies":[],"instantMessaging":[]},"evidence":[],
            "relation_suggestions":[{"source_candidate_id":"person","target_candidate_id":"company",
                "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole"}},
                "uncertain":false,"evidence":[{"field_path":"$relation",
                    "value":{"relation_type":"worksFor","source_id":"person","target_id":"company"},
                    "source_type":"file","file_name":"resume.pdf","file_sha256":"abc",
                    "quote":"职业经历","page":1,"locator_status":"located",
                    "collected_at":"2026-09-26T00:00:00.000Z"}]}],
            "warnings":[],"can_commit":true});
        let company = json!({"candidate_id":"company","label":"Organization",
            "properties":{"name":target_name},"evidence":[proof("properties.name",json!(target_name))],
            "relation_suggestions":[],"warnings":[],"can_commit":true});
        let import_id = ready(&store, vec![person, company]);
        let result = store.commit_import(&json!({"operation_id":format!("contact-import:{import_id}"),
            "actor":"reviewer","import_id":import_id,"expected_version":2,
            "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"company","action":"create"}],
            "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"company",
                "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole"}}}]}));
        assert_eq!(result.is_ok(), should_commit, "target={target_name}");
    }
}

#[test]
fn review_item_survives_preview_but_requires_explicit_manual_confirmation_to_commit() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let mut preview = candidate("person", "陈晓");
    preview["review_items"] = json!([{"kind":"field","field_path":"properties.skills",
        "value":"Java","reason":"missing_evidence","page":1,"quote":"Java"}]);
    let import_id = ready(&store, vec![preview.clone()]);
    let committed = store
        .commit_import(&json!({
            "operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
            "import_id":import_id,"expected_version":2,
            "choices":[{"candidate_id":"person","action":"create"}]
        }))
        .unwrap();
    let id = committed["results"][0]["entity_id"].as_str().unwrap();
    let saved = store.get_contact(&json!({"entity_id":id})).unwrap();
    assert_eq!(saved["entity"]["properties"]["skills"], json!([]));
    assert_eq!(
        store
            .get_import_job(&json!({"import_id":import_id}))
            .unwrap()["data"]["candidates"][0]["review_items"],
        preview["review_items"]
    );

    let second_dir = tempfile::tempdir().unwrap();
    let second_store = Store::open(second_dir.path().join("graph.sqlite")).unwrap();
    let second_import_id = ready(&second_store, vec![preview]);
    let confirmed = second_store
        .commit_import(&json!({
            "operation_id":format!("contact-import:{second_import_id}"),"actor":"reviewer",
            "import_id":second_import_id,"expected_version":2,
            "choices":[{"candidate_id":"person","action":"create",
                "set_properties":{"skills":["Java"]},
                "evidence":[proof("properties.skills",json!("Java"))]}]
        }))
        .unwrap();
    let confirmed_id = confirmed["results"][0]["entity_id"].as_str().unwrap();
    let saved = second_store
        .get_contact(&json!({"entity_id":confirmed_id}))
        .unwrap();
    assert_eq!(saved["entity"]["properties"]["skills"], json!(["Java"]));
}

#[test]
fn unnamed_skill_candidate_commits_without_a_placeholder_name() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let preview = json!({"candidate_id":"anonymous","label":"Person",
        "properties":{"skills":["Python"]},
        "extensions":{"hobbies":[],"instantMessaging":[]},
        "evidence":[proof("properties.skills",json!("Python"))],
        "relation_suggestions":[],"warnings":[],"can_commit":true});
    let import_id = ready(&store, vec![preview]);
    let committed = store
        .commit_import(&json!({
            "operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
            "import_id":import_id,"expected_version":2,
            "choices":[{"candidate_id":"anonymous","action":"create"}]
        }))
        .unwrap();
    let id = committed["results"][0]["entity_id"].as_str().unwrap();
    let saved = store.get_contact(&json!({"entity_id":id})).unwrap();
    assert!(saved["entity"]["properties"].get("name").is_none());
    assert_eq!(saved["entity"]["properties"]["skills"], json!(["Python"]));
}

#[test]
fn unnamed_relation_only_candidate_requires_a_selected_located_relation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let person = json!({"candidate_id":"person","label":"Person","properties":{},
        "extensions":{"hobbies":[],"instantMessaging":[]},"evidence":[],
        "relation_suggestions":[{"source_candidate_id":"person","target_candidate_id":"school",
            "relation_type":"alumniOf","properties":{},"uncertain":false,
            "evidence":[{"field_path":"$relation","value":{"relation_type":"alumniOf","source_id":"person","target_id":"school"},
                "source_type":"file","file_name":"resume.pdf","file_sha256":"abc",
                "quote":"曾就读星辰大学","page":1,"locator_status":"located",
                "collected_at":"2026-09-26T00:00:00.000Z"}]}],"warnings":[],"can_commit":true});
    let school = json!({"candidate_id":"school","label":"Organization",
        "properties":{"name":"星辰大学"},
        "evidence":[proof("properties.name",json!("星辰大学"))],
        "relation_suggestions":[],"warnings":[],"can_commit":true});
    let bare_dir = tempfile::tempdir().unwrap();
    let bare_store = Store::open(bare_dir.path().join("graph.sqlite")).unwrap();
    let mut bare_person = person.clone();
    bare_person["relation_suggestions"][0]["evidence"][0]["locator_status"] = json!("unavailable");
    let bare_import = ready(&bare_store, vec![bare_person, school.clone()]);
    assert_eq!(bare_store.commit_import(&json!({
        "operation_id":format!("contact-import:{bare_import}"),"actor":"reviewer",
        "import_id":bare_import,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"school","action":"create"}],
        "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"school",
            "relation_type":"alumniOf","properties":{}}]
    })).unwrap_err().code, "VALIDATION_ERROR");
    let negated_dir = tempfile::tempdir().unwrap();
    let negated_store = Store::open(negated_dir.path().join("graph.sqlite")).unwrap();
    let mut negated_person = person.clone();
    negated_person["relation_suggestions"][0]["evidence"][0]["quote"] = json!("");
    let negated_import = ready(&negated_store, vec![negated_person, school.clone()]);
    assert_eq!(negated_store.commit_import(&json!({
        "operation_id":format!("contact-import:{negated_import}"),"actor":"reviewer",
        "import_id":negated_import,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"school","action":"create"}],
        "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"school",
            "relation_type":"alumniOf","properties":{}}]
    })).unwrap_err().code, "VALIDATION_ERROR");
    let bad_dir = tempfile::tempdir().unwrap();
    let bad_store = Store::open(bad_dir.path().join("graph.sqlite")).unwrap();
    let mut bad_person = person.clone();
    bad_person["relation_suggestions"][0]["evidence"][0]["value"]["target_id"] =
        json!("someone-else");
    let bad_import = ready(&bad_store, vec![bad_person, school.clone()]);
    let bad_result = bad_store.commit_import(&json!({
        "operation_id":format!("contact-import:{bad_import}"),"actor":"reviewer",
        "import_id":bad_import,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"school","action":"create"}],
        "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"school",
            "relation_type":"alumniOf","properties":{}}]
    }));
    assert_eq!(bad_result.unwrap_err().code, "VALIDATION_ERROR");
    let import_id = ready(&store, vec![person, school]);
    let mut payload = json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"school","action":"create"}],
        "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"school",
            "relation_type":"alumniOf","properties":{}}]});
    let selected = payload["relation_choices"].clone();
    payload["relation_choices"] = json!([]);
    assert_eq!(
        store.commit_import(&payload).unwrap_err().code,
        "VALIDATION_ERROR"
    );
    assert_eq!(count(&store, "kg_entities"), 0);
    payload["relation_choices"] = selected;
    let committed = store.commit_import(&payload).unwrap();
    assert_eq!(committed["relations"].as_array().unwrap().len(), 1);
    assert_eq!(count(&store, "contact_claims"), 0);
}

#[test]
fn unnamed_employment_does_not_accept_a_role_without_located_file_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let person = json!({"candidate_id":"person","label":"Person","properties":{},
        "extensions":{"hobbies":[],"instantMessaging":[]},"evidence":[],
        "relation_suggestions":[{"source_candidate_id":"person","target_candidate_id":"company",
            "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole","roleName":"CEO"}},
            "uncertain":false,"evidence":[{"field_path":"$relation",
                "value":{"relation_type":"worksFor","source_id":"person","target_id":"company"},
                "source_type":"file","file_name":"resume.pdf","file_sha256":"abc",
                "quote":"任职甲公司","page":1,"locator_status":"located",
                "collected_at":"2026-09-26T00:00:00.000Z"}]}],"warnings":[],"can_commit":true});
    let company = json!({"candidate_id":"company","label":"Organization",
        "properties":{"name":"甲公司"},"evidence":[proof("properties.name",json!("甲公司"))],
        "relation_suggestions":[],"warnings":[],"can_commit":true});
    let import_id = ready(&store, vec![person, company]);
    let result = store.commit_import(&json!({
        "operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
        "import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"company","action":"create"}],
        "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"company",
            "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole","roleName":"CEO"}}}]
    }));
    assert_eq!(result.unwrap_err().code, "VALIDATION_ERROR");
    assert_eq!(count(&store, "kg_entities"), 0);
}

#[test]
fn merge_into_unnamed_target_still_checks_anonymous_relation_evidence() {
    for has_role_proof in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let anonymous = store
            .save_contact(&json!({
                "operation_id":"anonymous-target","actor":"reviewer","label":"Person",
                "set_properties":{"skills":["Python"]},
                "evidence":[proof("properties.skills",json!("Python"))]
            }))
            .unwrap();
        let target_id = anonymous["entity_id"].as_str().unwrap();
        let mut named = candidate("named", "陈晓");
        named["relation_suggestions"] = json!([{
            "source_candidate_id":"named","target_candidate_id":"company","relation_type":"worksFor",
            "properties":{"role":{"@type":"OrganizationRole","roleName":"CEO"}},"uncertain":false,
            "evidence":[{"field_path":"$relation","value":{"relation_type":"worksFor",
                "source_id":"named","target_id":"company"},"source_type":"file",
                "file_name":"resume.pdf","file_sha256":"abc","quote":"陈晓任职甲公司",
                "page":1,"locator_status":"located","collected_at":"2026-09-26T00:00:00.000Z"}]
        }]);
        if has_role_proof {
            named["relation_suggestions"][0]["evidence"]
                .as_array_mut()
                .unwrap()
                .push(
                    json!({"field_path":"properties.role.roleName","value":"CEO",
                "source_type":"file","file_name":"resume.pdf","file_sha256":"abc",
                "quote":"陈晓在甲公司担任CEO","page":1,"locator_status":"located",
                "collected_at":"2026-09-26T00:00:00.000Z"}),
                );
        }
        let company = json!({"candidate_id":"company","label":"Organization",
        "properties":{"name":"甲公司"},"evidence":[proof("properties.name",json!("甲公司"))],
        "relation_suggestions":[],"warnings":[],"can_commit":true});
        let import_id = ready(&store, vec![named, company]);
        let result = store.commit_import(&json!({
        "operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
        "import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"named","action":"merge","target_id":target_id,
            "expected_target_version":1},{"candidate_id":"company","action":"create"}],
        "relation_choices":[{"source_candidate_id":"named","target_candidate_id":"company",
            "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole","roleName":"CEO"}}}]
    }));
        if has_role_proof {
            assert_eq!(result.unwrap()["relations"].as_array().unwrap().len(), 1);
            let saved = store.get_contact(&json!({"entity_id":target_id})).unwrap();
            assert_eq!(saved["entity"]["properties"]["name"], "陈晓");
            assert_eq!(
                saved["relations"][0]["properties"]["role"]["roleName"],
                "CEO"
            );
            assert_eq!(saved["version"], 2);
            assert_eq!(count(&store, "kg_relations"), 1);
        } else {
            assert_eq!(result.unwrap_err().code, "VALIDATION_ERROR");
            let saved = store.get_contact(&json!({"entity_id":target_id})).unwrap();
            assert_eq!(saved["version"], 1);
            assert!(saved["entity"]["properties"].get("name").is_none());
            assert_eq!(count(&store, "kg_entities"), 1);
            assert_eq!(count(&store, "kg_relations"), 0);
        }
    }
}

#[test]
fn named_candidate_can_merge_into_an_unnamed_person_without_a_null_alias() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let anonymous = store
        .save_contact(&json!({"operation_id":"anonymous-target",
        "actor":"reviewer","label":"Person","set_properties":{"skills":["Python"]},
        "evidence":[proof("properties.skills",json!("Python"))]}))
        .unwrap();
    let id = anonymous["entity_id"].as_str().unwrap();
    let import_id = ready(&store, vec![candidate("named", "陈晓")]);
    let committed = store
        .commit_import(&json!({
            "operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
            "import_id":import_id,"expected_version":2,
            "choices":[{"candidate_id":"named","action":"merge","target_id":id,
                "expected_target_version":1,"keep_name":false}]
        }))
        .unwrap();
    assert_eq!(committed["results"][0]["entity_id"], id);
    let saved = store.get_contact(&json!({"entity_id":id})).unwrap();
    assert_eq!(saved["entity"]["properties"]["name"], "陈晓");
    assert_eq!(saved["entity"]["properties"]["alternateName"], json!([]));
}

#[test]
fn unlocated_file_evidence_cannot_commit_without_manual_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let mut proposed = candidate("uncertain", "Invented Person");
    proposed["can_commit"] = json!(false);
    proposed["evidence"] = json!([{
        "field_path":"properties.name", "value":"Invented Person",
        "source_type":"file", "file_name":"uncertain.pdf", "file_sha256":"abc",
        "quote":"unclear text", "locator_status":"unavailable",
        "collected_at":"2026-09-26T00:00:00.000Z"
    }]);
    let import_id = ready(&store, vec![proposed]);
    let mut commit = json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"uncertain","action":"create"}]});
    assert_eq!(
        store.commit_import(&commit).unwrap_err().code,
        "VALIDATION_ERROR"
    );
    assert_eq!(count(&store, "kg_entities"), 0);
    commit["choices"][0]["evidence"] = json!([proof("properties.name", json!("Invented Person"))]);
    let confirmed = store.commit_import(&commit).unwrap();
    assert_eq!(confirmed["status"], "committed");
    assert_eq!(count(&store, "kg_entities"), 1);
}

#[test]
fn preserves_located_file_evidence_for_a_confirmed_spouse_relation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let mut person = candidate("a", "陈晓");
    person["relation_suggestions"] = json!([{
        "source_candidate_id":"a","target_candidate_id":"b","relation_type":"spouse",
        "properties":{},"evidence":[{
            "evidence_id":"preview-relation-proof",
            "subject_kind":"relation","subject_id":"a:b",
            "field_path":"$relation",
            "value":{"relation_type":"spouse","source_id":"a","target_id":"b"},
            "source_type":"file","file_name":"resume.pdf","file_sha256":"aaa",
            "quote":"陈晓与李华为配偶","page":2,"locator_status":"located",
            "collected_at":"2026-09-26T00:00:00.000Z"
        }],"uncertain":false
    }]);
    let import_id = ready(&store, vec![person, candidate("b", "李华")]);
    let saved = store.commit_import(&json!({
        "operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
        "import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"a","action":"create"},{"candidate_id":"b","action":"create"}],
        "relation_choices":[{"source_candidate_id":"a","target_candidate_id":"b",
            "relation_type":"spouse","properties":{}}]
    })).unwrap();
    let relation_id = saved["relations"][0]["relation_id"].as_str().unwrap();
    let source: String = store.graph.connection().query_row(
        "SELECT json_extract(record_json,'$.source_type') FROM evidence WHERE subject_kind='relation' AND subject_id=?1 AND json_extract(record_json,'$.source_type')='file'",
        [relation_id], |row| row.get(0),
    ).unwrap();
    assert_eq!(source, "file");
}

#[test]
fn creates_selected_candidate_skips_other_and_replays_before_version_check() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("graph.sqlite");
    let payload;
    let entity_id;
    {
        let store = Store::open(&path).unwrap();
        let import_id = ready(&store, vec![candidate("a", "陈晓"), candidate("b", "李华")]);
        payload = json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
            "import_id":import_id,"expected_version":2,"choices":[
                {"candidate_id":"a","action":"create"},
                {"candidate_id":"b","action":"skip"}]});
        let result = store.commit_import(&payload).unwrap();
        assert_eq!(result["version"], 3);
        assert_eq!(result["status"], "committed");
        assert_eq!(result["replayed"], false);
        assert_eq!(result["results"].as_array().unwrap().len(), 2);
        entity_id = result["results"][0]["entity_id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(result["results"][1]["action"], "skip");
        assert_eq!(count(&store, "kg_entities"), 1);
        assert_eq!(count(&store, "evidence"), 1);
        assert_eq!(
            store
                .get_import_job(&json!({"import_id":import_id}))
                .unwrap()["status"],
            "committed"
        );
    }
    let store = Store::open(&path).unwrap();
    let replay = store.commit_import(&payload).unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["results"][0]["entity_id"], entity_id);
    assert_eq!(count(&store, "kg_entities"), 1);
    assert_eq!(count(&store, "evidence"), 1);
    let mut changed = payload.clone();
    changed["actor"] = json!("someone-else");
    assert_eq!(
        store.commit_import(&changed).unwrap_err().code,
        "OPERATION_CONFLICT"
    );
}

#[test]
fn second_invalid_choice_rolls_back_entities_evidence_job_and_operation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let import_id = ready(&store, vec![candidate("a", "陈晓"), candidate("b", "李华")]);
    let bad = json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
        "import_id":import_id,"expected_version":2,"choices":[
            {"candidate_id":"a","action":"create"},
            {"candidate_id":"b","action":"create","set_properties":{"email":["li@example.com"]}}]});
    assert_eq!(
        store.commit_import(&bad).unwrap_err().code,
        "VALIDATION_ERROR"
    );
    assert_eq!(count(&store, "kg_entities"), 0);
    assert_eq!(count(&store, "evidence"), 0);
    assert_eq!(count(&store, "audit_log"), 0);
    assert_eq!(
        store
            .get_import_job(&json!({"import_id":import_id}))
            .unwrap()["status"],
        "ready_for_review"
    );
    assert_eq!(count(&store, "operation_results"), 2);
}

#[test]
fn merge_updates_target_at_expected_version_and_keeps_existing_name() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let existing = store
        .save_contact(&json!({"operation_id":"existing","actor":"reviewer",
        "label":"Person","set_properties":{"name":"原名"},
        "evidence":[proof("properties.name",json!("原名"))]}))
        .unwrap();
    let target_id = existing["entity_id"].as_str().unwrap();
    let import_id = ready(&store, vec![candidate("a", "候选名")]);
    let result = store
        .commit_import(
            &json!({"operation_id":format!("contact-import:{import_id}"),
            "actor":"reviewer","import_id":import_id,"expected_version":2,"choices":[{
                "candidate_id":"a","action":"merge","target_id":target_id,
                "expected_target_version":1,"keep_name":true,
                "set_properties":{"jobTitle":"销售"},
                "evidence":[proof("properties.jobTitle",json!("销售"))]
            }]}),
        )
        .unwrap();
    assert_eq!(result["results"][0]["entity_id"], target_id);
    assert_eq!(result["results"][0]["version"], 2);
    let saved = store.get_contact(&json!({"entity_id":target_id})).unwrap();
    assert_eq!(saved["entity"]["properties"]["name"], "原名");
    assert_eq!(saved["entity"]["properties"]["jobTitle"], "销售");
    assert_eq!(count(&store, "kg_entities"), 1);
}

#[test]
fn requires_complete_candidate_selection_ready_status_and_prefixed_operation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let import_id = ready(&store, vec![candidate("a", "陈晓"), candidate("b", "李华")]);
    let base = json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
        "import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"a","action":"create"}]});
    assert_eq!(
        store.commit_import(&base).unwrap_err().code,
        "VALIDATION_ERROR"
    );
    let mut wrong_op = base.clone();
    wrong_op["operation_id"] = json!("other");
    assert_eq!(
        store.commit_import(&wrong_op).unwrap_err().code,
        "VALIDATION_ERROR"
    );
    assert_eq!(count(&store, "kg_entities"), 0);
}

#[test]
fn merge_does_not_clear_existing_arrays_from_normalized_candidate_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let existing = store.save_contact(&json!({"operation_id":"existing","actor":"reviewer",
        "label":"Person","set_properties":{"name":"原名","email":["old@example.com"]},
        "evidence":[proof("properties.name",json!("原名")),proof("properties.email",json!("old@example.com"))]})).unwrap();
    let target_id = existing["entity_id"].as_str().unwrap();
    let mut preview = candidate("a", "候选名");
    preview["properties"]["email"] = json!([]);
    let import_id = ready(&store, vec![preview]);
    let result = store
        .commit_import(
            &json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,"choices":[{
            "candidate_id":"a","action":"merge","target_id":target_id,
            "expected_target_version":1,"keep_name":true}]}),
        )
        .unwrap();
    assert_eq!(result["results"][0]["version"], 2);
    let saved = store.get_contact(&json!({"entity_id":target_id})).unwrap();
    assert_eq!(
        saved["entity"]["properties"]["email"],
        json!(["old@example.com"])
    );
}

#[test]
fn unnamed_preview_can_be_named_by_explicit_manual_correction() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let preview = json!({"candidate_id":"a","label":"Person","properties":{},
        "extensions":{"hobbies":[],"instantMessaging":[]},"evidence":[],
        "relation_suggestions":[],"warnings":[],"can_commit":false});
    let import_id = ready(&store, vec![preview]);
    let result = store
        .commit_import(
            &json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,"choices":[{
            "candidate_id":"a","action":"create","set_properties":{"name":"人工补名"},
            "evidence":[proof("properties.name",json!("人工补名"))]}]}),
        )
        .unwrap();
    assert_eq!(result["results"][0]["action"], "create");
    assert_eq!(count(&store, "kg_entities"), 1);
}

#[test]
fn explicit_rename_preserves_verified_old_name_as_alternate_name() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let existing = store
        .save_contact(&json!({"operation_id":"existing","actor":"reviewer",
        "label":"Person","set_properties":{"name":"原名"},
        "evidence":[proof("properties.name",json!("原名"))]}))
        .unwrap();
    let target_id = existing["entity_id"].as_str().unwrap();
    let import_id = ready(&store, vec![candidate("a", "新名")]);
    store
        .commit_import(
            &json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,"choices":[{
            "candidate_id":"a","action":"merge","target_id":target_id,
            "expected_target_version":1,"keep_name":false}]}),
        )
        .unwrap();
    let saved = store.get_contact(&json!({"entity_id":target_id})).unwrap();
    assert_eq!(saved["entity"]["properties"]["name"], "新名");
    assert_eq!(
        saved["entity"]["properties"]["alternateName"],
        json!(["原名"])
    );
    assert!(saved["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["field_path"] == "properties.alternateName" && e["value"] == "原名"));
}

#[test]
fn merge_unions_existing_and_candidate_contact_values() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let existing = store.save_contact(&json!({"operation_id":"existing","actor":"reviewer",
        "label":"Person","set_properties":{"name":"原名","email":["old@example.com"]},
        "evidence":[proof("properties.name",json!("原名")),proof("properties.email",json!("old@example.com"))]})).unwrap();
    let target_id = existing["entity_id"].as_str().unwrap();
    let mut preview = candidate("a", "候选名");
    preview["properties"]["email"] = json!(["new@example.com"]);
    preview["evidence"]
        .as_array_mut()
        .unwrap()
        .push(proof("properties.email", json!("new@example.com")));
    let import_id = ready(&store, vec![preview]);
    store
        .commit_import(
            &json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,"choices":[{
            "candidate_id":"a","action":"merge","target_id":target_id,
            "expected_target_version":1,"keep_name":true}]}),
        )
        .unwrap();
    let saved = store.get_contact(&json!({"entity_id":target_id})).unwrap();
    assert_eq!(
        saved["entity"]["properties"]["email"],
        json!(["old@example.com", "new@example.com"])
    );
}

#[test]
fn merge_skill_aliases_keeps_both_sources_without_appending_duplicate_names() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let existing = store
        .save_contact(&json!({"operation_id":"existing","actor":"reviewer",
        "label":"Person","set_properties":{"name":"本人","skills":["K8s","Python","MySQL"]},
        "evidence":[proof("properties.name",json!("本人")),proof("properties.skills",json!("K8s")),
            proof("properties.skills",json!("Python")),proof("properties.skills",json!("MySQL"))]}))
        .unwrap();
    let target_id = existing["entity_id"].as_str().unwrap();
    let mut preview = candidate("a", "本人");
    preview["properties"]["skills"] = json!(["Kubernetes", "python", "MongoDB"]);
    for skill in ["Kubernetes", "python", "MongoDB"] {
        preview["evidence"]
            .as_array_mut()
            .unwrap()
            .push(proof("properties.skills", json!(skill)));
    }
    let import_id = ready(&store, vec![preview]);
    let input = json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
        "import_id":import_id,"expected_version":2,"choices":[{"candidate_id":"a","action":"merge",
        "target_id":target_id,"expected_target_version":1,"keep_name":true}]});
    store.commit_import(&input).unwrap();
    let saved = store
        .get_contact(&json!({"entity_id":target_id,"evidence_limit":50}))
        .unwrap();
    assert_eq!(
        saved["entity"]["properties"]["skills"],
        json!(["K8s", "Python", "MySQL", "MongoDB"])
    );
    let evidence = saved["evidence"].as_array().unwrap();
    for skill in ["K8s", "Kubernetes", "Python", "python", "MySQL", "MongoDB"] {
        assert!(evidence
            .iter()
            .any(|e| e["field_path"] == "properties.skills" && e["value"] == skill));
    }
    let replay = store.commit_import(&input).unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(
        store.get_contact(&json!({"entity_id":target_id})).unwrap()["entity"]["properties"]
            ["skills"],
        json!(["K8s", "Python", "MySQL", "MongoDB"])
    );
}

#[test]
fn corrected_name_preserves_verified_old_name() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let existing = store
        .save_contact(&json!({"operation_id":"existing","actor":"reviewer",
        "label":"Person","set_properties":{"name":"原名"},
        "evidence":[proof("properties.name",json!("原名"))]}))
        .unwrap();
    let target_id = existing["entity_id"].as_str().unwrap();
    let import_id = ready(&store, vec![candidate("a", "候选名")]);
    store
        .commit_import(
            &json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,"choices":[{
            "candidate_id":"a","action":"merge","target_id":target_id,
            "expected_target_version":1,"set_properties":{"name":"确认新名"},
            "evidence":[proof("properties.name",json!("确认新名"))]}]}),
        )
        .unwrap();
    let saved = store.get_contact(&json!({"entity_id":target_id})).unwrap();
    assert_eq!(saved["entity"]["properties"]["name"], "确认新名");
    assert_eq!(
        saved["entity"]["properties"]["alternateName"],
        json!(["原名"])
    );
}

fn organization_candidate(id: &str, name: &str) -> Value {
    json!({"candidate_id":id,"label":"Organization","properties":{"name":name},
        "evidence":[proof("properties.name",json!(name))],
        "relation_suggestions":[],"warnings":[],"can_commit":true})
}

#[test]
fn selected_relation_uses_committed_ids_and_unselected_suggestion_stays_pending() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let mut person = candidate("person", "陈晓");
    let suggestion = json!({"source_candidate_id":"person","target_candidate_id":"org",
        "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole","roleName":"工程师"}},
        "evidence":[{"field_path":"properties.role.roleName","value":"工程师","source_type":"file",
            "collected_at":"2026-09-26T00:00:00.000Z","locator_status":"located",
        "file_name":"resume.pdf","file_sha256":"abc","quote":"曾任工程师","page":1},
        {"field_path":"properties.role.roleName","value":"工程师","source_type":"file",
            "collected_at":"2026-09-26T00:00:00.000Z","locator_status":"located",
            "file_name":"resume.pdf","file_sha256":"abc","quote":"负责系统开发","page":2},
        {"field_path":"properties.role.roleName","value":"工程师","source_type":"file",
            "collected_at":"2026-09-26T00:00:00.000Z","locator_status":"unavailable",
            "file_name":"resume.pdf","file_sha256":"abc"}],"uncertain":true});
    person["relation_suggestions"] = json!([suggestion.clone(),
        {"source_candidate_id":"person","target_candidate_id":"org",
        "relation_type":"alumniOf","properties":{},"evidence":[],"uncertain":false}]);
    let import_id = ready(
        &store,
        vec![person, organization_candidate("org", "甲公司")],
    );
    let result = store.commit_import(&json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"org","action":"create"}],
        "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"org",
            "relation_type":"worksFor","properties":suggestion["properties"]}]})).unwrap();
    assert_eq!(count(&store, "kg_relations"), 1);
    assert_eq!(result["relations"].as_array().unwrap().len(), 1);
    let person_id = result["results"][0]["entity_id"].as_str().unwrap();
    let org_id = result["results"][1]["entity_id"].as_str().unwrap();
    let edge = &result["relations"][0];
    assert_eq!(edge["source_id"], person_id);
    assert_eq!(edge["target_id"], org_id);
    let relation_evidence: i64 = store
        .graph
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM evidence WHERE subject_kind='relation'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(relation_evidence, 4);
    let sourced: i64 = store.graph.connection().query_row(
        "SELECT COUNT(*) FROM evidence WHERE subject_kind='relation' AND json_extract(record_json,'$.source_type')='file'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(sourced, 2);
    assert_eq!(
        store
            .list_relations(&json!({"entity_id":person_id}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn unoffered_relation_choice_rolls_back_created_contacts() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let import_id = ready(
        &store,
        vec![
            candidate("person", "陈晓"),
            organization_candidate("org", "甲公司"),
        ],
    );
    let result = store.commit_import(&json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"org","action":"create"}],
        "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"org",
            "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole"}}}]}));
    assert_eq!(result.unwrap_err().code, "VALIDATION_ERROR");
    assert_eq!(count(&store, "kg_entities"), 0);
    assert_eq!(count(&store, "kg_relations"), 0);
    assert_eq!(count(&store, "evidence"), 0);
    assert_eq!(
        store
            .get_import_job(&json!({"import_id":import_id}))
            .unwrap()["status"],
        "ready_for_review"
    );
}

#[test]
fn selected_relation_cannot_use_a_skipped_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let mut person = candidate("person", "陈晓");
    person["relation_suggestions"] = json!([{"source_candidate_id":"person",
        "target_candidate_id":"org","relation_type":"worksFor",
        "properties":{"role":{"@type":"OrganizationRole"}},"evidence":[],"uncertain":false}]);
    let import_id = ready(
        &store,
        vec![person, organization_candidate("org", "甲公司")],
    );
    let result = store.commit_import(&json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"org","action":"skip"}],
        "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"org",
            "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole"}}}]}));
    assert_eq!(result.unwrap_err().code, "VALIDATION_ERROR");
    assert_eq!(count(&store, "kg_entities"), 0);
    assert_eq!(count(&store, "kg_relations"), 0);
}

fn claim_preview() -> Vec<Value> {
    let mut person = candidate("person", "示例甲");
    person["review_items"] = json!([{"kind":"field","field_path":"properties.skills",
        "value":"Rust","reason":"missing_evidence","page":1,"quote":"Rust"}]);
    let org = json!({"candidate_id":"company","label":"Organization",
        "properties":{"name":"示例公司"},"evidence":[proof("properties.name",json!("示例公司"))],
        "relation_suggestions":[{"source_candidate_id":"person","target_candidate_id":"company",
            "relation_type":"worksFor","properties":{"role":{"@type":"OrganizationRole"}},
            "uncertain":true,"review_reason":"structured_heading",
            "evidence":[{"field_path":"$relation","value":{},"source_type":"file",
                "file_sha256":"example-hash","page":1,"quote":"工作经历：示例公司"}]}],
        "review_items":[],"can_commit":true});
    vec![person, org]
}

fn claim_commit(import_id: &str, person_action: &str, company_action: &str) -> Value {
    json!({"operation_id":format!("contact-import:{import_id}"),"actor":"reviewer",
        "import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"person","action":person_action},
            {"candidate_id":"company","action":company_action}]})
}

#[test]
fn claims_preserve_unselected_suggestions_on_the_source_without_promoting_or_replaying() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let import_id = ready(&store, claim_preview());
    let input = claim_commit(&import_id, "create", "skip");
    let result = store.commit_import(&input).unwrap();
    let id = &result["results"][0]["entity_id"];
    let loaded = store.get_contact(&json!({"entity_id":id})).unwrap();
    let claims = loaded["unverified_claims"].as_array().expect("claims page");
    assert_eq!(claims.len(), 2);
    assert_eq!(count(&store, "entity_ids"), 1);
    assert_eq!(count(&store, "kg_relations"), 0);
    assert_eq!(loaded["entity"]["properties"]["skills"], json!([]));
    for claim in claims {
        assert_eq!(&claim["subject_id"], id);
        assert_eq!(claim["status"], "unverified");
    }
    let relation = claims.iter().find(|c| c["kind"] == "relation").unwrap();
    assert!(relation["target_id"].is_null());
    assert_eq!(relation["value"]["target_name"], "示例公司");
    assert_eq!(relation["reason"], "structured_heading");
    assert_eq!(relation["source"]["quote"], "工作经历：示例公司");
    assert_eq!(store.commit_import(&input).unwrap()["replayed"], true);
    assert_eq!(count(&store, "contact_claims"), 2);
    let page = store
        .get_contact(&json!({"entity_id":id,"claim_limit":1}))
        .unwrap();
    assert_eq!(page["unverified_claims"].as_array().unwrap().len(), 1);
    assert_eq!(page["pagination"]["unverified_claims"]["total"], 2);
    assert_eq!(page["pagination"]["unverified_claims"]["next_offset"], 1);
    let next = store
        .get_contact(&json!({"entity_id":id,"claim_limit":1,"claim_offset":1}))
        .unwrap();
    assert_ne!(
        page["unverified_claims"][0]["claim_id"],
        next["unverified_claims"][0]["claim_id"]
    );
    assert_eq!(page["evidence"], next["evidence"]);
    assert!(store
        .get_contact(&json!({"entity_id":id,"claim_limit":51}))
        .is_err());
}

#[test]
fn relation_review_items_never_create_edges_and_skipped_sources_get_no_claims() {
    for skip_person in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let mut preview = claim_preview();
        preview[1]["review_items"] = json!([{"kind":"relation","source_candidate_id":"person",
            "target_candidate_id":"company","relation_type":"alumniOf","properties":{},
            "reason":"ambiguous_owner","quote":"示例公司"}]);
        let import_id = ready(&store, preview);
        let result = store
            .commit_import(&claim_commit(
                &import_id,
                if skip_person { "skip" } else { "create" },
                "create",
            ))
            .unwrap();
        assert_eq!(count(&store, "kg_relations"), 0);
        assert_eq!(
            count(&store, "contact_claims"),
            if skip_person { 0 } else { 3 }
        );
        if !skip_person {
            let loaded = store
                .get_contact(&json!({"entity_id":result["results"][0]["entity_id"]}))
                .unwrap();
            assert_eq!(loaded["unverified_claims"].as_array().unwrap().len(), 3);
        }
    }
}

#[test]
fn claim_insert_failure_rolls_back_entities_mapping_and_preview_status() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let import_id = ready(&store, claim_preview());
    store.graph.connection().execute_batch("CREATE TRIGGER fail_claim BEFORE INSERT ON contact_claims BEGIN SELECT RAISE(ABORT, 'test rollback'); END;").unwrap();
    assert!(store
        .commit_import(&claim_commit(&import_id, "create", "skip"))
        .is_err());
    for table in [
        "entity_ids",
        "kg_entities",
        "source_mapping",
        "contact_claims",
    ] {
        assert_eq!(count(&store, table), 0);
    }
    assert_eq!(
        store
            .get_import_job(&json!({"import_id":import_id}))
            .unwrap()["status"],
        "ready_for_review"
    );
}

#[test]
fn claims_follow_manual_subject_and_organization_merges() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let import_id = ready(&store, claim_preview());
    let result = store
        .commit_import(&claim_commit(&import_id, "create", "create"))
        .unwrap();
    let person = &result["results"][0]["entity_id"];
    let org = &result["results"][1]["entity_id"];
    let mut survivors = vec![];
    for (label, source) in [("Person", person), ("Organization", org)] {
        let survivor = store.save_contact(&json!({"operation_id":format!("create-{label}"),"actor":"reviewer",
            "label":label,"set_properties":{"name":"目标样例"},"evidence":[proof("properties.name",json!("目标样例"))]})).unwrap()["entity_id"].clone();
        store.merge_contacts(&json!({"operation_id":format!("merge-{label}"),"actor":"reviewer",
            "source_id":source,"target_id":survivor,"expected_source_version":1,"expected_target_version":1})).unwrap();
        assert!(store
            .get_contact(&json!({"entity_id":source}))
            .unwrap()
            .is_null());
        survivors.push(survivor);
    }
    let loaded = store
        .get_contact(&json!({"entity_id":survivors[0]}))
        .unwrap();
    let claims = loaded["unverified_claims"].as_array().expect("claims page");
    assert_eq!(claims.len(), 2);
    assert!(claims.iter().all(|c| c["subject_id"] == survivors[0]));
    assert_eq!(
        claims.iter().find(|c| c["kind"] == "relation").unwrap()["target_id"],
        survivors[1]
    );
}

#[test]
fn claims_do_not_make_an_empty_anonymous_candidate_committable() {
    for action in ["skip", "create"] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let mut person = candidate("person", "示例甲");
        person["properties"] = json!({});
        person["evidence"] = json!([]);
        person["can_commit"] = json!(false);
        person["review_items"] = json!([{"kind":"field","field_path":"properties.skills",
            "value":"Rust","reason":"missing_evidence"}]);
        let import_id = ready(&store, vec![person]);
        let result = store.commit_import(
            &json!({"operation_id":format!("contact-import:{import_id}"),
            "actor":"reviewer","import_id":import_id,"expected_version":2,
            "choices":[{"candidate_id":"person","action":action}]}),
        );
        assert_eq!(result.is_ok(), action == "skip");
        assert_eq!(count(&store, "entity_ids"), 0);
        assert_eq!(count(&store, "contact_claims"), 0);
    }
}

#[test]
fn claims_are_deduplicated_bounded_and_persist_on_import_merge() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let target = store
        .save_contact(
            &json!({"operation_id":"target","actor":"reviewer","label":"Person",
        "set_properties":{"name":"示例甲"},"evidence":[proof("properties.name",json!("示例甲"))]}),
        )
        .unwrap();
    let mut previews = claim_preview();
    let duplicate = previews[1]["relation_suggestions"][0].clone();
    previews[0]["relation_suggestions"] = json!([duplicate]);
    previews[0]["review_items"] = json!((0..100).map(|index| json!({"kind":"field",
        "field_path":"properties.skills","value":format!("skill-{index}"),"reason":"missing_evidence",
        "quote":"例".repeat(500)})).collect::<Vec<_>>());
    let import_id = ready(&store, previews);
    let mut input = claim_commit(&import_id, "merge", "skip");
    input["choices"][0]["target_id"] = target["entity_id"].clone();
    input["choices"][0]["expected_target_version"] = json!(1);
    store.commit_import(&input).unwrap();
    assert_eq!(count(&store, "contact_claims"), 101);
    let loaded = store
        .get_contact(&json!({"entity_id":target["entity_id"]}))
        .unwrap();
    assert_eq!(loaded["unverified_claims"].as_array().unwrap().len(), 10);
    assert!(loaded.to_string().len() < 256 * 1024);
    assert_eq!(loaded["pagination"]["unverified_claims"]["total"], 101);
}

#[test]
fn oversized_review_items_fail_without_partial_graph_writes() {
    for oversized in [json!([{"kind":"field","field_path":"properties.skills","value":"x".repeat(2048),"reason":"missing_evidence"}]),
        json!((0..101).map(|_| json!({"kind":"field","field_path":"properties.skills","value":"Rust","reason":"missing_evidence"})).collect::<Vec<_>>())] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let mut previews = claim_preview();
        previews[0]["review_items"] = oversized;
        let import_id = ready(&store, previews);
        assert!(store.commit_import(&claim_commit(&import_id,"create","skip")).is_err());
        assert_eq!(count(&store,"contact_claims"),0);
        assert_eq!(count(&store,"entity_ids"),0);
    }
}

#[test]
fn invalid_relation_endpoint_clue_does_not_block_a_supported_person() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let mut person = candidate("person", "示例甲");
    person["review_items"] = json!([{"kind":"relation","source_candidate_id":"person",
        "target_candidate_id":"person","relation_type":"worksFor","properties":{},"reason":"invalid_shape"}]);
    let import_id = ready(&store, vec![person]);
    store
        .commit_import(
            &json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"}]}),
        )
        .unwrap();
    assert_eq!(count(&store, "contact_claims"), 1);
    assert_eq!(count(&store, "kg_relations"), 0);
}

#[test]
fn claim_sources_bound_serialized_unicode_and_escaping_without_losing_file_identity() {
    for quote in ["😀".repeat(491), "\u{0001}".repeat(491)] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let mut previews = claim_preview();
        let file_name = format!("{}.pdf", "f".repeat(100));
        let hash = "a".repeat(64);
        let source = &mut previews[1]["relation_suggestions"][0]["evidence"][0];
        source["quote"] = json!(quote);
        source["file_name"] = json!(file_name);
        source["file_sha256"] = json!(hash);
        let import_id = ready(&store, previews);
        let result = store
            .commit_import(&claim_commit(&import_id, "create", "skip"))
            .unwrap();
        let loaded = store
            .get_contact(&json!({"entity_id":result["results"][0]["entity_id"]}))
            .unwrap();
        let claim = loaded["unverified_claims"]
            .as_array()
            .unwrap()
            .iter()
            .find(|claim| claim["kind"] == "relation")
            .unwrap();
        let source = &claim["source"];
        assert_eq!(source["file_name"], file_name);
        assert_eq!(source["file_sha256"], hash);
        assert_eq!(source["page"], 1);
        assert!(source.to_string().len() <= 2048);
        let saved_quote = source["quote"].as_str().unwrap();
        assert!(!saved_quote.is_empty());
        assert!(quote.starts_with(saved_quote));
        assert_eq!(count(&store, "kg_relations"), 0);
    }
}

#[test]
fn auto_selected_cannot_promote_uncertainty_or_cross_subject_relation_proof() {
    for mode in ["uncertain", "cross_subject", "wrong_kind"] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let mut person = candidate("person", "陈晓");
        let mut suggestion = json!({"source_candidate_id":"person","target_candidate_id":"org",
            "relation_type":"alumniOf","properties":{},"uncertain":false,
            "evidence":[{"field_path":"$relation","value":{"relation_type":"alumniOf","source_id":"person","target_id":"org"},
                "subject_kind":"relation","subject_id":"person:org","source_type":"file",
                "file_name":"resume.pdf","file_sha256":"abc","quote":"教育经历","page":1,
                "locator_status":"located","collected_at":"2026-09-26T00:00:00.000Z"}]});
        match mode {
            "uncertain" => suggestion["uncertain"] = json!(true),
            "cross_subject" => suggestion["evidence"][0]["subject_id"] = json!("other:org"),
            _ => suggestion["evidence"][0]["subject_kind"] = json!("entity"),
        }
        person["relation_suggestions"] = json!([suggestion]);
        let import_id = ready(
            &store,
            vec![person, organization_candidate("org", "星辰大学")],
        );
        let result = store.commit_import(&json!({"operation_id":format!("contact-import:{import_id}"),
            "actor":"reviewer","import_id":import_id,"expected_version":2,"auto_selected_relations":true,
            "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"org","action":"create"}],
            "relation_choices":[{"source_candidate_id":"person","target_candidate_id":"org","relation_type":"alumniOf","properties":{}}]}));
        assert_eq!(result.unwrap_err().code, "VALIDATION_ERROR", "{mode}");
        assert_eq!(count(&store, "kg_entities"), 0);
    }
}

#[test]
fn public_writes_reject_self_certified_file_sources() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let forged = json!({"field_path":"properties.skills","value":"伪造资质","source_type":"file",
        "locator_status":"located","file_name":"never-uploaded.pdf","file_sha256":"abc",
        "collected_at":"2026-09-26T00:00:00.000Z","quote":"无关原文"});
    assert_eq!(
        store
            .save_contact(
                &json!({"operation_id":"forged-save","actor":"reviewer","label":"Person",
        "set_properties":{"skills":["伪造资质"]},"evidence":[forged.clone()]})
            )
            .unwrap_err()
            .code,
        "VALIDATION_ERROR"
    );
    let import_id = ready(&store, vec![candidate("person", "陈晓")]);
    assert_eq!(store.commit_import(&json!({"operation_id":format!("contact-import:{import_id}"),
        "actor":"reviewer","import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create","set_properties":{"skills":["伪造资质"]},
            "evidence":[forged]}]})).unwrap_err().code, "VALIDATION_ERROR");
    assert_eq!(count(&store, "kg_entities"), 0);
}

#[test]
fn public_relation_write_cannot_mint_file_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let mut ids = Vec::new();
    for name in ["Person A", "Person B"] {
        ids.push(
            store
                .save_contact(
                    &json!({"operation_id":name,"actor":"reviewer","label":"Person",
            "set_properties":{"name":name},"evidence":[proof("properties.name",json!(name))]}),
                )
                .unwrap()["entity_id"]
                .clone(),
        );
    }
    assert_eq!(store.save_relation(&json!({"operation_id":"forged-edge","actor":"reviewer",
        "source_id":ids[0],"target_id":ids[1],"relation_type":"colleague","properties":{},
        "evidence":[{"field_path":"$relation","value":{"relation_type":"colleague","source_id":ids[0],"target_id":ids[1]},
            "source_type":"file","locator_status":"located","file_name":"never-uploaded.pdf",
            "file_sha256":"abc","quote":"unrelated","collected_at":"2026-09-26T00:00:00Z"}]})).unwrap_err().code, "VALIDATION_ERROR");
    assert_eq!(count(&store, "kg_relations"), 0);
}

#[test]
fn long_project_claim_display_is_bounded_without_losing_saved_target_or_replay_warning() {
    for name in ["项目".repeat(300), "😀".repeat(900)] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
        let mut previews = claim_preview();
        let description = "描\"\n😀".repeat(800);
        previews[0]["review_items"] = json!([]);
        previews[1]["label"] = json!("Project");
        previews[1]["properties"] = json!({"name":name,"description":description});
        previews[1]["evidence"] = json!([
            proof("properties.name", json!(name)),
            proof("properties.description", json!(description))
        ]);
        previews[1]["relation_suggestions"][0]["relation_type"] = json!("memberOf");
        let import_id = ready(&store, previews);
        let input = claim_commit(&import_id, "create", "create");
        let result = store.commit_import(&input).unwrap();
        let person = store
            .get_contact(&json!({"entity_id":result["results"][0]["entity_id"]}))
            .unwrap();
        let project = store
            .get_contact(&json!({"entity_id":result["results"][1]["entity_id"]}))
            .unwrap();
        let claim = &person["unverified_claims"][0];
        assert_eq!(claim["target_id"], project["entity"]["entity_id"]);
        assert_eq!(claim["value"]["target_candidate_id"], "company");
        assert!(claim["value"].to_string().len() <= 2048);
        assert!(name.starts_with(claim["value"]["target_name"].as_str().unwrap()));
        assert!(description.starts_with(claim["value"]["target_description"].as_str().unwrap()));
        assert_eq!(project["entity"]["properties"]["description"], description);
        assert_eq!(project["entity"]["properties"]["name"], name);
        assert_eq!(result["warnings"].as_array().unwrap().len(), 1);
        assert_eq!(
            store.commit_import(&input).unwrap()["warnings"],
            result["warnings"]
        );
        assert_eq!(count(&store, "contact_claims"), 1);
        assert_eq!(count(&store, "kg_relations"), 0);
    }
}
