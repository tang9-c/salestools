use serde_json::{Map, Value};
use std::collections::HashSet;

const COMMON_ARRAYS: &[&str] = &["alternateName", "telephone", "email", "sameAs"];
const PERSON_ARRAYS: &[&str] = &[
    "skills",
    "nationality",
    "workLocation",
    "knowsAbout",
    "knowsLanguage",
    "award",
    "hasOccupation",
    "hasCredential",
    "contactPoint",
    "faxNumber",
];
const COMMON_SCALARS: &[&str] = &["name", "description", "address", "url"];
const PERSON_SCALARS: &[&str] = &[
    "jobTitle",
    "givenName",
    "familyName",
    "additionalName",
    "honorificPrefix",
    "honorificSuffix",
    "birthDate",
    "deathDate",
    "gender",
    "birthPlace",
    "homeLocation",
    "image",
    "disambiguatingDescription",
];

pub fn has_substantive_person_data(properties: &Value, extensions: Option<&Value>) -> bool {
    let present = |value: &Value| match value {
        Value::Null => false,
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
        Value::String(text) => !text.trim().is_empty(),
        _ => true,
    };
    properties.as_object().is_some_and(|fields| {
        fields
            .iter()
            .any(|(key, value)| key != "name" && present(value))
    }) || extensions
        .and_then(Value::as_object)
        .is_some_and(|fields| fields.values().any(present))
}

pub fn allowed_entity_evidence_path(label: &str, path: &str) -> bool {
    if let Some(key) = path.strip_prefix("properties.") {
        COMMON_ARRAYS.contains(&key)
            || COMMON_SCALARS.contains(&key)
            || (label == "Person"
                && (PERSON_ARRAYS.contains(&key) || PERSON_SCALARS.contains(&key)))
            || (label == "Organization" && ["legalName", "identifier"].contains(&key))
    } else if let Some(key) = path.strip_prefix("extensions.") {
        label == "Person"
            && [
                "nativePlace",
                "hobbies",
                "maritalStatus",
                "instantMessaging",
            ]
            .contains(&key)
    } else {
        false
    }
}

fn object<'a>(value: &'a Value, context: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{context} must be an object"))
}

fn nonempty(value: &Value, context: &str) -> Result<String, String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{context} must be a string"))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{context} must not be empty"));
    }
    Ok(trimmed.to_owned())
}

fn absolute_http_url(value: &str) -> bool {
    (value.starts_with("https://") || value.starts_with("http://"))
        && value
            .split_once("://")
            .is_some_and(|(_, rest)| !rest.is_empty() && !rest.starts_with('/'))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

pub fn partial_date(value: &str) -> Result<(i32, u32, u32, u32, u32), String> {
    let parts: Vec<&str> = value.split('-').collect();
    if parts.is_empty()
        || parts.len() > 3
        || parts[0].len() != 4
        || parts.iter().skip(1).any(|part| part.len() != 2)
        || parts
            .iter()
            .any(|part| !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("Invalid partial date format".into());
    }
    let year: i32 = parts[0].parse().map_err(|_| "Invalid year")?;
    if year == 0 {
        return Err("Year zero is not supported".into());
    }
    let month: u32 = if parts.len() >= 2 {
        parts[1].parse().map_err(|_| "Invalid month")?
    } else {
        1
    };
    if !(1..=12).contains(&month) {
        return Err("Invalid month".into());
    }
    let day: u32 = if parts.len() == 3 {
        parts[2].parse().map_err(|_| "Invalid day")?
    } else {
        1
    };
    if day == 0 || day > days_in_month(year, month) {
        return Err("Invalid day".into());
    }
    let end_month = if parts.len() == 1 { 12 } else { month };
    let end_day = if parts.len() == 3 {
        day
    } else {
        days_in_month(year, end_month)
    };
    Ok((year, month, day, end_month, end_day))
}

fn validate_nested(value: &Value, kind: &str) -> Result<Value, String> {
    let fields = object(value, kind)?;
    let (required, optional): (&[&str], &[&str]) = match kind {
        "Country" => (&["@type", "name"], &[]),
        "Place" => (&["@type", "name"], &["address"]),
        "Occupation" => (&["@type", "name"], &["description"]),
        "EducationalOccupationalCredential" => (
            &["@type", "name"],
            &[
                "credentialCategory",
                "educationalLevel",
                "description",
                "url",
            ],
        ),
        "ContactPoint" => (&["@type", "contactType"], &["telephone", "email", "url"]),
        "PropertyValue" => (&["@type", "propertyID", "value"], &[]),
        _ => return Err("Unknown embedded object type".into()),
    };
    for key in fields.keys() {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return Err(format!("Unknown {kind} field: {key}"));
        }
    }
    if fields.get("@type").and_then(Value::as_str) != Some(kind) {
        return Err(format!("Embedded object must have @type={kind}"));
    }
    let mut output = Map::new();
    output.insert("@type".into(), Value::String(kind.into()));
    for key in required
        .iter()
        .chain(optional.iter())
        .filter(|key| **key != "@type")
    {
        if let Some(raw) = fields.get(*key) {
            if kind == "ContactPoint" && (*key == "telephone" || *key == "email") {
                output.insert((*key).into(), normalize_text_array(raw, key)?);
            } else {
                let value = nonempty(raw, key)?;
                if *key == "url" && !absolute_http_url(&value) {
                    return Err("URL must be absolute HTTP(S)".into());
                }
                output.insert((*key).into(), Value::String(value));
            }
        } else if kind == "ContactPoint" && (*key == "telephone" || *key == "email") {
            output.insert((*key).into(), Value::Array(vec![]));
        } else if required.contains(key) {
            return Err(format!("Missing {kind} field: {key}"));
        }
    }
    if kind == "ContactPoint"
        && output["telephone"].as_array().is_some_and(Vec::is_empty)
        && output["email"].as_array().is_some_and(Vec::is_empty)
        && !output.contains_key("url")
    {
        return Err("ContactPoint needs a contact value".into());
    }
    Ok(Value::Object(output))
}

fn normalize_text_array(raw: &Value, key: &str) -> Result<Value, String> {
    let values = raw
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for item in values {
        let value = nonempty(item, key)?;
        if key == "sameAs" && !absolute_http_url(&value) {
            return Err("sameAs requires HTTP(S) URL".into());
        }
        if seen.insert(value.clone()) {
            output.push(Value::String(value));
        }
    }
    Ok(Value::Array(output))
}

fn normalize_object_array(raw: &Value, key: &str, kind: &str) -> Result<Value, String> {
    let values = raw
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    let mut output = Vec::new();
    for item in values {
        let item = validate_nested(item, kind)?;
        if !output.contains(&item) {
            output.push(item);
        }
    }
    Ok(Value::Array(output))
}

pub fn normalize_properties(label: &str, raw: &Value, create: bool) -> Result<Value, String> {
    if label != "Person" && label != "Organization" {
        return Err("Unknown entity label".into());
    }
    let fields = object(raw, "properties")?;
    let mut output = Map::new();
    for (key, value) in fields {
        let normalized = if COMMON_ARRAYS.contains(&key.as_str())
            || (label == "Person"
                && PERSON_ARRAYS.contains(&key.as_str())
                && !matches!(
                    key.as_str(),
                    "nationality"
                        | "workLocation"
                        | "hasOccupation"
                        | "hasCredential"
                        | "contactPoint"
                )) {
            normalize_text_array(value, key)?
        } else if label == "Organization" && key == "identifier" {
            normalize_object_array(value, key, "PropertyValue")?
        } else if label == "Person"
            && matches!(
                key.as_str(),
                "nationality" | "workLocation" | "hasOccupation" | "hasCredential" | "contactPoint"
            )
        {
            let kind = match key.as_str() {
                "nationality" => "Country",
                "workLocation" => "Place",
                "hasOccupation" => "Occupation",
                "hasCredential" => "EducationalOccupationalCredential",
                _ => "ContactPoint",
            };
            normalize_object_array(value, key, kind)?
        } else if label == "Person" && matches!(key.as_str(), "birthPlace" | "homeLocation") {
            validate_nested(value, "Place")?
        } else if COMMON_SCALARS.contains(&key.as_str())
            || (label == "Person" && PERSON_SCALARS.contains(&key.as_str()))
            || (label == "Organization" && key == "legalName")
        {
            let text = nonempty(value, key)?;
            if matches!(key.as_str(), "url" | "image") && !absolute_http_url(&text) {
                return Err(format!("{key} requires an absolute HTTP(S) URL"));
            }
            if matches!(key.as_str(), "birthDate" | "deathDate") {
                partial_date(&text)?;
            }
            Value::String(text)
        } else {
            return Err(format!("Unknown {label} property: {key}"));
        };
        output.insert(key.clone(), normalized);
    }
    if create {
        if label == "Organization" && !output.get("name").is_some_and(Value::is_string) {
            return Err("name is required".into());
        }
        for key in COMMON_ARRAYS.iter().chain(if label == "Person" {
            PERSON_ARRAYS
        } else {
            &["identifier"]
        }) {
            output
                .entry((*key).to_owned())
                .or_insert_with(|| Value::Array(vec![]));
        }
    }
    if let (Some(birth), Some(death)) = (output.get("birthDate"), output.get("deathDate")) {
        let b = partial_date(birth.as_str().unwrap())?;
        let d = partial_date(death.as_str().unwrap())?;
        if (b.0, b.1, b.2) > (d.0, d.3, d.4) {
            return Err("Birth date is after death date".into());
        }
    }
    Ok(Value::Object(output))
}

pub fn normalize_extensions(raw: &Value, create: bool) -> Result<Value, String> {
    let fields = object(raw, "extensions")?;
    let mut output = Map::new();
    for (key, value) in fields {
        let normalized = match key.as_str() {
            "nativePlace" => Value::String(nonempty(value, key)?),
            "hobbies" => normalize_text_array(value, key)?,
            "maritalStatus" => {
                let status = object(value, "maritalStatus")?;
                if status.keys().any(|key| key != "status" && key != "asOf") {
                    return Err("Unknown maritalStatus field".into());
                }
                let choice = status
                    .get("status")
                    .and_then(Value::as_str)
                    .ok_or("maritalStatus.status is required")?;
                if !["never_married", "married", "divorced", "widowed", "other"].contains(&choice) {
                    return Err("Invalid maritalStatus.status".into());
                }
                if let Some(as_of) = status.get("asOf") {
                    partial_date(as_of.as_str().ok_or("maritalStatus.asOf must be text")?)?;
                }
                value.clone()
            }
            "instantMessaging" => {
                let values = value
                    .as_array()
                    .ok_or("instantMessaging must be an array")?;
                let mut seen = HashSet::new();
                let mut normalized = Vec::new();
                for item in values {
                    let item = object(item, "instantMessaging item")?;
                    if item
                        .keys()
                        .any(|key| !["platform", "accountId", "label"].contains(&key.as_str()))
                    {
                        return Err("Unknown instantMessaging field".into());
                    }
                    let platform =
                        nonempty(item.get("platform").ok_or("Missing platform")?, "platform")?;
                    if !platform
                        .bytes()
                        .next()
                        .is_some_and(|b| b.is_ascii_lowercase())
                        || !platform.bytes().all(|b| {
                            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-'
                        })
                    {
                        return Err("Invalid instantMessaging platform".into());
                    }
                    let account_id = nonempty(
                        item.get("accountId").ok_or("Missing accountId")?,
                        "accountId",
                    )?;
                    if !seen.insert((platform.clone(), account_id.clone())) {
                        return Err("Duplicate instantMessaging account".into());
                    }
                    let mut object = Map::new();
                    object.insert("platform".into(), Value::String(platform));
                    object.insert("accountId".into(), Value::String(account_id));
                    if let Some(label) = item.get("label") {
                        object.insert("label".into(), Value::String(nonempty(label, "label")?));
                    }
                    normalized.push(Value::Object(object));
                }
                Value::Array(normalized)
            }
            _ => return Err(format!("Unknown Person extension: {key}")),
        };
        output.insert(key.clone(), normalized);
    }
    if create {
        output
            .entry("hobbies")
            .or_insert_with(|| Value::Array(vec![]));
        output
            .entry("instantMessaging")
            .or_insert_with(|| Value::Array(vec![]));
    }
    Ok(Value::Object(output))
}

pub fn ensure_value_evidence(
    properties: &Value,
    extensions: Option<&Value>,
    evidence: &[Value],
) -> Result<(), String> {
    fn quote_supports(value: &Value, quote: &str) -> bool {
        match value {
            Value::Object(fields) => fields
                .iter()
                .filter(|(key, _)| key.as_str() != "@type")
                .all(|(_, value)| quote_supports(value, quote)),
            Value::Array(items) => items.iter().all(|value| quote_supports(value, quote)),
            Value::String(text) => quote.contains(text),
            other => quote.contains(&other.to_string()),
        }
    }
    fn supports_value(record: &Value, value: &Value) -> bool {
        match record.get("source_type").and_then(Value::as_str) {
            Some("manual") => record["locator_status"] == "not_applicable",
            Some("file" | "web") => {
                record["locator_status"] == "located"
                    && record
                        .get("quote")
                        .and_then(Value::as_str)
                        .is_some_and(|quote| quote_supports(value, quote))
            }
            _ => false,
        }
    }
    for record in evidence {
        if let Some(leaf) = record.get("value_path").and_then(Value::as_str) {
            if leaf == "@type"
                || !record
                    .get("value")
                    .and_then(Value::as_object)
                    .is_some_and(|value| value.contains_key(leaf))
            {
                return Err("Evidence value_path must name a selected object leaf".into());
            }
        }
    }
    for (scope, fields) in [("properties", Some(properties)), ("extensions", extensions)] {
        let Some(fields) = fields else { continue };
        for (key, value) in object(fields, scope)? {
            let path = format!("{scope}.{key}");
            let values: Vec<&Value> = match value {
                Value::Array(items) => items.iter().collect(),
                other => vec![other],
            };
            for selected in values {
                let matching: Vec<&Value> = evidence
                    .iter()
                    .filter(|record| {
                        record.get("field_path").and_then(Value::as_str) == Some(path.as_str())
                            && record.get("value") == Some(selected)
                    })
                    .collect();
                let supported = if let Some(object) = selected.as_object() {
                    matching.iter().any(|record| {
                        record.get("value_path").is_none() && supports_value(record, selected)
                    }) || object
                        .keys()
                        .filter(|key| key.as_str() != "@type")
                        .all(|key| {
                            matching.iter().any(|record| {
                                record.get("value_path").and_then(Value::as_str) == Some(key)
                                    && supports_value(record, &object[key])
                            })
                        })
                } else {
                    matching.iter().any(|record| {
                        record.get("value_path").is_none() && supports_value(record, selected)
                    })
                };
                if !supported {
                    return Err(format!("Missing evidence for {path} value"));
                }
            }
        }
    }
    Ok(())
}
