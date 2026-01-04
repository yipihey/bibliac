/**
 * INSPIRE HEP Plugin
 *
 * Provides search, lookup, references, citations, and PDF download capabilities
 * for INSPIRE HEP (High Energy Physics Literature Database).
 *
 * API Documentation: https://github.com/inspirehep/rest-api-doc
 * Rate Limit: 15 requests per 5-second window
 */

'use strict';

const https = require('https');
const {
  createPaper,
  createDefaultCapabilities,
  createDefaultSearchCapabilities,
  PDF_SOURCE_TYPES
} = require('../../lib/plugins/types.cjs');

// =============================================================================
// Constants
// =============================================================================

const INSPIRE_API_BASE = 'https://inspirehep.net/api';
const INSPIRE_LITERATURE_ENDPOINT = '/literature';
const ARXIV_PDF_BASE = 'https://arxiv.org/pdf';

// Rate limiting: 15 requests per 5-second window
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const MIN_REQUEST_DELAY_MS = 333; // 5000/15 = 333ms minimum between requests

// =============================================================================
// HTTP Request Helper
// =============================================================================

/**
 * Make an HTTPS GET request and return JSON
 * @param {string} url - Full URL to fetch
 * @returns {Promise<Object>} Parsed JSON response
 */
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    console.log('[INSPIRE] HTTP GET:', url);

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Bibliac/1.0 (scientific bibliography manager)',
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        console.log('[INSPIRE] HTTP response status:', res.statusCode);

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (err) {
            console.error('[INSPIRE] JSON parse error:', err.message);
            reject(new Error(`Failed to parse INSPIRE response: ${err.message}`));
          }
        } else if (res.statusCode === 429) {
          console.error('[INSPIRE] Rate limited (429)');
          reject(new Error('INSPIRE API rate limit exceeded. Please wait a moment.'));
        } else {
          console.error('[INSPIRE] API error:', res.statusCode, data.slice(0, 200));
          reject(new Error(`INSPIRE API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error('[INSPIRE] Request error:', err.message);
      reject(err);
    });

    req.end();
  });
}

/**
 * Make an HTTPS GET request and return raw text (for BibTeX)
 * @param {string} url - Full URL to fetch
 * @returns {Promise<string>} Raw text response
 */
function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    console.log('[INSPIRE] HTTP GET (text):', url);

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Bibliac/1.0 (scientific bibliography manager)',
        'Accept': 'application/x-bibtex, text/plain'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        console.log('[INSPIRE] HTTP response status:', res.statusCode);

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`INSPIRE API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// =============================================================================
// Paper Transformation
// =============================================================================

/**
 * Transform INSPIRE API hit to unified Paper format
 * @param {Object} hit - INSPIRE API hit object
 * @returns {import('../../lib/plugins/types.cjs').Paper}
 */
function transformHitToPaper(hit) {
  const metadata = hit.metadata || {};
  const recid = hit.id || metadata.control_number;

  console.log('[INSPIRE] Transforming hit:', recid);

  // Extract title
  let title = 'Untitled';
  if (metadata.titles && metadata.titles.length > 0) {
    title = metadata.titles[0].title || 'Untitled';
  }

  // Extract authors
  let authors = [];
  if (metadata.authors && Array.isArray(metadata.authors)) {
    authors = metadata.authors.map(a => a.full_name || `${a.first_name || ''} ${a.last_name || ''}`.trim());
  }

  // Extract abstract
  let abstract = '';
  if (metadata.abstracts && metadata.abstracts.length > 0) {
    abstract = metadata.abstracts[0].value || '';
  }

  // Extract year from publication_info or preprint_date
  let year = null;
  if (metadata.publication_info && metadata.publication_info.length > 0) {
    year = metadata.publication_info[0].year;
  }
  if (!year && metadata.preprint_date) {
    year = parseInt(metadata.preprint_date.slice(0, 4), 10);
  }
  if (!year && metadata.earliest_date) {
    year = parseInt(metadata.earliest_date.slice(0, 4), 10);
  }

  // Extract journal
  let journal = '';
  if (metadata.publication_info && metadata.publication_info.length > 0) {
    const pubInfo = metadata.publication_info[0];
    journal = pubInfo.journal_title || pubInfo.pubinfo_freetext || '';
  }

  // Extract DOI
  let doi = null;
  if (metadata.dois && metadata.dois.length > 0) {
    doi = metadata.dois[0].value;
  }

  // Extract arXiv ID
  let arxivId = null;
  if (metadata.arxiv_eprints && metadata.arxiv_eprints.length > 0) {
    arxivId = metadata.arxiv_eprints[0].value;
  }

  // Extract citation count
  const citationCount = metadata.citation_count || 0;

  // Extract keywords
  let keywords = [];
  if (metadata.keywords && Array.isArray(metadata.keywords)) {
    keywords = metadata.keywords.map(k => k.value).filter(Boolean);
  }

  // Extract INSPIRE texkeys for BibTeX citation key
  let texkey = null;
  if (metadata.texkeys && metadata.texkeys.length > 0) {
    texkey = metadata.texkeys[0];
  }

  return createPaper({
    title,
    authors,
    abstract,
    year,
    journal,
    doi,
    arxivId,
    citationCount,
    keywords,
    // INSPIRE-specific metadata
    _inspire: {
      recid,
      texkey,
      controlNumber: metadata.control_number,
      documentType: metadata.document_type,
      publicationInfo: metadata.publication_info,
      collaborations: metadata.collaborations
    }
  }, 'inspire', String(recid));
}

// =============================================================================
// Query Translation
// =============================================================================

/**
 * Translate UnifiedQuery to INSPIRE query string
 * @param {import('../../lib/plugins/types.cjs').UnifiedQuery} query
 * @returns {string}
 */
function translateQuery(query) {
  // Raw query passed directly
  if (query.raw) {
    return query.raw;
  }

  const parts = [];

  // Author search
  if (query.author) {
    parts.push(`a ${query.author}`);
  }

  // Title search
  if (query.title) {
    parts.push(`t "${query.title}"`);
  }

  // Abstract search
  if (query.abstract) {
    parts.push(`ab ${query.abstract}`);
  }

  // Year search
  if (query.year) {
    if (Array.isArray(query.year)) {
      parts.push(`date ${query.year[0]}->${query.year[1]}`);
    } else {
      parts.push(`date ${query.year}`);
    }
  }

  // DOI search
  if (query.doi) {
    parts.push(`doi ${query.doi}`);
  }

  // arXiv ID search
  if (query.arxivId) {
    parts.push(`eprint ${query.arxivId}`);
  }

  // Full text search (use "find" for general search)
  if (query.fullText) {
    parts.push(query.fullText);
  }

  return parts.join(' and ');
}

/**
 * Map sort option to INSPIRE sort parameter
 * @param {'date'|'citations'|'relevance'} sort
 * @returns {string}
 */
function mapSortBy(sort) {
  switch (sort) {
    case 'date':
      return 'mostrecent';
    case 'citations':
      return 'mostcited';
    case 'relevance':
    default:
      return 'bestmatch';
  }
}

// =============================================================================
// INSPIRE Plugin
// =============================================================================

/** @type {number[]} Track request times for rate limiting */
let requestTimes = [];

/**
 * Wait for rate limit if necessary
 * @returns {Promise<void>}
 */
async function waitForRateLimit() {
  const now = Date.now();

  // Clean up old request times (older than 5 seconds)
  requestTimes = requestTimes.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

  console.log('[INSPIRE] Rate limit status:', requestTimes.length, '/', RATE_LIMIT_MAX_REQUESTS, 'in window');

  if (requestTimes.length >= RATE_LIMIT_MAX_REQUESTS) {
    // Calculate wait time until oldest request falls out of window
    const waitTime = RATE_LIMIT_WINDOW_MS - (now - requestTimes[0]) + 50;
    console.log('[INSPIRE] Rate limit: waiting', waitTime, 'ms');
    await new Promise(resolve => setTimeout(resolve, waitTime));
    // Clean up again after waiting
    requestTimes = requestTimes.filter(t => Date.now() - t < RATE_LIMIT_WINDOW_MS);
  }

  // Record this request
  requestTimes.push(Date.now());
}

/**
 * @type {import('../../lib/plugins/types.cjs').SourcePlugin}
 */
const inspirePlugin = {
  id: 'inspire',
  name: 'INSPIRE HEP',
  icon: '\uD83D\uDD2C', // microscope emoji
  description: 'High Energy Physics literature database',
  homepage: 'https://inspirehep.net',

  capabilities: {
    ...createDefaultCapabilities(),
    search: true,
    lookup: true,
    references: true,   // INSPIRE provides curated references
    citations: true,    // INSPIRE provides citation data
    pdfDownload: true,  // Via arXiv links
    bibtex: true,
    metadata: true,
    priority: 20  // Middle priority - has refs/cites, good for HEP
  },

  searchCapabilities: {
    ...createDefaultSearchCapabilities(),
    supportsFullText: false,  // Searches metadata only
    supportsReferences: true,
    supportsCitations: true,
    supportsDateRange: true,
    supportsBooleanOperators: true,
    supportsFieldSearch: true,
    maxResults: 1000,
    queryLanguage: 'inspire',
    sortOptions: ['date', 'citations', 'relevance']
  },

  // Search UI configuration
  searchConfig: {
    title: 'Search INSPIRE HEP',
    placeholder: 'e.g., a witten t "string theory" date 2020',
    nlPlaceholder: 'e.g., papers by Witten about supersymmetry...',
    shortcuts: [
      { label: 'a (author)', insert: 'a ' },
      { label: 't (title)', insert: 't ' },
      { label: 'ab (abstract)', insert: 'ab ' },
      { label: 'date', insert: 'date ' },
      { label: 'eprint', insert: 'eprint ' },
      { label: 'topcite', insert: 'topcite ' }
    ],
    exampleSearches: [
      { label: 'Witten string theory', query: 'a witten and t "string theory"' },
      { label: 'Recent supersymmetry', query: 'ab supersymmetry and date 2023' },
      { label: 'Highly cited HEP', query: 'topcite 1000+ and date 2020->' },
      { label: 'LHC Higgs papers', query: 't higgs and j "JHEP"' }
    ]
  },

  // Query templates for refs/cites
  queryTemplates: {
    references: 'citedby:recid:{id}',
    citations: 'refersto:recid:{id}'
  },

  // Natural language translation prompt
  nlPrompt: `You translate a user's natural-language request about scholarly literature into one INSPIRE HEP search query string.

INSPIRE Query Syntax:
- Author: a <surname> or au <surname>
- Title words: t "<phrase>" or ti "<phrase>"
- Abstract: ab <terms>
- arXiv ID: eprint <id>
- DOI: doi <value>
- Journal: j "<abbreviated name>"
- Year: date <year> or date <start>-><end>
- Citations: topcite <N>+ (at least N citations)
- Combine with: and, or, not

Examples:
- "papers by Witten on string theory" → a witten and t "string theory"
- "supersymmetry papers from 2023 with 100+ citations" → ab supersymmetry and date 2023 and topcite 100+
- "ATLAS collaboration Higgs papers" → a ATLAS and t higgs

Return ONLY the query string, no explanation.`,

  auth: {
    type: 'none',
    description: 'INSPIRE API is open access, no authentication required'
  },

  // ===========================================================================
  // Authentication (not required for INSPIRE)
  // ===========================================================================

  async validateAuth() {
    // INSPIRE doesn't require authentication
    return true;
  },

  getRateLimitStatus() {
    const now = Date.now();
    const activeRequests = requestTimes.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - activeRequests.length);

    return {
      remaining,
      limit: RATE_LIMIT_MAX_REQUESTS,
      resetAt: activeRequests.length > 0 ? activeRequests[0] + RATE_LIMIT_WINDOW_MS : now,
      retryAfter: remaining > 0 ? 0 : Math.ceil((RATE_LIMIT_WINDOW_MS - (now - activeRequests[0])) / 1000)
    };
  },

  // ===========================================================================
  // Search
  // ===========================================================================

  /**
   * Search INSPIRE for papers
   * @param {import('../../lib/plugins/types.cjs').UnifiedQuery} query
   * @returns {Promise<import('../../lib/plugins/types.cjs').SearchResult>}
   */
  async search(query) {
    console.log('[INSPIRE] search() called with:', JSON.stringify(query));

    // Build query string
    const searchQuery = translateQuery(query);
    if (!searchQuery && !query.raw) {
      console.log('[INSPIRE] Empty query, returning no results');
      return { papers: [], totalResults: 0 };
    }

    // Build URL parameters
    const params = new URLSearchParams();
    params.set('q', query.raw || searchQuery);
    params.set('size', String(query.limit || 25));
    params.set('page', String(Math.floor((query.offset || 0) / (query.limit || 25)) + 1));

    // Add sorting
    if (query.sort) {
      params.set('sort', mapSortBy(query.sort));
    }

    const url = `${INSPIRE_API_BASE}${INSPIRE_LITERATURE_ENDPOINT}?${params.toString()}`;
    console.log('[INSPIRE] Search URL:', url);

    // Rate limiting
    await waitForRateLimit();

    // Make request
    const response = await httpsGetJson(url);

    // Parse results
    const hits = response.hits || {};
    const total = hits.total || 0;
    const papers = (hits.hits || []).map(transformHitToPaper);

    console.log('[INSPIRE] Found', total, 'total results, returned', papers.length, 'papers');

    return {
      papers,
      totalResults: total,
      metadata: {
        query: query.raw || searchQuery,
        page: Math.floor((query.offset || 0) / (query.limit || 25)) + 1,
        size: query.limit || 25
      }
    };
  },

  translateQuery,

  // ===========================================================================
  // Record Lookup
  // ===========================================================================

  /**
   * Get a single paper by INSPIRE record ID
   * @param {string} recid - INSPIRE record ID
   * @returns {Promise<import('../../lib/plugins/types.cjs').Paper|null>}
   */
  async getRecord(recid) {
    console.log('[INSPIRE] getRecord() for recid:', recid);

    const url = `${INSPIRE_API_BASE}${INSPIRE_LITERATURE_ENDPOINT}/${recid}`;

    await waitForRateLimit();

    try {
      const response = await httpsGetJson(url);
      if (response && response.metadata) {
        return transformHitToPaper({ id: recid, metadata: response.metadata });
      }
      return null;
    } catch (err) {
      console.error('[INSPIRE] getRecord error:', err.message);
      return null;
    }
  },

  /**
   * Lookup by arXiv ID
   * @param {string} arxivId
   * @returns {Promise<import('../../lib/plugins/types.cjs').Paper|null>}
   */
  async getByArxiv(arxivId) {
    console.log('[INSPIRE] getByArxiv():', arxivId);
    const result = await this.search({ raw: `eprint ${arxivId}` });
    return result.papers[0] || null;
  },

  /**
   * Lookup by DOI
   * @param {string} doi
   * @returns {Promise<import('../../lib/plugins/types.cjs').Paper|null>}
   */
  async getByDOI(doi) {
    console.log('[INSPIRE] getByDOI():', doi);
    const result = await this.search({ raw: `doi ${doi}` });
    return result.papers[0] || null;
  },

  // ===========================================================================
  // References & Citations
  // ===========================================================================

  /**
   * Get references (papers this paper cites)
   * @param {string} recid - INSPIRE record ID
   * @param {Object} options
   * @param {number} [options.limit=200]
   * @returns {Promise<import('../../lib/plugins/types.cjs').Paper[]>}
   */
  async getReferences(recid, options = {}) {
    console.log('[INSPIRE] getReferences() for recid:', recid);

    // First get the record to extract reference recids
    const url = `${INSPIRE_API_BASE}${INSPIRE_LITERATURE_ENDPOINT}/${recid}`;

    await waitForRateLimit();

    const response = await httpsGetJson(url);
    const metadata = response.metadata || {};
    const references = metadata.references || [];

    console.log('[INSPIRE] Found', references.length, 'references in metadata');

    // Extract recids from references
    const refRecids = [];
    for (const ref of references) {
      if (ref.record && ref.record.$ref) {
        // Extract recid from URL like https://inspirehep.net/api/literature/123456
        const match = ref.record.$ref.match(/\/literature\/(\d+)$/);
        if (match) {
          refRecids.push(match[1]);
        }
      }
    }

    console.log('[INSPIRE] Extracted', refRecids.length, 'reference recids');

    if (refRecids.length === 0) {
      return [];
    }

    // Batch fetch referenced papers
    // Use recid search to get multiple records
    const limit = options.limit || 200;
    const recidsToFetch = refRecids.slice(0, limit);
    const query = recidsToFetch.map(id => `recid:${id}`).join(' or ');

    const result = await this.search({ raw: query, limit });

    console.log('[INSPIRE] Fetched', result.papers.length, 'reference papers');

    return result.papers;
  },

  /**
   * Get citations (papers that cite this paper)
   * @param {string} recid - INSPIRE record ID
   * @param {Object} options
   * @param {number} [options.limit=200]
   * @returns {Promise<import('../../lib/plugins/types.cjs').Paper[]>}
   */
  async getCitations(recid, options = {}) {
    console.log('[INSPIRE] getCitations() for recid:', recid);

    // Search for papers that reference this record
    const limit = options.limit || 200;
    const query = `refersto:recid:${recid}`;

    const result = await this.search({ raw: query, limit, sort: 'citations' });

    console.log('[INSPIRE] Found', result.papers.length, 'citing papers');

    return result.papers;
  },

  // ===========================================================================
  // PDF Sources
  // ===========================================================================

  /**
   * Get PDF download sources for a paper
   * @param {string} recidOrPaper - INSPIRE record ID or paper object
   * @returns {Promise<import('../../lib/plugins/types.cjs').PdfSource[]>}
   */
  async getPdfSources(recidOrPaper) {
    let arxivId = null;
    let recid = recidOrPaper;

    // If it's a paper object, extract arXiv ID
    if (typeof recidOrPaper === 'object') {
      arxivId = recidOrPaper.arxivId;
      recid = recidOrPaper._inspire?.recid || recidOrPaper.sourceId;
    }

    console.log('[INSPIRE] getPdfSources() recid:', recid, 'arxivId:', arxivId);

    // If we don't have arXiv ID, fetch the record
    if (!arxivId && recid) {
      const paper = await this.getRecord(recid);
      if (paper) {
        arxivId = paper.arxivId;
      }
    }

    const sources = [];

    // arXiv PDF source
    if (arxivId) {
      // Normalize arXiv ID (remove version suffix and arXiv: prefix)
      const normalizedId = arxivId.replace(/^arXiv:/i, '').replace(/v\d+$/, '');
      sources.push({
        type: PDF_SOURCE_TYPES.ARXIV,
        url: `${ARXIV_PDF_BASE}/${normalizedId}.pdf`,
        label: 'arXiv PDF',
        requiresAuth: false,
        priority: 1
      });
      console.log('[INSPIRE] Added arXiv PDF source:', normalizedId);
    }

    return sources;
  },

  /**
   * Download PDF from source (placeholder - handled by app)
   * @param {import('../../lib/plugins/types.cjs').PdfSource} source
   * @param {Object} options
   * @returns {Promise<Buffer>}
   */
  async downloadPdf(source, options = {}) {
    // PDF download is handled by the main app's pdf-download module
    throw new Error('PDF download should be handled by the application pdf-download module');
  },

  // ===========================================================================
  // BibTeX
  // ===========================================================================

  /**
   * Get BibTeX for a single paper
   * @param {string} recid - INSPIRE record ID
   * @returns {Promise<string>}
   */
  async getBibtex(recid) {
    console.log('[INSPIRE] getBibtex() for recid:', recid);

    const url = `${INSPIRE_API_BASE}${INSPIRE_LITERATURE_ENDPOINT}/${recid}?format=bibtex`;

    await waitForRateLimit();

    const bibtex = await httpsGetText(url);
    console.log('[INSPIRE] Got BibTeX, length:', bibtex.length);

    return bibtex;
  },

  /**
   * Get BibTeX for multiple papers
   * @param {string[]} recids - INSPIRE record IDs
   * @returns {Promise<Map<string, string>>}
   */
  async getBibtexBatch(recids) {
    console.log('[INSPIRE] getBibtexBatch() for', recids.length, 'records');

    const results = new Map();

    for (const recid of recids) {
      try {
        const bibtex = await this.getBibtex(recid);
        results.set(recid, bibtex);
      } catch (err) {
        console.error('[INSPIRE] getBibtex error for', recid, ':', err.message);
        results.set(recid, `% Error: ${err.message}`);
      }
    }

    return results;
  },

  // ===========================================================================
  // Web URL
  // ===========================================================================

  /**
   * Get URL to view paper on INSPIRE website
   * @param {Object} paper - Paper object with _inspire.recid or sourceId
   * @returns {string} URL to INSPIRE abstract page
   */
  getRecordUrl(paper) {
    const recid = paper._inspire?.recid || paper.sourceId || paper.inspire_recid;
    if (!recid) return null;
    return `https://inspirehep.net/literature/${recid}`;
  }
};

// =============================================================================
// Module Exports
// =============================================================================

module.exports = inspirePlugin;
