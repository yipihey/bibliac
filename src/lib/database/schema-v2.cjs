/**
 * Bibliac - Schema V2: Plugin Data Architecture
 *
 * Adds support for:
 * - Multiple sources per paper (ADS, arXiv, INSPIRE)
 * - Persistent refs/cites caching with 7-day freshness
 * - Paper deduplication via DOI/arXiv matching
 * - Cross-source capability tracking
 */

'use strict';

/**
 * SQL statements to create new plugin data tables
 */
const PLUGIN_TABLES_SQL = `
-- Paper source links (multiple sources per paper)
-- Tracks where each paper came from and what capabilities that source has
CREATE TABLE IF NOT EXISTS paper_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL,

  -- Source identification
  source TEXT NOT NULL,           -- 'ads', 'arxiv', 'inspire'
  source_id TEXT NOT NULL,        -- bibcode, arxiv ID, recid

  -- Source-specific metadata (JSON)
  source_metadata TEXT,           -- _inspire, _arxiv, etc.

  -- Capabilities at time of import
  has_references INTEGER DEFAULT 0,
  has_citations INTEGER DEFAULT 0,
  has_pdf INTEGER DEFAULT 0,
  has_bibtex INTEGER DEFAULT 0,

  -- Priority for selecting best source (lower = preferred)
  -- Stored from plugin.capabilities.priority at import time
  priority INTEGER DEFAULT 50,

  -- Sync tracking
  last_synced TEXT,
  is_primary INTEGER DEFAULT 0,   -- Preferred source for this paper

  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
  UNIQUE(paper_id, source),
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_sources_paper ON paper_sources(paper_id);
CREATE INDEX IF NOT EXISTS idx_paper_sources_source ON paper_sources(source, source_id);

-- Cached references (7-day freshness)
-- Papers that this paper cites
CREATE TABLE IF NOT EXISTS paper_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL,

  -- Reference identifiers (for linking to library papers)
  ref_doi TEXT,
  ref_arxiv_id TEXT,
  ref_bibcode TEXT,
  ref_inspire_id TEXT,

  -- Reference metadata
  ref_title TEXT,
  ref_authors TEXT,
  ref_year INTEGER,
  ref_journal TEXT,
  ref_citation_count INTEGER,

  -- Source tracking
  source_plugin TEXT NOT NULL,    -- Which plugin provided this ref
  cached_at TEXT NOT NULL,

  -- Link to library paper if exists (resolved on display)
  linked_paper_id INTEGER,

  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
  FOREIGN KEY (linked_paper_id) REFERENCES papers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_refs_paper ON paper_references(paper_id);
CREATE INDEX IF NOT EXISTS idx_paper_refs_cached ON paper_references(cached_at);
CREATE INDEX IF NOT EXISTS idx_paper_refs_doi ON paper_references(ref_doi);
CREATE INDEX IF NOT EXISTS idx_paper_refs_arxiv ON paper_references(ref_arxiv_id);
CREATE INDEX IF NOT EXISTS idx_paper_refs_bibcode ON paper_references(ref_bibcode);

-- Cached citations (7-day freshness)
-- Papers that cite this paper
CREATE TABLE IF NOT EXISTS paper_citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL,

  -- Citing paper identifiers
  citing_doi TEXT,
  citing_arxiv_id TEXT,
  citing_bibcode TEXT,
  citing_inspire_id TEXT,

  -- Citing paper metadata
  citing_title TEXT,
  citing_authors TEXT,
  citing_year INTEGER,
  citing_journal TEXT,
  citing_citation_count INTEGER,

  -- Source tracking
  source_plugin TEXT NOT NULL,
  cached_at TEXT NOT NULL,

  -- Link to library paper if exists
  linked_paper_id INTEGER,

  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
  FOREIGN KEY (linked_paper_id) REFERENCES papers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_cites_paper ON paper_citations(paper_id);
CREATE INDEX IF NOT EXISTS idx_paper_cites_cached ON paper_citations(cached_at);
CREATE INDEX IF NOT EXISTS idx_paper_cites_doi ON paper_citations(citing_doi);
CREATE INDEX IF NOT EXISTS idx_paper_cites_arxiv ON paper_citations(citing_arxiv_id);
CREATE INDEX IF NOT EXISTS idx_paper_cites_bibcode ON paper_citations(citing_bibcode);
`;

/**
 * Migrations to add source tracking columns to papers table
 */
const PAPER_SOURCE_MIGRATIONS = [
  // Add source column to track primary source
  'ALTER TABLE papers ADD COLUMN source TEXT DEFAULT \'ads\'',
  // Add source_id for the ID in that source's system
  'ALTER TABLE papers ADD COLUMN source_id TEXT'
];

/**
 * Cache freshness in days
 */
const CACHE_FRESHNESS_DAYS = 7;

/**
 * Apply schema V2 tables to a database
 * @param {Object} db - sql.js database instance
 */
function applySchemaV2(db) {
  // Create new tables
  const statements = PLUGIN_TABLES_SQL.trim().split(';').filter(s => s.trim());
  for (const stmt of statements) {
    if (stmt.trim()) {
      try {
        db.run(stmt);
      } catch (e) {
        // Table or index might already exist
        if (!e.message.includes('already exists')) {
          console.warn('[schema-v2] Warning:', e.message);
        }
      }
    }
  }

  // Run migrations for papers table
  for (const migration of PAPER_SOURCE_MIGRATIONS) {
    try {
      db.run(migration);
    } catch (e) {
      // Column already exists, ignore
      if (!e.message.includes('duplicate column')) {
        // Only log unexpected errors
      }
    }
  }

  // Backfill source_id for existing papers
  try {
    db.run(`
      UPDATE papers
      SET source_id = bibcode
      WHERE source = 'ads' AND bibcode IS NOT NULL AND source_id IS NULL
    `);
  } catch (e) {
    console.warn('[schema-v2] Backfill warning:', e.message);
  }

  console.log('[schema-v2] Plugin data tables applied');
}

/**
 * Check if a cache is stale
 * @param {string} cachedAt - ISO date string
 * @returns {boolean}
 */
function isCacheStale(cachedAt) {
  if (!cachedAt) return true;
  const cacheDate = new Date(cachedAt);
  const now = new Date();
  const ageMs = now - cacheDate;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > CACHE_FRESHNESS_DAYS;
}

/**
 * Get days since a date
 * @param {string} dateStr - ISO date string
 * @returns {number}
 */
function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const date = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - date) / (1000 * 60 * 60 * 24));
}

// ============================================================================
// Paper Sources Operations
// ============================================================================

/**
 * Add a source link for a paper
 * @param {Object} db - sql.js database instance
 * @param {Object} params
 * @param {number} params.paperId
 * @param {string} params.source - 'ads', 'arxiv', 'inspire'
 * @param {string} params.sourceId - ID in that source's system
 * @param {Object} [params.metadata] - Source-specific metadata
 * @param {Object} [params.capabilities] - What this source provides
 * @param {boolean} [params.isPrimary] - Is this the primary source?
 * @returns {number} The source link ID
 */
function addPaperSource(db, params) {
  const {
    paperId,
    source,
    sourceId,
    metadata = {},
    capabilities = {},
    isPrimary = false
  } = params;

  const now = new Date().toISOString();

  // Priority: use plugin-provided priority, default to 50
  const priority = capabilities.priority ?? 50;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO paper_sources (
      paper_id, source, source_id, source_metadata,
      has_references, has_citations, has_pdf, has_bibtex,
      priority, last_synced, is_primary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run([
    paperId,
    source,
    sourceId,
    JSON.stringify(metadata),
    capabilities.references ? 1 : 0,
    capabilities.citations ? 1 : 0,
    capabilities.pdfDownload ? 1 : 0,
    capabilities.bibtex ? 1 : 0,
    priority,
    now,
    isPrimary ? 1 : 0
  ]);
  stmt.free();

  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0];
}

/**
 * Get all source links for a paper
 * @param {Object} db
 * @param {number} paperId
 * @returns {Array}
 */
function getPaperSources(db, paperId) {
  const results = db.exec(`
    SELECT * FROM paper_sources WHERE paper_id = ? ORDER BY is_primary DESC, last_synced DESC
  `, [paperId]);

  if (results.length === 0) return [];

  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    if (obj.source_metadata) {
      try {
        obj.source_metadata = JSON.parse(obj.source_metadata);
      } catch (e) {
        obj.source_metadata = {};
      }
    }
    obj.has_references = obj.has_references === 1;
    obj.has_citations = obj.has_citations === 1;
    obj.has_pdf = obj.has_pdf === 1;
    obj.has_bibtex = obj.has_bibtex === 1;
    obj.is_primary = obj.is_primary === 1;
    obj.priority = obj.priority ?? 50; // Default priority if not set
    return obj;
  });
}

/**
 * Find the best source for getting references
 * Uses stored priority from database, not hardcoded plugin IDs
 * @param {Array} sources - Paper sources from getPaperSources
 * @returns {Object|null}
 */
function findBestSourceForRefs(sources) {
  const withRefs = sources.filter(s => s.has_references);
  if (withRefs.length === 0) return null;

  // Sort by: is_primary first, then by stored priority (lower = better)
  return withRefs.sort((a, b) => {
    // Primary source wins
    if (a.is_primary && !b.is_primary) return -1;
    if (b.is_primary && !a.is_primary) return 1;
    // Then by stored priority
    return (a.priority ?? 50) - (b.priority ?? 50);
  })[0];
}

/**
 * Find the best source for getting citations
 * Uses stored priority from database, not hardcoded plugin IDs
 * @param {Array} sources - Paper sources from getPaperSources
 * @returns {Object|null}
 */
function findBestSourceForCites(sources) {
  const withCites = sources.filter(s => s.has_citations);
  if (withCites.length === 0) return null;

  // Sort by: is_primary first, then by stored priority (lower = better)
  return withCites.sort((a, b) => {
    // Primary source wins
    if (a.is_primary && !b.is_primary) return -1;
    if (b.is_primary && !a.is_primary) return 1;
    // Then by stored priority
    return (a.priority ?? 50) - (b.priority ?? 50);
  })[0];
}

// ============================================================================
// Paper Deduplication
// ============================================================================

/**
 * Find existing paper by DOI
 * @param {Object} db
 * @param {string} doi
 * @returns {Object|null}
 */
function findPaperByDOI(db, doi) {
  if (!doi) return null;
  const normalizedDoi = doi.toLowerCase();
  const results = db.exec(`SELECT * FROM papers WHERE LOWER(doi) = ?`, [normalizedDoi]);
  if (results.length === 0 || results[0].values.length === 0) return null;

  const columns = results[0].columns;
  const row = results[0].values[0];
  const obj = {};
  columns.forEach((col, i) => obj[col] = row[i]);
  return obj;
}

/**
 * Find existing paper by arXiv ID
 * @param {Object} db
 * @param {string} arxivId
 * @returns {Object|null}
 */
function findPaperByArxiv(db, arxivId) {
  if (!arxivId) return null;
  // Normalize: remove arXiv: prefix and version suffix
  const normalized = arxivId.replace(/^arXiv:/i, '').replace(/v\d+$/, '');
  const results = db.exec(`
    SELECT * FROM papers
    WHERE REPLACE(REPLACE(LOWER(arxiv_id), 'arxiv:', ''), 'v1', '') LIKE ?
       OR REPLACE(REPLACE(LOWER(arxiv_id), 'arxiv:', ''), 'v2', '') LIKE ?
       OR REPLACE(REPLACE(LOWER(arxiv_id), 'arxiv:', ''), 'v3', '') LIKE ?
  `, [normalized.toLowerCase(), normalized.toLowerCase(), normalized.toLowerCase()]);

  if (results.length === 0 || results[0].values.length === 0) return null;

  const columns = results[0].columns;
  const row = results[0].values[0];
  const obj = {};
  columns.forEach((col, i) => obj[col] = row[i]);
  return obj;
}

/**
 * Find existing paper by bibcode
 * @param {Object} db
 * @param {string} bibcode
 * @returns {Object|null}
 */
function findPaperByBibcode(db, bibcode) {
  if (!bibcode) return null;
  const results = db.exec(`SELECT * FROM papers WHERE bibcode = ?`, [bibcode]);
  if (results.length === 0 || results[0].values.length === 0) return null;

  const columns = results[0].columns;
  const row = results[0].values[0];
  const obj = {};
  columns.forEach((col, i) => obj[col] = row[i]);
  return obj;
}

/**
 * Find or create a paper, deduplicating by DOI/arXiv
 * @param {Object} db
 * @param {Object} paperData
 * @param {string} source - 'ads', 'arxiv', 'inspire'
 * @param {string} sourceId - ID in that source's system
 * @param {Object} capabilities - Plugin capabilities
 * @returns {{paper: Object, isNew: boolean}}
 */
function findOrCreatePaper(db, paperData, source, sourceId, capabilities = {}) {
  // Step 1: Check for existing paper by identifiers
  let existingPaper = null;

  if (paperData.doi) {
    existingPaper = findPaperByDOI(db, paperData.doi);
  }
  if (!existingPaper && paperData.arxiv_id) {
    existingPaper = findPaperByArxiv(db, paperData.arxiv_id);
  }
  if (!existingPaper && paperData.bibcode) {
    existingPaper = findPaperByBibcode(db, paperData.bibcode);
  }

  if (existingPaper) {
    // Paper exists - add source link if new
    addPaperSource(db, {
      paperId: existingPaper.id,
      source,
      sourceId,
      metadata: paperData[`_${source}`] || {},
      capabilities,
      isPrimary: false // Existing paper keeps its primary source
    });

    console.log(`[schema-v2] Found existing paper ${existingPaper.id}, added ${source} source link`);
    return { paper: existingPaper, isNew: false };
  }

  // Step 2: Create new paper - don't do this here, just return null
  // The actual paper creation is handled by the existing addPaper logic
  return { paper: null, isNew: true };
}

// ============================================================================
// References Caching
// ============================================================================

/**
 * Cache references for a paper
 * @param {Object} db
 * @param {number} paperId
 * @param {Array} refs - Array of reference paper objects
 * @param {string} sourcePlugin - Which plugin provided these
 */
function cacheReferences(db, paperId, refs, sourcePlugin) {
  const now = new Date().toISOString();

  // Clear existing refs from this source (or all if refreshing)
  db.run('DELETE FROM paper_references WHERE paper_id = ?', [paperId]);

  if (!refs || refs.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO paper_references (
      paper_id, ref_doi, ref_arxiv_id, ref_bibcode, ref_inspire_id,
      ref_title, ref_authors, ref_year, ref_journal, ref_citation_count,
      source_plugin, cached_at, linked_paper_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const ref of refs) {
    // Try to find matching library paper
    let linkedPaperId = null;
    if (ref.doi) {
      const linked = findPaperByDOI(db, ref.doi);
      if (linked) linkedPaperId = linked.id;
    }
    if (!linkedPaperId && ref.arxiv_id) {
      const linked = findPaperByArxiv(db, ref.arxiv_id);
      if (linked) linkedPaperId = linked.id;
    }
    if (!linkedPaperId && ref.bibcode) {
      const linked = findPaperByBibcode(db, ref.bibcode);
      if (linked) linkedPaperId = linked.id;
    }

    stmt.run([
      paperId,
      ref.doi || null,
      ref.arxiv_id || null,
      ref.bibcode || null,
      ref._inspire?.recid || ref.inspire_recid || null,
      ref.title || null,
      Array.isArray(ref.authors) ? ref.authors.join('; ') : (ref.authors || null),
      ref.year || null,
      ref.journal || null,
      ref.citation_count || null,
      sourcePlugin,
      now,
      linkedPaperId
    ]);
    stmt.reset();
  }
  stmt.free();

  console.log(`[schema-v2] Cached ${refs.length} references for paper ${paperId} from ${sourcePlugin}`);
}

/**
 * Get cached references for a paper
 * @param {Object} db
 * @param {number} paperId
 * @returns {{refs: Array, sourcePlugin: string, cachedAt: string, isStale: boolean}}
 */
function getCachedReferences(db, paperId) {
  const results = db.exec(`
    SELECT * FROM paper_references WHERE paper_id = ? ORDER BY ref_year DESC, id
  `, [paperId]);

  if (results.length === 0 || results[0].values.length === 0) {
    return { refs: [], sourcePlugin: null, cachedAt: null, isStale: true };
  }

  const columns = results[0].columns;
  const refs = results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return {
      doi: obj.ref_doi,
      arxiv_id: obj.ref_arxiv_id,
      bibcode: obj.ref_bibcode,
      inspire_recid: obj.ref_inspire_id,
      title: obj.ref_title,
      authors: obj.ref_authors,
      year: obj.ref_year,
      journal: obj.ref_journal,
      citation_count: obj.ref_citation_count,
      linked_paper_id: obj.linked_paper_id,
      inLibrary: obj.linked_paper_id !== null
    };
  });

  const firstRow = {};
  columns.forEach((col, i) => firstRow[col] = results[0].values[0][i]);

  return {
    refs,
    sourcePlugin: firstRow.source_plugin,
    cachedAt: firstRow.cached_at,
    isStale: isCacheStale(firstRow.cached_at)
  };
}

// ============================================================================
// Citations Caching
// ============================================================================

/**
 * Cache citations for a paper
 * @param {Object} db
 * @param {number} paperId
 * @param {Array} cites - Array of citing paper objects
 * @param {string} sourcePlugin - Which plugin provided these
 */
function cacheCitations(db, paperId, cites, sourcePlugin) {
  const now = new Date().toISOString();

  // Clear existing cites
  db.run('DELETE FROM paper_citations WHERE paper_id = ?', [paperId]);

  if (!cites || cites.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO paper_citations (
      paper_id, citing_doi, citing_arxiv_id, citing_bibcode, citing_inspire_id,
      citing_title, citing_authors, citing_year, citing_journal, citing_citation_count,
      source_plugin, cached_at, linked_paper_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const cite of cites) {
    // Try to find matching library paper
    let linkedPaperId = null;
    if (cite.doi) {
      const linked = findPaperByDOI(db, cite.doi);
      if (linked) linkedPaperId = linked.id;
    }
    if (!linkedPaperId && cite.arxiv_id) {
      const linked = findPaperByArxiv(db, cite.arxiv_id);
      if (linked) linkedPaperId = linked.id;
    }
    if (!linkedPaperId && cite.bibcode) {
      const linked = findPaperByBibcode(db, cite.bibcode);
      if (linked) linkedPaperId = linked.id;
    }

    stmt.run([
      paperId,
      cite.doi || null,
      cite.arxiv_id || null,
      cite.bibcode || null,
      cite._inspire?.recid || cite.inspire_recid || null,
      cite.title || null,
      Array.isArray(cite.authors) ? cite.authors.join('; ') : (cite.authors || null),
      cite.year || null,
      cite.journal || null,
      cite.citation_count || null,
      sourcePlugin,
      now,
      linkedPaperId
    ]);
    stmt.reset();
  }
  stmt.free();

  console.log(`[schema-v2] Cached ${cites.length} citations for paper ${paperId} from ${sourcePlugin}`);
}

/**
 * Get cached citations for a paper
 * @param {Object} db
 * @param {number} paperId
 * @returns {{cites: Array, sourcePlugin: string, cachedAt: string, isStale: boolean}}
 */
function getCachedCitations(db, paperId) {
  const results = db.exec(`
    SELECT * FROM paper_citations WHERE paper_id = ? ORDER BY citing_year DESC, id
  `, [paperId]);

  if (results.length === 0 || results[0].values.length === 0) {
    return { cites: [], sourcePlugin: null, cachedAt: null, isStale: true };
  }

  const columns = results[0].columns;
  const cites = results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return {
      doi: obj.citing_doi,
      arxiv_id: obj.citing_arxiv_id,
      bibcode: obj.citing_bibcode,
      inspire_recid: obj.citing_inspire_id,
      title: obj.citing_title,
      authors: obj.citing_authors,
      year: obj.citing_year,
      journal: obj.citing_journal,
      citation_count: obj.citing_citation_count,
      linked_paper_id: obj.linked_paper_id,
      inLibrary: obj.linked_paper_id !== null
    };
  });

  const firstRow = {};
  columns.forEach((col, i) => firstRow[col] = results[0].values[0][i]);

  return {
    cites,
    sourcePlugin: firstRow.source_plugin,
    cachedAt: firstRow.cached_at,
    isStale: isCacheStale(firstRow.cached_at)
  };
}

// ============================================================================
// Update Library Links
// ============================================================================

/**
 * Re-link cached refs/cites to library papers
 * Call this after adding papers to library to update "in library" status
 * @param {Object} db
 * @param {number} paperId - Newly added paper ID
 */
function updateLibraryLinks(db, paperId) {
  const paper = findPaperByDOI(db, null); // Get paper by ID
  const results = db.exec('SELECT * FROM papers WHERE id = ?', [paperId]);
  if (results.length === 0 || results[0].values.length === 0) return;

  const columns = results[0].columns;
  const row = results[0].values[0];
  const paperData = {};
  columns.forEach((col, i) => paperData[col] = row[i]);

  // Update references that match this paper
  if (paperData.doi) {
    db.run(`
      UPDATE paper_references SET linked_paper_id = ? WHERE ref_doi = ?
    `, [paperId, paperData.doi]);
    db.run(`
      UPDATE paper_citations SET linked_paper_id = ? WHERE citing_doi = ?
    `, [paperId, paperData.doi]);
  }

  if (paperData.arxiv_id) {
    db.run(`
      UPDATE paper_references SET linked_paper_id = ? WHERE ref_arxiv_id = ?
    `, [paperId, paperData.arxiv_id]);
    db.run(`
      UPDATE paper_citations SET linked_paper_id = ? WHERE citing_arxiv_id = ?
    `, [paperId, paperData.arxiv_id]);
  }

  if (paperData.bibcode) {
    db.run(`
      UPDATE paper_references SET linked_paper_id = ? WHERE ref_bibcode = ?
    `, [paperId, paperData.bibcode]);
    db.run(`
      UPDATE paper_citations SET linked_paper_id = ? WHERE citing_bibcode = ?
    `, [paperId, paperData.bibcode]);
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Schema
  PLUGIN_TABLES_SQL,
  PAPER_SOURCE_MIGRATIONS,
  CACHE_FRESHNESS_DAYS,
  applySchemaV2,

  // Utilities
  isCacheStale,
  daysSince,

  // Paper sources
  addPaperSource,
  getPaperSources,
  findBestSourceForRefs,
  findBestSourceForCites,

  // Deduplication
  findPaperByDOI,
  findPaperByArxiv,
  findPaperByBibcode,
  findOrCreatePaper,

  // References caching
  cacheReferences,
  getCachedReferences,

  // Citations caching
  cacheCitations,
  getCachedCitations,

  // Library links
  updateLibraryLinks
};
