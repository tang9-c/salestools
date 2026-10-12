use std::collections::{BTreeMap, BTreeSet};

use chrono::DateTime;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use crate::store::{AppError, Store};

fn normalize(value: &str) -> String {
    value
        .nfkc()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn credit_code(id: &Value) -> Option<String> {
    let kind = normalize(id.get("propertyID")?.as_str()?);
    if !["统一社会信用代码", "credit_code", "uscc"].contains(&kind.as_str()) {
        return None;
    }
    id.get("value")
        .and_then(Value::as_str)
        .map(normalize)
        .filter(|v| !v.is_empty())
}

pub(crate) fn refresh_keys(store: &Store, entity_id: &str) -> Result<(), AppError> {
    let conn = store.graph.connection();
    conn.execute(
        "DELETE FROM company_organization_keys WHERE entity_id=?1",
        [entity_id],
    )
    .map_err(AppError::internal)?;
    let row: Option<(i64, String)> = conn.query_row(
        "SELECT i.kg_id,m.metadata_json FROM entity_ids i JOIN entity_meta m USING(entity_id) JOIN kg_entities e ON e.id=i.kg_id WHERE i.entity_id=?1 AND e.entity_type='Organization'",
        [entity_id], |r| Ok((r.get(0)?,r.get(1)?)),
    ).optional().map_err(AppError::internal)?;
    let Some((kg_id, meta)) = row else {
        return Ok(());
    };
    let meta: Value = serde_json::from_str(&meta).map_err(AppError::internal)?;
    if meta.get("archived_at").is_some() || meta.get("merged_into").is_some() {
        return Ok(());
    }
    let entity = store.graph.get_entity(kg_id).map_err(AppError::internal)?;
    let properties = serde_json::to_value(entity.properties).map_err(AppError::internal)?;
    for field in ["name", "legalName"] {
        if let Some(value) = properties[field]
            .as_str()
            .map(normalize)
            .filter(|v| !v.is_empty())
        {
            conn.execute("INSERT OR IGNORE INTO company_organization_keys(entity_id,kind,value) VALUES(?1,'name',?2)", params![entity_id,value]).map_err(AppError::internal)?;
        }
    }
    if let Some(ids) = properties["identifier"].as_array() {
        for id in ids {
            if let Some(value) = credit_code(id) {
                conn.execute("INSERT OR IGNORE INTO company_organization_keys(entity_id,kind,value) VALUES(?1,'credit_code',?2)", params![entity_id,value]).map_err(AppError::internal)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn migrate_keys(store: &Store) -> Result<(), AppError> {
    let conn = store.graph.connection();
    conn.execute_batch("CREATE TABLE IF NOT EXISTS company_organization_keys (entity_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('name','credit_code')),value TEXT NOT NULL,PRIMARY KEY(entity_id,kind,value));
        CREATE INDEX IF NOT EXISTS company_organization_key_lookup ON company_organization_keys(kind,value,entity_id);
        CREATE TABLE IF NOT EXISTS company_context_migrations (version INTEGER PRIMARY KEY);").map_err(AppError::internal)?;
    let done: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM company_context_migrations WHERE version=1)",
            [],
            |r| r.get(0),
        )
        .map_err(AppError::internal)?;
    if done {
        return Ok(());
    }
    let tx = store.graph.transaction().map_err(AppError::internal)?;
    let ids = {
        let mut stmt = tx.prepare("SELECT i.entity_id FROM entity_ids i JOIN kg_entities e ON e.id=i.kg_id WHERE e.entity_type='Organization'").map_err(AppError::internal)?;
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map_err(AppError::internal)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::internal)?
    };
    for id in ids {
        refresh_keys(store, &id)?;
    }
    tx.execute(
        "INSERT INTO company_context_migrations(version) VALUES(1)",
        [],
    )
    .map_err(AppError::internal)?;
    tx.commit().map_err(AppError::internal)?;
    Ok(())
}

fn strings(raw: &Value, key: &str, max: usize) -> Result<Vec<String>, AppError> {
    let values = raw
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation(format!("Invalid {key}")))?;
    if values.len() > max {
        return Err(AppError::validation(format!("Too many {key}")));
    }
    values
        .iter()
        .map(|v| {
            v.as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| AppError::validation(format!("Invalid {key}")))
        })
        .collect()
}

fn page(raw: &Value, max: u64) -> Result<(usize, usize), AppError> {
    let offset = raw
        .get("offset")
        .map_or(Some(0), Value::as_u64)
        .ok_or_else(|| AppError::validation("Invalid offset"))?;
    let limit = raw
        .get("limit")
        .map_or(Some(max), Value::as_u64)
        .filter(|v| (1..=max).contains(v))
        .ok_or_else(|| AppError::validation("Invalid limit"))?;
    Ok((
        usize::try_from(offset).map_err(|_| AppError::validation("Invalid offset"))?,
        limit as usize,
    ))
}

fn identity(store: &Store, id: &str) -> Result<Option<Value>, AppError> {
    let conn = store.graph.connection();
    let row: Option<(i64,String)> = conn.query_row("SELECT i.kg_id,m.metadata_json FROM entity_ids i JOIN kg_entities e ON e.id=i.kg_id JOIN entity_meta m USING(entity_id) WHERE i.entity_id=?1 AND e.entity_type='Organization'",[id],|r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(AppError::internal)?;
    let Some((kg_id, metadata)) = row else {
        return Ok(None);
    };
    let metadata: Value = serde_json::from_str(&metadata).map_err(AppError::internal)?;
    if metadata.get("archived_at").is_some() || metadata.get("merged_into").is_some() {
        return Ok(None);
    }
    let entity = store.graph.get_entity(kg_id).map_err(AppError::internal)?;
    let props = serde_json::to_value(entity.properties).map_err(AppError::internal)?;
    let evidence: Vec<Value> = store
        .read_evidence(id)?
        .into_iter()
        .filter(|ev| {
            [
                "properties.name",
                "properties.legalName",
                "properties.identifier",
            ]
            .contains(&ev["field_path"].as_str().unwrap_or(""))
        })
        .collect();
    let conflicts: Vec<Value> = evidence
        .iter()
        .filter(|ev| {
            let key = ev["field_path"]
                .as_str()
                .unwrap()
                .strip_prefix("properties.")
                .unwrap();
            let current = &props[key];
            if let Some(array) = current.as_array() {
                !array.contains(&ev["value"])
            } else {
                current != &ev["value"]
            }
        })
        .cloned()
        .collect();
    Ok(Some(
        json!({"entity_id":id,"version":metadata["version"],"name":props["name"],
        "legal_name":props["legalName"],"identifiers":props["identifier"],"archived":false,
        "identity_complete":true,"evidence":evidence,"conflicts":conflicts}),
    ))
}

pub fn organizations(store: &Store, raw: &Value) -> Result<Value, AppError> {
    let ids = strings(raw, "entity_ids", 50)?;
    let credits = strings(raw, "credit_codes", 50)?;
    let names = strings(raw, "normalized_names", 50)?;
    if ids.is_empty() && credits.is_empty() && names.is_empty() {
        return Err(AppError::validation("At least one filter is required"));
    }
    let (offset, limit) = page(raw, 50)?;
    let mut matches = BTreeSet::new();
    for id in ids {
        matches.insert(id);
    }
    let conn = store.graph.connection();
    for (kind, values) in [("credit_code", credits), ("name", names)] {
        for value in values {
            let mut stmt = conn.prepare("SELECT entity_id FROM company_organization_keys WHERE kind=?1 AND value=?2 ORDER BY entity_id").map_err(AppError::internal)?;
            let rows = stmt
                .query_map(params![kind, normalize(&value)], |r| r.get::<_, String>(0))
                .map_err(AppError::internal)?;
            for row in rows {
                matches.insert(row.map_err(AppError::internal)?);
            }
        }
    }
    let mut all = Vec::new();
    for id in matches {
        if let Some(item) = identity(store, &id)? {
            all.push(item);
        }
    }
    let total = all.len();
    let items: Vec<_> = all.into_iter().skip(offset).take(limit).collect();
    let next = (offset.saturating_add(items.len()) < total).then_some(offset + items.len());
    Ok(json!({"items":items,"total":total,"next_offset":next,"complete":next.is_none()}))
}

fn live_ids(store: &Store, raw: &Value) -> Result<Vec<String>, AppError> {
    let ids = strings(raw, "organization_ids", 50)?;
    if ids.is_empty() {
        return Err(AppError::validation("organization_ids cannot be empty"));
    }
    let mut result = Vec::new();
    for id in ids {
        if identity(store, &id)?.is_some() {
            result.push(id);
        }
    }
    Ok(result)
}

fn edges_to(store: &Store, target_id: &str) -> Result<Vec<Value>, AppError> {
    let conn = store.graph.connection();
    let mut stmt = conn.prepare("SELECT ids.relation_id,s.entity_id,t.entity_id,r.rel_type,r.properties,m.metadata_json,se.entity_type,te.entity_type
      FROM relation_ids ids JOIN kg_relations r ON r.id=ids.kg_id
      JOIN entity_ids s ON s.kg_id=r.source_id JOIN entity_ids t ON t.kg_id=r.target_id
      JOIN kg_entities se ON se.id=r.source_id JOIN kg_entities te ON te.id=r.target_id
      JOIN relation_meta m USING(relation_id) JOIN entity_meta sm ON sm.entity_id=s.entity_id JOIN entity_meta tm ON tm.entity_id=t.entity_id
      WHERE t.entity_id=?1 AND r.rel_type IN ('worksFor','alumniOf','affiliation','memberOf','clientOrganization')
      AND json_extract(m.metadata_json,'$.archived_at') IS NULL
      AND json_extract(sm.metadata_json,'$.archived_at') IS NULL AND json_extract(tm.metadata_json,'$.archived_at') IS NULL
      AND json_extract(sm.metadata_json,'$.merged_into') IS NULL AND json_extract(tm.metadata_json,'$.merged_into') IS NULL
      ORDER BY ids.relation_id").map_err(AppError::internal)?;
    let rows = stmt
        .query_map([target_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })
        .map_err(AppError::internal)?;
    let mut edges = Vec::new();
    for row in rows {
        let (id, source, target, kind, props, meta, source_label, target_label) =
            row.map_err(AppError::internal)?;
        edges.push(
            json!({"relation_id":id,"source_id":source,"target_id":target,"relation_type":kind,
            "properties":serde_json::from_str::<Value>(&props).map_err(AppError::internal)?,
            "metadata":serde_json::from_str::<Value>(&meta).map_err(AppError::internal)?,
            "source_label":source_label,"target_label":target_label}),
        );
    }
    Ok(edges)
}

fn profession_edges(store: &Store, ids: &[String]) -> Result<Vec<Value>, AppError> {
    let mut selected = BTreeMap::<String, Value>::new();
    let mut projects = BTreeSet::<String>::new();
    for id in ids {
        for edge in edges_to(store, id)? {
            let kind = edge["relation_type"].as_str().unwrap();
            if kind == "clientOrganization" {
                if let Some(project) = edge["source_id"].as_str() {
                    projects.insert(project.into());
                }
            }
            if kind == "memberOf" && edge["target_label"] != "Organization" {
                continue;
            }
            let relation_id = edge["relation_id"].as_str().unwrap().to_owned();
            selected.insert(relation_id, edge);
        }
    }
    for project in projects {
        for edge in edges_to(store, &project)? {
            if edge["relation_type"] != "memberOf" || edge["target_label"] != "Project" {
                continue;
            }
            let relation_id = edge["relation_id"].as_str().unwrap().to_owned();
            selected.insert(relation_id, edge);
        }
    }
    Ok(selected
        .into_values()
        .map(|mut edge| {
            edge.as_object_mut().unwrap().remove("source_label");
            edge.as_object_mut().unwrap().remove("target_label");
            edge
        })
        .collect())
}

pub fn relations(store: &Store, raw: &Value) -> Result<Value, AppError> {
    let ids = live_ids(store, raw)?;
    let (offset, limit) = page(raw, 50)?;
    let edges = profession_edges(store, &ids)?;
    let total = edges.len();
    let items: Vec<_> = edges.into_iter().skip(offset).take(limit).collect();
    let next = (offset.saturating_add(items.len()) < total).then_some(offset + items.len());
    Ok(json!({"items":items,"total":total,"next_offset":next,"complete":next.is_none()}))
}

pub fn recent_records(store: &Store, raw: &Value) -> Result<Value, AppError> {
    let ids = live_ids(store, raw)?;
    let since = raw
        .get("since")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("since is required"))?;
    DateTime::parse_from_rfc3339(since).map_err(|_| AppError::validation("Invalid since"))?;
    let limit = raw
        .get("limit")
        .map_or(Some(20), Value::as_u64)
        .filter(|n| (1..=20).contains(n))
        .ok_or_else(|| AppError::validation("Invalid limit"))? as usize;
    let edges = profession_edges(store, &ids)?;
    let mut entity_ids: BTreeSet<String> = ids.into_iter().collect();
    for edge in &edges {
        for key in ["source_id", "target_id"] {
            if let Some(id) = edge[key].as_str() {
                entity_ids.insert(id.into());
            }
        }
    }
    let mut records = Vec::new();
    let conn = store.graph.connection();
    for id in entity_ids {
        let row:Option<(String,String)>=conn.query_row("SELECT e.entity_type,m.metadata_json FROM entity_ids i JOIN kg_entities e ON e.id=i.kg_id JOIN entity_meta m USING(entity_id) WHERE i.entity_id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(AppError::internal)?;
        if let Some((label, meta)) = row {
            let meta: Value = serde_json::from_str(&meta).map_err(AppError::internal)?;
            if let Some(time) = meta["updated_at"].as_str().filter(|t| *t > since) {
                records.push(json!({"kind":"entity","id":id,"entity_id":id,"recorded_at":time,"label":label}));
            }
        }
        let mut stmt=conn.prepare("SELECT evidence_id,record_json FROM evidence WHERE subject_kind='entity' AND subject_id=?1 AND field_path IN ('properties.name','properties.legalName','properties.identifier')").map_err(AppError::internal)?;
        let rows = stmt
            .query_map([&id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(AppError::internal)?;
        for row in rows {
            let (eid, record) = row.map_err(AppError::internal)?;
            let ev: Value = serde_json::from_str(&record).map_err(AppError::internal)?;
            if let Some(time) = ev["collected_at"].as_str().filter(|t| *t > since) {
                records.push(json!({"kind":"evidence","id":eid,"entity_id":id,"recorded_at":time,"label":"主体身份依据"}));
            }
        }
    }
    for edge in edges {
        if let Some(time) = edge["metadata"]["updated_at"]
            .as_str()
            .filter(|t| *t > since)
        {
            records.push(json!({"kind":"relation","id":edge["relation_id"],"recorded_at":time,"label":edge["relation_type"]}));
        }
    }
    records.sort_by(|a, b| {
        b["recorded_at"]
            .as_str()
            .cmp(&a["recorded_at"].as_str())
            .then_with(|| a["kind"].as_str().cmp(&b["kind"].as_str()))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let total = records.len();
    let items: Vec<_> = records.into_iter().take(limit).collect();
    let next = (items.len() < total).then_some(items.len());
    Ok(json!({"items":items,"total":total,"next_offset":next,"complete":next.is_none()}))
}
