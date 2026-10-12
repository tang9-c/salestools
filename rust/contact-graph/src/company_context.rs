use chrono::DateTime;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use crate::store::{AppError, Store};

fn normalize(value: &str) -> String {
    value
        .nfkc()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_lowercase())
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
        CREATE TABLE IF NOT EXISTS company_context_migrations (version INTEGER PRIMARY KEY);
        CREATE INDEX IF NOT EXISTS company_relation_target_lookup ON kg_relations(target_id);").map_err(AppError::internal)?;
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
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(AppError::internal)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::internal)?;
        rows
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
    let mut statement = conn.prepare("SELECT record_json FROM evidence WHERE subject_kind='entity' AND subject_id=?1 AND field_path IN ('properties.name','properties.legalName','properties.identifier') ORDER BY rowid LIMIT 51").map_err(AppError::internal)?;
    let rows = statement
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(AppError::internal)?;
    let mut evidence = rows
        .map(|row| {
            serde_json::from_str::<Value>(&row.map_err(AppError::internal)?)
                .map_err(AppError::internal)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let identity_complete = evidence.len() <= 50;
    evidence.truncate(50);
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
        "legal_name":props["legalName"],"identifiers":props["identifier"].as_array().cloned().unwrap_or_default(),"archived":false,
        "identity_complete":identity_complete,"evidence":evidence,"conflicts":conflicts}),
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
    let conn = store.graph.connection();
    let mut stmt = conn.prepare("WITH candidates AS (
        SELECT value AS entity_id FROM json_each(?1)
        UNION SELECT entity_id FROM company_organization_keys WHERE kind='credit_code' AND value IN (SELECT value FROM json_each(?2))
        UNION SELECT entity_id FROM company_organization_keys WHERE kind='name' AND value IN (SELECT value FROM json_each(?3))
      ) SELECT c.entity_id FROM candidates c JOIN entity_ids i ON i.entity_id=c.entity_id
        JOIN kg_entities e ON e.id=i.kg_id JOIN entity_meta m ON m.entity_id=c.entity_id
      WHERE e.entity_type='Organization' AND json_extract(m.metadata_json,'$.archived_at') IS NULL
        AND json_extract(m.metadata_json,'$.merged_into') IS NULL
      ORDER BY c.entity_id LIMIT ?4 OFFSET ?5").map_err(AppError::internal)?;
    let normalized_credits: Vec<_> = credits.iter().map(|s| normalize(s)).collect();
    let normalized_names: Vec<_> = names.iter().map(|s| normalize(s)).collect();
    let rows = stmt
        .query_map(
            params![
                json!(ids).to_string(),
                json!(normalized_credits).to_string(),
                json!(normalized_names).to_string(),
                (limit + 1) as i64,
                offset.min(i64::MAX as usize) as i64
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(AppError::internal)?;
    let found = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::internal)?;
    let has_more = found.len() > limit;
    let mut items = Vec::new();
    for id in found.into_iter().take(limit) {
        if let Some(item) = identity(store, &id)? {
            items.push(item);
        }
    }
    let next = has_more.then_some(offset + items.len());
    Ok(json!({"items":items,"total":null,"next_offset":next,"complete":next.is_none()}))
}

// The same bounded professional path drives relation pages and recent records.
// A project is reachable only through its clientOrganization edge to a selected organization.
const REACHABLE: &str = r#"
WITH requested AS (SELECT DISTINCT value AS entity_id FROM json_each(?1)),
selected_org AS (
  SELECT i.kg_id,i.entity_id FROM requested q
  JOIN entity_ids i ON i.entity_id=q.entity_id
  JOIN kg_entities e ON e.id=i.kg_id
  JOIN entity_meta m ON m.entity_id=i.entity_id
  WHERE e.entity_type='Organization'
    AND json_extract(m.metadata_json,'$.archived_at') IS NULL
    AND json_extract(m.metadata_json,'$.merged_into') IS NULL
),
client_projects AS (
  SELECT DISTINCT r.source_id AS kg_id FROM selected_org org
  JOIN kg_relations r ON r.target_id=org.kg_id AND r.rel_type='clientOrganization'
  JOIN relation_ids rid ON rid.kg_id=r.id
  JOIN relation_meta rm ON rm.relation_id=rid.relation_id
  JOIN entity_ids source ON source.kg_id=r.source_id
  JOIN kg_entities project ON project.id=r.source_id AND project.entity_type='Project'
  JOIN entity_meta sm ON sm.entity_id=source.entity_id
  WHERE json_extract(rm.metadata_json,'$.archived_at') IS NULL
    AND json_extract(sm.metadata_json,'$.archived_at') IS NULL
    AND json_extract(sm.metadata_json,'$.merged_into') IS NULL
),
reachable_ids AS (
  SELECT rid.relation_id FROM selected_org org
  JOIN kg_relations r ON r.target_id=org.kg_id
  JOIN relation_ids rid ON rid.kg_id=r.id
  WHERE r.rel_type IN ('worksFor','alumniOf','affiliation','memberOf','clientOrganization')
  UNION
  SELECT rid.relation_id FROM client_projects project
  JOIN kg_relations r ON r.target_id=project.kg_id AND r.rel_type='memberOf'
  JOIN relation_ids rid ON rid.kg_id=r.id
),
live_relations AS (
  SELECT rid.relation_id,source.entity_id AS source_id,target.entity_id AS target_id,
         r.rel_type,r.properties,rm.metadata_json
  FROM reachable_ids ids
  JOIN relation_ids rid ON rid.relation_id=ids.relation_id
  JOIN kg_relations r ON r.id=rid.kg_id
  JOIN relation_meta rm ON rm.relation_id=rid.relation_id
  JOIN entity_ids source ON source.kg_id=r.source_id
  JOIN entity_ids target ON target.kg_id=r.target_id
  JOIN entity_meta sm ON sm.entity_id=source.entity_id
  JOIN entity_meta tm ON tm.entity_id=target.entity_id
  WHERE json_extract(rm.metadata_json,'$.archived_at') IS NULL
    AND json_extract(sm.metadata_json,'$.archived_at') IS NULL
    AND json_extract(sm.metadata_json,'$.merged_into') IS NULL
    AND json_extract(tm.metadata_json,'$.archived_at') IS NULL
    AND json_extract(tm.metadata_json,'$.merged_into') IS NULL
)
"#;

fn organization_ids(raw: &Value) -> Result<Vec<String>, AppError> {
    let ids = strings(raw, "organization_ids", 50)?;
    if ids.is_empty() {
        return Err(AppError::validation("organization_ids cannot be empty"));
    }
    Ok(ids)
}

pub fn relations(store: &Store, raw: &Value) -> Result<Value, AppError> {
    let ids = organization_ids(raw)?;
    let (offset, limit) = page(raw, 50)?;
    let sql = format!(
        "{REACHABLE} SELECT relation_id,source_id,target_id,rel_type,properties,metadata_json
        FROM live_relations ORDER BY relation_id LIMIT ?2 OFFSET ?3"
    );
    let mut stmt = store
        .graph
        .connection()
        .prepare(&sql)
        .map_err(AppError::internal)?;
    let rows = stmt
        .query_map(
            params![
                json!(ids).to_string(),
                (limit + 1) as i64,
                offset.min(i64::MAX as usize) as i64
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .map_err(AppError::internal)?;
    let mut items = Vec::new();
    let mut more = false;
    for row in rows {
        if items.len() == limit {
            more = true;
            break;
        }
        let (id, source, target, kind, properties, metadata) = row.map_err(AppError::internal)?;
        items.push(json!({"relation_id":id,"source_id":source,"target_id":target,
            "relation_type":kind,"properties":serde_json::from_str::<Value>(&properties).map_err(AppError::internal)?,
            "metadata":serde_json::from_str::<Value>(&metadata).map_err(AppError::internal)?}));
    }
    let next = more.then_some(offset.saturating_add(items.len()));
    Ok(json!({"items":items,"total":null,"next_offset":next,"complete":next.is_none()}))
}

pub fn recent_records(store: &Store, raw: &Value) -> Result<Value, AppError> {
    let ids = organization_ids(raw)?;
    let (offset, limit) = page(raw, 20)?;
    let since = raw
        .get("since")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("since is required"))?;
    DateTime::parse_from_rfc3339(since).map_err(|_| AppError::validation("Invalid since"))?;
    let sql = format!(
        r#"{REACHABLE},
reachable_entities AS (
  SELECT entity_id FROM selected_org
  UNION SELECT source_id FROM live_relations
  UNION SELECT target_id FROM live_relations
),
safe_records AS (
  SELECT 'entity' AS kind,re.entity_id AS id,re.entity_id AS entity_id,
         json_extract(m.metadata_json,'$.updated_at') AS recorded_at,e.entity_type AS label
  FROM reachable_entities re
  JOIN entity_ids i ON i.entity_id=re.entity_id JOIN kg_entities e ON e.id=i.kg_id
  JOIN entity_meta m ON m.entity_id=re.entity_id
  WHERE json_extract(m.metadata_json,'$.archived_at') IS NULL
    AND json_extract(m.metadata_json,'$.merged_into') IS NULL
  UNION ALL
  SELECT 'relation',r.relation_id,r.source_id,json_extract(r.metadata_json,'$.updated_at'),r.rel_type
  FROM live_relations r
  UNION ALL
  SELECT 'evidence',ev.evidence_id,ev.subject_id,
         json_extract(ev.record_json,'$.collected_at'),
         CASE WHEN e.entity_type='Person' THEN '职业身份依据' ELSE '主体身份依据' END
  FROM reachable_entities re
  JOIN evidence ev ON ev.subject_kind='entity' AND ev.subject_id=re.entity_id
  JOIN entity_ids i ON i.entity_id=re.entity_id JOIN kg_entities e ON e.id=i.kg_id
  WHERE (e.entity_type='Organization' AND ev.field_path IN
         ('properties.name','properties.legalName','properties.identifier'))
     OR (e.entity_type='Person' AND ev.field_path IN
         ('properties.name','properties.jobTitle','properties.hasOccupation','properties.skills'))
     OR (e.entity_type='Project' AND ev.field_path IN ('properties.name','properties.description'))
  UNION ALL
  SELECT 'evidence',ev.evidence_id,r.source_id,
         json_extract(ev.record_json,'$.collected_at'),'职业关系依据'
  FROM live_relations r
  JOIN evidence ev ON ev.subject_kind='relation' AND ev.subject_id=r.relation_id
  WHERE ev.field_path='$relation' OR ev.field_path LIKE 'properties.%' OR ev.field_path LIKE 'metadata.%'
)
SELECT kind,id,entity_id,recorded_at,label FROM safe_records
WHERE julianday(recorded_at)>julianday(?2)
ORDER BY julianday(recorded_at) DESC,kind,id LIMIT ?3 OFFSET ?4"#
    );
    let mut stmt = store
        .graph
        .connection()
        .prepare(&sql)
        .map_err(AppError::internal)?;
    let rows = stmt
        .query_map(
            params![
                json!(ids).to_string(),
                since,
                (limit + 1) as i64,
                offset.min(i64::MAX as usize) as i64
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(AppError::internal)?;
    let mut items = Vec::new();
    let mut more = false;
    for row in rows {
        if items.len() == limit {
            more = true;
            break;
        }
        let (kind, id, entity_id, recorded_at, label) = row.map_err(AppError::internal)?;
        let mut record = json!({"kind":kind,"id":id,"recorded_at":recorded_at,"label":label});
        record["entity_id"] = json!(entity_id);
        items.push(record);
    }
    let next = more.then_some(offset.saturating_add(items.len()));
    Ok(json!({"items":items,"total":null,"next_offset":next,"complete":next.is_none()}))
}
