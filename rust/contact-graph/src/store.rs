use sqlite_knowledge_graph::KnowledgeGraph;
use std::path::Path;

pub struct Store {
    pub graph: KnowledgeGraph,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Box<dyn std::error::Error>> {
        let graph = KnowledgeGraph::open(path)?;
        graph.connection().execute_batch(
            "
            CREATE TABLE IF NOT EXISTS entity_ids (
                entity_id TEXT PRIMARY KEY,
                kg_id INTEGER NOT NULL UNIQUE REFERENCES kg_entities(id)
            );
            CREATE TABLE IF NOT EXISTS relation_ids (
                relation_id TEXT PRIMARY KEY,
                kg_id INTEGER NOT NULL UNIQUE REFERENCES kg_relations(id)
            );
            CREATE TABLE IF NOT EXISTS entity_meta (
                entity_id TEXT PRIMARY KEY REFERENCES entity_ids(entity_id),
                metadata_json TEXT NOT NULL,
                extensions_json TEXT
            );
            CREATE TABLE IF NOT EXISTS relation_meta (
                relation_id TEXT PRIMARY KEY REFERENCES relation_ids(relation_id),
                metadata_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS evidence (
                evidence_id TEXT PRIMARY KEY,
                subject_kind TEXT NOT NULL CHECK(subject_kind IN ('entity','relation')),
                subject_id TEXT NOT NULL,
                field_path TEXT NOT NULL,
                value_json TEXT NOT NULL,
                record_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS evidence_subject ON evidence(subject_kind, subject_id);
            CREATE TABLE IF NOT EXISTS source_mapping (
                source_key TEXT PRIMARY KEY,
                entity_id TEXT NOT NULL REFERENCES entity_ids(entity_id),
                relation_id TEXT REFERENCES relation_ids(relation_id)
            );
            CREATE INDEX IF NOT EXISTS source_mapping_entity ON source_mapping(entity_id);
            CREATE TABLE IF NOT EXISTS operation_results (
                operation_id TEXT PRIMARY KEY,
                actor TEXT NOT NULL,
                op TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                result_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_jobs (
                import_id TEXT PRIMARY KEY,
                file_id TEXT NOT NULL UNIQUE,
                actor TEXT NOT NULL,
                status TEXT NOT NULL,
                version INTEGER NOT NULL,
                data_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS import_jobs_status ON import_jobs(status);
            CREATE TABLE IF NOT EXISTS sync_cursor (
                id INTEGER PRIMARY KEY CHECK(id=1),
                last_snapshot_id INTEGER NOT NULL,
                initialized INTEGER NOT NULL CHECK(initialized IN (0,1))
            );
            CREATE TABLE IF NOT EXISTS vector_meta (
                entity_id TEXT PRIMARY KEY REFERENCES entity_ids(entity_id),
                model TEXT,
                dimension INTEGER,
                content_version INTEGER NOT NULL,
                status TEXT NOT NULL
            );
            ",
        )?;
        Ok(Self { graph })
    }
}
