// ADS Reader - Database Module (sql.js)
// SQLite database using sql.js (in-memory with periodic saves to disk)

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { applySchema } = require('../shared/database-schema.cjs');

/**
 * @typedef {Object} Paper
 * @property {number} id - Primary key
 * @property {string|null} bibcode - ADS bibcode
 * @property {string|null} doi - DOI identifier
 * @property {string|null} arxiv_id - arXiv ID (e.g., "2401.12345")
 * @property {string} title - Paper title
 * @property {string[]} authors - Array of author names
 * @property {number|null} year - Publication year
 * @property {string|null} journal - Journal name
 * @property {string|null} abstract - Paper abstract
 * @property {string[]} keywords - Array of keywords
 * @property {string|null} pdf_path - Relative path to PDF
 * @property {string|null} text_path - Relative path to extracted text
 * @property {string|null} bibtex - BibTeX entry
 * @property {string} read_status - "unread", "reading", or "read"
 * @property {number} rating - 0-4 rating
 * @property {string} added_date - ISO timestamp
 * @property {string} modified_date - ISO timestamp
 * @property {string|null} import_source - Source .bib file path
 * @property {string|null} import_source_key - Original BibTeX key
 * @property {boolean} [is_indexed] - Has embeddings (computed)
 * @property {number} [annotation_count] - Number of annotations (computed)
 * @property {number} [citation_count] - Number of citing papers (computed)
 */

/**
 * @typedef {Object} GetAllPapersOptions
 * @property {string} [readStatus] - Filter by read status
 * @property {string} [search] - Search term for title/authors/abstract
 * @property {string} [orderBy] - Column to sort by (default: "added_date")
 * @property {string} [order] - Sort direction: "ASC" or "DESC" (default: "DESC")
 * @property {number} [limit] - Maximum number of results
 */

/**
 * @typedef {Object} SearchResult
 * @property {Paper} paper - The matching paper
 * @property {number} matchCount - Relevance score
 * @property {string} matchSource - Where match was found: "title", "authors", "abstract", "fulltext", "field"
 * @property {string} context - Snippet showing match context
 */

let db = null;
let dbPath = null;
let SQL = null;

// Initialize sql.js and load/create database
async function initDatabase(libraryPath) {
  if (!SQL) {
    SQL = await initSqlJs();
  }

  dbPath = path.join(libraryPath, 'library.sqlite');

  // Load existing database or create new one
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    // Ensure all tables exist (for migrations)
    createSchema();
    saveDatabase();
  } else {
    db = new SQL.Database();
    createSchema();
    saveDatabase();
  }

  return true;
}

// Create database schema using shared definition
function createSchema() {
  applySchema(db);
}

// Save database to file
function saveDatabase() {
  if (db && dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

// Close database
function closeDatabase() {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
  }
}

// Paper operations

/**
 * Add a new paper to the database
 * @param {Partial<Paper>} paper - Paper data (id, added_date, modified_date are auto-generated)
 * @returns {number} The ID of the newly created paper
 */
function addPaper(paper) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO papers (bibcode, doi, arxiv_id, title, authors, year, journal,
                        abstract, keywords, pdf_path, text_path, bibtex,
                        read_status, added_date, modified_date, import_source, import_source_key, citation_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run([
    paper.bibcode || null,
    paper.doi || null,
    paper.arxiv_id || null,
    paper.title || 'Untitled',
    JSON.stringify(paper.authors || []),
    paper.year || null,
    paper.journal || null,
    paper.abstract || null,
    JSON.stringify(paper.keywords || []),
    paper.pdf_path || null,
    paper.text_path || null,
    paper.bibtex || null,
    paper.read_status || 'unread',
    now,
    now,
    paper.import_source || null,
    paper.import_source_key || null,
    paper.citation_count || 0
  ]);
  stmt.free();

  saveDatabase();

  // Return the inserted paper with ID
  const result = db.exec(`SELECT last_insert_rowid() as id`);
  return result[0].values[0][0];
}

// Bulk insert papers for fast .bib import - no intermediate saves
function addPapersBulk(papers, progressCallback = null) {
  const now = new Date().toISOString();
  const inserted = [];
  const skipped = [];

  const stmt = db.prepare(`
    INSERT INTO papers (bibcode, doi, arxiv_id, title, authors, year, journal,
                        abstract, keywords, pdf_path, text_path, bibtex,
                        read_status, added_date, modified_date, import_source, import_source_key, citation_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];

    // Check for duplicates by DOI, arXiv ID, or title+year
    let isDuplicate = false;

    if (paper.doi) {
      const existing = db.exec(`SELECT id FROM papers WHERE doi = ?`, [paper.doi]);
      if (existing.length > 0 && existing[0].values.length > 0) {
        isDuplicate = true;
      }
    }

    if (!isDuplicate && paper.arxiv_id) {
      const existing = db.exec(`SELECT id FROM papers WHERE arxiv_id = ?`, [paper.arxiv_id]);
      if (existing.length > 0 && existing[0].values.length > 0) {
        isDuplicate = true;
      }
    }

    if (!isDuplicate && paper.title && paper.year) {
      const existing = db.exec(`SELECT id FROM papers WHERE title = ? AND year = ?`, [paper.title, paper.year]);
      if (existing.length > 0 && existing[0].values.length > 0) {
        isDuplicate = true;
      }
    }

    if (isDuplicate) {
      skipped.push({ paper, reason: 'duplicate' });
    } else {
      try {
        stmt.run([
          paper.bibcode || null,
          paper.doi || null,
          paper.arxiv_id || null,
          paper.title || 'Untitled',
          JSON.stringify(paper.authors || []),
          paper.year || null,
          paper.journal || null,
          paper.abstract || null,
          JSON.stringify(paper.keywords || []),
          paper.pdf_path || null,
          paper.text_path || null,
          paper.bibtex || null,
          paper.read_status || 'unread',
          now,
          now,
          paper.import_source || null,
          paper.import_source_key || null,
          paper.citation_count || 0
        ]);
        stmt.reset();

        const result = db.exec(`SELECT last_insert_rowid() as id`);
        inserted.push({ id: result[0].values[0][0], title: paper.title });
      } catch (e) {
        skipped.push({ paper, reason: e.message });
      }
    }

    // Report progress every 10 entries
    if (progressCallback && (i + 1) % 10 === 0) {
      progressCallback({
        current: i + 1,
        total: papers.length,
        inserted: inserted.length,
        skipped: skipped.length
      });
    }
  }

  stmt.free();

  // Single save at the end
  saveDatabase();

  return { inserted, skipped };
}

/**
 * Update paper fields
 * @param {number} id - Paper ID
 * @param {Partial<Paper>} updates - Fields to update (authors/keywords can be arrays)
 * @param {boolean} [save=true] - Whether to save database immediately
 */
function updatePaper(id, updates, save = true) {
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (key === 'authors' || key === 'keywords') {
      fields.push(`${key} = ?`);
      values.push(JSON.stringify(value));
    } else {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  fields.push('modified_date = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.run(`UPDATE papers SET ${fields.join(', ')} WHERE id = ?`, values);
  if (save) saveDatabase();
}

function deletePaper(id, save = true) {
  db.run(`DELETE FROM paper_collections WHERE paper_id = ?`, [id]);
  db.run(`DELETE FROM papers WHERE id = ?`, [id]);
  if (save) saveDatabase();
}

function getPaper(id) {
  const stmt = db.prepare(`SELECT * FROM papers WHERE id = ?`);
  stmt.bind([id]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return parsePaperRow(row);
  }
  stmt.free();
  return null;
}

function getPaperByBibcode(bibcode) {
  const stmt = db.prepare(`SELECT * FROM papers WHERE bibcode = ?`);
  stmt.bind([bibcode]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return parsePaperRow(row);
  }
  stmt.free();
  return null;
}

/**
 * Get all papers with optional filtering and sorting
 * @param {GetAllPapersOptions} [options={}] - Query options
 * @returns {Paper[]} Array of papers with computed fields (is_indexed, annotation_count, citation_count)
 */
function getAllPapers(options = {}) {
  // Note: citation_count comes from p.citation_count (stored from ADS metadata)
  // not from counting citations table rows (which may only have 50 entries)
  let query = `
    SELECT p.*,
      (SELECT COUNT(*) FROM text_embeddings e WHERE e.paper_id = p.id) > 0 AS is_indexed,
      (SELECT COUNT(*) FROM annotations a WHERE a.paper_id = p.id) AS annotation_count
    FROM papers p`;
  const conditions = [];
  const values = [];

  if (options.readStatus) {
    conditions.push(`p.read_status = ?`);
    values.push(options.readStatus);
  }

  if (options.search) {
    conditions.push(`(p.title LIKE ? OR p.authors LIKE ? OR p.abstract LIKE ?)`);
    const searchTerm = `%${options.search}%`;
    values.push(searchTerm, searchTerm, searchTerm);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ` ORDER BY ${options.orderBy || 'p.added_date'} ${options.order || 'DESC'}`;

  if (options.limit) {
    query += ` LIMIT ${options.limit}`;
  }

  const results = db.exec(query, values);
  if (results.length === 0) return [];

  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return parsePaperRow(obj);
  });
}

// Parse field-specific search queries like "author:Smith year:2020 dark matter"
function parseSearchQuery(query) {
  const fields = {};
  const generalTerms = [];

  // Match field:value patterns (supports quoted values and comparison operators)
  // Supports: author, year, title, bibcode, journal, source, status, rating, has, citations
  const fieldPattern = /(author|year|title|bibcode|journal|source|status|rating|has|citations):("([^"]+)"|([<>=]*\S+))/gi;
  let remaining = query;
  let match;

  while ((match = fieldPattern.exec(query)) !== null) {
    const field = match[1].toLowerCase();
    const value = match[3] || match[4]; // Quoted or unquoted value
    fields[field] = value.toLowerCase();
    // Remove matched part from remaining
    remaining = remaining.replace(match[0], '');
  }

  // Remaining text is general search terms
  const generalText = remaining.trim();
  if (generalText) {
    generalTerms.push(generalText.toLowerCase());
  }

  return { fields, generalTerms };
}

/**
 * Full-text search across papers, including PDF text files
 * Supports field-specific queries like "author:Smith year:2020 dark matter"
 * @param {string} searchTerm - Search query (supports field:value syntax)
 * @param {string} libraryPath - Path to library folder (for reading text files)
 * @returns {SearchResult[]} Results sorted by relevance (matchCount descending)
 */
function searchPapersFullText(searchTerm, libraryPath) {
  console.log('searchPapersFullText called:', searchTerm, libraryPath);
  const results = [];
  const papers = getAllPapers();
  console.log('Total papers in DB:', papers.length);

  // Parse field-specific queries
  const { fields, generalTerms } = parseSearchQuery(searchTerm);
  const hasFieldFilters = Object.keys(fields).length > 0;
  const searchLower = generalTerms.join(' ').toLowerCase();

  // Escape special regex characters for safe regex creation
  const escapedTerm = searchLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let searchRegex;
  try {
    searchRegex = escapedTerm ? new RegExp(escapedTerm, 'gi') : null;
  } catch (e) {
    // Fallback to simple string matching if regex fails
    searchRegex = null;
  }

  for (const paper of papers) {
    // First check field-specific filters
    if (hasFieldFilters) {
      let fieldMatch = true;

      if (fields.author) {
        const authorsStr = (paper.authors?.join(' ') || '').toLowerCase();
        if (!authorsStr.includes(fields.author)) fieldMatch = false;
      }
      if (fields.year && fieldMatch) {
        const paperYear = String(paper.year || '');
        if (!paperYear.includes(fields.year)) fieldMatch = false;
      }
      if (fields.title && fieldMatch) {
        const titleLower = (paper.title || '').toLowerCase();
        if (!titleLower.includes(fields.title)) fieldMatch = false;
      }
      if (fields.bibcode && fieldMatch) {
        const bibcodeLower = (paper.bibcode || '').toLowerCase();
        if (!bibcodeLower.includes(fields.bibcode)) fieldMatch = false;
      }
      if (fields.journal && fieldMatch) {
        const journalLower = (paper.journal || '').toLowerCase();
        if (!journalLower.includes(fields.journal)) fieldMatch = false;
      }
      if (fields.source && fieldMatch) {
        const sourceLower = (paper.import_source || '').toLowerCase();
        if (!sourceLower.includes(fields.source)) fieldMatch = false;
      }

      // Status filter: status:unread, status:reading, status:read
      if (fields.status && fieldMatch) {
        const statusLower = (paper.read_status || 'unread').toLowerCase();
        if (statusLower !== fields.status) fieldMatch = false;
      }

      // Rating filter: rating:1, rating:2, rating:3, rating:4 (or seminal, important, useful, meh)
      if (fields.rating && fieldMatch) {
        const ratingMap = { 'seminal': 1, 'important': 2, 'useful': 3, 'meh': 4 };
        let targetRating = parseInt(fields.rating);
        if (isNaN(targetRating)) {
          targetRating = ratingMap[fields.rating] || 0;
        }
        if ((paper.rating || 0) !== targetRating) fieldMatch = false;
      }

      // Has filter: has:pdf, has:notes, has:abstract
      if (fields.has && fieldMatch) {
        const hasType = fields.has;
        if (hasType === 'pdf' && !paper.pdf_path) fieldMatch = false;
        if (hasType === 'notes' && !(paper.annotation_count > 0)) fieldMatch = false;
        if (hasType === 'abstract' && !paper.abstract) fieldMatch = false;
      }

      // Citations filter: citations:>10, citations:<5, citations:>=100
      if (fields.citations && fieldMatch) {
        const citationStr = fields.citations;
        const paperCitations = paper.citation_count || 0;

        if (citationStr.startsWith('>=')) {
          const num = parseInt(citationStr.substring(2));
          if (paperCitations < num) fieldMatch = false;
        } else if (citationStr.startsWith('<=')) {
          const num = parseInt(citationStr.substring(2));
          if (paperCitations > num) fieldMatch = false;
        } else if (citationStr.startsWith('>')) {
          const num = parseInt(citationStr.substring(1));
          if (paperCitations <= num) fieldMatch = false;
        } else if (citationStr.startsWith('<')) {
          const num = parseInt(citationStr.substring(1));
          if (paperCitations >= num) fieldMatch = false;
        } else {
          const num = parseInt(citationStr);
          if (paperCitations !== num) fieldMatch = false;
        }
      }

      if (!fieldMatch) continue; // Skip this paper if field filter doesn't match
    }

    // If no general search terms and we passed field filters, include the paper
    if (!searchLower && hasFieldFilters) {
      results.push({
        paper,
        matchCount: 1,
        matchSource: 'field',
        context: ''
      });
      continue;
    }

    // If no search terms at all, skip (shouldn't happen but safeguard)
    if (!searchLower) continue;
    let matchCount = 0;
    let context = '';
    let matchSource = '';

    // Search in title
    if (paper.title && paper.title.toLowerCase().includes(searchLower)) {
      matchCount += 10; // Weight title matches higher
      matchSource = 'title';
      context = paper.title;
    }

    // Search in authors
    const authorsStr = paper.authors?.join(' ') || '';
    if (authorsStr.toLowerCase().includes(searchLower)) {
      matchCount += 5; // Weight author matches
      if (!matchSource) {
        matchSource = 'authors';
        context = authorsStr;
      }
    }

    // Search in abstract
    if (paper.abstract && paper.abstract.toLowerCase().includes(searchLower)) {
      matchCount += 3;
      if (!matchSource) {
        matchSource = 'abstract';
        const idx = paper.abstract.toLowerCase().indexOf(searchLower);
        const start = Math.max(0, idx - 50);
        const end = Math.min(paper.abstract.length, idx + searchTerm.length + 50);
        context = (start > 0 ? '...' : '') + paper.abstract.substring(start, end) + (end < paper.abstract.length ? '...' : '');
      }
    }

    // Search in full-text file
    if (paper.text_path) {
      const textFile = path.join(libraryPath, paper.text_path);
      if (fs.existsSync(textFile)) {
        try {
          const content = fs.readFileSync(textFile, 'utf-8');
          if (searchRegex) {
            const matches = content.match(searchRegex);
            if (matches) {
              matchCount += matches.length;
              if (!matchSource) {
                matchSource = 'fulltext';
                const lowerContent = content.toLowerCase();
                const matchIndex = lowerContent.indexOf(searchLower);
                const start = Math.max(0, matchIndex - 100);
                const end = Math.min(content.length, matchIndex + searchTerm.length + 100);
                context = (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
              }
            }
          } else if (content.toLowerCase().includes(searchLower)) {
            matchCount += 1;
            if (!matchSource) {
              matchSource = 'fulltext';
              const lowerContent = content.toLowerCase();
              const matchIndex = lowerContent.indexOf(searchLower);
              const start = Math.max(0, matchIndex - 100);
              const end = Math.min(content.length, matchIndex + searchTerm.length + 100);
              context = (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
            }
          }
        } catch (e) {
          // Ignore read errors
        }
      }
    }

    // Search in annotations/notes for this paper
    const annotations = getAnnotations(paper.id);
    for (const annotation of annotations) {
      const noteContent = (annotation.note_content || '').toLowerCase();
      const selectionText = (annotation.selection_text || '').toLowerCase();
      const combinedText = noteContent + ' ' + selectionText;

      if (combinedText.includes(searchLower)) {
        matchCount += 4; // Weight note matches higher than abstract
        if (!matchSource) {
          matchSource = 'notes';
          // Show the matching note as context
          const noteText = annotation.note_content || annotation.selection_text || '';
          const idx = combinedText.indexOf(searchLower);
          const start = Math.max(0, idx - 50);
          const end = Math.min(noteText.length, idx + searchTerm.length + 50);
          context = (start > 0 ? '...' : '') + noteText.substring(start, end) + (end < noteText.length ? '...' : '');
        }
      }
    }

    if (matchCount > 0) {
      results.push({
        paper,
        matchCount,
        matchSource,
        context
      });
    }
  }

  return results.sort((a, b) => b.matchCount - a.matchCount);
}

function parsePaperRow(row) {
  return {
    ...row,
    authors: row.authors ? JSON.parse(row.authors) : [],
    keywords: row.keywords ? JSON.parse(row.keywords) : []
  };
}

// Collections

function createCollection(name, parentId = null, isSmart = false, query = null) {
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO collections (name, parent_id, is_smart, query, created_date)
    VALUES (?, ?, ?, ?, ?)
  `, [name, parentId, isSmart ? 1 : 0, query, now]);
  saveDatabase();

  const result = db.exec(`SELECT last_insert_rowid() as id`);
  return result[0].values[0][0];
}

function getCollections() {
  const results = db.exec(`
    SELECT c.*, COUNT(pc.paper_id) as paper_count
    FROM collections c
    LEFT JOIN paper_collections pc ON c.id = pc.collection_id
    GROUP BY c.id
    ORDER BY c.name
  `);
  if (results.length === 0) return [];

  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    obj.is_smart = obj.is_smart === 1;
    return obj;
  });
}

function addPaperToCollection(paperId, collectionId) {
  db.run(`
    INSERT OR IGNORE INTO paper_collections (paper_id, collection_id)
    VALUES (?, ?)
  `, [paperId, collectionId]);
  saveDatabase();
}

function removePaperFromCollection(paperId, collectionId) {
  db.run(`
    DELETE FROM paper_collections WHERE paper_id = ? AND collection_id = ?
  `, [paperId, collectionId]);
  saveDatabase();
}

function getPapersInCollection(collectionId) {
  const results = db.exec(`
    SELECT p.* FROM papers p
    JOIN paper_collections pc ON p.id = pc.paper_id
    WHERE pc.collection_id = ?
    ORDER BY p.added_date DESC
  `, [collectionId]);

  if (results.length === 0) return [];

  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return parsePaperRow(obj);
  });
}

/**
 * Get a single collection by ID
 */
function getCollection(collectionId) {
  const results = db.exec(`SELECT * FROM collections WHERE id = ?`, [collectionId]);
  if (results.length === 0 || results[0].values.length === 0) return null;

  const columns = results[0].columns;
  const row = results[0].values[0];
  const obj = {};
  columns.forEach((col, i) => obj[col] = row[i]);
  obj.is_smart = obj.is_smart === 1;
  return obj;
}

/**
 * Get papers matching a smart collection's query
 */
function getPapersInSmartCollection(collectionId, libraryPath) {
  const collection = getCollection(collectionId);
  if (!collection || !collection.is_smart || !collection.query) {
    return [];
  }

  // Use existing search function with the stored query
  return searchPapersFullText(collection.query, libraryPath);
}

function deleteCollection(collectionId) {
  db.run(`DELETE FROM paper_collections WHERE collection_id = ?`, [collectionId]);
  db.run(`DELETE FROM collections WHERE id = ?`, [collectionId]);
  saveDatabase();
}

// Stats

function getStats() {
  const totalResult = db.exec(`SELECT COUNT(*) as count FROM papers`);
  const total = totalResult[0]?.values[0][0] || 0;

  const unreadResult = db.exec(`SELECT COUNT(*) as count FROM papers WHERE read_status = 'unread'`);
  const unread = unreadResult[0]?.values[0][0] || 0;

  const readingResult = db.exec(`SELECT COUNT(*) as count FROM papers WHERE read_status = 'reading'`);
  const reading = readingResult[0]?.values[0][0] || 0;

  const readResult = db.exec(`SELECT COUNT(*) as count FROM papers WHERE read_status = 'read'`);
  const read = readResult[0]?.values[0][0] || 0;

  return { total, unread, reading, read };
}

// LLM Summaries

function getSummary(paperId) {
  const stmt = db.prepare(`SELECT * FROM paper_summaries WHERE paper_id = ?`);
  stmt.bind([paperId]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return {
      ...row,
      key_points: row.key_points ? JSON.parse(row.key_points) : []
    };
  }
  stmt.free();
  return null;
}

function saveSummary(paperId, summary, keyPoints, model) {
  const now = new Date().toISOString();
  const existing = getSummary(paperId);

  if (existing) {
    db.run(`
      UPDATE paper_summaries
      SET summary = ?, key_points = ?, model = ?, generated_date = ?
      WHERE paper_id = ?
    `, [summary, JSON.stringify(keyPoints), model, now, paperId]);
  } else {
    db.run(`
      INSERT INTO paper_summaries (paper_id, summary, key_points, model, generated_date)
      VALUES (?, ?, ?, ?, ?)
    `, [paperId, summary, JSON.stringify(keyPoints), model, now]);
  }
  saveDatabase();
}

function deleteSummary(paperId) {
  db.run(`DELETE FROM paper_summaries WHERE paper_id = ?`, [paperId]);
  saveDatabase();
}

// LLM Q&A

function getQAHistory(paperId, limit = 20) {
  const results = db.exec(`
    SELECT * FROM paper_qa
    WHERE paper_id = ?
    ORDER BY created_date DESC
    LIMIT ?
  `, [paperId, limit]);

  if (results.length === 0) return [];

  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return obj;
  }).reverse(); // Return in chronological order
}

function saveQA(paperId, question, answer, contextUsed, model) {
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO paper_qa (paper_id, question, answer, context_used, model, created_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [paperId, question, answer, contextUsed, model, now]);
  saveDatabase();
}

function clearQAHistory(paperId) {
  db.run(`DELETE FROM paper_qa WHERE paper_id = ?`, [paperId]);
  saveDatabase();
}

// Text Embeddings

function getEmbeddings(paperId) {
  const results = db.exec(`
    SELECT * FROM text_embeddings
    WHERE paper_id = ?
    ORDER BY chunk_index
  `, [paperId]);

  if (results.length === 0) return [];

  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    // Convert BLOB to Float32Array
    if (obj.embedding) {
      obj.embedding = new Float32Array(obj.embedding.buffer);
    }
    return obj;
  });
}

function hasEmbeddings(paperId) {
  const results = db.exec(`SELECT COUNT(*) FROM text_embeddings WHERE paper_id = ?`, [paperId]);
  return results[0]?.values[0][0] > 0;
}

function getUnindexedPaperIds() {
  const results = db.exec(`
    SELECT p.id FROM papers p
    LEFT JOIN text_embeddings e ON p.id = e.paper_id
    WHERE e.id IS NULL
  `);
  if (results.length === 0) return [];
  return results[0].values.map(row => row[0]);
}

function saveEmbeddings(paperId, chunks) {
  // Clear existing embeddings for this paper
  db.run(`DELETE FROM text_embeddings WHERE paper_id = ?`, [paperId]);

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO text_embeddings (paper_id, chunk_index, chunk_text, embedding, created_date)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Convert Float32Array to Buffer for storage
    const embeddingBuffer = Buffer.from(new Float32Array(chunk.embedding).buffer);
    stmt.run([paperId, chunk.chunkIndex, chunk.chunkText, embeddingBuffer, now]);
  }

  stmt.free();
  saveDatabase();
}

function deleteEmbeddings(paperId) {
  db.run(`DELETE FROM text_embeddings WHERE paper_id = ?`, [paperId]);
  saveDatabase();
}

function getAllEmbeddings() {
  const results = db.exec(`
    SELECT te.*, p.title, p.bibcode
    FROM text_embeddings te
    JOIN papers p ON te.paper_id = p.id
    ORDER BY te.paper_id, te.chunk_index
  `);

  if (results.length === 0) return [];

  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    if (obj.embedding) {
      obj.embedding = new Float32Array(obj.embedding.buffer);
    }
    return obj;
  });
}

// Annotations

function getAnnotations(paperId) {
  // Use prepared statement since db.exec doesn't support parameterized queries
  const stmt = db.prepare(`
    SELECT * FROM annotations
    WHERE paper_id = ?
    ORDER BY page_number, id
  `);
  stmt.bind([paperId]);

  const annotations = [];
  while (stmt.step()) {
    const obj = stmt.getAsObject();
    // Parse selection_rects JSON
    if (obj.selection_rects) {
      try {
        obj.selection_rects = JSON.parse(obj.selection_rects);
      } catch (e) {
        obj.selection_rects = [];
      }
    }
    annotations.push(obj);
  }
  stmt.free();
  return annotations;
}

function getAnnotationCountsBySource(paperId) {
  // Use prepared statement since db.exec doesn't support parameterized queries
  const stmt = db.prepare(`
    SELECT pdf_source, COUNT(*) as count
    FROM annotations
    WHERE paper_id = ?
    GROUP BY pdf_source
  `);
  stmt.bind([paperId]);

  const counts = {};
  while (stmt.step()) {
    const row = stmt.get();
    const source = row[0] || 'unknown';
    counts[source] = row[1];
  }
  stmt.free();
  return counts;
}

function createAnnotation(paperId, data) {
  const now = new Date().toISOString();

  // Use db.run() like other functions - it works with parameters
  db.run(`
    INSERT INTO annotations (paper_id, page_number, selection_text, selection_rects, note_content, color, pdf_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    paperId,
    data.page_number || 1,
    data.selection_text || null,
    typeof data.selection_rects === 'string' ? data.selection_rects : JSON.stringify(data.selection_rects || []),
    data.note_content || '',
    data.color || '#ffeb3b',
    data.pdf_source || null,
    now,
    now
  ]);

  // Get ID immediately after insert, before saveDatabase
  const result = db.exec(`SELECT last_insert_rowid() as id`);
  const id = result[0].values[0][0];

  saveDatabase();

  // Return the created annotation - use exec with ID directly (safe since it's from db)
  const selectResult = db.exec(`SELECT * FROM annotations WHERE id = ${id}`);

  if (selectResult.length === 0 || selectResult[0].values.length === 0) {
    // Fallback: get the most recent annotation for this paper
    const fallbackResult = db.exec(`SELECT * FROM annotations WHERE paper_id = ${paperId} ORDER BY id DESC LIMIT 1`);
    if (fallbackResult.length > 0 && fallbackResult[0].values.length > 0) {
      const columns = fallbackResult[0].columns;
      const row = fallbackResult[0].values[0];
      const obj = {};
      columns.forEach((col, i) => obj[col] = row[i]);
      if (obj.selection_rects) {
        try {
          obj.selection_rects = JSON.parse(obj.selection_rects);
        } catch (e) {
          obj.selection_rects = [];
        }
      }
      return obj;
    }
    return null;
  }

  const columns = selectResult[0].columns;
  const row = selectResult[0].values[0];
  const obj = {};
  columns.forEach((col, i) => obj[col] = row[i]);

  // Parse selection_rects JSON
  if (obj.selection_rects) {
    try {
      obj.selection_rects = JSON.parse(obj.selection_rects);
    } catch (e) {
      obj.selection_rects = [];
    }
  }
  return obj;
}

function updateAnnotation(id, data) {
  const fields = [];
  const values = [];

  if (data.note_content !== undefined) {
    fields.push('note_content = ?');
    values.push(data.note_content);
  }
  if (data.color !== undefined) {
    fields.push('color = ?');
    values.push(data.color);
  }
  if (data.selection_text !== undefined) {
    fields.push('selection_text = ?');
    values.push(data.selection_text);
  }
  if (data.selection_rects !== undefined) {
    fields.push('selection_rects = ?');
    values.push(typeof data.selection_rects === 'string' ? data.selection_rects : JSON.stringify(data.selection_rects));
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.run(`UPDATE annotations SET ${fields.join(', ')} WHERE id = ?`, values);
  saveDatabase();
}

function deleteAnnotation(id) {
  db.run(`DELETE FROM annotations WHERE id = ?`, [id]);
  saveDatabase();
}

function deleteAnnotationsForPaper(paperId) {
  db.run(`DELETE FROM annotations WHERE paper_id = ?`, [paperId]);
  saveDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// PDF PAGE ROTATIONS
// ═══════════════════════════════════════════════════════════════════════════

function getPageRotations(paperId, pdfSource = null) {
  const sourceCondition = pdfSource ? 'AND pdf_source = ?' : 'AND (pdf_source IS NULL OR pdf_source = ?)';
  const params = pdfSource ? [paperId, pdfSource] : [paperId, ''];

  const results = db.exec(
    `SELECT page_number, rotation FROM pdf_page_rotations WHERE paper_id = ? ${sourceCondition}`,
    params
  );

  if (results.length === 0) return {};

  const rotations = {};
  for (const row of results[0].values) {
    rotations[row[0]] = row[1];
  }
  return rotations;
}

function setPageRotation(paperId, pageNumber, rotation, pdfSource = null) {
  // Use REPLACE to upsert
  db.run(
    `INSERT OR REPLACE INTO pdf_page_rotations (paper_id, pdf_source, page_number, rotation)
     VALUES (?, ?, ?, ?)`,
    [paperId, pdfSource || '', pageNumber, rotation]
  );
  saveDatabase();
}

function setPageRotations(paperId, rotations, pdfSource = null) {
  // Clear existing rotations for this paper/source
  const sourceCondition = pdfSource ? 'AND pdf_source = ?' : 'AND (pdf_source IS NULL OR pdf_source = ?)';
  const deleteParams = pdfSource ? [paperId, pdfSource] : [paperId, ''];
  db.run(`DELETE FROM pdf_page_rotations WHERE paper_id = ? ${sourceCondition}`, deleteParams);

  // Insert new rotations
  for (const [pageNum, rotation] of Object.entries(rotations)) {
    if (rotation !== 0) {
      db.run(
        `INSERT INTO pdf_page_rotations (paper_id, pdf_source, page_number, rotation) VALUES (?, ?, ?, ?)`,
        [paperId, pdfSource || '', parseInt(pageNum), rotation]
      );
    }
  }
  saveDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA VERSION & METADATA
// ═══════════════════════════════════════════════════════════════════════════

function getSchemaVersion() {
  try {
    const result = db.exec("SELECT value FROM metadata WHERE key = 'schema_version'");
    if (result.length > 0 && result[0].values.length > 0) {
      return parseInt(result[0].values[0][0]) || 1;
    }
    return 1;
  } catch {
    return 1;
  }
}

function setSchemaVersion(version) {
  db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)", [String(version)]);
  saveDatabase();
}

function getMetadata(key) {
  try {
    const stmt = db.prepare("SELECT value FROM metadata WHERE key = ?");
    stmt.bind([key]);
    if (stmt.step()) {
      const value = stmt.get()[0];
      stmt.free();
      return value;
    }
    stmt.free();
    return null;
  } catch {
    return null;
  }
}

function setMetadata(key, value) {
  db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [key, value]);
  saveDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// PAPER FILES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add a file record to paper_files
 * @param {number} paperId - Paper ID
 * @param {Object} fileData - File data
 * @returns {number} The ID of the newly created file record
 */
function addPaperFile(paperId, fileData) {
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO paper_files (paper_id, file_hash, filename, original_name, mime_type, file_size, file_role, source_type, source_url, added_date, status, error_message, text_extracted, text_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    paperId,
    fileData.file_hash || null,
    fileData.filename,
    fileData.original_name || fileData.filename,
    fileData.mime_type || 'application/octet-stream',
    fileData.file_size || 0,
    fileData.file_role || 'pdf',
    fileData.source_type || 'manual',
    fileData.source_url || null,
    fileData.added_date || now,
    fileData.status || 'ready',
    fileData.error_message || null,
    fileData.text_extracted || 0,
    fileData.text_path || null
  ]);

  const result = db.exec(`SELECT last_insert_rowid() as id`);
  const id = result[0].values[0][0];
  saveDatabase();

  return id;
}

/**
 * Get files for a paper with optional filters
 * @param {number} paperId - Paper ID
 * @param {Object} filters - Optional filters (role, status, sourceType)
 * @returns {Array} Array of file records
 */
function getPaperFiles(paperId, filters = {}) {
  let query = `SELECT * FROM paper_files WHERE paper_id = ?`;
  const params = [paperId];

  if (filters.role) {
    query += ` AND file_role = ?`;
    params.push(filters.role);
  }

  if (filters.status) {
    query += ` AND status = ?`;
    params.push(filters.status);
  }

  if (filters.sourceType) {
    query += ` AND source_type = ?`;
    params.push(filters.sourceType);
  }

  query += ` ORDER BY added_date DESC`;

  const stmt = db.prepare(query);
  stmt.bind(params);

  const files = [];
  while (stmt.step()) {
    files.push(stmt.getAsObject());
  }
  stmt.free();

  return files;
}

/**
 * Get a single file record by ID
 * @param {number} fileId - File ID
 * @returns {Object|null} File record or null
 */
function getPaperFile(fileId) {
  const stmt = db.prepare(`SELECT * FROM paper_files WHERE id = ?`);
  stmt.bind([fileId]);

  let file = null;
  if (stmt.step()) {
    file = stmt.getAsObject();
  }
  stmt.free();

  return file;
}

/**
 * Update a file record
 * @param {number} fileId - File ID
 * @param {Object} updates - Fields to update
 */
function updatePaperFile(fileId, updates) {
  const fields = [];
  const values = [];

  const allowedFields = [
    'file_hash', 'filename', 'original_name', 'mime_type', 'file_size',
    'file_role', 'source_type', 'source_url', 'status', 'error_message',
    'text_extracted', 'text_path'
  ];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return;

  values.push(fileId);

  db.run(`UPDATE paper_files SET ${fields.join(', ')} WHERE id = ?`, values);
  saveDatabase();
}

/**
 * Find file records by hash (for deduplication)
 * @param {string} hash - File hash
 * @returns {Array} Array of file records with this hash
 */
function getFileByHash(hash) {
  const stmt = db.prepare(`SELECT * FROM paper_files WHERE file_hash = ?`);
  stmt.bind([hash]);

  const files = [];
  while (stmt.step()) {
    files.push(stmt.getAsObject());
  }
  stmt.free();

  return files;
}

/**
 * Get all files with a specific status
 * @param {string} status - File status
 * @returns {Array} Array of file records
 */
function getPaperFilesByStatus(status) {
  const stmt = db.prepare(`
    SELECT pf.*, p.bibcode, p.title
    FROM paper_files pf
    JOIN papers p ON pf.paper_id = p.id
    WHERE pf.status = ?
    ORDER BY pf.added_date ASC
  `);
  stmt.bind([status]);

  const files = [];
  while (stmt.step()) {
    files.push(stmt.getAsObject());
  }
  stmt.free();

  return files;
}

/**
 * Delete all files for a paper
 * @param {number} paperId - Paper ID
 */
function deletePaperFiles(paperId) {
  db.run(`DELETE FROM paper_files WHERE paper_id = ?`, [paperId]);
  saveDatabase();
}

function deletePaperFile(id) {
  db.run(`DELETE FROM paper_files WHERE id = ?`, [id]);
  saveDatabase();
}

// ═══════════════════════════════════════════════════════════════════════════
// SMART ADS SEARCHES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new smart search
 * @param {Object} data - Search data: name, query, sortOrder
 * @returns {number} The ID of the newly created search
 */
function createSmartSearch(data) {
  const now = new Date().toISOString();
  const maxOrderResult = db.exec('SELECT MAX(display_order) FROM smart_searches');
  const maxOrder = maxOrderResult[0]?.values[0][0] || 0;

  db.run(`
    INSERT INTO smart_searches (name, query, sort_order, display_order, created_date)
    VALUES (?, ?, ?, ?, ?)
  `, [
    data.name,
    data.query,
    data.sortOrder || 'date desc',
    maxOrder + 1,
    now
  ]);

  const result = db.exec('SELECT last_insert_rowid()');
  const id = result[0].values[0][0];
  saveDatabase();
  return id;
}

/**
 * Get a single smart search by ID
 * @param {number} id - Search ID
 * @returns {Object|null} Search object or null
 */
function getSmartSearch(id) {
  const stmt = db.prepare('SELECT * FROM smart_searches WHERE id = ?');
  stmt.bind([id]);

  if (stmt.step()) {
    const obj = stmt.getAsObject();
    stmt.free();
    return obj;
  }
  stmt.free();
  return null;
}

/**
 * Get all smart searches
 * @returns {Array} Array of search objects
 */
function getAllSmartSearches() {
  const results = db.exec(`
    SELECT * FROM smart_searches ORDER BY display_order ASC, created_date DESC
  `);
  if (results.length === 0) return [];

  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return obj;
  });
}

/**
 * Update a smart search
 * @param {number} id - Search ID
 * @param {Object} updates - Fields to update
 */
function updateSmartSearch(id, updates) {
  const fields = [];
  const values = [];

  const allowedFields = ['name', 'query', 'sort_order', 'display_order', 'last_refresh_date', 'result_count', 'error_message'];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return;

  values.push(id);
  db.run(`UPDATE smart_searches SET ${fields.join(', ')} WHERE id = ?`, values);
  saveDatabase();
}

/**
 * Delete a smart search (cascade deletes results)
 * @param {number} id - Search ID
 */
function deleteSmartSearch(id) {
  // Delete results first (in case FK cascade doesn't work with sql.js)
  db.run('DELETE FROM smart_search_results WHERE search_id = ?', [id]);
  db.run('DELETE FROM smart_searches WHERE id = ?', [id]);
  saveDatabase();
}

/**
 * Clear all cached results for a search
 * @param {number} searchId - Search ID
 */
function clearSmartSearchResults(searchId) {
  db.run('DELETE FROM smart_search_results WHERE search_id = ?', [searchId]);
}

/**
 * Add a result to a smart search
 * @param {number} searchId - Search ID
 * @param {Object} data - Paper data from ADS
 */
function addSmartSearchResult(searchId, data) {
  db.run(`
    INSERT OR REPLACE INTO smart_search_results
    (search_id, bibcode, title, authors, year, journal, abstract, doi, arxiv_id, citation_count, cached_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    searchId,
    data.bibcode,
    data.title || null,
    typeof data.authors === 'string' ? data.authors : JSON.stringify(data.authors || []),
    data.year || null,
    data.journal || null,
    data.abstract || null,
    data.doi || null,
    data.arxiv_id || null,
    data.citation_count || 0,
    data.cached_date || new Date().toISOString()
  ]);
}

/**
 * Get cached results for a search with library status (inLibrary flag)
 * @param {number} searchId - Search ID
 * @returns {Array} Results with inLibrary and libraryPaperId fields
 */
function getSmartSearchResultsWithLibraryStatus(searchId) {
  const results = db.exec(`
    SELECT ssr.*, p.id as library_paper_id
    FROM smart_search_results ssr
    LEFT JOIN papers p ON ssr.bibcode = p.bibcode
    WHERE ssr.search_id = ?
    ORDER BY ssr.id
  `, [searchId]);

  if (results.length === 0) return [];

  const columns = results[0].columns;
  return results[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    // Parse authors JSON
    if (obj.authors && typeof obj.authors === 'string') {
      try {
        obj.authors = JSON.parse(obj.authors);
      } catch (e) {
        obj.authors = [];
      }
    }
    // Add computed fields
    obj.inLibrary = obj.library_paper_id !== null;
    obj.libraryPaperId = obj.library_paper_id;
    return obj;
  });
}

/**
 * Reorder smart searches
 * @param {number[]} orderedIds - Array of search IDs in desired order
 */
function reorderSmartSearches(orderedIds) {
  orderedIds.forEach((id, index) => {
    db.run('UPDATE smart_searches SET display_order = ? WHERE id = ?', [index, id]);
  });
  saveDatabase();
}

/**
 * Check which bibcodes are already in the library
 * @param {string[]} bibcodes - Array of bibcodes to check
 * @returns {string[]} Array of bibcodes that exist in library
 */
function checkBibcodesInLibrary(bibcodes) {
  if (!bibcodes || bibcodes.length === 0) return [];

  const placeholders = bibcodes.map(() => '?').join(',');
  const results = db.exec(
    `SELECT bibcode FROM papers WHERE bibcode IN (${placeholders})`,
    bibcodes
  );

  if (results.length === 0) return [];
  return results[0].values.map(row => row[0]);
}

module.exports = {
  initDatabase,
  closeDatabase,
  saveDatabase,
  addPaper,
  addPapersBulk,
  updatePaper,
  deletePaper,
  getPaper,
  getPaperByBibcode,
  getAllPapers,
  searchPapersFullText,
  createCollection,
  getCollections,
  addPaperToCollection,
  removePaperFromCollection,
  getPapersInCollection,
  getCollection,
  getPapersInSmartCollection,
  deleteCollection,
  getStats,
  // LLM functions
  getSummary,
  saveSummary,
  deleteSummary,
  getQAHistory,
  saveQA,
  clearQAHistory,
  getEmbeddings,
  hasEmbeddings,
  getUnindexedPaperIds,
  saveEmbeddings,
  deleteEmbeddings,
  getAllEmbeddings,
  // Annotations
  getAnnotations,
  getAnnotationCountsBySource,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  deleteAnnotationsForPaper,
  // PDF page rotations
  getPageRotations,
  setPageRotation,
  setPageRotations,
  // Schema version & metadata
  getSchemaVersion,
  setSchemaVersion,
  getMetadata,
  setMetadata,
  // Paper files
  addPaperFile,
  getPaperFiles,
  getPaperFile,
  updatePaperFile,
  getFileByHash,
  getPaperFilesByStatus,
  deletePaperFile,
  deletePaperFiles,
  // Smart ADS Searches
  createSmartSearch,
  getSmartSearch,
  getAllSmartSearches,
  updateSmartSearch,
  deleteSmartSearch,
  clearSmartSearchResults,
  addSmartSearchResult,
  getSmartSearchResultsWithLibraryStatus,
  reorderSmartSearches,
  checkBibcodesInLibrary
};
