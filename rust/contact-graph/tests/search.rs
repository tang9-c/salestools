use contact_graph::{protocol::parse_and_dispatch, store::Store};
use serde_json::{json, Value};

mod store {
    pub use contact_graph::store::*;
}
#[path = "../src/search.rs"]
mod search;

fn request(store: &Store, op: &str, payload: Value) -> Value {
    parse_and_dispatch(
        &serde_json::to_vec(&json!({
            "version":1,"request_id":"search-test","op":op,"payload":payload
        }))
        .unwrap(),
        store,
    )
}

fn proof(field: &str, value: Value) -> Value {
    json!({"field_path":field,"value":value,"source_type":"manual",
        "collected_at":"2026-09-26T00:00:00.000Z","locator_status":"not_applicable"})
}

fn entity(
    store: &Store,
    operation: &str,
    label: &str,
    name: &str,
    aliases: &[&str],
    skills: &[&str],
    job_title: Option<&str>,
) -> String {
    let mut properties = json!({"name":name});
    let mut evidence = vec![proof("properties.name", json!(name))];
    if !aliases.is_empty() {
        properties["alternateName"] = json!(aliases);
        evidence.extend(
            aliases
                .iter()
                .map(|value| proof("properties.alternateName", json!(value))),
        );
    }
    if !skills.is_empty() {
        properties["skills"] = json!(skills);
        evidence.extend(
            skills
                .iter()
                .map(|value| proof("properties.skills", json!(value))),
        );
    }
    if let Some(title) = job_title {
        properties["jobTitle"] = json!(title);
        evidence.push(proof("properties.jobTitle", json!(title)));
    }
    let result = request(
        store,
        "save_contact",
        json!({
            "operation_id":operation,"actor":"tester","label":label,
            "set_properties":properties,"evidence":evidence
        }),
    );
    assert_eq!(result["ok"], true, "{result}");
    result["result"]["entity_id"].as_str().unwrap().to_owned()
}

fn works_for(store: &Store, operation: &str, person: &str, organization: &str, title: &str) {
    let relation = json!({"relation_type":"worksFor","source_id":person,"target_id":organization});
    let result = request(
        store,
        "save_relation",
        json!({
            "operation_id":operation,"actor":"tester",
            "source_id":person,"target_id":organization,
            "relation_type":"worksFor",
            "properties":{"role":{"@type":"OrganizationRole","roleName":title}},
            "metadata":{"employment_status":"unknown"},
            "evidence":[proof("$relation",relation),
                proof("properties.role.roleName",json!(title)),
                proof("metadata.employment_status",json!("unknown"))]
        }),
    );
    assert_eq!(result["ok"], true, "{result}");
}

fn project_relation(store: &Store, operation: &str, source: &str, target: &str, kind: &str) {
    let relation = json!({"relation_type":kind,"source_id":source,"target_id":target});
    let result = request(
        store,
        "save_relation",
        json!({
            "operation_id":operation,"actor":"tester","source_id":source,"target_id":target,
            "relation_type":kind,"properties":{},"evidence":[proof("$relation",relation)]
        }),
    );
    assert_eq!(result["ok"], true, "{result}");
}

fn project_claim(
    store: &Store,
    operation: &str,
    subject: &str,
    target: &str,
    kind: &str,
) -> String {
    let job = store
        .put_import_job(&json!({
            "operation_id":format!("job-{operation}"),"actor":"tester","file_id":operation,
            "status":"queued","data":{"candidates":[]}
        }))
        .unwrap();
    let claim_id = format!("claim_{operation}");
    store.graph.connection().execute(
        "INSERT INTO contact_claims(claim_id,subject_id,kind,relation_type,target_id,value_json,source_json,status,reason,import_id,candidate_id,created_at,updated_at)
         VALUES(?1,?2,'relation',?3,?4,'{}','{}','unverified','missing_evidence',?5,'fixture','2026-09-28','2026-09-28')",
        rusqlite::params![claim_id,subject,kind,target,job["import_id"].as_str().unwrap()],
    ).unwrap();
    claim_id
}

fn search(store: &Store, payload: Value) -> Value {
    search::search_keyword(store, &payload).unwrap()
}

fn ids(result: &Value) -> Vec<String> {
    result["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["entity_id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn duplicate_claims_are_bidirectional_pending_pages_without_other_incoming_claims() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let a = entity(&store, "dup-a", "Person", "甲", &[], &[], None);
    let b = entity(&store, "dup-b", "Person", "乙", &[], &[], None);
    let c = entity(&store, "dup-c", "Person", "丙", &[], &[], None);
    let duplicate = project_claim(&store, "10-duplicate", &a, &b, "possible_duplicate");
    let ordinary = project_claim(&store, "20-own", &b, &c, "memberOf");
    project_claim(&store, "30-incoming", &c, &b, "memberOf");
    for status in ["rejected", "confirmed"] {
        let id = project_claim(&store, status, &a, &b, "possible_duplicate");
        store
            .graph
            .connection()
            .execute(
                "UPDATE contact_claims SET status=?1 WHERE claim_id=?2",
                rusqlite::params![status, id],
            )
            .unwrap();
    }
    let get = |id: &str, offset: usize, limit: usize| {
        request(
            &store,
            "get_contact",
            json!({"entity_id":id,"claim_offset":offset,"claim_limit":limit}),
        )
    };
    let first = get(&b, 0, 1);
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(
        first["result"]["unverified_claims"][0]["claim_id"],
        duplicate
    );
    assert_eq!(first["result"]["unverified_claims"][0]["subject_id"], a);
    assert_eq!(
        first["result"]["pagination"]["unverified_claims"],
        json!({"offset":0,"limit":1,"total":2,"next_offset":1})
    );
    let second = get(&b, 1, 1);
    assert_eq!(
        second["result"]["unverified_claims"][0]["claim_id"],
        ordinary
    );
    assert_eq!(
        second["result"]["pagination"]["unverified_claims"]["next_offset"],
        Value::Null
    );
    assert_eq!(
        get(&a, 0, 50)["result"]["unverified_claims"][0]["claim_id"],
        duplicate
    );
    let third = get(&c, 0, 50);
    assert_eq!(
        third["result"]["unverified_claims"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        third["result"]["unverified_claims"][0]["relation_type"],
        "memberOf"
    );
    assert_eq!(
        get(&b, 0, 0)["result"]["pagination"]["unverified_claims"]["total"],
        2
    );
    assert_eq!(get(&b, 2, 1)["result"]["unverified_claims"], json!([]));
}

#[test]
fn duplicate_name_snapshots_never_supply_search_facts() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let a = entity(&store, "dup-search-a", "Person", "甲", &[], &[], None);
    let b = entity(
        &store,
        "dup-search-b",
        "Person",
        "乙Python星辰项目",
        &[],
        &["Python"],
        None,
    );
    let claim = project_claim(&store, "duplicate-search", &a, &b, "possible_duplicate");
    store.graph.connection().execute("UPDATE contact_claims SET value_json=?1 WHERE claim_id=?2", rusqlite::params![json!({"subject_name":"甲", "target_name":"乙Python星辰项目", "reasons":["same_name"]}).to_string(), claim]).unwrap();
    for query in ["Python", "星辰项目", "乙"] {
        let result = search(&store, json!({"query":query,"include_unverified":true}));
        assert_eq!(ids(&result), vec![b.clone()], "{query}: {result}");
        assert_eq!(result["total"], 1);
        assert_eq!(
            ids(&search(&store, json!({"query":query}))),
            vec![b.clone()]
        );
    }
    assert_eq!(
        ids(&search(
            &store,
            json!({"skill":"Python","include_unverified":false})
        )),
        vec![b.clone()]
    );
    let ordinary = project_claim(&store, "ordinary-search", &a, &b, "memberOf");
    store
        .graph
        .connection()
        .execute(
            "UPDATE contact_claims SET value_json=?1 WHERE claim_id=?2",
            rusqlite::params![json!({"target_name":"可核实机构"}).to_string(), ordinary],
        )
        .unwrap();
    assert_eq!(
        ids(&search(
            &store,
            json!({"query":"可核实机构","include_unverified":true})
        )),
        vec![a]
    );
}

#[test]
fn identity_lookup_suggests_changed_name_by_exact_phone_without_auto_merge() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let saved = request(
        &store,
        "save_contact",
        json!({
            "operation_id":"old-name","actor":"tester","label":"Person",
            "set_properties":{"name":"旧姓名","telephone":["+86 138-0013-8000"]},
            "evidence":[proof("properties.name",json!("旧姓名")),
                proof("properties.telephone",json!("+86 138-0013-8000"))]
        }),
    );
    assert_eq!(saved["ok"], true, "{saved}");
    let id = saved["result"]["entity_id"].as_str().unwrap();
    let found = search::find_identity_candidates(
        &store,
        &json!({"phones":["+8613800138000"],"emails":[],"accounts":[]}),
    )
    .unwrap();
    assert_eq!(found["entity_ids"], json!([id]));
    assert_eq!(search(&store, json!({"name":"新姓名"}))["total"], 0);
}

#[test]
fn search_finds_old_name_and_skill_without_merging_same_name_people() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let renamed = entity(
        &store,
        "person-a",
        "Person",
        "陈晓",
        &["旧姓名"],
        &["材料科学"],
        Some("研发总监"),
    );
    let another = entity(&store, "person-b", "Person", "陈晓", &[], &[], None);
    let alias = search(&store, json!({"query":"旧姓名","offset":0,"limit":10}));
    assert_eq!(ids(&alias), vec![renamed.clone()]);
    assert!(alias["items"][0]["reasons"]
        .as_array()
        .unwrap()
        .contains(&json!("alternate_name")));
    let names = search(&store, json!({"name":"陈晓","offset":0,"limit":10}));
    assert_eq!(names["total"], 2);
    assert!(ids(&names).contains(&renamed));
    assert!(ids(&names).contains(&another));
    assert_eq!(
        ids(&search(
            &store,
            json!({"skill":"材料科学","offset":0,"limit":10})
        )),
        vec![renamed]
    );
}

#[test]
fn institution_name_finds_unnamed_person_only_through_confirmed_relations() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let anonymous = request(
        &store,
        "save_contact",
        json!({
            "operation_id":"anonymous","actor":"tester","label":"Person",
            "set_properties":{"skills":["Python"]},
            "evidence":[proof("properties.skills",json!("Python"))]
        }),
    );
    assert_eq!(anonymous["ok"], true, "{anonymous}");
    let person = anonymous["result"]["entity_id"].as_str().unwrap();
    let company = entity(&store, "company", "Organization", "甲公司", &[], &[], None);
    let school = entity(&store, "school", "Organization", "乙校", &[], &[], None);
    assert!(!ids(&search(&store, json!({"query":"甲公司"}))).contains(&person.to_owned()));
    works_for(&store, "employment", person, &company, "工程师");
    let alumni = request(
        &store,
        "save_relation",
        json!({
            "operation_id":"education","actor":"tester","source_id":person,"target_id":school,
            "relation_type":"alumniOf","properties":{},"evidence":[proof("$relation",json!({
                "relation_type":"alumniOf","source_id":person,"target_id":school
            }))]
        }),
    );
    assert_eq!(alumni["ok"], true, "{alumni}");
    for (query, organization) in [("甲公司", &company), ("乙校", &school)] {
        let by_name = search(&store, json!({"query":query}));
        assert!(ids(&by_name).contains(&person.to_owned()), "{by_name}");
        assert_eq!(
            by_name["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["entity_id"] == person)
                .unwrap()["name"],
            Value::Null
        );
        let by_id = search(&store, json!({"organization_id":organization}));
        assert!(ids(&by_id).contains(&person.to_owned()), "{by_id}");
    }
    assert!(!ids(&search(
        &store,
        json!({"organization_id":school,"job_title":"工程师"})
    ))
    .contains(&person.to_owned()));
}

#[test]
fn search_filters_one_employment_episode_by_organization_and_role() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = entity(&store, "person", "Person", "张明", &[], &[], None);
    let old_org = entity(&store, "old-org", "Organization", "甲公司", &[], &[], None);
    let new_org = entity(&store, "new-org", "Organization", "乙公司", &[], &[], None);
    works_for(&store, "old-role", &person, &old_org, "工程师");
    works_for(&store, "new-role", &person, &new_org, "经理");
    assert_eq!(
        ids(&search(
            &store,
            json!({
                "organization_id":new_org,"job_title":"经理","offset":0,"limit":10
            })
        )),
        vec![person.clone()]
    );
    assert!(ids(&search(
        &store,
        json!({
            "organization_id":old_org,"job_title":"经理","offset":0,"limit":10
        })
    ))
    .is_empty());
    assert_eq!(
        ids(&search(
            &store,
            json!({"query":"经理","offset":0,"limit":10})
        )),
        vec![person.clone()]
    );
    let archived = request(
        &store,
        "archive_contact",
        json!({
            "operation_id":"archive-org","actor":"tester",
            "entity_id":new_org,"expected_version":1
        }),
    );
    assert_eq!(archived["ok"], true, "{archived}");
    assert!(ids(&search(
        &store,
        json!({
            "organization_id":new_org,"offset":0,"limit":10
        })
    ))
    .is_empty());
}

#[test]
fn project_client_query_returns_person_only_through_the_correct_project_path() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = entity(
        &store,
        "project-person",
        "Person",
        "项目顾问",
        &[],
        &[],
        None,
    );
    let unrelated = entity(&store, "other-person", "Person", "另一顾问", &[], &[], None);
    let project = entity(&store, "project-a", "Project", "PLM 升级", &[], &[], None);
    let same_name = entity(&store, "project-b", "Project", "PLM 升级", &[], &[], None);
    let customer = entity(
        &store,
        "client",
        "Organization",
        "乙客户公司",
        &[],
        &[],
        None,
    );
    assert!(!ids(&search(&store, json!({"query":"乙客户公司"}))).contains(&person));
    project_relation(&store, "member-a", &person, &project, "memberOf");
    project_relation(&store, "member-b", &unrelated, &same_name, "memberOf");
    assert!(!ids(&search(&store, json!({"query":"乙客户公司"}))).contains(&person));
    project_relation(
        &store,
        "client-a",
        &project,
        &customer,
        "clientOrganization",
    );
    let page = search(&store, json!({"query":"乙客户公司"}));
    let hit = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["entity_id"] == person)
        .unwrap();
    assert_eq!(hit["matched_project_id"], project);
    assert_eq!(hit["match_status"], "confirmed");
    assert!(hit["reasons"]
        .as_array()
        .unwrap()
        .contains(&json!("project_client_match")));
    assert!(!ids(&page).contains(&unrelated));
    assert!(!ids(&search(&store, json!({"organization_id":customer}))).contains(&person));
}

#[test]
fn project_client_claim_path_requires_opt_in_and_reports_both_claim_ids() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = entity(&store, "claim-person", "Person", "候选顾问", &[], &[], None);
    let project = entity(
        &store,
        "claim-project",
        "Project",
        "ERP 交付",
        &[],
        &[],
        None,
    );
    let customer = entity(
        &store,
        "claim-client",
        "Organization",
        "乙客户公司",
        &[],
        &[],
        None,
    );
    let member_claim = project_claim(&store, "member-claim", &person, &project, "memberOf");
    let client_claim = project_claim(
        &store,
        "client-claim",
        &project,
        &customer,
        "clientOrganization",
    );
    assert!(!ids(&search(&store, json!({"query":"乙客户公司"}))).contains(&person));
    let page = search(
        &store,
        json!({"query":"乙客户公司","include_unverified":true}),
    );
    let hit = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["entity_id"] == person)
        .unwrap();
    assert_eq!(hit["matched_project_id"], project);
    assert_eq!(hit["match_status"], "unverified");
    assert_eq!(hit["claim_ids"], json!([member_claim, client_claim]));
    store
        .graph
        .connection()
        .execute(
            "UPDATE contact_claims SET status='rejected' WHERE claim_id=?1",
            [&client_claim],
        )
        .unwrap();
    assert!(!ids(&search(
        &store,
        json!({"query":"乙客户公司","include_unverified":true})
    ))
    .contains(&person));
}

#[test]
fn project_client_query_marks_a_single_weak_edge_and_hides_archived_client() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = entity(&store, "mixed-person", "Person", "候选顾问", &[], &[], None);
    let project = entity(
        &store,
        "mixed-project",
        "Project",
        "PLM 实施",
        &[],
        &[],
        None,
    );
    let customer = entity(
        &store,
        "mixed-client",
        "Organization",
        "乙客户公司",
        &[],
        &[],
        None,
    );
    project_relation(&store, "mixed-member", &person, &project, "memberOf");
    let client_claim = project_claim(
        &store,
        "mixed-client-claim",
        &project,
        &customer,
        "clientOrganization",
    );
    assert!(!ids(&search(&store, json!({"query":"乙客户公司"}))).contains(&person));
    let page = search(
        &store,
        json!({"query":"乙客户公司","include_unverified":true}),
    );
    let hit = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["entity_id"] == person)
        .unwrap();
    assert_eq!(hit["claim_ids"], json!([client_claim]));
    assert_eq!(hit["match_status"], "unverified");
    assert_eq!(
        request(
            &store,
            "archive_contact",
            json!({
                "operation_id":"mixed-archive-client","actor":"tester",
                "entity_id":customer,"expected_version":1
            })
        )["ok"],
        true
    );
    assert!(!ids(&search(
        &store,
        json!({"query":"乙客户公司","include_unverified":true})
    ))
    .contains(&person));
}

#[test]
fn confirmed_direct_hits_are_not_relabelled_by_an_unverified_project_path() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let client = entity(
        &store,
        "priority-client",
        "Organization",
        "乙客户公司",
        &[],
        &[],
        None,
    );
    let by_name = entity(
        &store,
        "priority-name",
        "Person",
        "乙客户公司顾问",
        &[],
        &[],
        None,
    );
    let by_employer = entity(
        &store,
        "priority-employer",
        "Person",
        "正式雇员",
        &[],
        &[],
        None,
    );
    works_for(
        &store,
        "priority-works-for",
        &by_employer,
        &client,
        "工程师",
    );
    for (index, person) in [&by_name, &by_employer].iter().enumerate() {
        let project = entity(
            &store,
            &format!("priority-project-{index}"),
            "Project",
            &format!("弱项目{index}"),
            &[],
            &[],
            None,
        );
        project_relation(
            &store,
            &format!("priority-member-{index}"),
            person,
            &project,
            "memberOf",
        );
        project_claim(
            &store,
            &format!("priority-claim-{index}"),
            &project,
            &client,
            "clientOrganization",
        );
    }
    let page = search(
        &store,
        json!({"query":"乙客户公司","include_unverified":true}),
    );
    for person in [&by_name, &by_employer] {
        let hit = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["entity_id"] == *person)
            .unwrap();
        assert_eq!(hit["match_status"], "confirmed", "{hit}");
        assert!(hit.get("matched_project_id").is_none(), "{hit}");
        assert!(hit.get("claim_ids").is_none(), "{hit}");
    }
}

#[test]
fn project_client_query_deduplicates_people_and_hides_archived_project() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = entity(&store, "dedup-person", "Person", "项目顾问", &[], &[], None);
    let customer = entity(
        &store,
        "dedup-client",
        "Organization",
        "乙客户公司",
        &[],
        &[],
        None,
    );
    let first = entity(&store, "dedup-project-a", "Project", "一期", &[], &[], None);
    let second = entity(&store, "dedup-project-b", "Project", "二期", &[], &[], None);
    for (index, project) in [&first, &second].iter().enumerate() {
        project_relation(
            &store,
            &format!("dedup-member-{index}"),
            &person,
            project,
            "memberOf",
        );
        project_relation(
            &store,
            &format!("dedup-client-{index}"),
            project,
            &customer,
            "clientOrganization",
        );
    }
    let page = search(&store, json!({"query":"乙客户公司","limit":1}));
    assert_eq!(page["total"], 2); // Customer node and one Person; projects are not search results.
    let second_page = search(&store, json!({"query":"乙客户公司","limit":1,"offset":1}));
    let all = [ids(&page), ids(&second_page)].concat();
    assert_eq!(all.iter().filter(|id| *id == &person).count(), 1);
    for (index, project) in [&first, &second].iter().enumerate() {
        assert_eq!(
            request(
                &store,
                "archive_contact",
                json!({
                    "operation_id":format!("archive-project-{index}"),"actor":"tester",
                    "entity_id":project,"expected_version":1
                })
            )["ok"],
            true
        );
    }
    assert!(!ids(&search(&store, json!({"query":"乙客户公司"}))).contains(&person));
}

#[test]
fn search_paginates_after_archived_filter_and_rejects_wildcards_as_data() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let mut people = Vec::new();
    for index in 0..4 {
        people.push(entity(
            &store,
            &format!("person-{index}"),
            "Person",
            &format!("搜索人物{index}"),
            &[],
            &[],
            None,
        ));
    }
    let archived = request(
        &store,
        "archive_contact",
        json!({
            "operation_id":"archive-person","actor":"tester",
            "entity_id":people[1],"expected_version":1
        }),
    );
    assert_eq!(archived["ok"], true, "{archived}");
    let first = search(&store, json!({"query":"搜索人物","offset":0,"limit":2}));
    let second = search(&store, json!({"query":"搜索人物","offset":2,"limit":2}));
    assert_eq!(first["total"], 3);
    assert_eq!(first["next_offset"], 2);
    assert_eq!(second["total"], 3);
    assert!(second.get("next_offset").is_none());
    let mut all = ids(&first);
    all.extend(ids(&second));
    all.sort();
    all.dedup();
    assert_eq!(all.len(), 3);
    assert!(!all.contains(&people[1]));
    assert_eq!(
        search(&store, json!({"query":"%","offset":0,"limit":10}))["total"],
        0
    );
    assert!(search::search_keyword(&store, &json!({"offset":0,"limit":51})).is_err());
    assert!(search::search_keyword(&store, &json!({"offset":-1,"limit":10})).is_err());
}

fn claimed_person(store: &Store, tag: &str, name: &str) -> String {
    let candidate = json!({"candidate_id":"person","label":"Person","properties":{"name":name},
        "evidence":[proof("properties.name",json!(name))],"can_commit":true,
        "relation_suggestions":[],"review_items":[
          {"kind":"relation","relation_type":"alumniOf","source_candidate_id":"person",
           "target_candidate_id":"school","properties":{},"reason":"missing_evidence"},
          {"kind":"field","field_path":"properties.skills","value":"Synthetic Company",
           "reason":"missing_evidence","quote":"source-only-needle"},
          {"kind":"field","field_path":"properties.telephone","value":"+15550000000",
           "reason":"missing_evidence"}]});
    let started = store
        .put_import_job(&json!({"operation_id":format!("start-{tag}"),
        "actor":"tester","file_id":tag,"status":"queued","data":{"candidates":[]}}))
        .unwrap();
    let import_id = &started["import_id"];
    store.put_import_job(&json!({"operation_id":format!("ready-{tag}"),"actor":"tester",
        "file_id":tag,"import_id":import_id,"expected_version":1,"status":"ready_for_review",
        "data":{"candidates":[candidate,{"candidate_id":"school","label":"Organization","properties":{"name":"Synthetic Academy"},"evidence":[proof("properties.name",json!("Synthetic Academy"))],"can_commit":true}]}})).unwrap();
    let result = store.commit_import(&json!({"operation_id":format!("contact-import:{}",import_id.as_str().unwrap()),
        "actor":"tester","import_id":import_id,"expected_version":2,
        "choices":[{"candidate_id":"person","action":"create"},{"candidate_id":"school","action":"skip"}]})).unwrap();
    result["results"][0]["entity_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn unverified_keyword_is_opt_in_deduplicated_ranked_and_paged() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let claim = claimed_person(&store, "claim", "A Claim");
    let confirmed = claimed_person(&store, "confirmed", "Z Synthetic Company");
    for query in ["Synthetic Academy", "Synthetic Company"] {
        let default = search(&store, json!({"query":query}));
        assert!(!ids(&default).contains(&claim));
        let page = search(&store, json!({"query":query,"include_unverified":true}));
        let hit = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["entity_id"] == claim)
            .unwrap();
        assert_eq!(hit["match_status"], "unverified");
        assert!(hit["claim_id"].as_str().is_some());
    }
    let first = search(
        &store,
        json!({"query":"Synthetic Company","include_unverified":true,"limit":1}),
    );
    assert_eq!(first["total"], 2);
    assert_eq!(ids(&first), vec![confirmed]);
    assert_eq!(first["items"][0]["match_status"], "confirmed");
    assert!(first["items"][0].get("claim_id").is_none());
    assert_eq!(first["next_offset"], 1);
    let second = search(
        &store,
        json!({"query":"Synthetic Company","include_unverified":true,"limit":1,"offset":1}),
    );
    assert_eq!(ids(&second), vec![claim]);
    assert!(second.get("next_offset").is_none());
    assert_eq!(
        search(
            &store,
            json!({"query":"source-only-needle","include_unverified":true})
        )["total"],
        0
    );
    assert_eq!(
        search(&store, json!({"query":"school","include_unverified":true}))["total"],
        0
    );
    assert_eq!(
        search(
            &store,
            json!({"query":"Synthetic Company","name":"absent","include_unverified":true})
        )["total"],
        0
    );
    for query in ["", "   "] {
        assert!(
            search::search_keyword(&store, &json!({"query":query,"include_unverified":true}))
                .is_err()
        );
    }
    assert!(search::search_keyword(&store, &json!({"include_unverified":true})).is_err());
    assert_eq!(
        search::find_identity_candidates(
            &store,
            &json!({"phones":["+15550000000"],"emails":[],"accounts":[]})
        )
        .unwrap()["entity_ids"],
        json!([])
    );
}

#[test]
fn unverified_keyword_hides_archived_merged_and_reviewed_claims() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("graph.sqlite")).unwrap();
    let archived = claimed_person(&store, "archived", "Archived");
    let old = claimed_person(&store, "old", "Old");
    let target = entity(&store, "target", "Person", "Target", &[], &[], None);
    assert_eq!(
        request(
            &store,
            "archive_contact",
            json!({"operation_id":"archive","actor":"tester",
      "entity_id":archived,"expected_version":1})
        )["ok"],
        true
    );
    assert_eq!(
        request(
            &store,
            "merge_contacts",
            json!({"operation_id":"merge","actor":"tester",
      "source_id":old,"target_id":target,"expected_source_version":1,"expected_target_version":1,
      "field_choices":{"properties.name":"target"}})
        )["ok"],
        true
    );
    let found = search(
        &store,
        json!({"query":"Synthetic Academy","include_unverified":true}),
    );
    assert_eq!(ids(&found), vec![target.clone()]);
    store
        .graph
        .connection()
        .execute(
            "UPDATE contact_claims SET status='rejected' WHERE subject_id=?1",
            [&target],
        )
        .unwrap();
    assert_eq!(
        search(
            &store,
            json!({"query":"Synthetic Academy","include_unverified":true})
        )["total"],
        0
    );
    store
        .graph
        .connection()
        .execute(
            "UPDATE contact_claims SET status='confirmed' WHERE subject_id=?1",
            [&target],
        )
        .unwrap();
    assert_eq!(
        search(
            &store,
            json!({"query":"Synthetic Academy","include_unverified":true})
        )["total"],
        0
    );
}

#[test]
fn matching_claim_id_is_stable_and_belongs_to_the_matching_claims() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("graph.sqlite");
    let store = Store::open(&path).unwrap();
    let person = claimed_person(&store, "stable", "Stable Person");
    let detail = store.get_contact(&json!({"entity_id":person})).unwrap();
    let mut matching: Vec<String> = detail["unverified_claims"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|claim| claim["kind"] == "relation" || claim["field_path"] == "properties.skills")
        .map(|claim| claim["claim_id"].as_str().unwrap().to_owned())
        .collect();
    matching.sort();
    assert_eq!(matching.len(), 2);
    let query = json!({"query":"Synthetic","include_unverified":true});
    for _ in 0..3 {
        let page = search(&store, query.clone());
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["claim_id"], matching[0]);
    }
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        search(&store, query.clone())["items"][0]["claim_id"],
        matching[0]
    );
    store
        .graph
        .connection()
        .execute(
            "UPDATE contact_claims SET status='rejected' WHERE claim_id=?1",
            [&matching[0]],
        )
        .unwrap();
    assert_eq!(search(&store, query)["items"][0]["claim_id"], matching[1]);
}

#[test]
fn project_name_finds_participants_without_client_edges() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("graph.sqlite")).unwrap();
    let person = entity(&store, "direct-person", "Person", "参与者", &[], &[], None);
    let weak = entity(&store, "weak-person", "Person", "待核实者", &[], &[], None);
    let project = entity(
        &store,
        "direct-project",
        "Project",
        "独立项目",
        &[],
        &[],
        None,
    );
    project_relation(&store, "direct-member", &person, &project, "memberOf");
    project_claim(&store, "weak-member", &weak, &project, "memberOf");
    let formal = search(&store, json!({"query":"独立项目"}));
    assert!(ids(&formal).contains(&person));
    assert!(!ids(&formal).contains(&weak));
    let inclusive = search(
        &store,
        json!({"query":"独立项目", "include_unverified":true}),
    );
    let hit = inclusive["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["entity_id"] == weak)
        .unwrap();
    assert_eq!(hit["match_status"], "unverified");
    assert_eq!(hit["matched_project_id"], project);
    assert_eq!(hit["reasons"], json!(["project_match"]));
    assert_eq!(
        request(
            &store,
            "archive_contact",
            json!({
                "operation_id":"archive-direct-project", "actor":"tester",
                "entity_id":project, "expected_version":1
            })
        )["ok"],
        true
    );
    assert!(ids(&search(
        &store,
        json!({"query":"独立项目", "include_unverified":true})
    ))
    .is_empty());
}
