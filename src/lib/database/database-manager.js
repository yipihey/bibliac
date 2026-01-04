/**
 * Bibliac Core - Database Manager
 *
 * Platform-agnostic database operations using sql.js.
 * Provides the same interface for both Electron and Capacitor.
 */

import { applySchema } from './schema.js';

/**
 * Create a database manager instance
 *
 * @param {Object} options
 * @param {function(): Promise<Object>} options.initSqlJs - sql.js initialization function
 * @param {function(Uint8Array): Promise<void>} options.save - Function to save database
 * @param {function(): Promise<Uint8Array|null>} options.load - Function to load database
 * @returns {DatabaseManager}
 */
export function createDatabaseManager(options) {
  return new DatabaseManager(options);
}

/**
 * Database Manager Class
 */
export class DatabaseManager {
  constructor(options) {
    this.initSqlJs = options.initSqlJs;
    this.saveToStorage = options.save;
    this.loadFromStorage = options.load;

    this.db = null;
    this.SQL = null;
    this.initialized = false;
  }

  /**
   * Initialize the database
   * @returns {Promise<boolean>}
   */
  async init() {
    if (this.initialized) return true;

    if (!this.SQL) {
      this.SQL = await this.initSqlJs();
    }

    // Try to load existing database
    const existingData = await this.loadFromStorage();
    if (existingData) {
      this.db = new this.SQL.Database(existingData);
    } else {
      this.db = new this.SQL.Database();
    }

    // Ensure schema exists
    applySchema(this.db);
    await this.save();

    this.initialized = true;
    return true;
  }

  /**
   * Save database to storage
   */
  async save() {
    if (this.db) {
      const data = this.db.export();
      await this.saveToStorage(new Uint8Array(data));
    }
  }

  /**
   * Close database
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }

  /**
   * Check if database is initialized
   * @returns {boolean}
   */
  isInitialized() {
    return this.initialized;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAPER OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add a paper to the database
   * @param {Partial<import('../types.js').Paper>} paper
   * @returns {number} The new paper ID
   */
  addPaper(paper) {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
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

    const result = this.db.exec('SELECT last_insert_rowid()');
    return result[0].values[0][0];
  }

  /**
   * Bulk add papers
   * @param {Partial<import('../types.js').Paper>[]} papers
   * @param {function} [progressCallback]
   * @returns {{inserted: Array, skipped: Array}}
   */
  addPapersBulk(papers, progressCallback = null) {
    const now = new Date().toISOString();
    const inserted = [];
    const skipped = [];

    const stmt = this.db.prepare(`
      INSERT INTO papers (bibcode, doi, arxiv_id, title, authors, year, journal,
                          abstract, keywords, pdf_path, text_path, bibtex,
                          read_status, added_date, modified_date, import_source, import_source_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < papers.length; i++) {
      const paper = papers[i];

      // Check for duplicates
      let isDuplicate = false;

      if (paper.doi) {
        const existing = this.db.exec(`SELECT id FROM papers WHERE doi = ?`, [paper.doi]);
        if (existing.length > 0 && existing[0].values.length > 0) isDuplicate = true;
      }

      if (!isDuplicate && paper.arxiv_id) {
        const existing = this.db.exec(`SELECT id FROM papers WHERE arxiv_id = ?`, [paper.arxiv_id]);
        if (existing.length > 0 && existing[0].values.length > 0) isDuplicate = true;
      }

      if (!isDuplicate && paper.title && paper.year) {
        const existing = this.db.exec(`SELECT id FROM papers WHERE title = ? AND year = ?`, [paper.title, paper.year]);
        if (existing.length > 0 && existing[0].values.length > 0) isDuplicate = true;
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
            paper.import_source_key || null
          ]);
          stmt.reset();

          const result = this.db.exec('SELECT last_insert_rowid()');
          inserted.push({ id: result[0].values[0][0], title: paper.title });
        } catch (e) {
          skipped.push({ paper, reason: e.message });
        }
      }

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
    return { inserted, skipped };
  }

  /**
   * Get a paper by ID
   * @param {number} id
   * @returns {import('../types.js').Paper|null}
   */
  getPaper(id) {
    const stmt = this.db.prepare('SELECT * FROM papers WHERE id = ?');
    stmt.bind([id]);

    if (stmt.step()) {
      const paper = this._parsePaperRow(stmt.getAsObject());
      stmt.free();
      return paper;
    }
    stmt.free();
    return null;
  }

  /**
   * Get a paper by bibcode
   * @param {string} bibcode
   * @returns {import('../types.js').Paper|null}
   */
  getPaperByBibcode(bibcode) {
    const stmt = this.db.prepare('SELECT * FROM papers WHERE bibcode = ?');
    stmt.bind([bibcode]);

    if (stmt.step()) {
      const paper = this._parsePaperRow(stmt.getAsObject());
      stmt.free();
      return paper;
    }
    stmt.free();
    return null;
  }

  /**
   * Get all papers with optional filtering
   * @param {import('../types.js').GetPapersOptions} [options={}]
   * @returns {import('../types.js').Paper[]}
   */
  getAllPapers(options = {}) {
    let query = `
      SELECT p.*,
        (SELECT COUNT(*) FROM text_embeddings e WHERE e.paper_id = p.id) > 0 AS is_indexed,
        (SELECT COUNT(*) FROM annotations a WHERE a.paper_id = p.id) AS annotation_count,
        (SELECT COUNT(*) FROM citations c WHERE c.paper_id = p.id) AS citation_count_db
      FROM papers p`;
    const conditions = [];
    const values = [];

    if (options.readStatus) {
      conditions.push('p.read_status = ?');
      values.push(options.readStatus);
    }

    if (options.collectionId) {
      conditions.push('p.id IN (SELECT paper_id FROM paper_collections WHERE collection_id = ?)');
      values.push(options.collectionId);
    }

    if (options.search) {
      conditions.push('(p.title LIKE ? OR p.authors LIKE ? OR p.abstract LIKE ?)');
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

    const results = this.db.exec(query, values);
    if (results.length === 0) return [];

    const columns = results[0].columns;
    return results[0].values.map(row => {
      const obj = {};
      columns.forEach((col, i) => obj[col] = row[i]);
      return this._parsePaperRow(obj);
    });
  }

  /**
   * Update a paper
   * @param {number} id
   * @param {Partial<import('../types.js').Paper>} updates
   * @param {boolean} [save=true]
   */
  updatePaper(id, updates, save = true) {
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

    this.db.run(`UPDATE papers SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  /**
   * Delete a paper
   * @param {number} id
   */
  deletePaper(id) {
    this.db.run('DELETE FROM refs WHERE paper_id = ?', [id]);
    this.db.run('DELETE FROM citations WHERE paper_id = ?', [id]);
    this.db.run('DELETE FROM paper_collections WHERE paper_id = ?', [id]);
    this.db.run('DELETE FROM annotations WHERE paper_id = ?', [id]);
    this.db.run('DELETE FROM paper_summaries WHERE paper_id = ?', [id]);
    this.db.run('DELETE FROM paper_qa WHERE paper_id = ?', [id]);
    this.db.run('DELETE FROM text_embeddings WHERE paper_id = ?', [id]);
    this.db.run('DELETE FROM attachments WHERE paper_id = ?', [id]);
    this.db.run('DELETE FROM papers WHERE id = ?', [id]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COLLECTION OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a collection
   * @param {string} name
   * @param {number|null} [parentId=null]
   * @param {boolean} [isSmart=false]
   * @param {string|null} [query=null]
   * @returns {number}
   */
  createCollection(name, parentId = null, isSmart = false, query = null) {
    const now = new Date().toISOString();
    this.db.run(`
      INSERT INTO collections (name, parent_id, is_smart, query, created_date)
      VALUES (?, ?, ?, ?, ?)
    `, [name, parentId, isSmart ? 1 : 0, query, now]);

    const result = this.db.exec('SELECT last_insert_rowid()');
    return result[0].values[0][0];
  }

  /**
   * Get all collections
   * @returns {import('../types.js').Collection[]}
   */
  getCollections() {
    const results = this.db.exec(`
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

  /**
   * Add paper to collection
   * @param {number} paperId
   * @param {number} collectionId
   */
  addPaperToCollection(paperId, collectionId) {
    this.db.run(`
      INSERT OR IGNORE INTO paper_collections (paper_id, collection_id)
      VALUES (?, ?)
    `, [paperId, collectionId]);
  }

  /**
   * Remove paper from collection
   * @param {number} paperId
   * @param {number} collectionId
   */
  removePaperFromCollection(paperId, collectionId) {
    this.db.run(`
      DELETE FROM paper_collections WHERE paper_id = ? AND collection_id = ?
    `, [paperId, collectionId]);
  }

  /**
   * Delete collection
   * @param {number} collectionId
   */
  deleteCollection(collectionId) {
    this.db.run('DELETE FROM paper_collections WHERE collection_id = ?', [collectionId]);
    this.db.run('DELETE FROM collections WHERE id = ?', [collectionId]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REFERENCES & CITATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add references for a paper
   * @param {number} paperId
   * @param {Array} refs
   */
  addReferences(paperId, refs) {
    this.db.run('DELETE FROM refs WHERE paper_id = ?', [paperId]);

    if (!refs || refs.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO refs (paper_id, ref_bibcode, ref_title, ref_authors, ref_year)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const ref of refs) {
      if (ref.bibcode) {
        stmt.run([paperId, ref.bibcode, ref.title, ref.authors, ref.year]);
      }
    }
    stmt.free();
  }

  /**
   * Add citations for a paper
   * @param {number} paperId
   * @param {Array} citations
   */
  addCitations(paperId, citations) {
    this.db.run('DELETE FROM citations WHERE paper_id = ?', [paperId]);

    if (!citations || citations.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO citations (paper_id, citing_bibcode, citing_title, citing_authors, citing_year)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const cit of citations) {
      if (cit.bibcode) {
        stmt.run([paperId, cit.bibcode, cit.title, cit.authors, cit.year]);
      }
    }
    stmt.free();
  }

  /**
   * Get references for a paper
   * @param {number} paperId
   * @returns {Array}
   */
  getReferences(paperId) {
    const results = this.db.exec('SELECT * FROM refs WHERE paper_id = ?', [paperId]);
    if (results.length === 0) return [];

    const columns = results[0].columns;
    return results[0].values.map(row => {
      const obj = {};
      columns.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  /**
   * Get citations for a paper
   * @param {number} paperId
   * @returns {Array}
   */
  getCitations(paperId) {
    const results = this.db.exec('SELECT * FROM citations WHERE paper_id = ?', [paperId]);
    if (results.length === 0) return [];

    const columns = results[0].columns;
    return results[0].values.map(row => {
      const obj = {};
      columns.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANNOTATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get annotations for a paper
   * @param {number} paperId
   * @returns {import('../types.js').Annotation[]}
   */
  getAnnotations(paperId) {
    const stmt = this.db.prepare(`
      SELECT * FROM annotations WHERE paper_id = ? ORDER BY page_number, id
    `);
    stmt.bind([paperId]);

    const annotations = [];
    while (stmt.step()) {
      const obj = stmt.getAsObject();
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

  /**
   * Create annotation
   * @param {number} paperId
   * @param {Object} data
   * @returns {import('../types.js').Annotation}
   */
  createAnnotation(paperId, data) {
    const now = new Date().toISOString();

    this.db.run(`
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

    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0];

    // Return created annotation
    const stmt = this.db.prepare('SELECT * FROM annotations WHERE id = ?');
    stmt.bind([id]);
    if (stmt.step()) {
      const obj = stmt.getAsObject();
      if (obj.selection_rects) {
        try {
          obj.selection_rects = JSON.parse(obj.selection_rects);
        } catch (e) {
          obj.selection_rects = [];
        }
      }
      stmt.free();
      return obj;
    }
    stmt.free();
    return null;
  }

  /**
   * Update annotation
   * @param {number} id
   * @param {Object} data
   */
  updateAnnotation(id, data) {
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

    this.db.run(`UPDATE annotations SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  /**
   * Delete annotation
   * @param {number} id
   */
  deleteAnnotation(id) {
    this.db.run('DELETE FROM annotations WHERE id = ?', [id]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get library statistics
   * @returns {{total: number, unread: number, reading: number, read: number}}
   */
  getStats() {
    const totalResult = this.db.exec('SELECT COUNT(*) FROM papers');
    const total = totalResult[0]?.values[0][0] || 0;

    const unreadResult = this.db.exec("SELECT COUNT(*) FROM papers WHERE read_status = 'unread'");
    const unread = unreadResult[0]?.values[0][0] || 0;

    const readingResult = this.db.exec("SELECT COUNT(*) FROM papers WHERE read_status = 'reading'");
    const reading = readingResult[0]?.values[0][0] || 0;

    const readResult = this.db.exec("SELECT COUNT(*) FROM papers WHERE read_status = 'read'");
    const read = readResult[0]?.values[0][0] || 0;

    return { total, unread, reading, read };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Parse a paper row from the database
   * @private
   */
  _parsePaperRow(row) {
    return {
      ...row,
      authors: row.authors ? JSON.parse(row.authors) : [],
      keywords: row.keywords ? JSON.parse(row.keywords) : []
    };
  }
}
