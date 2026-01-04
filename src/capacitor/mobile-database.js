/**
 * Bibliac - Mobile Database Module (sql.js + Capacitor Filesystem)
 * SQLite database using sql.js with Capacitor Filesystem for persistence
 *
 * This module provides the same interface as the desktop database.cjs
 * but uses Capacitor's Filesystem API instead of Node.js fs.
 */

import initSqlJs from 'sql.js';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { registerPlugin } from '@capacitor/core';
import { applySchema } from '../shared/database-schema.js';

// Register native iCloud plugin
const ICloud = registerPlugin('ICloud');

let db = null;
let dbPath = null;
let libraryPath = null;
let currentLocation = 'local'; // 'local' or 'icloud'
let SQL = null;

// sql.js WASM file URL - loaded from CDN
const SQL_WASM_URL = 'https://sql.js.org/dist/sql-wasm.wasm';

/**
 * Read file from appropriate storage backend
 */
async function readDbFile(path, location) {
  if (location === 'icloud') {
    const result = await ICloud.readFile({ path, encoding: null });
    return result.data;
  } else {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Documents
    });
    return result.data;
  }
}

/**
 * Write file to appropriate storage backend
 * For large iCloud files (>5MB), uses native copy to avoid memory issues
 */
async function writeDbFile(path, data, location) {
  console.log(`[MobileDB] writeDbFile: ${path} to ${location}`);

  // Estimate decoded size (base64 is ~1.33x larger than binary)
  const estimatedBytes = data.length * 0.75;
  const isLargeFile = estimatedBytes > 5 * 1024 * 1024; // 5MB threshold

  try {
    if (location === 'icloud') {
      if (isLargeFile) {
        // Large file: write to local temp first, then copy to iCloud natively
        // This avoids passing large base64 data through JavaScript bridge
        console.log(`[MobileDB] Large file (${Math.round(estimatedBytes / 1024 / 1024)}MB), using temp file approach`);

        const tempPath = `_temp_db_${Date.now()}.sqlite`;

        // Write to local temp file
        await Filesystem.writeFile({
          path: tempPath,
          data: data,
          directory: Directory.Documents
        });
        console.log(`[MobileDB] Temp file written: ${tempPath}`);

        // Copy from local to iCloud using native Swift (no base64 in JS)
        try {
          await ICloud.copyFromLocal({
            sourcePath: tempPath,
            destPath: path
          });
          console.log(`[MobileDB] Copied to iCloud: ${path}`);
        } finally {
          // Clean up temp file
          try {
            await Filesystem.deleteFile({
              path: tempPath,
              directory: Directory.Documents
            });
            console.log(`[MobileDB] Temp file cleaned up`);
          } catch (cleanupErr) {
            console.warn(`[MobileDB] Failed to clean up temp file:`, cleanupErr.message);
          }
        }
      } else {
        // Small file: use existing base64 approach
        const parentDir = path.substring(0, path.lastIndexOf('/'));
        if (parentDir) {
          console.log(`[MobileDB] Ensuring iCloud directory exists: ${parentDir}`);
          try {
            await ICloud.mkdir({ path: parentDir, recursive: true });
          } catch (e) {
            // Directory might already exist
            console.log(`[MobileDB] mkdir result:`, e.message || 'ok');
          }
        }
        await ICloud.writeFile({ path, data, encoding: null, recursive: true });
      }
    } else {
      // Local storage: always use Filesystem directly
      const parentDir = path.substring(0, path.lastIndexOf('/'));
      if (parentDir) {
        try {
          await Filesystem.mkdir({
            path: parentDir,
            directory: Directory.Documents,
            recursive: true
          });
        } catch (e) {
          // Directory might already exist
        }
      }
      await Filesystem.writeFile({
        path,
        data,
        directory: Directory.Documents,
        recursive: true
      });
    }
    console.log(`[MobileDB] writeDbFile: success`);
  } catch (e) {
    console.error(`[MobileDB] writeDbFile failed:`, e.message);
    throw e;
  }
}

/**
 * Initialize sql.js and load/create database
 * @param {string} libPath - Library folder path (relative to directory)
 * @param {string} location - Storage location: 'local' or 'icloud'
 * @returns {Promise<boolean>}
 */
export async function initDatabase(libPath, location = 'local') {
  libraryPath = libPath;
  dbPath = `${libPath}/library.sqlite`;
  currentLocation = location;

  console.log(`[MobileDB] Initializing database at ${dbPath} in ${location}`);

  if (!SQL) {
    console.log('[MobileDB] Loading sql.js...');
    // Initialize sql.js with WASM
    SQL = await initSqlJs({
      locateFile: file => SQL_WASM_URL
    });
    console.log('[MobileDB] sql.js loaded');
  }

  // Try to load existing database
  try {
    console.log('[MobileDB] Attempting to read existing database...');
    const base64Data = await readDbFile(dbPath, location);
    console.log('[MobileDB] Database file read, size:', base64Data?.length || 0);

    // Convert base64 to Uint8Array
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    db = new SQL.Database(bytes);
    console.log('[MobileDB] Loaded existing database');
  } catch (e) {
    // Database doesn't exist, create new one (expected for new libraries)
    console.log('[MobileDB] No existing database, creating new');
    db = new SQL.Database();
  }

  // Ensure schema exists
  console.log('[MobileDB] Creating schema...');
  createSchema();
  console.log('[MobileDB] Schema created, saving database...');

  try {
    await saveDatabase();
    console.log('[MobileDB] Database saved successfully');
  } catch (e) {
    console.error('[MobileDB] Failed to save database:', e.message);
    // Don't throw - we can still work with the in-memory database
  }

  return true;
}

/**
 * Save database to filesystem
 */
export async function saveDatabase() {
  if (!db || !dbPath) {
    console.log('[MobileDB] saveDatabase: no db or dbPath');
    return;
  }

  console.log(`[MobileDB] Saving database to ${dbPath} (${currentLocation})`);

  try {
    const data = db.export();
    const uint8Array = new Uint8Array(data);
    console.log('[MobileDB] Database exported, size:', uint8Array.length);

    // Convert to base64 for storage
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64 = btoa(binary);
    console.log('[MobileDB] Converted to base64, length:', base64.length);

    await writeDbFile(dbPath, base64, currentLocation);

    console.log('[MobileDB] Database saved successfully');
  } catch (e) {
    console.error('[MobileDB] Failed to save database:', e.message);
    throw e; // Re-throw so caller knows it failed
  }
}

/**
 * Close database
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Get the current storage location ('local' or 'icloud')
 */
export function getLocation() {
  return currentLocation;
}

/**
 * Get the current library path
 */
export function getLibraryPath() {
  return libraryPath;
}

/**
 * Create database schema using shared definition
 */
function createSchema() {
  applySchema(db);
}

// ═══════════════════════════════════════════════════════════════════════════
// PAPER OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add a paper to the database
 * @param {Object} paper - Paper data
 * @returns {number} - The new paper ID
 */
export function addPaper(paper) {
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO papers (bibcode, doi, arxiv_id, title, authors, year, journal, abstract, keywords,
                        pdf_path, text_path, bibtex, read_status, rating, added_date, modified_date,
                        import_source, import_source_key, citation_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    paper.rating || 0,
    now,
    now,
    paper.import_source || null,
    paper.import_source_key || null,
    paper.citation_count || 0
  ]);
  stmt.free();

  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0];
}

/**
 * Get a paper by ID
 * @param {number} id - Paper ID
 * @returns {Object|null} - Paper object or null
 */
export function getPaper(id) {
  const stmt = db.prepare('SELECT * FROM papers WHERE id = ?');
  stmt.bind([id]);

  if (stmt.step()) {
    const paper = rowToPaper(stmt.getAsObject());
    stmt.free();
    return paper;
  }
  stmt.free();
  return null;
}

/**
 * Get a paper by bibcode
 * @param {string} bibcode - ADS bibcode
 * @returns {Object|null} - Paper object or null
 */
export function getPaperByBibcode(bibcode) {
  const stmt = db.prepare('SELECT * FROM papers WHERE bibcode = ?');
  stmt.bind([bibcode]);

  if (stmt.step()) {
    const paper = rowToPaper(stmt.getAsObject());
    stmt.free();
    return paper;
  }
  stmt.free();
  return null;
}

/**
 * Get all papers with optional filtering
 * @param {Object} options - Query options
 * @returns {Array} - Array of papers
 */
export function getAllPapers(options = {}) {
  let sql = 'SELECT * FROM papers WHERE 1=1';
  const params = [];

  if (options.readStatus) {
    sql += ' AND read_status = ?';
    params.push(options.readStatus);
  }

  if (options.collectionId) {
    sql += ' AND id IN (SELECT paper_id FROM paper_collections WHERE collection_id = ?)';
    params.push(options.collectionId);
  }

  if (options.search) {
    sql += ' AND (title LIKE ? OR authors LIKE ? OR abstract LIKE ?)';
    const searchTerm = `%${options.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  const orderBy = options.orderBy || 'added_date';
  const order = options.order || 'DESC';
  sql += ` ORDER BY ${orderBy} ${order}`;

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const stmt = db.prepare(sql);
  stmt.bind(params);

  const papers = [];
  while (stmt.step()) {
    papers.push(rowToPaper(stmt.getAsObject()));
  }
  stmt.free();

  return papers;
}

/**
 * Update a paper
 * @param {number} id - Paper ID
 * @param {Object} updates - Fields to update
 * @returns {boolean} - Success
 */
export function updatePaper(id, updates) {
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id') continue;

    fields.push(`${key} = ?`);
    if (key === 'authors' || key === 'keywords') {
      values.push(JSON.stringify(value));
    } else {
      values.push(value);
    }
  }

  if (fields.length === 0) return false;

  fields.push('modified_date = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const sql = `UPDATE papers SET ${fields.join(', ')} WHERE id = ?`;
  db.run(sql, values);
  return true;
}

/**
 * Delete a paper
 * @param {number} id - Paper ID
 * @returns {boolean} - Success
 */
export function deletePaper(id) {
  db.run('DELETE FROM refs WHERE paper_id = ?', [id]);
  db.run('DELETE FROM citations WHERE paper_id = ?', [id]);
  db.run('DELETE FROM paper_collections WHERE paper_id = ?', [id]);
  db.run('DELETE FROM annotations WHERE paper_id = ?', [id]);
  db.run('DELETE FROM paper_summaries WHERE paper_id = ?', [id]);
  db.run('DELETE FROM paper_qa WHERE paper_id = ?', [id]);
  db.run('DELETE FROM text_embeddings WHERE paper_id = ?', [id]);
  db.run('DELETE FROM papers WHERE id = ?', [id]);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// COLLECTION OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get all collections
 * @returns {Array} - Array of collections
 */
export function getCollections() {
  const result = db.exec(`
    SELECT c.*,
           (SELECT COUNT(*) FROM paper_collections WHERE collection_id = c.id) as paper_count
    FROM collections c
    ORDER BY c.name
  `);

  if (!result[0]) return [];

  return result[0].values.map(row => ({
    id: row[0],
    name: row[1],
    parent_id: row[2],
    is_smart: row[3] === 1,
    query: row[4],
    created_date: row[5],
    paper_count: row[6]
  }));
}

/**
 * Create a collection
 * @param {string} name - Collection name
 * @param {number|null} parentId - Parent collection ID
 * @returns {number} - New collection ID
 */
export function createCollection(name, parentId = null) {
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO collections (name, parent_id, created_date) VALUES (?, ?, ?)',
    [name, parentId, now]
  );
  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0];
}

/**
 * Add paper to collection
 * @param {number} paperId - Paper ID
 * @param {number} collectionId - Collection ID
 */
export function addPaperToCollection(paperId, collectionId) {
  try {
    db.run(
      'INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)',
      [paperId, collectionId]
    );
  } catch (e) {
    // Already in collection
  }
}

/**
 * Remove paper from collection
 * @param {number} paperId - Paper ID
 * @param {number} collectionId - Collection ID
 */
export function removePaperFromCollection(paperId, collectionId) {
  db.run(
    'DELETE FROM paper_collections WHERE paper_id = ? AND collection_id = ?',
    [paperId, collectionId]
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ANNOTATION OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get annotations for a paper
 * @param {number} paperId - Paper ID
 * @param {string} pdfSource - PDF source type (optional)
 * @returns {Array} - Array of annotations
 */
export function getAnnotations(paperId, pdfSource = null) {
  let sql = 'SELECT * FROM annotations WHERE paper_id = ?';
  const params = [paperId];

  if (pdfSource) {
    sql += ' AND pdf_source = ?';
    params.push(pdfSource);
  }

  sql += ' ORDER BY page_number, id';

  const stmt = db.prepare(sql);
  stmt.bind(params);

  const annotations = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    annotations.push({
      id: row.id,
      paper_id: row.paper_id,
      page_number: row.page_number,
      selection_text: row.selection_text,
      selection_rects: row.selection_rects ? JSON.parse(row.selection_rects) : [],
      note_content: row.note_content,
      color: row.color,
      pdf_source: row.pdf_source,
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  }
  stmt.free();

  return annotations;
}

/**
 * Add annotation
 * @param {Object} annotation - Annotation data
 * @returns {number} - New annotation ID
 */
export function addAnnotation(annotation) {
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO annotations (paper_id, page_number, selection_text, selection_rects,
                            note_content, color, pdf_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    annotation.paper_id,
    annotation.page_number,
    annotation.selection_text,
    JSON.stringify(annotation.selection_rects || []),
    annotation.note_content || '',
    annotation.color || '#ffeb3b',
    annotation.pdf_source || null,
    now,
    now
  ]);

  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0];
}

/**
 * Delete annotation
 * @param {number} id - Annotation ID
 * @returns {boolean} - Success
 */
export function deleteAnnotation(id) {
  db.run('DELETE FROM annotations WHERE id = ?', [id]);
  return true;
}

/**
 * Create annotation (alias for addAnnotation with different parameter format)
 * @param {number} paperId - Paper ID
 * @param {Object} data - Annotation data
 * @returns {number} - New annotation ID
 */
export function createAnnotation(paperId, data) {
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO annotations (paper_id, page_number, selection_text, selection_rects,
                            note_content, color, pdf_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    paperId,
    data.pageNumber || data.page_number,
    data.content || data.selection_text || data.selectionText,
    JSON.stringify(data.position || data.selection_rects || data.selectionRects || []),
    data.note || data.note_content || data.noteContent || '',
    data.color || '#ffeb3b',
    data.pdfSource || data.pdf_source || null,
    now,
    now
  ]);

  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0];
}

/**
 * Update annotation
 * @param {number} id - Annotation ID
 * @param {Object} data - Fields to update
 * @returns {boolean} - Success
 */
export function updateAnnotation(id, data) {
  const updates = [];
  const params = [];

  if (data.note !== undefined || data.note_content !== undefined || data.noteContent !== undefined) {
    updates.push('note_content = ?');
    params.push(data.note || data.note_content || data.noteContent);
  }
  if (data.color !== undefined) {
    updates.push('color = ?');
    params.push(data.color);
  }
  if (data.content !== undefined || data.selection_text !== undefined || data.selectionText !== undefined) {
    updates.push('selection_text = ?');
    params.push(data.content || data.selection_text || data.selectionText);
  }

  if (updates.length === 0) return false;

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  db.run(`UPDATE annotations SET ${updates.join(', ')} WHERE id = ?`, params);
  return true;
}

/**
 * Get annotation counts grouped by PDF source
 * @param {number} paperId - Paper ID
 * @returns {Object} - Counts by source { 'EPRINT_PDF': 3, 'PUB_PDF': 1, ... }
 */
export function getAnnotationCountsBySource(paperId) {
  const sql = `SELECT pdf_source, COUNT(*) as count FROM annotations
               WHERE paper_id = ? GROUP BY pdf_source`;
  const stmt = db.prepare(sql);
  stmt.bind([paperId]);

  const counts = {};
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const source = row.pdf_source || 'default';
    counts[source] = row.count;
  }
  stmt.free();

  return counts;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get summary for a paper
 * @param {number} paperId - Paper ID
 * @returns {Object|null} - Summary object or null
 */
export function getSummary(paperId) {
  const stmt = db.prepare('SELECT * FROM paper_summaries WHERE paper_id = ?');
  stmt.bind([paperId]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return {
      id: row.id,
      paper_id: row.paper_id,
      summary: row.summary,
      key_points: row.key_points,
      model: row.model,
      generated_date: row.generated_date
    };
  }
  stmt.free();
  return null;
}

/**
 * Save summary for a paper
 * @param {number} paperId - Paper ID
 * @param {string} summary - Summary text
 * @param {string} model - Model used to generate summary
 * @param {string} keyPoints - Key points (optional)
 * @returns {number} - Summary ID
 */
export function saveSummary(paperId, summary, model, keyPoints = null) {
  const now = new Date().toISOString();

  // Check if summary exists for this paper
  const existing = getSummary(paperId);

  if (existing) {
    // Update existing summary
    db.run(`
      UPDATE paper_summaries
      SET summary = ?, key_points = ?, model = ?, generated_date = ?
      WHERE paper_id = ?
    `, [summary, keyPoints, model, now, paperId]);
    return existing.id;
  } else {
    // Insert new summary
    db.run(`
      INSERT INTO paper_summaries (paper_id, summary, key_points, model, generated_date)
      VALUES (?, ?, ?, ?, ?)
    `, [paperId, summary, keyPoints, model, now]);
    const result = db.exec('SELECT last_insert_rowid()');
    return result[0].values[0][0];
  }
}

/**
 * Delete summary for a paper
 * @param {number} paperId - Paper ID
 */
export function deleteSummary(paperId) {
  db.run('DELETE FROM paper_summaries WHERE paper_id = ?', [paperId]);
}

// ═══════════════════════════════════════════════════════════════════════════
// Q&A HISTORY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get Q&A history for a paper
 * @param {number} paperId - Paper ID
 * @returns {Array} - Array of Q&A entries
 */
export function getQAHistory(paperId) {
  const stmt = db.prepare(`
    SELECT * FROM paper_qa
    WHERE paper_id = ?
    ORDER BY created_date DESC
  `);
  stmt.bind([paperId]);

  const history = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    history.push({
      id: row.id,
      paper_id: row.paper_id,
      question: row.question,
      answer: row.answer,
      context_used: row.context_used,
      model: row.model,
      created_at: row.created_date
    });
  }
  stmt.free();

  return history;
}

/**
 * Add Q&A entry for a paper
 * @param {number} paperId - Paper ID
 * @param {string} question - Question asked
 * @param {string} answer - Answer generated
 * @param {string} model - Model used
 * @param {string} contextUsed - Context snippet used (optional)
 * @returns {number} - Q&A entry ID
 */
export function addQAEntry(paperId, question, answer, model, contextUsed = null) {
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO paper_qa (paper_id, question, answer, context_used, model, created_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [paperId, question, answer, contextUsed, model, now]);
  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0];
}

/**
 * Clear Q&A history for a paper
 * @param {number} paperId - Paper ID
 */
export function clearQAHistory(paperId) {
  db.run('DELETE FROM paper_qa WHERE paper_id = ?', [paperId]);
}

// ═══════════════════════════════════════════════════════════════════════════
// REFERENCES & CITATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get references for a paper (papers this paper cites)
 * @param {number} paperId - Paper ID
 * @returns {Array} - Array of reference objects
 */
export function getReferences(paperId) {
  const stmt = db.prepare('SELECT * FROM refs WHERE paper_id = ? ORDER BY ref_year DESC');
  stmt.bind([paperId]);

  const refs = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    // Return with original column names to match Electron version
    refs.push({
      id: row.id,
      paper_id: row.paper_id,
      ref_bibcode: row.ref_bibcode,
      ref_title: row.ref_title,
      ref_authors: row.ref_authors,
      ref_year: row.ref_year
    });
  }
  stmt.free();

  return refs;
}

/**
 * Get citations for a paper (papers that cite this paper)
 * @param {number} paperId - Paper ID
 * @returns {Array} - Array of citation objects
 */
export function getCitations(paperId) {
  const stmt = db.prepare('SELECT * FROM citations WHERE paper_id = ? ORDER BY citing_year DESC');
  stmt.bind([paperId]);

  const cites = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    // Return with original column names to match Electron version
    cites.push({
      id: row.id,
      paper_id: row.paper_id,
      citing_bibcode: row.citing_bibcode,
      citing_title: row.citing_title,
      citing_authors: row.citing_authors,
      citing_year: row.citing_year
    });
  }
  stmt.free();

  return cites;
}

/**
 * Add references for a paper (replaces existing)
 * @param {number} paperId - Paper ID
 * @param {Array} refs - Array of reference objects
 */
export function addReferences(paperId, refs) {
  // Clear existing references for this paper
  db.run('DELETE FROM refs WHERE paper_id = ?', [paperId]);

  // Insert new references
  for (const ref of refs) {
    // Handle authors - may be array or string
    const authorsStr = Array.isArray(ref.author) ? ref.author.join(', ') : (ref.authors || ref.author || '');

    db.run(
      'INSERT INTO refs (paper_id, ref_bibcode, ref_title, ref_authors, ref_year) VALUES (?, ?, ?, ?, ?)',
      [paperId, ref.bibcode || null, ref.title || null, authorsStr, ref.year || null]
    );
  }
}

/**
 * Add citations for a paper (replaces existing)
 * @param {number} paperId - Paper ID
 * @param {Array} cites - Array of citation objects
 */
export function addCitations(paperId, cites) {
  // Clear existing citations for this paper
  db.run('DELETE FROM citations WHERE paper_id = ?', [paperId]);

  // Insert new citations
  for (const cite of cites) {
    // Handle authors - may be array or string
    const authorsStr = Array.isArray(cite.author) ? cite.author.join(', ') : (cite.authors || cite.author || '');

    db.run(
      'INSERT INTO citations (paper_id, citing_bibcode, citing_title, citing_authors, citing_year) VALUES (?, ?, ?, ?, ?)',
      [paperId, cite.bibcode || null, cite.title || null, authorsStr, cite.year || null]
    );
  }
}

/**
 * Get reference count for a paper
 * @param {number} paperId - Paper ID
 * @returns {number} - Reference count
 */
export function getReferencesCount(paperId) {
  const result = db.exec('SELECT COUNT(*) FROM refs WHERE paper_id = ?', [paperId]);
  return result[0]?.values[0][0] || 0;
}

/**
 * Get citation count for a paper
 * @param {number} paperId - Paper ID
 * @returns {number} - Citation count
 */
export function getCitationsCount(paperId) {
  const result = db.exec('SELECT COUNT(*) FROM citations WHERE paper_id = ?', [paperId]);
  return result[0]?.values[0][0] || 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert database row to paper object
 */
function rowToPaper(row) {
  return {
    id: row.id,
    bibcode: row.bibcode,
    doi: row.doi,
    arxiv_id: row.arxiv_id,
    title: row.title,
    authors: row.authors ? JSON.parse(row.authors) : [],
    year: row.year,
    journal: row.journal,
    abstract: row.abstract,
    keywords: row.keywords ? JSON.parse(row.keywords) : [],
    pdf_path: row.pdf_path,
    text_path: row.text_path,
    bibtex: row.bibtex,
    read_status: row.read_status,
    rating: row.rating,
    added_date: row.added_date,
    modified_date: row.modified_date,
    import_source: row.import_source,
    import_source_key: row.import_source_key,
    citation_count: row.citation_count || 0
  };
}

/**
 * Check if database is initialized
 * @returns {boolean}
 */
export function isInitialized() {
  return db !== null;
}

/**
 * Get library statistics
 * @returns {Object} Stats with total, unread, reading, read counts
 */
export function getStats() {
  if (!db) return { total: 0, unread: 0, reading: 0, read: 0 };

  try {
    const total = db.exec('SELECT COUNT(*) FROM papers')[0]?.values[0][0] || 0;
    const unread = db.exec("SELECT COUNT(*) FROM papers WHERE read_status = 'unread'")[0]?.values[0][0] || 0;
    const reading = db.exec("SELECT COUNT(*) FROM papers WHERE read_status = 'reading'")[0]?.values[0][0] || 0;
    const read = db.exec("SELECT COUNT(*) FROM papers WHERE read_status = 'read'")[0]?.values[0][0] || 0;

    return { total, unread, reading, read };
  } catch (e) {
    console.error('[MobileDB] Failed to get stats:', e);
    return { total: 0, unread: 0, reading: 0, read: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAPER FILES OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add a file record to the paper_files table
 * @param {number} paperId - Paper ID
 * @param {Object} fileData - File metadata
 * @returns {number} - New file record ID
 */
export function addPaperFile(paperId, fileData) {
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO paper_files (
      paper_id, file_hash, filename, original_name, mime_type, file_size,
      file_role, source_type, source_url, added_date, status, error_message,
      text_extracted, text_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run([
    paperId,
    fileData.file_hash || null,
    fileData.filename,
    fileData.original_name || null,
    fileData.mime_type || 'application/octet-stream',
    fileData.file_size || null,
    fileData.file_role || 'other',
    fileData.source_type || null,
    fileData.source_url || null,
    fileData.added_date || now,
    fileData.status || 'ready',
    fileData.error_message || null,
    fileData.text_extracted || 0,
    fileData.text_path || null
  ]);
  stmt.free();

  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0];
}

/**
 * Get a file record by ID
 * @param {number} fileId - File record ID
 * @returns {Object|null} - File record or null
 */
export function getPaperFile(fileId) {
  const stmt = db.prepare('SELECT * FROM paper_files WHERE id = ?');
  stmt.bind([fileId]);

  if (stmt.step()) {
    const file = stmt.getAsObject();
    stmt.free();
    return file;
  }
  stmt.free();
  return null;
}

/**
 * Get all files for a paper with optional filters
 * @param {number} paperId - Paper ID
 * @param {Object} filters - Optional filters (role, status)
 * @returns {Array} - Array of file records
 */
export function getPaperFiles(paperId, filters = {}) {
  let sql = 'SELECT * FROM paper_files WHERE paper_id = ?';
  const params = [paperId];

  if (filters.role) {
    sql += ' AND file_role = ?';
    params.push(filters.role);
  }

  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  }

  sql += ' ORDER BY added_date DESC';

  const stmt = db.prepare(sql);
  stmt.bind(params);

  const files = [];
  while (stmt.step()) {
    files.push(stmt.getAsObject());
  }
  stmt.free();
  return files;
}

/**
 * Update a file record
 * @param {number} fileId - File record ID
 * @param {Object} updates - Fields to update
 * @returns {boolean} - Success
 */
export function updatePaperFile(fileId, updates) {
  const allowedFields = [
    'file_hash', 'filename', 'original_name', 'mime_type', 'file_size',
    'file_role', 'source_type', 'source_url', 'status', 'error_message',
    'text_extracted', 'text_path'
  ];

  const setClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) return false;

  values.push(fileId);
  const sql = `UPDATE paper_files SET ${setClauses.join(', ')} WHERE id = ?`;

  db.run(sql, values);
  return true;
}

/**
 * Delete a file record
 * @param {number} fileId - File record ID
 * @returns {boolean} - Success
 */
export function deletePaperFile(fileId) {
  db.run('DELETE FROM paper_files WHERE id = ?', [fileId]);
  return true;
}

/**
 * Find files by hash (for deduplication)
 * @param {string} hash - SHA-256 hash
 * @returns {Array} - Array of file records with this hash
 */
export function getFilesByHash(hash) {
  const stmt = db.prepare('SELECT * FROM paper_files WHERE file_hash = ?');
  stmt.bind([hash]);

  const files = [];
  while (stmt.step()) {
    files.push(stmt.getAsObject());
  }
  stmt.free();
  return files;
}

/**
 * Get PDF files for a paper, sorted by source priority
 * @param {number} paperId - Paper ID
 * @returns {Array} - Array of PDF file records
 */
export function getPaperPdfs(paperId) {
  const stmt = db.prepare(`
    SELECT * FROM paper_files
    WHERE paper_id = ? AND file_role = 'pdf' AND status = 'ready'
    ORDER BY
      CASE source_type
        WHEN 'publisher' THEN 1
        WHEN 'arxiv' THEN 2
        WHEN 'ads_scan' THEN 3
        WHEN 'manual' THEN 4
        ELSE 5
      END
  `);
  stmt.bind([paperId]);

  const files = [];
  while (stmt.step()) {
    files.push(stmt.getAsObject());
  }
  stmt.free();
  return files;
}

/**
 * Get pending/downloading files (for queue recovery)
 * @returns {Array} - Array of file records with pending status
 */
export function getPendingFiles() {
  const stmt = db.prepare(`
    SELECT pf.*, p.bibcode, p.arxiv_id, p.doi
    FROM paper_files pf
    JOIN papers p ON pf.paper_id = p.id
    WHERE pf.status IN ('pending', 'queued', 'downloading')
    ORDER BY pf.added_date
  `);

  const files = [];
  while (stmt.step()) {
    files.push(stmt.getAsObject());
  }
  stmt.free();
  return files;
}

/**
 * Initialize database from iCloud
 * @param {string} libPath - Library folder path (relative to iCloud container)
 * @returns {Promise<boolean>}
 */
export async function initDatabaseFromICloud(libPath) {
  // Just call initDatabase with icloud location
  return initDatabase(libPath, 'icloud');
}

// Note: saveDatabaseToICloud removed - saveDatabase now handles both local and iCloud
