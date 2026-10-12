use contact_graph::{
    protocol::{parse_and_dispatch, MAX_FRAME_BYTES},
    store::Store,
};
use rusqlite::params;
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
    assert!(page1["result"]["items"][0]["identifiers"].is_array());
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
    let restore = request(
        &store,
        "restore_contact",
        json!({"operation_id":"restore","actor":"tester","entity_id":id,"expected_version":3}),
    );
    assert_eq!(restore["ok"], true, "{restore}");
    assert_eq!(lookup("新公司")["result"]["items"][0]["entity_id"], id);
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

#[test]
fn credit_code_whitelist_refreshes_and_reopen_backfills_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("graph.db");
    let code = |property_id: &str, value: &str| json!({"@type":"PropertyValue","propertyID":property_id,"value":value});
    let id;
    {
        let store = Store::open(&path).unwrap();
        let correct = code("统一社会信用代码", "91ABC");
        let wrong = code("其他编号", "OTHER");
        let create = request(
            &store,
            "save_contact",
            json!({"operation_id":"credit-create","actor":"tester",
            "label":"Organization","set_properties":{"name":"代码公司","identifier":[correct,wrong]},
            "evidence":[evidence("properties.name",json!("代码公司")),
                evidence("properties.identifier",correct),evidence("properties.identifier",wrong)]}),
        );
        assert_eq!(create["ok"], true, "{create}");
        id = create["result"]["entity_id"].as_str().unwrap().to_owned();
        let find = |value: &str| {
            request(
                &store,
                "company_organizations",
                json!({"entity_ids":[],"credit_codes":[value],"normalized_names":[],"limit":50,"offset":0}),
            )
        };
        assert_eq!(find("91abc")["result"]["items"][0]["entity_id"], id);
        assert_eq!(find("OTHER")["result"]["items"], json!([]));
        store
            .graph
            .connection()
            .execute("DELETE FROM company_organization_keys", [])
            .unwrap();
        store
            .graph
            .connection()
            .execute("DELETE FROM company_context_migrations", [])
            .unwrap();
    }
    let store = Store::open(&path).unwrap();
    let find = |value: &str| {
        request(
            &store,
            "company_organizations",
            json!({"entity_ids":[],"credit_codes":[value],"normalized_names":[],"limit":50,"offset":0}),
        )
    };
    assert_eq!(find("91abc")["result"]["items"][0]["entity_id"], id);
    let replacement = code("uscc", "NEW123");
    let edit = request(
        &store,
        "save_contact",
        json!({"operation_id":"credit-edit","actor":"tester",
        "label":"Organization","entity_id":id,"expected_version":1,
        "set_properties":{"identifier":[replacement]},"evidence":[evidence("properties.identifier",replacement)]}),
    );
    assert_eq!(edit["ok"], true, "{edit}");
    assert_eq!(find("91abc")["result"]["items"], json!([]));
    assert_eq!(find("new123")["result"]["items"][0]["entity_id"], id);
}

#[test]
fn client_project_members_are_reachable_only_from_customer_organization() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let customer = entity(&store, "Organization", "客户", "customer");
    let other = entity(&store, "Organization", "别家公司", "other");
    let project = entity(&store, "Project", "项目", "project");
    let member = entity(&store, "Person", "成员", "member");
    let unrelated = entity(&store, "Person", "外人", "outsider");
    let save = |operation: &str, source: &str, target: &str, kind: &str| {
        request(
            &store,
            "save_relation",
            json!({
        "operation_id":operation,"actor":"tester","source_id":source,"target_id":target,
        "relation_type":kind,"properties":{},"metadata":{},"evidence":[evidence("$relation",json!({
            "relation_type":kind,"source_id":source,"target_id":target}))]}),
        )
    };
    let customer_edge = save("client", &project, &customer, "clientOrganization");
    assert_eq!(customer_edge["ok"], true, "{customer_edge}");
    let participation = request(
        &store,
        "save_relation",
        json!({"operation_id":"member","actor":"tester",
        "source_id":member,"target_id":project,"relation_type":"memberOf",
        "properties":{"role":{"@type":"OrganizationRole","roleName":"成员"}},"metadata":{},
        "evidence":[evidence("$relation",json!({"relation_type":"memberOf","source_id":member,"target_id":project})),
            evidence("properties.role.roleName",json!("成员"))]}),
    );
    assert_eq!(participation["ok"], true, "{participation}");
    let (a, b) = if member < unrelated {
        (&member, &unrelated)
    } else {
        (&unrelated, &member)
    };
    let family = save("family", a, b, "spouse");
    assert_eq!(family["ok"], true, "{family}");
    let page = request(
        &store,
        "company_relations",
        json!({"organization_ids":[customer],"limit":50,"offset":0}),
    );
    assert_eq!(page["ok"], true, "{page}");
    let kinds: Vec<&str> = page["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["relation_type"].as_str().unwrap())
        .collect();
    assert_eq!(kinds.len(), 2, "{page}");
    assert!(kinds.contains(&"clientOrganization") && kinds.contains(&"memberOf"));
    let unrelated_page = request(
        &store,
        "company_relations",
        json!({"organization_ids":[other],"limit":50,"offset":0}),
    );
    assert_eq!(unrelated_page["result"]["items"], json!([]));
}

#[test]
fn merge_retires_source_name_key() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let source = entity(&store, "Organization", "旧主体", "merge-source");
    let target = entity(&store, "Organization", "保留主体", "merge-target");
    let merged = request(
        &store,
        "merge_contacts",
        json!({"operation_id":"merge","actor":"tester",
        "source_id":source,"target_id":target,"expected_source_version":1,"expected_target_version":1}),
    );
    assert_eq!(merged["ok"], true, "{merged}");
    let lookup = |name: &str| {
        request(
            &store,
            "company_organizations",
            json!({"entity_ids":[],"credit_codes":[],"normalized_names":[name],"limit":50,"offset":0}),
        )
    };
    assert_eq!(lookup("旧主体")["result"]["items"], json!([]));
    assert_eq!(
        lookup("保留主体")["result"]["items"][0]["entity_id"],
        target
    );
}

#[test]
fn imported_organization_is_searchable_without_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let job = store
        .put_import_job(
            &json!({"operation_id":"start","actor":"tester","file_id":"import-file",
        "status":"queued","data":{"candidates":[]}}),
        )
        .unwrap();
    let import_id = job["import_id"].as_str().unwrap();
    let candidate = json!({"candidate_id":"company","label":"Organization","properties":{"name":"导入公司"},
        "evidence":[evidence("properties.name",json!("导入公司"))],"relation_suggestions":[],"warnings":[],"can_commit":true});
    store.put_import_job(&json!({"operation_id":"ready","actor":"system","file_id":"import-file",
        "import_id":import_id,"expected_version":1,"status":"ready_for_review","data":{"candidates":[candidate]}})).unwrap();
    let result = request(
        &store,
        "commit_import",
        json!({"operation_id":format!("contact-import:{import_id}"),"actor":"tester",
        "import_id":import_id,"expected_version":2,"choices":[{"candidate_id":"company","action":"create"}]}),
    );
    assert_eq!(result["ok"], true, "{result}");
    let found = request(
        &store,
        "company_organizations",
        json!({"entity_ids":[],"credit_codes":[],
        "normalized_names":["导入公司"],"limit":50,"offset":0}),
    );
    assert_eq!(
        found["result"]["items"].as_array().unwrap().len(),
        1,
        "{found}"
    );
}

#[test]
fn confirmed_organization_claim_refreshes_legal_name_key() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let org = entity(&store, "Organization", "主体", "claim-org");
    let job = store
        .put_import_job(
            &json!({"operation_id":"claim-job","actor":"tester","file_id":"claim-file",
        "status":"queued","data":{}}),
        )
        .unwrap();
    store.graph.connection().execute("INSERT INTO contact_claims(claim_id,subject_id,kind,field_path,value_json,source_json,status,reason,import_id,candidate_id,created_at,updated_at) VALUES('legal',?1,'field','properties.legalName',?2,'{}','unverified','missing_evidence',?3,'synthetic','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')",
        params![org,json!("新法定名").to_string(),job["import_id"].as_str()]).unwrap();
    let result = request(
        &store,
        "review_contact_claim",
        json!({"claim_id":"legal","action":"confirm",
        "operation_id":"review-legal","actor":"tester","expected_entity_version":1,"confirmation_note":"人工核实"}),
    );
    assert_eq!(result["ok"], true, "{result}");
    let found = request(
        &store,
        "company_organizations",
        json!({"entity_ids":[],"credit_codes":[],
        "normalized_names":["新法定名"],"limit":50,"offset":0}),
    );
    assert_eq!(found["result"]["items"][0]["entity_id"], org);
}

#[test]
fn snapshot_created_organization_refreshes_name_key() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let initialize = request(
        &store,
        "sync_snapshots",
        json!({"operation_id":"snapshot-sync:initialize","actor":"system",
        "initialize":true,"snapshots":[]}),
    );
    assert_eq!(initialize["ok"], true, "{initialize}");
    let snapshot = json!({"snapshot_id":1,"cache_key":"query-a","normalized_query":"快照公司",
        "normalized_region_hint":null,"collected_at":"2026-09-26T00:00:00.000Z","stored_at":"2026-09-26T00:00:00.000Z",
        "companies":[{"company_name":"快照公司","contacts":[{"name":"甲","title":"工程师",
            "source_url":"https://example.com/1","published_at":"2026-09-20T00:00:00.000Z"}]}]});
    let result = request(
        &store,
        "sync_snapshots",
        json!({"operation_id":"snapshot-sync:1-1","actor":"system","snapshots":[snapshot]}),
    );
    assert_eq!(result["ok"], true, "{result}");
    let found = request(
        &store,
        "company_organizations",
        json!({"entity_ids":[],"credit_codes":[],
        "normalized_names":["快照公司"],"limit":50,"offset":0}),
    );
    assert_eq!(
        found["result"]["items"].as_array().unwrap().len(),
        1,
        "{found}"
    );
}

fn insert_identity_evidence(
    store: &Store,
    subject: &str,
    evidence_id: &str,
    value: &str,
    collected_at: &str,
    quote_len: usize,
) {
    let record = json!({"evidence_id":evidence_id,"subject_kind":"entity","subject_id":subject,
        "field_path":"properties.name","value":value,"collected_at":collected_at,"quote":"证".repeat(quote_len)});
    store.graph.connection().execute("INSERT INTO evidence(evidence_id,subject_kind,subject_id,field_path,value_json,record_json) VALUES(?1,'entity',?2,'properties.name',?3,?4)",
        params![evidence_id,subject,json!(value).to_string(),record.to_string()]).unwrap();
}

#[test]
fn company_identity_budget_advances_page_and_marks_truncated_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let first = entity(&store, "Organization", "预算公司", "budget-first");
    let second = entity(&store, "Organization", "预算公司", "budget-second");
    insert_identity_evidence(
        &store,
        &first,
        "large-first",
        "预算公司",
        "2026-10-02T00:00:00Z",
        47000,
    );
    insert_identity_evidence(
        &store,
        &second,
        "large-second",
        "预算公司",
        "2026-10-02T00:00:00Z",
        47000,
    );
    let payload = json!({"entity_ids":[first,second],"credit_codes":[],"normalized_names":[],"offset":0,"limit":2});
    let page1 = request(&store, "company_organizations", payload.clone());
    assert_eq!(page1["ok"], true, "{page1}");
    assert!(serde_json::to_vec(&page1).unwrap().len() < MAX_FRAME_BYTES);
    assert_eq!(
        page1["result"]["items"].as_array().unwrap().len(),
        1,
        "{page1}"
    );
    assert_eq!(page1["result"]["next_offset"], 1);
    let mut next = payload;
    next["offset"] = json!(1);
    let page2 = request(&store, "company_organizations", next);
    assert_eq!(page2["ok"], true, "{page2}");
    assert_ne!(
        page1["result"]["items"][0]["entity_id"],
        page2["result"]["items"][0]["entity_id"]
    );
    assert_eq!(page2["result"]["next_offset"], Value::Null);

    for index in 0..3 {
        insert_identity_evidence(
            &store,
            &first,
            &format!("extra-{index}"),
            "预算公司",
            "2026-10-02T00:00:00Z",
            35000,
        );
    }
    let oversized = request(
        &store,
        "company_organizations",
        json!({"entity_ids":[first],"credit_codes":[],
        "normalized_names":[],"offset":0,"limit":1}),
    );
    assert_eq!(oversized["ok"], true, "{oversized}");
    assert!(serde_json::to_vec(&oversized).unwrap().len() < MAX_FRAME_BYTES);
    assert_eq!(oversized["result"]["items"][0]["identity_complete"], false);
}

#[test]
fn one_oversized_relation_returns_response_too_large() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let org = entity(&store, "Organization", "超大关系公司", "large-org");
    let person = entity(&store, "Person", "甲", "large-person");
    let relation = work(&store, "large-work", &person, &org);
    let huge =
        json!({"role":{"@type":"OrganizationRole","roleName":"甲".repeat(90000)}}).to_string();
    store.graph.connection().execute("UPDATE kg_relations SET properties=?1 WHERE id=(SELECT kg_id FROM relation_ids WHERE relation_id=?2)",
        params![huge,relation]).unwrap();
    let response = request(
        &store,
        "company_relations",
        json!({"organization_ids":[org],"offset":0,"limit":1}),
    );
    assert_eq!(
        response["error"]["code"], "RESPONSE_TOO_LARGE",
        "{response}"
    );
}

#[test]
fn recent_since_is_exclusive_and_equal_times_sort_by_kind_then_id() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.db")).unwrap();
    let org = entity(&store, "Organization", "时间公司", "time-org");
    insert_identity_evidence(
        &store,
        &org,
        "time-b",
        "时间公司",
        "2026-10-02T00:00:00Z",
        0,
    );
    insert_identity_evidence(
        &store,
        &org,
        "time-a",
        "时间公司",
        "2026-10-02T00:00:00Z",
        0,
    );
    let input = json!({"organization_ids":[org],"since":"2026-10-01T00:00:00Z","limit":20});
    let records = request(&store, "company_recent_records", input);
    assert_eq!(records["ok"], true, "{records}");
    let evidence_ids: Vec<&str> = records["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["id"] == "time-a" || r["id"] == "time-b")
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(evidence_ids, vec!["time-a", "time-b"]);
    let boundary = request(
        &store,
        "company_recent_records",
        json!({"organization_ids":[org],
        "since":"2026-10-02T00:00:00Z","limit":20}),
    );
    assert!(
        !boundary["result"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "time-a" || r["id"] == "time-b"),
        "{boundary}"
    );
}
