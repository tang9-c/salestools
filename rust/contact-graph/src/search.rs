use rusqlite::named_params;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::{AppError, Store};

fn invalid(message: impl Into<String>) -> AppError {
    AppError {
        code: "VALIDATION_ERROR",
        message: message.into(),
    }
}

fn internal(error: impl std::fmt::Display) -> AppError {
    AppError {
        code: "INTERNAL_ERROR",
        message: error.to_string(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeywordInput {
    query: Option<String>,
    name: Option<String>,
    organization_id: Option<String>,
    job_title: Option<String>,
    skill: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityInput {
    phones: Vec<String>,
    emails: Vec<String>,
    accounts: Vec<String>,
}

/// Exact, bounded lookup used only to suggest a human-reviewed merge.
pub fn find_identity_candidates(store: &Store, raw: &Value) -> Result<Value, AppError> {
    let input: IdentityInput =
        serde_json::from_value(raw.clone()).map_err(|error| invalid(error.to_string()))?;
    if input.phones.len() > 20
        || input.emails.len() > 20
        || input.accounts.len() > 20
        || input
            .phones
            .iter()
            .chain(&input.emails)
            .chain(&input.accounts)
            .any(|value| value.is_empty() || value.len() > 200)
    {
        return Err(invalid("Invalid identity lookup values"));
    }
    let phones = serde_json::to_string(&input.phones).map_err(internal)?;
    let emails = serde_json::to_string(&input.emails).map_err(internal)?;
    let accounts = serde_json::to_string(&input.accounts).map_err(internal)?;
    let sql = format!(
        r#"
        SELECT i.entity_id {FROM_VISIBLE}
          AND e.entity_type='Person'
          AND (
            EXISTS (SELECT 1 FROM json_each(e.properties,'$.telephone') value
              JOIN json_each(:phones) needle
              ON replace(replace(replace(replace(value.value,' ',''),'-',''),'(',''),')','')=needle.value)
            OR EXISTS (SELECT 1 FROM json_each(e.properties,'$.email') value
              JOIN json_each(:emails) needle ON lower(value.value)=needle.value)
            OR EXISTS (SELECT 1 FROM json_each(e.properties,'$.contactPoint') point
              JOIN json_each(json_extract(point.value,'$.telephone')) value
              JOIN json_each(:phones) needle
              ON replace(replace(replace(replace(value.value,' ',''),'-',''),'(',''),')','')=needle.value
              WHERE lower(json_extract(point.value,'$.contactType')) IN ('self','personal','本人','私人'))
            OR EXISTS (SELECT 1 FROM json_each(e.properties,'$.contactPoint') point
              JOIN json_each(json_extract(point.value,'$.email')) value
              JOIN json_each(:emails) needle ON lower(value.value)=needle.value
              WHERE lower(json_extract(point.value,'$.contactType')) IN ('self','personal','本人','私人'))
            OR EXISTS (SELECT 1 FROM json_each(m.extensions_json,'$.instantMessaging') account
              JOIN json_each(:accounts) needle
              ON lower(json_extract(account.value,'$.platform')) || char(0) ||
                 json_extract(account.value,'$.accountId')=needle.value)
          )
        ORDER BY i.entity_id LIMIT 51
    "#
    );
    let mut statement = store.graph.connection().prepare(&sql).map_err(internal)?;
    let matches = statement
        .query_map(
            named_params! {
                ":phones":phones, ":emails":emails, ":accounts":accounts,
            },
            |row| row.get::<_, String>(0),
        )
        .map_err(internal)?;
    let mut ids = matches
        .map(|row| row.map_err(internal))
        .collect::<Result<Vec<_>, _>>()?;
    let truncated = ids.len() > 50;
    ids.truncate(50);
    Ok(json!({"entity_ids": ids, "truncated": truncated}))
}

fn filter(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

fn includes(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

fn properties_reason(properties: &Value, query: &str) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if properties["name"]
        .as_str()
        .is_some_and(|name| includes(name, query))
    {
        reasons.push("name");
    }
    if properties["alternateName"]
        .as_array()
        .is_some_and(|aliases| {
            aliases
                .iter()
                .any(|item| item.as_str().is_some_and(|alias| includes(alias, query)))
        })
    {
        reasons.push("alternate_name");
    }
    if properties["jobTitle"]
        .as_str()
        .is_some_and(|title| includes(title, query))
    {
        reasons.push("job_title");
    }
    if properties["skills"].as_array().is_some_and(|skills| {
        skills
            .iter()
            .any(|item| item.as_str().is_some_and(|skill| includes(skill, query)))
    }) {
        reasons.push("skill");
    }
    reasons
}

const FROM_VISIBLE: &str = r#"
    FROM entity_ids i
    JOIN kg_entities e ON e.id=i.kg_id
    JOIN entity_meta m ON m.entity_id=i.entity_id
    WHERE json_extract(m.metadata_json,'$.archived_at') IS NULL
      AND json_extract(m.metadata_json,'$.merged_into') IS NULL
      AND e.entity_type IN ('Person','Organization')
"#;

const ACTIVE_RELATION: &str = r#"
    SELECT 1 FROM kg_relations r
    JOIN relation_ids rid ON rid.kg_id=r.id
    JOIN relation_meta rm ON rm.relation_id=rid.relation_id
    JOIN entity_ids oid ON oid.kg_id=r.target_id
    JOIN entity_meta om ON om.entity_id=oid.entity_id
    JOIN kg_entities oe ON oe.id=r.target_id
    WHERE r.source_id=e.id AND r.rel_type='worksFor'
      AND json_extract(rm.metadata_json,'$.archived_at') IS NULL
      AND json_extract(om.metadata_json,'$.archived_at') IS NULL
      AND json_extract(om.metadata_json,'$.merged_into') IS NULL
"#;

fn where_sql() -> String {
    format!(
        r#"
      AND (:name IS NULL OR lower(json_extract(e.properties,'$.name'))=lower(:name)
        OR EXISTS (SELECT 1 FROM json_each(e.properties,'$.alternateName') alias
          WHERE lower(alias.value)=lower(:name)))
      AND (:skill IS NULL OR EXISTS (
        SELECT 1 FROM json_each(e.properties,'$.skills') skill
        WHERE lower(skill.value)=lower(:skill)))
      AND (:organization_id IS NULL OR EXISTS ({ACTIVE_RELATION}
        AND oid.entity_id=:organization_id
        AND (:job_title IS NULL OR instr(lower(json_extract(r.properties,'$.role.roleName')),
          lower(:job_title))>0)))
      AND (:job_title IS NULL OR :organization_id IS NOT NULL
        OR instr(lower(json_extract(e.properties,'$.jobTitle')),lower(:job_title))>0
        OR EXISTS ({ACTIVE_RELATION}
          AND instr(lower(json_extract(r.properties,'$.role.roleName')),lower(:job_title))>0))
      AND (:query IS NULL
        OR instr(lower(json_extract(e.properties,'$.name')),lower(:query))>0
        OR EXISTS (SELECT 1 FROM json_each(e.properties,'$.alternateName') alias
          WHERE instr(lower(alias.value),lower(:query))>0)
        OR instr(lower(json_extract(e.properties,'$.jobTitle')),lower(:query))>0
        OR EXISTS (SELECT 1 FROM json_each(e.properties,'$.skills') skill
          WHERE instr(lower(skill.value),lower(:query))>0)
        OR EXISTS ({ACTIVE_RELATION}
          AND (instr(lower(json_extract(r.properties,'$.role.roleName')),lower(:query))>0
            OR instr(lower(json_extract(oe.properties,'$.name')),lower(:query))>0)))
    "#
    )
}

/// Deterministic, read-only candidate lookup. Node adds mode_used and warnings.
pub fn search_keyword(store: &Store, raw: &Value) -> Result<Value, AppError> {
    let input: KeywordInput =
        serde_json::from_value(raw.clone()).map_err(|error| invalid(error.to_string()))?;
    let offset = input.offset.unwrap_or(0);
    let limit = input.limit.unwrap_or(10);
    if offset < 0 || !(1..=50).contains(&limit) {
        return Err(invalid("Invalid search pagination"));
    }
    let query = filter(input.query);
    let name = filter(input.name);
    let organization_id = filter(input.organization_id);
    let job_title = filter(input.job_title);
    let skill = filter(input.skill);
    let predicates = where_sql();
    let count_sql = format!("SELECT COUNT(*) {FROM_VISIBLE} {predicates}");
    let conn = store.graph.connection();
    let total: i64 = conn
        .query_row(
            &count_sql,
            named_params! {
                ":query":query.as_deref(), ":name":name.as_deref(),
                ":organization_id":organization_id.as_deref(),
                ":job_title":job_title.as_deref(), ":skill":skill.as_deref(),
            },
            |row| row.get(0),
        )
        .map_err(internal)?;
    let page_sql = format!(
        "SELECT i.entity_id,e.entity_type,e.properties {FROM_VISIBLE} {predicates}
         ORDER BY lower(json_extract(e.properties,'$.name')),i.entity_id
         LIMIT :limit OFFSET :offset"
    );
    let mut statement = conn.prepare(&page_sql).map_err(internal)?;
    let rows = statement
        .query_map(
            named_params! {
                ":query":query.as_deref(), ":name":name.as_deref(),
                ":organization_id":organization_id.as_deref(),
                ":job_title":job_title.as_deref(), ":skill":skill.as_deref(),
                ":limit":limit, ":offset":offset,
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(internal)?;
    let mut items = Vec::new();
    for row in rows {
        let (id, label, raw_properties) = row.map_err(internal)?;
        let properties: Value = serde_json::from_str(&raw_properties).map_err(internal)?;
        let mut reasons = query
            .as_deref()
            .map_or_else(Vec::new, |query| properties_reason(&properties, query));
        if name.is_some() && !reasons.contains(&"name") && !reasons.contains(&"alternate_name") {
            reasons.push("name");
        }
        if organization_id.is_some() {
            reasons.push("organization");
        }
        if job_title.is_some() && !reasons.contains(&"job_title") {
            reasons.push("relation_role");
        }
        if skill.is_some() && !reasons.contains(&"skill") {
            reasons.push("skill");
        }
        if query.is_some() && reasons.is_empty() {
            reasons.push("relation_match");
        }
        items.push(
            json!({"entity_id":id,"label":label,"name":properties["name"],
            "reasons":reasons}),
        );
    }
    let mut output = json!({"items":items,"total":total});
    if offset + (items.len() as i64) < total {
        output["next_offset"] = json!(offset + items.len() as i64);
    }
    Ok(output)
}
