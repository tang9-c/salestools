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
