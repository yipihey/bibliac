/**
 * ADS Reader - Database Schema (CommonJS version)
 * Shared schema definition for desktop platform
 */

/**
 * SQL statements to create the database schema
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bibcode TEXT UNIQUE,
  doi TEXT,
  arxiv_id TEXT,
  title TEXT,
  authors TEXT,
  year INTEGER,
  journal TEXT,
  abstract TEXT,
  keywords TEXT,
  pdf_path TEXT,
  text_path TEXT,
  bibtex TEXT,
  read_status TEXT DEFAULT 'unread',
  rating INTEGER DEFAULT 0,
  added_date TEXT,
  modified_date TEXT,
  import_source TEXT,
  import_source_key TEXT,
  citation_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER,
  ref_bibcode TEXT,
  ref_title TEXT,
  ref_authors TEXT,
  ref_year INTEGER,
  FOREIGN KEY (paper_id) REFERENCES papers(id)
);

CREATE TABLE IF NOT EXISTS citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER,
  citing_bibcode TEXT,
  citing_title TEXT,
  citing_authors TEXT,
  citing_year INTEGER,
  FOREIGN KEY (paper_id) REFERENCES papers(id)
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  is_smart INTEGER DEFAULT 0,
  query TEXT,
  created_date TEXT
);

CREATE TABLE IF NOT EXISTS paper_collections (
  paper_id INTEGER,
  collection_id INTEGER,
  PRIMARY KEY (paper_id, collection_id),
  FOREIGN KEY (paper_id) REFERENCES papers(id),
  FOREIGN KEY (collection_id) REFERENCES collections(id)
);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  selection_text TEXT,
  selection_rects TEXT,
  note_content TEXT,
  color TEXT DEFAULT '#ffeb3b',
  pdf_source TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);


CREATE TABLE IF NOT EXISTS paper_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER UNIQUE,
  summary TEXT,
  key_points TEXT,
  model TEXT,
  generated_date TEXT,
  FOREIGN KEY (paper_id) REFERENCES papers(id)
);

CREATE TABLE IF NOT EXISTS paper_qa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER,
  question TEXT,
  answer TEXT,
  context_used TEXT,
  model TEXT,
  created_date TEXT,
  FOREIGN KEY (paper_id) REFERENCES papers(id)
);

CREATE TABLE IF NOT EXISTS text_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER,
  chunk_index INTEGER,
  chunk_text TEXT,
  embedding BLOB,
  created_date TEXT,
  FOREIGN KEY (paper_id) REFERENCES papers(id)
);

CREATE TABLE IF NOT EXISTS paper_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL,
  file_hash TEXT,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  file_role TEXT NOT NULL,
  source_type TEXT,
  source_url TEXT,
  added_date TEXT NOT NULL,
  status TEXT DEFAULT 'ready',
  error_message TEXT,
  text_extracted INTEGER DEFAULT 0,
  text_path TEXT,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS pdf_page_rotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL,
  pdf_source TEXT,
  page_number INTEGER NOT NULL,
  rotation INTEGER DEFAULT 0,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
  UNIQUE(paper_id, pdf_source, page_number)
);

CREATE TABLE IF NOT EXISTS smart_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  sort_order TEXT DEFAULT 'date desc',
  display_order INTEGER DEFAULT 0,
  created_date TEXT NOT NULL,
  last_refresh_date TEXT,
  result_count INTEGER DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS smart_search_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id INTEGER NOT NULL,
  bibcode TEXT NOT NULL,
  title TEXT,
  authors TEXT,
  year INTEGER,
  journal TEXT,
  abstract TEXT,
  doi TEXT,
  arxiv_id TEXT,
  citation_count INTEGER DEFAULT 0,
  cached_date TEXT NOT NULL,
  FOREIGN KEY (search_id) REFERENCES smart_searches(id) ON DELETE CASCADE,
  UNIQUE(search_id, bibcode)
);
`;

/**
 * SQL statements to create indexes
 */
const INDEXES_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_papers_bibcode ON papers(bibcode)',
  'CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi)',
  'CREATE INDEX IF NOT EXISTS idx_papers_arxiv ON papers(arxiv_id)',
  'CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year)',
  'CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(read_status)',
  'CREATE INDEX IF NOT EXISTS idx_papers_rating ON papers(rating)',
  'CREATE INDEX IF NOT EXISTS idx_refs_paper ON refs(paper_id)',
  'CREATE INDEX IF NOT EXISTS idx_citations_paper ON citations(paper_id)',
  'CREATE INDEX IF NOT EXISTS idx_annotations_paper ON annotations(paper_id)',
    'CREATE INDEX IF NOT EXISTS idx_embeddings_paper ON text_embeddings(paper_id)',
  'CREATE INDEX IF NOT EXISTS idx_qa_paper ON paper_qa(paper_id)',
  'CREATE INDEX IF NOT EXISTS idx_collections_parent ON collections(parent_id)',
  'CREATE INDEX IF NOT EXISTS idx_paper_files_paper ON paper_files(paper_id)',
  'CREATE INDEX IF NOT EXISTS idx_paper_files_hash ON paper_files(file_hash)',
  'CREATE INDEX IF NOT EXISTS idx_paper_files_status ON paper_files(status)',
  'CREATE INDEX IF NOT EXISTS idx_pdf_rotations_paper ON pdf_page_rotations(paper_id)',
  'CREATE INDEX IF NOT EXISTS idx_smart_search_results_search ON smart_search_results(search_id)',
  'CREATE INDEX IF NOT EXISTS idx_smart_search_results_bibcode ON smart_search_results(bibcode)'
];

/**
 * Migration statements for schema updates
 */
const MIGRATIONS = [
  'ALTER TABLE papers ADD COLUMN rating INTEGER DEFAULT 0',
  'ALTER TABLE papers ADD COLUMN import_source TEXT',
  'ALTER TABLE papers ADD COLUMN import_source_key TEXT',
  'ALTER TABLE papers ADD COLUMN citation_count INTEGER DEFAULT 0',
  'ALTER TABLE annotations ADD COLUMN pdf_source TEXT',
  'ALTER TABLE papers ADD COLUMN pdf_source TEXT',
  'ALTER TABLE papers ADD COLUMN available_sources TEXT',
  'ALTER TABLE papers ADD COLUMN pdf_path TEXT'
];

/**
 * Apply schema to a database
 * @param {Object} db - sql.js database instance
 */
function applySchema(db) {
  // Run main schema - split by semicolon and execute each statement
  const statements = SCHEMA_SQL.split(';').filter(s => s.trim());
  for (const stmt of statements) {
    if (stmt.trim()) {
      db.run(stmt);
    }
  }

  // Run indexes
  for (const indexSql of INDEXES_SQL) {
    db.run(indexSql);
  }

  // Run migrations (ignore errors for existing columns)
  for (const migration of MIGRATIONS) {
    try {
      db.run(migration);
    } catch (e) {
      // Column already exists, ignore
    }
  }
}

module.exports = {
  SCHEMA_SQL,
  INDEXES_SQL,
  MIGRATIONS,
  applySchema
};
