use rusqlite::{named_params, OptionalExtension};
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
    include_unverified: Option<bool>,
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

const ACTIVE_INSTITUTION_RELATION: &str = r#"
    SELECT 1 FROM kg_relations r
    JOIN relation_ids rid ON rid.kg_id=r.id
    JOIN relation_meta rm ON rm.relation_id=rid.relation_id
    JOIN entity_ids oid ON oid.kg_id=r.target_id
    JOIN entity_meta om ON om.entity_id=oid.entity_id
    JOIN kg_entities oe ON oe.id=r.target_id
    WHERE r.source_id=e.id AND r.rel_type IN ('worksFor','alumniOf')
      AND json_extract(rm.metadata_json,'$.archived_at') IS NULL
      AND json_extract(om.metadata_json,'$.archived_at') IS NULL
      AND json_extract(om.metadata_json,'$.merged_into') IS NULL
"#;

// The only customer-to-person route is an explicit project participation and
// an explicit project client edge. Claims can substitute for either edge only
// when the caller opted in; every endpoint must still be a visible graph node.
const PROJECT_PATH_CTES: &str = r#"
    member_edges AS (
      SELECT person.entity_id AS person_id,project.entity_id AS project_id,
             NULL AS claim_id
      FROM kg_relations r
      JOIN relation_ids rid ON rid.kg_id=r.id
      JOIN relation_meta rm ON rm.relation_id=rid.relation_id
      JOIN entity_ids person ON person.kg_id=r.source_id
      JOIN entity_ids project ON project.kg_id=r.target_id
      WHERE r.rel_type='memberOf'
        AND json_extract(rm.metadata_json,'$.archived_at') IS NULL
      UNION ALL
      SELECT c.subject_id,c.target_id,c.claim_id
      FROM contact_claims c
      WHERE :include_unverified=1 AND c.kind='relation'
        AND c.relation_type='memberOf' AND c.status='unverified'
        AND c.target_id IS NOT NULL
    ), client_edges AS (
      SELECT project.entity_id AS project_id,client.entity_id AS client_id,
             NULL AS claim_id
      FROM kg_relations r
      JOIN relation_ids rid ON rid.kg_id=r.id
      JOIN relation_meta rm ON rm.relation_id=rid.relation_id
      JOIN entity_ids project ON project.kg_id=r.source_id
      JOIN entity_ids client ON client.kg_id=r.target_id
      WHERE r.rel_type='clientOrganization'
        AND json_extract(rm.metadata_json,'$.archived_at') IS NULL
      UNION ALL
      SELECT c.subject_id,c.target_id,c.claim_id
      FROM contact_claims c
      WHERE :include_unverified=1 AND c.kind='relation'
        AND c.relation_type='clientOrganization' AND c.status='unverified'
        AND c.target_id IS NOT NULL
    ), project_matches AS (
      SELECT member.person_id,member.project_id,
             member.claim_id AS member_claim_id,client.claim_id AS client_claim_id,
             (member.claim_id IS NOT NULL)+(client.claim_id IS NOT NULL) AS claim_count
      FROM member_edges member
      JOIN client_edges client ON client.project_id=member.project_id
      JOIN entity_ids pid ON pid.entity_id=member.person_id
      JOIN kg_entities pe ON pe.id=pid.kg_id AND pe.entity_type='Person'
      JOIN entity_meta pm ON pm.entity_id=pid.entity_id
      JOIN entity_ids prid ON prid.entity_id=member.project_id
      JOIN kg_entities pre ON pre.id=prid.kg_id AND pre.entity_type='Project'
      JOIN entity_meta prm ON prm.entity_id=prid.entity_id
      JOIN entity_ids oid ON oid.entity_id=client.client_id
      JOIN kg_entities oe ON oe.id=oid.kg_id AND oe.entity_type='Organization'
      JOIN entity_meta om ON om.entity_id=oid.entity_id
      WHERE :query IS NOT NULL
        AND (instr(lower(json_extract(oe.properties,'$.name')),lower(:query))>0
          OR EXISTS (SELECT 1 FROM json_each(oe.properties,'$.alternateName') alias
            WHERE instr(lower(alias.value),lower(:query))>0))
        AND json_extract(pm.metadata_json,'$.archived_at') IS NULL
        AND json_extract(pm.metadata_json,'$.merged_into') IS NULL
        AND json_extract(prm.metadata_json,'$.archived_at') IS NULL
        AND json_extract(prm.metadata_json,'$.merged_into') IS NULL
        AND json_extract(om.metadata_json,'$.archived_at') IS NULL
        AND json_extract(om.metadata_json,'$.merged_into') IS NULL
    )
"#;

fn where_sql(include_project_match: bool) -> String {
    let project_match = if include_project_match {
        "OR EXISTS (SELECT 1 FROM project_matches pm WHERE pm.person_id=i.entity_id AND pm.claim_count=0)"
    } else {
        ""
    };
    format!(
        r#"
      AND (:name IS NULL OR lower(json_extract(e.properties,'$.name'))=lower(:name)
        OR EXISTS (SELECT 1 FROM json_each(e.properties,'$.alternateName') alias
          WHERE lower(alias.value)=lower(:name)))
      AND (:skill IS NULL OR EXISTS (
        SELECT 1 FROM json_each(e.properties,'$.skills') skill
        WHERE lower(skill.value)=lower(:skill)))
      AND (:organization_id IS NULL OR EXISTS ({ACTIVE_INSTITUTION_RELATION}
        AND oid.entity_id=:organization_id
        AND (:job_title IS NULL OR (r.rel_type='worksFor' AND instr(lower(json_extract(r.properties,'$.role.roleName')),
          lower(:job_title))>0))))
      AND (:job_title IS NULL OR :organization_id IS NOT NULL
        OR instr(lower(json_extract(e.properties,'$.jobTitle')),lower(:job_title))>0
        OR EXISTS ({ACTIVE_INSTITUTION_RELATION}
          AND r.rel_type='worksFor'
          AND instr(lower(json_extract(r.properties,'$.role.roleName')),lower(:job_title))>0))
      AND (:query IS NULL
        OR instr(lower(json_extract(e.properties,'$.name')),lower(:query))>0
        OR EXISTS (SELECT 1 FROM json_each(e.properties,'$.alternateName') alias
          WHERE instr(lower(alias.value),lower(:query))>0)
        OR instr(lower(json_extract(e.properties,'$.jobTitle')),lower(:query))>0
        OR EXISTS (SELECT 1 FROM json_each(e.properties,'$.skills') skill
          WHERE instr(lower(skill.value),lower(:query))>0)
        OR EXISTS ({ACTIVE_INSTITUTION_RELATION}
          AND ((r.rel_type='worksFor' AND instr(lower(json_extract(r.properties,'$.role.roleName')),lower(:query))>0)
            OR instr(lower(json_extract(oe.properties,'$.name')),lower(:query))>0))
        {project_match})
    "#
    )
}

fn matching_project(
    store: &Store,
    person_id: &str,
    query: &str,
    include_unverified: bool,
) -> Result<Option<(String, Option<String>, Option<String>)>, AppError> {
    let sql = format!(
        "WITH {PROJECT_PATH_CTES}
         SELECT project_id,member_claim_id,client_claim_id FROM project_matches
         WHERE person_id=:person_id
         ORDER BY claim_count,project_id,member_claim_id,client_claim_id LIMIT 1"
    );
    store
        .graph
        .connection()
        .query_row(
            &sql,
            named_params! {
                ":query":query, ":include_unverified":include_unverified as i64,
                ":person_id":person_id,
            },
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(internal)
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
    let include_unverified = input.include_unverified.unwrap_or(false);
    if include_unverified && query.is_none() {
        return Err(invalid("include_unverified requires a nonempty query"));
    }
    let predicates = where_sql(true);
    // Structured filters retain their factual meaning. Only the free-text query
    // may match a claim; provenance quotes and JSON keys are not searchable facts.
    let official = format!("SELECT i.entity_id,e.entity_type,e.properties,NULL AS claim_id,0 AS priority {FROM_VISIBLE} {predicates}");
    let candidates = if include_unverified {
        let factual_filters = where_sql(false).replace(":query", "NULL");
        format!(
            r#"WITH {PROJECT_PATH_CTES}, confirmed AS ({official}), claim_hits AS (
            SELECT i.entity_id,e.entity_type,e.properties,
              (SELECT MIN(c.claim_id) FROM contact_claims c
                WHERE c.subject_id=i.entity_id AND c.status='unverified'
                  AND EXISTS (SELECT 1 FROM json_tree(CASE WHEN c.kind='relation' THEN
                      json_object('target_name',json_extract(c.value_json,'$.target_name'),
                        'properties',json_extract(c.value_json,'$.properties'))
                      ELSE c.value_json END) leaf
                    WHERE leaf.type='text' AND leaf.key IS NOT '@type'
                      AND instr(lower(leaf.atom),lower(:query))>0)) AS claim_id,
              1 AS priority
            {FROM_VISIBLE} {factual_filters}
              AND NOT EXISTS (SELECT 1 FROM confirmed f WHERE f.entity_id=i.entity_id)
        ), candidates AS (
            SELECT * FROM confirmed UNION ALL SELECT * FROM claim_hits
              WHERE claim_id IS NOT NULL OR EXISTS (
                SELECT 1 FROM project_matches pm
                WHERE pm.person_id=claim_hits.entity_id AND pm.claim_count>0)
        )"#
        )
    } else {
        format!("WITH {PROJECT_PATH_CTES}, candidates AS ({official})")
    };
    let count_sql = format!("{candidates} SELECT COUNT(*) FROM candidates");
    let conn = store.graph.connection();
    let total: i64 = conn
        .query_row(
            &count_sql,
            named_params! {
                ":query":query.as_deref(), ":name":name.as_deref(),
                ":organization_id":organization_id.as_deref(),
                ":job_title":job_title.as_deref(), ":skill":skill.as_deref(),
                ":include_unverified":include_unverified as i64,
            },
            |row| row.get(0),
        )
        .map_err(internal)?;
    let page_sql = format!(
        "{candidates} SELECT entity_id,entity_type,properties,claim_id,priority FROM candidates
         ORDER BY priority,lower(json_extract(properties,'$.name')),entity_id
         LIMIT :limit OFFSET :offset"
    );
    let mut statement = conn.prepare(&page_sql).map_err(internal)?;
    let rows = statement
        .query_map(
            named_params! {
                ":query":query.as_deref(), ":name":name.as_deref(),
                ":organization_id":organization_id.as_deref(),
                ":job_title":job_title.as_deref(), ":skill":skill.as_deref(),
                ":include_unverified":include_unverified as i64,
                ":limit":limit, ":offset":offset,
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .map_err(internal)?;
    let mut items = Vec::new();
    for row in rows {
        let (id, label, raw_properties, claim_id, priority) = row.map_err(internal)?;
        let properties: Value = serde_json::from_str(&raw_properties).map_err(internal)?;
        let project = if label == "Person" {
            query
                .as_deref()
                // A confirmed direct hit must not inherit the status of an
                // unrelated weak project route that happens to match the query.
                .map(|query| {
                    matching_project(store, &id, query, include_unverified && priority > 0)
                })
                .transpose()?
                .flatten()
        } else {
            None
        };
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
        if project.is_some() {
            reasons.push("project_client_match");
        }
        if query.is_some() && reasons.is_empty() {
            reasons.push("relation_match");
        }
        let mut item = json!({"entity_id":id,"label":label,"name":properties["name"],
            "reasons":reasons});
        if include_unverified {
            if let Some(claim_id) = claim_id {
                item["match_status"] = json!("unverified");
                item["claim_id"] = json!(claim_id);
                item["reasons"] = json!(["unverified_claim"]);
            } else {
                item["match_status"] = json!("confirmed");
            }
        }
        if let Some((project_id, member_claim, client_claim)) = project {
            item["matched_project_id"] = json!(project_id);
            let claim_ids: Vec<String> =
                [member_claim, client_claim].into_iter().flatten().collect();
            if !claim_ids.is_empty() {
                item["match_status"] = json!("unverified");
                item["claim_ids"] = json!(claim_ids);
                item["reasons"] = json!(["project_client_match"]);
            } else {
                item["match_status"] = json!("confirmed");
            }
        }
        items.push(item);
    }
    let mut output = json!({"items":items,"total":total});
    if offset + (items.len() as i64) < total {
        output["next_offset"] = json!(offset + items.len() as i64);
    }
    Ok(output)
}
