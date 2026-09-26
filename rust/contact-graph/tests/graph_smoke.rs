use sqlite_knowledge_graph::{Entity, KnowledgeGraph, Relation};

#[test]
fn library_entity_and_app_row_roll_back_together() -> Result<(), Box<dyn std::error::Error>> {
    let kg = KnowledgeGraph::open_in_memory()?;
    kg.connection()
        .execute_batch("CREATE TABLE app_probe (id INTEGER PRIMARY KEY);")?;
    {
        let tx = kg.transaction()?;
        let id = kg.insert_entity(&Entity::new("Person", "测试人"))?;
        tx.execute("INSERT INTO app_probe(id) VALUES(?1)", [id])?;
    }
    let entity_count: i64 =
        kg.connection()
            .query_row("SELECT count(*) FROM kg_entities", [], |row| row.get(0))?;
    let app_count: i64 =
        kg.connection()
            .query_row("SELECT count(*) FROM app_probe", [], |row| row.get(0))?;
    assert_eq!((entity_count, app_count), (0, 0));
    Ok(())
}

#[test]
fn library_keeps_two_employment_edges_for_one_pair() -> Result<(), Box<dyn std::error::Error>> {
    let kg = KnowledgeGraph::open_in_memory()?;
    let person = kg.insert_entity(&Entity::new("Person", "陈晓"))?;
    let organization = kg.insert_entity(&Entity::new("Organization", "示例科技"))?;
    let mut first = Relation::new(person, organization, "worksFor", 1.0)?;
    first.set_property("role", serde_json::json!({"roleName": "工程师"}));
    let mut second = Relation::new(person, organization, "worksFor", 1.0)?;
    second.set_property("role", serde_json::json!({"roleName": "经理"}));
    kg.insert_relation(&first)?;
    kg.insert_relation(&second)?;
    let count: i64 = kg.connection().query_row(
        "SELECT count(*) FROM kg_relations WHERE source_id=?1 AND target_id=?2",
        (person, organization),
        |row| row.get(0),
    )?;
    assert_eq!(count, 2);
    Ok(())
}

#[test]
fn library_vector_query_returns_inserted_entity() -> Result<(), Box<dyn std::error::Error>> {
    let kg = KnowledgeGraph::open_in_memory()?;
    let id = kg.insert_entity(&Entity::new("Person", "陈晓"))?;
    kg.insert_vector(id, vec![1.0, 0.0, 0.0])?;
    let hits = kg.search_vectors(vec![1.0, 0.0, 0.0], 1)?;
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].entity_id, id);
    Ok(())
}
