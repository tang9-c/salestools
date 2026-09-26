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
