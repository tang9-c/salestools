use contact_graph::{protocol::parse_and_dispatch, store::Store};
use rusqlite::params;
use serde_json::{json, Value};

const T1: &str = "2026-10-13T01:00:00Z";
const T2: &str = "2026-10-13T02:00:00Z";
const T3: &str = "2026-10-13T03:00:00Z";

fn call(store: &Store, op: &str, payload: Value) -> Value {
    parse_and_dispatch(
        &serde_json::to_vec(
            &json!({"version":1,"request_id":"zoho-test","op":op,"payload":payload}),
        )
        .unwrap(),
        store,
    )
}

fn company(connection: &str, account: &str, record: &str, title: Value) -> Value {
    json!({"connection_id":connection,"account_id":account,"company_name":"甲公司",
        "account_owner":{"id":"owner-account","name":"客户负责人"},
        "contacts":[{"record_id":record,"name":"张明","title":title,
            "contact_owner":{"id":"owner-contact","name":"联系人负责人"},"modified_at":T1}]})
}

fn input(operation: &str, time: &str, companies: Vec<Value>) -> Value {
    json!({"operation_id":operation,"actor":"user-a","collected_at":time,"companies":companies})
}

fn sync(store: &Store, operation: &str, time: &str, companies: Vec<Value>) -> Value {
    let reply = call(
        store,
        "sync_zoho_contacts",
        input(operation, time, companies),
    );
    assert_eq!(reply["ok"], true, "{reply}");
    reply["result"].clone()
}

fn detail(store: &Store, id: &str) -> Value {
    store.get_contact(&json!({"entity_id":id})).unwrap()
}

// Locate identities by CRM IDs, never by mutable display names or private key encoding.
fn mapped(store: &Store, connection: &str, module: &str, record: &str) -> (String, Value) {
    let (id, raw): (String, String) = store
        .graph
        .connection()
        .query_row(
            "SELECT entity_id,source_json FROM source_mapping WHERE relation_id IS NULL
         AND json_extract(source_json,'$.source_connection_id')=?1
         AND json_extract(source_json,'$.source_module')=?2
         AND json_extract(source_json,'$.source_record_id')=?3",
            params![connection, module, record],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    (id, serde_json::from_str(&raw).unwrap())
}

fn count(store: &Store, table: &str) -> i64 {
    store
        .graph
        .connection()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn contact_source_snapshots(store: &Store) -> Vec<Value> {
    let mut query = store
        .graph
        .connection()
        .prepare(
            "SELECT source_json FROM source_mapping
         WHERE json_extract(source_json,'$.source_connection_id')='crm_a'
           AND json_extract(source_json,'$.source_module')='Contacts'
           AND json_extract(source_json,'$.source_record_id')='contact-a'
         ORDER BY relation_id",
        )
        .unwrap();
    query
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| serde_json::from_str(&row.unwrap()).unwrap())
        .collect()
}

fn assert_collection_watermark_survives_older_delivery(newer_modified: bool) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let mut data = company("crm_a", "account-a", "contact-a", json!("A"));
    sync(&store, "latest-collection", T3, vec![data.clone()]);
    let (id, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    let before = detail(&store, &id);
    let mut expected_sources = contact_source_snapshots(&store);
    assert_eq!(
        expected_sources.len(),
        2,
        "Person and employment each have a source snapshot"
    );
    if newer_modified {
        data["contacts"][0]["modified_at"] = json!(T2);
        for source in &mut expected_sources {
            source["modified_at"] = json!(T2);
        }
    }
    let delivery = sync(&store, "older-collection", T1, vec![data.clone()]);
    if newer_modified {
        counts(&delivery, 0, 1, 0, 0);
    } else {
        counts(&delivery, 0, 0, 1, 0);
    }
    assert_eq!(
        detail(&store, &id),
        before,
        "time-only delivery must not change evidence or versions"
    );
    assert_eq!(contact_source_snapshots(&store),expected_sources,
        "Neither the Person nor the employment collection watermark may regress, even with a newer modified_at");

    data["contacts"][0]["title"] = json!("旧B");
    data["contacts"][0]["modified_at"] = Value::Null;
    let fallback = sync(&store, "older-missing-modified", T2, vec![data]);
    counts(&fallback, 0, 0, 1, 0);
    assert_eq!(fallback["entity_ids"], json!([]));
    assert_eq!(
        detail(&store, &id),
        before,
        "fallback must preserve display, all evidence, entity and index versions"
    );
    assert_eq!(contact_source_snapshots(&store), expected_sources);
}

#[test]
fn same_modified_at_older_collection_does_not_regress_person_or_employment_watermarks() {
    assert_collection_watermark_survives_older_delivery(false);
}

#[test]
fn newer_modified_at_older_collection_keeps_watermark_for_later_missing_modified_fallback() {
    assert_collection_watermark_survives_older_delivery(true);
}

fn counts(result: &Value, created: u64, updated: u64, unchanged: u64, archived: u64) {
    for (key, expected) in [
        ("created", created),
        ("updated", updated),
        ("unchanged", unchanged),
        ("archived", archived),
    ] {
        assert_eq!(result[key], expected, "{result}");
    }
}

fn manual(store: &Store, id: Option<&str>, name: &str, title: &str, op: &str) -> String {
    let proof = |path: &str, value: &str| {
        json!({"field_path":path,"value":value,
        "source_type":"manual","locator_status":"not_applicable","collected_at":T1})
    };
    let mut payload = json!({"operation_id":op,"actor":"reviewer","label":"Person",
        "set_properties":{"name":name,"jobTitle":title},
        "evidence":[proof("properties.name",name),proof("properties.jobTitle",title)]});
    if let Some(id) = id {
        payload["entity_id"] = json!(id);
        payload["expected_version"] = detail(store, id)["entity"]["metadata"]["version"].clone();
    }
    store.save_contact(&payload).unwrap()["entity_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn first_sync_creates_located_facts_unknown_employment_and_searchable_person() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let result = sync(
        &store,
        "first",
        T1,
        vec![company(
            "crm_a",
            "account-a",
            "contact-a",
            json!("研发总监"),
        )],
    );
    counts(&result, 1, 0, 0, 0);
    let (id, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    assert_eq!(result["entity_ids"], json!([id]));
    assert_eq!(count(&store, "entity_ids"), 2);
    assert_eq!(count(&store, "relation_ids"), 1);
    assert_eq!(count(&store, "import_jobs"), 0);
    let found = detail(&store, &id);
    assert_eq!(
        found["entity"]["properties"],
        json!({"name":"张明","jobTitle":"研发总监"})
    );
    assert_eq!(
        found["relations"][0]["metadata"]["employment_status"],
        "unknown"
    );
    assert!(found["relations"][0]["properties"]["role"]["startDate"].is_null());
    assert!(found["relations"][0]["properties"]["role"]["endDate"].is_null());
    for evidence in found["evidence"].as_array().unwrap() {
        assert_eq!(evidence["source_type"], "zoho");
        assert_eq!(evidence["source_connection_id"], "crm_a");
        assert_eq!(evidence["source_module"], "Contacts");
        assert_eq!(evidence["source_record_id"], "contact-a");
        assert_eq!(evidence["locator_status"], "not_applicable");
        assert!(evidence.get("source_url").is_none());
        assert!(evidence.get("quote").is_none());
    }
    let search = call(&store, "search_keyword", json!({"query":"研发总监"}));
    assert_eq!(search["ok"], true, "{search}");
    assert!(search["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["entity_id"] == id));
    assert_eq!(found["index_status"], "unindexed");
}

#[test]
fn repeated_content_and_operation_replay_do_not_grow_facts_evidence_or_versions() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("graph.db");
    let store = Store::open(&path).unwrap();
    let original = company("crm_a", "account-a", "contact-a", json!("总监"));
    sync(&store, "first", T1, vec![original.clone()]);
    let (id, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    let before = detail(&store, &id);
    let sizes = [
        count(&store, "entity_ids"),
        count(&store, "relation_ids"),
        count(&store, "evidence"),
        count(&store, "source_mapping"),
    ];
    counts(
        &sync(&store, "second", T2, vec![original.clone()]),
        0,
        0,
        1,
        0,
    );
    assert_eq!(detail(&store, &id), before);
    assert_eq!(
        [
            count(&store, "entity_ids"),
            count(&store, "relation_ids"),
            count(&store, "evidence"),
            count(&store, "source_mapping")
        ],
        sizes
    );
    drop(store);
    let store = Store::open(&path).unwrap();
    counts(
        &sync(&store, "second", T2, vec![original.clone()]),
        0,
        0,
        1,
        0,
    );
    assert_eq!(detail(&store, &id), before);
    let conflict = call(
        &store,
        "sync_zoho_contacts",
        input("second", T3, vec![original]),
    );
    assert_eq!(conflict["error"]["code"], "OPERATION_CONFLICT");
}

#[test]
fn newer_title_and_name_update_same_record_keep_history_and_invalidate_index() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let mut data = company("crm_a", "account-a", "contact-a", json!("总监"));
    sync(&store, "first", T1, vec![data.clone()]);
    let (id, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    let before = detail(&store, &id);
    let version = before["index_content_version"].as_u64().unwrap();
    assert_eq!(
        call(
            &store,
            "set_vector_state",
            json!({"operation_id":"pending","actor":"system","action":"set","entity_id":id,"content_version":version,"state":"pending"})
        )["ok"],
        true
    );
    data["contacts"][0]["name"] = json!("张明新");
    data["contacts"][0]["title"] = json!("技术经理");
    data["contacts"][0]["modified_at"] = json!(T2);
    let result = sync(&store, "change", T2, vec![data]);
    counts(&result, 0, 1, 0, 0);
    assert_eq!(result["entity_ids"], json!([id]));
    assert_eq!(mapped(&store, "crm_a", "Contacts", "contact-a").0, id);
    let after = detail(&store, &id);
    assert_eq!(after["entity"]["properties"]["name"], "张明新");
    assert_eq!(after["entity"]["properties"]["jobTitle"], "技术经理");
    assert_eq!(
        after["relations"][0]["properties"]["role"]["roleName"],
        "技术经理"
    );
    assert!(
        after["entity"]["metadata"]["version"].as_u64().unwrap()
            > before["entity"]["metadata"]["version"].as_u64().unwrap()
    );
    assert!(after["index_content_version"].as_u64().unwrap() > version);
    assert_eq!(after["index_status"], "unindexed");
    for value in ["总监", "技术经理"] {
        assert!(after["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["field_path"] == "properties.jobTitle" && item["value"] == value));
    }
    assert_eq!(count(&store, "entity_ids"), 2);
    assert_eq!(count(&store, "relation_ids"), 1);
}

#[test]
fn empty_title_retains_display_and_manual_values_keep_new_crm_conflict_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let mut data = company("crm_a", "account-a", "contact-a", json!("总监"));
    sync(&store, "first", T1, vec![data.clone()]);
    let (id, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    for (index, title) in [Value::Null, json!("")].into_iter().enumerate() {
        data["contacts"][0]["title"] = title;
        data["contacts"][0]["modified_at"] = json!(T2);
        sync(&store, &format!("empty-{index}"), T2, vec![data.clone()]);
        assert_eq!(
            detail(&store, &id)["entity"]["properties"]["jobTitle"],
            "总监"
        );
        assert_eq!(
            detail(&store, &id)["relations"][0]["properties"]["role"]["roleName"],
            "总监"
        );
    }
    manual(&store, Some(&id), "人工姓名", "人工职位", "manual");
    data["contacts"][0]["name"] = json!("CRM新姓名");
    data["contacts"][0]["title"] = json!("CRM新职位");
    data["contacts"][0]["modified_at"] = json!(T3);
    sync(&store, "conflict", T3, vec![data]);
    let after = detail(&store, &id);
    assert_eq!(after["entity"]["properties"]["name"], "人工姓名");
    assert_eq!(after["entity"]["properties"]["jobTitle"], "人工职位");
    for value in ["CRM新姓名", "CRM新职位"] {
        assert!(after["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["value"] == value && item["source_type"] == "zoho"));
    }
}

#[test]
fn source_freshness_uses_modified_time_then_collection_time_and_preserves_a_b_a_history() {
    for with_modified in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path().join("graph.db")).unwrap();
        let mut data = company("crm_a", "account-a", "contact-a", json!("A"));
        if !with_modified {
            data["contacts"][0]["modified_at"] = Value::Null;
        }
        sync(&store, "a", T1, vec![data.clone()]);
        let (id, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
        let mut b = data.clone();
        b["contacts"][0]["title"] = json!("B");
        if with_modified {
            b["contacts"][0]["modified_at"] = json!(T2);
        }
        sync(&store, "b", T2, vec![b]);
        let evidence_count = count(&store, "evidence");
        let late_time = if with_modified { T3 } else { T1 };
        counts(
            &sync(&store, "late", late_time, vec![data.clone()]),
            0,
            0,
            1,
            0,
        );
        assert_eq!(detail(&store, &id)["entity"]["properties"]["jobTitle"], "B");
        assert_eq!(count(&store, "evidence"), evidence_count);
        if with_modified {
            data["contacts"][0]["modified_at"] = json!(T3);
        }
        counts(&sync(&store, "a-again", T3, vec![data]), 0, 1, 0, 0);
        let result = detail(&store, &id);
        assert_eq!(result["entity"]["properties"]["jobTitle"], "A");
        let values: Vec<&str> = result["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["subject_kind"] == "entity" && e["field_path"] == "properties.jobTitle")
            .map(|e| e["value"].as_str().unwrap())
            .collect();
        assert_eq!(values, vec!["A", "B", "A"]);
    }
}

#[test]
fn owner_only_changes_remain_in_source_metadata_without_person_or_index_changes() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let mut data = company("crm_a", "account-a", "contact-a", json!("总监"));
    sync(&store, "first", T1, vec![data.clone()]);
    let (id, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    let before = detail(&store, &id);
    let evidence = count(&store, "evidence");
    data["account_owner"] = json!({"id":"new-account-owner","name":"新客户负责人"});
    data["contacts"][0]["contact_owner"] =
        json!({"id":"new-contact-owner","name":"新联系人负责人"});
    data["contacts"][0]["modified_at"] = json!(T2);
    let result = sync(&store, "owners", T2, vec![data]);
    counts(&result, 0, 1, 0, 0);
    assert_eq!(result["entity_ids"], json!([]));
    assert_eq!(detail(&store, &id), before);
    assert_eq!(count(&store, "evidence"), evidence);
    assert_eq!(count(&store, "entity_ids"), 2);
    assert_eq!(count(&store, "relation_ids"), 1);
    assert_eq!(
        mapped(&store, "crm_a", "Contacts", "contact-a").1["contact_owner"]["id"],
        "new-contact-owner"
    );
    assert_eq!(
        mapped(&store, "crm_a", "Accounts", "account-a").1["account_owner"]["id"],
        "new-account-owner"
    );
}

#[test]
fn one_record_across_two_companies_keeps_both_employments_and_partial_sync_keeps_missing_people() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let a = company("crm_a", "account-a", "contact-a", json!("总监"));
    let mut b = company("crm_a", "account-b", "contact-a", json!("总监"));
    b["company_name"] = json!("乙公司");
    counts(&sync(&store, "first", T1, vec![a.clone(), b]), 1, 0, 0, 0);
    let (id, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    assert_eq!(count(&store, "entity_ids"), 3);
    assert_eq!(
        detail(&store, &id)["relations"].as_array().unwrap().len(),
        2
    );
    sync(&store, "partial", T2, vec![a]);
    assert_eq!(
        detail(&store, &id)["relations"].as_array().unwrap().len(),
        2
    );
    counts(&sync(&store, "empty", T3, vec![]), 0, 0, 0, 0);
    assert!(!detail(&store, &id).is_null());
}

#[test]
fn same_name_keeps_separate_people_bidirectional_duplicate_and_rejection_survives_resync() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let first = company("crm_a", "account-a", "contact-a", json!("总监"));
    let second = company("crm_b", "account-a", "contact-a", json!("总监"));
    sync(&store, "first", T1, vec![first.clone(), second.clone()]);
    let (a, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    let (b, _) = mapped(&store, "crm_b", "Contacts", "contact-a");
    assert_ne!(a, b);
    assert_eq!(count(&store, "contact_claims"), 1);
    let left = detail(&store, &a)["unverified_claims"][0].clone();
    let right = detail(&store, &b)["unverified_claims"][0].clone();
    assert_eq!(left["claim_id"], right["claim_id"]);
    assert_eq!(left["relation_type"], "possible_duplicate");
    assert!(left["import_id"].is_null());
    for key in left["source"].as_object().unwrap().keys() {
        assert!([
            "source_type",
            "source_connection_id",
            "source_module",
            "source_record_id",
            "collected_at",
            "modified_at"
        ]
        .contains(&key.as_str()));
    }
    assert_eq!(count(&store, "relation_ids"), 2);
    let subject = left["subject_id"].as_str().unwrap();
    let rejected = call(
        &store,
        "review_contact_claim",
        json!({"operation_id":"reject","actor":"reviewer",
        "claim_id":left["claim_id"],"action":"reject","expected_entity_version":detail(&store,subject)["entity"]["metadata"]["version"],"confirmation_note":"不同人"}),
    );
    assert_eq!(rejected["ok"], true, "{rejected}");
    sync(&store, "again", T2, vec![second, first]);
    assert_eq!(count(&store, "contact_claims"), 1);
    assert_eq!(detail(&store, &a)["unverified_claims"], json!([]));
    assert_eq!(detail(&store, &b)["unverified_claims"], json!([]));
}

#[test]
fn manual_same_name_is_only_a_hint_and_placeholder_names_do_not_generate_hints() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let manual_id = manual(&store, None, "张明", "人工职位", "manual");
    sync(
        &store,
        "first",
        T1,
        vec![company("crm_a", "account-a", "contact-a", json!("总监"))],
    );
    let (crm_id, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    assert_ne!(manual_id, crm_id);
    assert_eq!(
        detail(&store, &manual_id)["unverified_claims"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut unknown_a = company("crm_a", "account-a", "unknown-a", Value::Null);
    unknown_a["contacts"][0]["name"] = json!("姓名未提供");
    let mut unknown_b = unknown_a.clone();
    unknown_b["contacts"][0]["record_id"] = json!("unknown-b");
    sync(&store, "unknown", T2, vec![unknown_a, unknown_b]);
    assert_eq!(count(&store, "contact_claims"), 1);
}

#[test]
fn merged_mapping_follows_survivor_and_archived_person_is_never_restored() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let mut data = company("crm_a", "account-a", "contact-a", json!("总监"));
    sync(&store, "first", T1, vec![data.clone()]);
    let (old, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    let target = manual(&store, None, "保留姓名", "人工职位", "manual");
    let merged = call(
        &store,
        "merge_contacts",
        json!({"operation_id":"merge","actor":"reviewer","source_id":old,"target_id":target,
        "expected_source_version":detail(&store,&old)["entity"]["metadata"]["version"],"expected_target_version":1}),
    );
    assert_eq!(merged["ok"], true, "{merged}");
    data["contacts"][0]["title"] = json!("新职位");
    data["contacts"][0]["modified_at"] = json!(T2);
    sync(&store, "after-merge", T2, vec![data.clone()]);
    assert_eq!(mapped(&store, "crm_a", "Contacts", "contact-a").0, target);
    assert_eq!(count(&store, "entity_ids"), 3);
    assert_eq!(
        detail(&store, &target)["entity"]["properties"]["jobTitle"],
        "人工职位"
    );
    let archived = call(
        &store,
        "archive_contact",
        json!({"operation_id":"archive","actor":"reviewer","entity_id":target,
        "expected_version":detail(&store,&target)["entity"]["metadata"]["version"]}),
    );
    assert_eq!(archived["ok"], true, "{archived}");
    let evidence = count(&store, "evidence");
    data["contacts"][0]["modified_at"] = json!(T3);
    data["contacts"][0]["title"] = json!("归档后职位");
    let result = sync(&store, "after-archive", T3, vec![data]);
    counts(&result, 0, 0, 0, 1);
    assert_eq!(result["entity_ids"], json!([]));
    assert!(detail(&store, &target).is_null());
    assert_eq!(count(&store, "evidence"), evidence);
    assert_eq!(count(&store, "entity_ids"), 3);
}

#[test]
fn archived_company_or_employment_is_not_revived_by_later_crm_changes() {
    for archive_company in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path().join("graph.db")).unwrap();
        let mut data = company("crm_a", "account-a", "contact-a", json!("总监"));
        sync(&store, "first", T1, vec![data.clone()]);
        let (person, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
        let before = detail(&store, &person);
        let (op, payload) = if archive_company {
            let (org, _) = mapped(&store, "crm_a", "Accounts", "account-a");
            (
                "archive_contact",
                json!({"operation_id":"archive","actor":"reviewer","entity_id":org,"expected_version":detail(&store,&org)["entity"]["metadata"]["version"]}),
            )
        } else {
            (
                "archive_relation",
                json!({"operation_id":"archive","actor":"reviewer","relation_id":before["relations"][0]["relation_id"],"expected_version":before["relations"][0]["metadata"]["version"]}),
            )
        };
        let reply = call(&store, op, payload);
        assert_eq!(reply["ok"], true, "{reply}");
        data["contacts"][0]["title"] = json!("新职位");
        data["contacts"][0]["modified_at"] = json!(T2);
        counts(&sync(&store, "changed", T2, vec![data]), 0, 1, 0, 1);
        assert_eq!(detail(&store, &person)["relations"], json!([]));
        assert_eq!(count(&store, "relation_ids"), 1);
    }
}

#[test]
fn merged_crm_sources_do_not_take_turns_overwriting_each_others_supported_values() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let mut a = company("crm_a", "account-a", "contact-a", json!("共同原职位"));
    let mut b = company("crm_b", "account-b", "contact-b", json!("共同原职位"));
    sync(&store, "first", T1, vec![a.clone(), b.clone()]);
    let (source, _) = mapped(&store, "crm_a", "Contacts", "contact-a");
    let (target, _) = mapped(&store, "crm_b", "Contacts", "contact-b");
    let merged = call(
        &store,
        "merge_contacts",
        json!({"operation_id":"merge-crm","actor":"reviewer",
        "source_id":source,"target_id":target,"expected_source_version":1,"expected_target_version":1}),
    );
    assert_eq!(merged["ok"], true, "{merged}");
    a["contacts"][0]["title"] = json!("A新职位");
    a["contacts"][0]["modified_at"] = json!(T2);
    b["contacts"][0]["title"] = json!("B新职位");
    b["contacts"][0]["modified_at"] = json!(T2);
    sync(&store, "both-change", T2, vec![a, b]);
    let after = detail(&store, &target);
    assert_eq!(after["entity"]["properties"]["jobTitle"], "共同原职位");
    for value in ["A新职位", "B新职位"] {
        assert!(after["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["field_path"] == "properties.jobTitle" && e["value"] == value));
    }
    assert_eq!(mapped(&store, "crm_a", "Contacts", "contact-a").0, target);
    assert_eq!(mapped(&store, "crm_b", "Contacts", "contact-b").0, target);
}

#[test]
fn archived_company_allows_new_person_and_reports_partial_while_other_companies_sync() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    sync(
        &store,
        "first",
        T1,
        vec![company("crm_a", "account-a", "contact-a", json!("总监"))],
    );
    let (org, _) = mapped(&store, "crm_a", "Accounts", "account-a");
    let archived = call(
        &store,
        "archive_contact",
        json!({"operation_id":"archive-company","actor":"reviewer","entity_id":org,
        "expected_version":detail(&store,&org)["entity"]["metadata"]["version"]}),
    );
    assert_eq!(archived["ok"], true, "{archived}");
    let result = sync(
        &store,
        "partial",
        T2,
        vec![
            company("crm_a", "account-a", "new-under-archive", json!("工程师")),
            company("crm_b", "account-b", "normal-contact", json!("经理")),
        ],
    );
    counts(&result, 2, 0, 0, 1);
    let (isolated, _) = mapped(&store, "crm_a", "Contacts", "new-under-archive");
    let (normal, _) = mapped(&store, "crm_b", "Contacts", "normal-contact");
    assert_eq!(detail(&store, &isolated)["relations"], json!([]));
    assert_eq!(
        detail(&store, &normal)["relations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(result["entity_ids"].as_array().unwrap().len(), 2);
    assert_eq!(count(&store, "relation_ids"), 2);
    assert!(detail(&store, &org).is_null());
}

#[test]
fn source_dates_compare_instants_and_use_collection_when_either_modified_time_is_missing() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let mut data = company("crm_a", "account-a", "contact-a", json!("新职位"));
    data["contacts"][0]["modified_at"] = json!("2026-10-13T02:00:00+00:00");
    sync(&store, "first", T2, vec![data.clone()]);
    let (id, source) = mapped(&store, "crm_a", "Contacts", "contact-a");
    data["contacts"][0]["modified_at"] = json!("2026-10-13T08:00:00+08:00");
    data["contacts"][0]["title"] = json!("迟到职位");
    counts(
        &sync(&store, "older-instant", T3, vec![data.clone()]),
        0,
        0,
        1,
        0,
    );
    assert_eq!(mapped(&store, "crm_a", "Contacts", "contact-a").1, source);
    data["contacts"][0]["modified_at"] = Value::Null;
    counts(
        &sync(&store, "missing-old", T1, vec![data.clone()]),
        0,
        0,
        1,
        0,
    );
    assert_eq!(
        detail(&store, &id)["entity"]["properties"]["jobTitle"],
        "新职位"
    );
    data["contacts"][0]["title"] = json!("仅采集时间的新职位");
    counts(&sync(&store, "missing-new", T3, vec![data]), 0, 1, 0, 0);
    assert_eq!(
        detail(&store, &id)["entity"]["properties"]["jobTitle"],
        "仅采集时间的新职位"
    );
}

#[test]
fn nested_private_fields_missing_nullable_fields_and_invalid_dates_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let baseline = company("crm_a", "account-a", "contact-a", json!("总监"));
    let mut cases = Vec::new();
    let mut owner = baseline.clone();
    owner["contacts"][0]["contact_owner"]["email"] = json!("private@example.test");
    cases.push(owner);
    let mut account = baseline.clone();
    account["telephone"] = json!("private");
    cases.push(account);
    let mut missing = baseline.clone();
    missing["contacts"][0]
        .as_object_mut()
        .unwrap()
        .remove("title");
    cases.push(missing);
    let mut modified = baseline;
    modified["contacts"][0]["modified_at"] = json!("yesterday");
    cases.push(modified);
    for (index, data) in cases.into_iter().enumerate() {
        let result = call(
            &store,
            "sync_zoho_contacts",
            input(&format!("invalid-{index}"), T1, vec![data]),
        );
        assert_eq!(result["error"]["code"], "VALIDATION_ERROR", "{result}");
    }
    assert_eq!(count(&store, "entity_ids"), 0);
    assert_eq!(count(&store, "operation_results"), 0);
}

#[test]
fn failing_update_rolls_back_existing_values_source_clocks_evidence_and_index() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let mut data = company("crm_a", "account-a", "contact-a", json!("总监"));
    sync(&store, "first", T1, vec![data.clone()]);
    let (id, source) = mapped(&store, "crm_a", "Contacts", "contact-a");
    let before = detail(&store, &id);
    store.graph.connection().execute_batch("CREATE TRIGGER fail_zoho_update BEFORE INSERT ON operation_results WHEN NEW.op='sync_zoho_contacts' BEGIN SELECT RAISE(ABORT,'forced rollback'); END;").unwrap();
    data["contacts"][0]["title"] = json!("经理");
    data["contacts"][0]["modified_at"] = json!(T2);
    let failed = call(
        &store,
        "sync_zoho_contacts",
        input("failed-update", T2, vec![data]),
    );
    assert_eq!(failed["ok"], false);
    assert!(
        failed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("forced rollback"),
        "{failed}"
    );
    assert_eq!(detail(&store, &id), before);
    assert_eq!(mapped(&store, "crm_a", "Contacts", "contact-a").1, source);
}

#[test]
fn invalid_fields_and_late_database_failure_leave_no_partial_batch() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.db")).unwrap();
    let good = company("crm_a", "account-a", "contact-a", json!("总监"));
    for key in ["email", "phone", "source_url"] {
        let mut bad = company("crm_b", "account-b", "contact-b", json!("经理"));
        bad["contacts"][0][key] = json!("forbidden");
        let result = call(
            &store,
            "sync_zoho_contacts",
            input(&format!("invalid-{key}"), T1, vec![good.clone(), bad]),
        );
        assert_eq!(result["error"]["code"], "VALIDATION_ERROR", "{result}");
        for table in [
            "entity_ids",
            "relation_ids",
            "evidence",
            "source_mapping",
            "contact_claims",
            "operation_results",
        ] {
            assert_eq!(count(&store, table), 0, "{table}");
        }
    }
    store.graph.connection().execute_batch("CREATE TRIGGER fail_zoho BEFORE INSERT ON operation_results WHEN NEW.op='sync_zoho_contacts' BEGIN SELECT RAISE(ABORT,'forced rollback'); END;").unwrap();
    let failed = call(
        &store,
        "sync_zoho_contacts",
        input(
            "rollback",
            T1,
            vec![
                good.clone(),
                company("crm_b", "account-b", "contact-b", json!("经理")),
            ],
        ),
    );
    assert_eq!(failed["ok"], false);
    assert!(
        failed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("forced rollback"),
        "{failed}"
    );
    for table in [
        "kg_entities",
        "kg_relations",
        "entity_ids",
        "relation_ids",
        "evidence",
        "source_mapping",
        "contact_claims",
        "operation_results",
        "audit_log",
        "vector_meta",
    ] {
        assert_eq!(count(&store, table), 0, "{table}");
    }
    store
        .graph
        .connection()
        .execute_batch("DROP TRIGGER fail_zoho;")
        .unwrap();
    counts(&sync(&store, "rollback", T1, vec![good]), 1, 0, 0, 0);
}
