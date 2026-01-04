/**
 * arXiv Plugin
 *
 * Provides search, lookup, and PDF download capabilities for arXiv.org.
 * arXiv is an open-access repository for scientific preprints in physics,
 * mathematics, computer science, and related fields.
 *
 * API Documentation: https://info.arxiv.org/help/api/index.html
 */

'use strict';

const http = require('http');
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

const ARXIV_API_HOST = 'export.arxiv.org';
const ARXIV_API_PATH = '/api/query';
const ARXIV_PDF_BASE = 'https://arxiv.org/pdf';

// Recommended delay between requests (arXiv recommends 3 seconds)
const MIN_REQUEST_DELAY_MS = 3000;

// =============================================================================
// XML Parsing Helpers
// =============================================================================

/**
 * Extract text content from an XML tag
 * @param {string} xml - XML string
 * @param {string} tag - Tag name to extract
 * @param {boolean} [all=false] - Return all matches (default: first only)
 * @returns {string|string[]|null}
 */
function extractTag(xml, tag, all = false) {
  // Handle namespaced tags like arxiv:doi
  const escapedTag = tag.replace(':', '\\:');
  const regex = new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, 'g');

  if (all) {
    const matches = [];
    let match;
    while ((match = regex.exec(xml)) !== null) {
      matches.push(decodeXmlEntities(match[1].trim()));
    }
    return matches;
  } else {
    const match = regex.exec(xml);
    return match ? decodeXmlEntities(match[1].trim()) : null;
  }
}

/**
 * Extract attribute value from an XML tag
 * @param {string} xml - XML string
 * @param {string} tag - Tag name
 * @param {string} attr - Attribute name
 * @returns {string|null}
 */
function extractAttribute(xml, tag, attr) {
  const escapedTag = tag.replace(':', '\\:');
  const regex = new RegExp(`<${escapedTag}[^>]*\\s${attr}="([^"]*)"[^>]*>`);
  const match = regex.exec(xml);
  return match ? decodeXmlEntities(match[1]) : null;
}

/**
 * Extract all entries from an Atom feed
 * @param {string} xml - Atom XML feed
 * @returns {string[]} Array of entry XML strings
 */
function extractEntries(xml) {
  const entries = [];
  const regex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    entries.push(match[1]);
  }
  return entries;
}

/**
 * Decode common XML entities
 * @param {string} str - String with XML entities
 * @returns {string}
 */
function decodeXmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

/**
 * Extract authors from an Atom entry
 * @param {string} entryXml - Entry XML
 * @returns {string[]}
 */
function extractAuthors(entryXml) {
  const authors = [];
  const authorRegex = /<author>\s*<name>([^<]*)<\/name>/g;
  let match;
  while ((match = authorRegex.exec(entryXml)) !== null) {
    authors.push(decodeXmlEntities(match[1].trim()));
  }
  return authors;
}

/**
 * Extract categories from an Atom entry
 * @param {string} entryXml - Entry XML
 * @returns {string[]}
 */
function extractCategories(entryXml) {
  const categories = [];
  const catRegex = /<category[^>]*term="([^"]*)"[^>]*\/>/g;
  let match;
  while ((match = catRegex.exec(entryXml)) !== null) {
    categories.push(match[1]);
  }
  return categories;
}

/**
 * Extract arXiv ID from the entry ID URL
 * @param {string} idUrl - ID URL like http://arxiv.org/abs/2401.12345v1
 * @returns {string} arXiv ID like 2401.12345v1
 */
function extractArxivIdFromUrl(idUrl) {
  if (!idUrl) return '';
  // Handle both new-style (2401.12345) and old-style (hep-th/9901001) IDs
  const match = idUrl.match(/arxiv\.org\/abs\/(.+)$/);
  return match ? match[1] : idUrl;
}

/**
 * Normalize arXiv ID (remove version suffix for consistent lookups)
 * @param {string} arxivId - arXiv ID possibly with version
 * @returns {string} Base arXiv ID without version
 */
function normalizeArxivId(arxivId) {
  if (!arxivId) return '';
  // Remove arXiv: prefix if present
  let id = arxivId.replace(/^arXiv:/i, '').trim();
  // Remove version suffix (v1, v2, etc.) for base ID
  return id.replace(/v\d+$/, '');
}

/**
 * Get the full arXiv ID with version from entry
 * @param {string} entryXml - Entry XML
 * @returns {string}
 */
function getFullArxivId(entryXml) {
  const idUrl = extractTag(entryXml, 'id');
  return extractArxivIdFromUrl(idUrl);
}

// =============================================================================
// HTTP Request Helper
// =============================================================================

/**
 * Make an HTTP GET request with redirect support
 * @param {string} url - Full URL to fetch
 * @param {number} [maxRedirects=5] - Maximum redirects to follow
 * @returns {Promise<string>} Response body
 */
function httpGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Bibliac/1.0 (scientific bibliography manager)'
      }
    };

    const req = client.request(options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        // Resolve relative URLs
        const redirectUrl = new URL(res.headers.location, url).href;
        httpGet(redirectUrl, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`arXiv API error: ${res.statusCode} - ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// =============================================================================
// Paper Parsing
// =============================================================================

/**
 * Parse an Atom entry into a Paper object
 * @param {string} entryXml - Entry XML string
 * @returns {import('../../lib/plugins/types.cjs').Paper}
 */
function parseEntry(entryXml) {
  const arxivId = getFullArxivId(entryXml);
  const baseId = normalizeArxivId(arxivId);

  // Extract title (may have newlines that need cleaning)
  let title = extractTag(entryXml, 'title') || 'Untitled';
  title = title.replace(/\s+/g, ' ').trim();

  // Extract abstract/summary
  let abstract = extractTag(entryXml, 'summary') || '';
  abstract = abstract.replace(/\s+/g, ' ').trim();

  // Extract published date and year
  const published = extractTag(entryXml, 'published');
  const year = published ? parseInt(published.slice(0, 4), 10) : null;

  // Extract DOI if available
  const doi = extractTag(entryXml, 'arxiv:doi');

  // Extract journal reference if available
  const journal = extractTag(entryXml, 'arxiv:journal_ref');

  // Extract primary category
  const primaryCategory = extractAttribute(entryXml, 'arxiv:primary_category', 'term');

  // Extract all categories as keywords
  const categories = extractCategories(entryXml);

  // Extract comment (may contain page count, figures, etc.)
  const comment = extractTag(entryXml, 'arxiv:comment');

  return createPaper({
    arxivId: baseId,
    doi: doi || undefined,
    title,
    authors: extractAuthors(entryXml),
    year,
    journal: journal || undefined,
    abstract,
    keywords: categories,
    // Additional arXiv-specific metadata
    _arxiv: {
      fullId: arxivId,
      primaryCategory,
      comment,
      published,
      updated: extractTag(entryXml, 'updated')
    }
  }, 'arxiv', baseId);
}

/**
 * Parse total results from feed
 * @param {string} xml - Full Atom feed XML
 * @returns {number}
 */
function parseTotalResults(xml) {
  const total = extractTag(xml, 'opensearch:totalResults');
  return total ? parseInt(total, 10) : 0;
}

// =============================================================================
// Query Translation
// =============================================================================

/**
 * Translate UnifiedQuery to arXiv query string
 * @param {import('../../lib/plugins/types.cjs').UnifiedQuery} query
 * @returns {string}
 */
function translateQuery(query) {
  const parts = [];

  // Raw query passed directly
  if (query.raw) {
    return query.raw;
  }

  // Title search
  if (query.title) {
    parts.push(`ti:${escapeQueryTerm(query.title)}`);
  }

  // Author search
  if (query.author) {
    parts.push(`au:${escapeQueryTerm(query.author)}`);
  }

  // Abstract search
  if (query.abstract) {
    parts.push(`abs:${escapeQueryTerm(query.abstract)}`);
  }

  // Full-text/all fields search
  if (query.fullText) {
    parts.push(`all:${escapeQueryTerm(query.fullText)}`);
  }

  // arXiv ID lookup
  if (query.arxivId) {
    const normalized = normalizeArxivId(query.arxivId);
    // Use id_list for exact ID lookup (handled separately in search)
    return `id:${normalized}`;
  }

  // Keywords (search in categories)
  if (query.keywords && query.keywords.length > 0) {
    const catQueries = query.keywords.map(k => `cat:${escapeQueryTerm(k)}`);
    parts.push(`(${catQueries.join(' OR ')})`);
  }

  // If no specific fields, use 'all' for any text
  if (parts.length === 0 && query.fullText) {
    parts.push(`all:${escapeQueryTerm(query.fullText)}`);
  }

  return parts.join(' AND ');
}

/**
 * Escape special characters in query terms
 * @param {string} term
 * @returns {string}
 */
function escapeQueryTerm(term) {
  // Wrap multi-word terms in quotes
  if (term.includes(' ')) {
    // Escape quotes within the term
    return `"${term.replace(/"/g, '\\"')}"`;
  }
  return term;
}

/**
 * Map sort option to arXiv sortBy parameter
 * @param {'date'|'citations'|'relevance'} sort
 * @returns {string}
 */
function mapSortBy(sort) {
  switch (sort) {
    case 'date':
      return 'submittedDate';
    case 'relevance':
      return 'relevance';
    case 'citations':
      // arXiv doesn't support citation sorting, fall back to relevance
      return 'relevance';
    default:
      return 'relevance';
  }
}

/**
 * Map sort direction
 * @param {'asc'|'desc'} direction
 * @returns {string}
 */
function mapSortOrder(direction) {
  return direction === 'asc' ? 'ascending' : 'descending';
}

// =============================================================================
// arXiv Plugin
// =============================================================================

/** @type {number} Track last request time for rate limiting */
let lastRequestTime = 0;

/**
 * @type {import('../../lib/plugins/types.cjs').SourcePlugin}
 */
const arxivPlugin = {
  id: 'arxiv',
  name: 'arXiv',
  icon: '\uD83D\uDCDC', // scroll emoji
  description: 'Open access repository for scientific preprints',
  homepage: 'https://arxiv.org',

  capabilities: {
    ...createDefaultCapabilities(),
    search: true,
    lookup: true,
    references: false,  // arXiv doesn't provide reference data
    citations: false,   // arXiv doesn't provide citation data
    pdfDownload: true,
    bibtex: true,
    metadata: true,
    priority: 30  // Lower priority - no refs/cites, use ADS/INSPIRE when available
  },

  searchCapabilities: {
    ...createDefaultSearchCapabilities(),
    supportsFullText: false,  // arXiv only searches metadata
    supportsReferences: false,
    supportsCitations: false,
    supportsDateRange: false, // Date filtering is limited
    supportsBooleanOperators: true,
    supportsFieldSearch: true,
    maxResults: 2000,  // arXiv has a 2000 result limit per query
    queryLanguage: 'arxiv',
    sortOptions: ['date', 'relevance']
  },

  // Search UI configuration
  searchConfig: {
    title: 'Search arXiv',
    placeholder: 'e.g., au:smith ti:galaxy cat:astro-ph.GA',
    nlPlaceholder: 'e.g., papers by Smith about galaxies...',
    shortcuts: [
      { label: 'au:', insert: 'au:' },
      { label: 'ti:', insert: 'ti:' },
      { label: 'abs:', insert: 'abs:' },
      { label: 'cat:', insert: 'cat:' },
      { label: 'all:', insert: 'all:' }
    ],
    exampleSearches: [
      { label: 'Recent astro-ph', query: 'cat:astro-ph' },
      { label: 'Galaxy evolution', query: 'ti:galaxy AND abs:evolution' },
      { label: 'Machine learning papers', query: 'cat:cs.LG' },
      { label: 'Quantum computing', query: 'all:"quantum computing"' }
    ]
  },

  // Query templates (arXiv doesn't support refs/cites)
  queryTemplates: {
    references: null,
    citations: null
  },

  // Natural language translation prompt
  nlPrompt: `You translate a user's natural-language request into one arXiv search query string.

arXiv Query Syntax:
- Author: au:surname
- Title words: ti:"phrase" or ti:word
- Abstract: abs:"terms"
- Category: cat:astro-ph.GA (see arXiv category taxonomy)
- All fields: all:"phrase"
- Combine with: AND, OR, ANDNOT

Common categories:
- astro-ph (Astrophysics), hep-th (High Energy Physics - Theory)
- gr-qc (General Relativity), cs.LG (Machine Learning)
- quant-ph (Quantum Physics), math.CO (Combinatorics)

Examples:
- "papers by Witten on string theory" → au:witten AND ti:"string theory"
- "galaxy formation in astro-ph" → abs:"galaxy formation" AND cat:astro-ph
- "quantum computing papers" → all:"quantum computing"

Return ONLY the query string, no explanation.`,

  auth: {
    type: 'none',
    description: 'arXiv API is open access, no authentication required'
  },

  /**
   * Get URL to view paper on arXiv website
   * @param {Object} paper - Paper object with arxivId
   * @returns {string} URL to arXiv abstract page
   */
  getRecordUrl(paper) {
    const arxivId = paper.arxivId || paper.sourceId || paper._arxiv?.fullId;
    if (!arxivId) return null;
    const normalized = normalizeArxivId(arxivId);
    return `https://arxiv.org/abs/${normalized}`;
  },

  // ===========================================================================
  // Authentication (not required for arXiv)
  // ===========================================================================

  async validateAuth() {
    // arXiv doesn't require authentication
    return true;
  },

  getRateLimitStatus() {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    const canRequest = elapsed >= MIN_REQUEST_DELAY_MS;

    return {
      remaining: canRequest ? 1 : 0,
      limit: 1,  // One request per 3 seconds
      resetAt: lastRequestTime + MIN_REQUEST_DELAY_MS,
      retryAfter: canRequest ? 0 : Math.ceil((MIN_REQUEST_DELAY_MS - elapsed) / 1000)
    };
  },

  // ===========================================================================
  // Search
  // ===========================================================================

  /**
   * Search arXiv for papers
   * @param {import('../../lib/plugins/types.cjs').UnifiedQuery} query
   * @returns {Promise<import('../../lib/plugins/types.cjs').SearchResult>}
   */
  async search(query) {
    // Build query parameters
    const params = new URLSearchParams();

    // Handle arXiv ID lookup specially with id_list
    if (query.arxivId) {
      const normalized = normalizeArxivId(query.arxivId);
      params.set('id_list', normalized);
    } else {
      const searchQuery = translateQuery(query);
      if (!searchQuery) {
        return { papers: [], totalResults: 0 };
      }
      params.set('search_query', searchQuery);
    }

    // Pagination
    const start = query.offset || 0;
    const maxResults = query.limit || 25;
    params.set('start', start.toString());
    params.set('max_results', maxResults.toString());

    // Sorting
    if (query.sort && query.sort !== 'relevance') {
      params.set('sortBy', mapSortBy(query.sort));
      params.set('sortOrder', mapSortOrder(query.sortDirection || 'desc'));
    }

    // Build URL
    const url = `http://${ARXIV_API_HOST}${ARXIV_API_PATH}?${params.toString()}`;

    // Enforce rate limiting
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_DELAY_MS) {
      await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_DELAY_MS - elapsed));
    }
    lastRequestTime = Date.now();

    // Make request
    console.log(`[arXiv] Searching: ${url}`);
    const xml = await httpGet(url);

    // Parse results
    const entries = extractEntries(xml);
    const papers = entries.map(parseEntry);
    const totalResults = parseTotalResults(xml);

    console.log(`[arXiv] Found ${totalResults} total, returned ${papers.length}`);

    return {
      papers,
      totalResults,
      metadata: {
        start,
        maxResults,
        query: query.arxivId ? `id:${query.arxivId}` : translateQuery(query)
      }
    };
  },

  translateQuery,

  // ===========================================================================
  // Record Lookup
  // ===========================================================================

  /**
   * Get a single paper by arXiv ID
   * @param {string} arxivId
   * @returns {Promise<import('../../lib/plugins/types.cjs').Paper|null>}
   */
  async getRecord(arxivId) {
    const result = await this.search({ arxivId });
    return result.papers[0] || null;
  },

  /**
   * Lookup by arXiv ID (alias for getRecord)
   * @param {string} arxivId
   * @returns {Promise<import('../../lib/plugins/types.cjs').Paper|null>}
   */
  async getByArxiv(arxivId) {
    return this.getRecord(arxivId);
  },

  /**
   * Lookup by DOI (search for papers with matching DOI)
   * @param {string} doi
   * @returns {Promise<import('../../lib/plugins/types.cjs').Paper|null>}
   */
  async getByDOI(doi) {
    // arXiv doesn't support DOI search directly in API
    // We would need to search and filter, but this is unreliable
    // Return null and let other plugins handle DOI lookups
    console.log(`[arXiv] DOI lookup not supported: ${doi}`);
    return null;
  },

  // ===========================================================================
  // PDF Sources
  // ===========================================================================

  /**
   * Get PDF download sources for a paper
   * @param {string} arxivId
   * @returns {Promise<import('../../lib/plugins/types.cjs').PdfSource[]>}
   */
  async getPdfSources(arxivId) {
    const normalized = normalizeArxivId(arxivId);

    return [{
      type: PDF_SOURCE_TYPES.ARXIV,
      url: `${ARXIV_PDF_BASE}/${normalized}.pdf`,
      label: 'arXiv PDF',
      requiresAuth: false,
      priority: 1  // arXiv PDFs are usually high priority (free, reliable)
    }];
  },

  /**
   * Download PDF from source
   * @param {import('../../lib/plugins/types.cjs').PdfSource} source
   * @param {Object} options - Download options (e.g., timeout)
   * @returns {Promise<Buffer>}
   */
  async downloadPdf(source, options = {}) {
    const url = source.url;

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;

      const reqOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Bibliac/1.0 (scientific bibliography manager)'
        }
      };

      const req = client.request(reqOptions, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          this.downloadPdf({ ...source, url: res.headers.location }, options)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download PDF: ${res.statusCode}`));
          return;
        }

        const chunks = [];

        res.on('data', chunk => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          resolve(Buffer.concat(chunks));
        });

        res.on('error', reject);
      });

      req.on('error', reject);

      if (options.timeout) {
        req.setTimeout(options.timeout, () => {
          req.destroy();
          reject(new Error('Download timeout'));
        });
      }

      req.end();
    });
  },

  // ===========================================================================
  // BibTeX Generation
  // ===========================================================================

  /**
   * Generate BibTeX entry for a paper
   * @param {string} arxivId
   * @returns {Promise<string>}
   */
  async getBibtex(arxivId) {
    const paper = await this.getRecord(arxivId);
    if (!paper) {
      throw new Error(`Paper not found: ${arxivId}`);
    }

    return generateBibtex(paper);
  },

  /**
   * Generate BibTeX for multiple papers
   * @param {string[]} arxivIds
   * @returns {Promise<Map<string, string>>}
   */
  async getBibtexBatch(arxivIds) {
    const results = new Map();

    for (const id of arxivIds) {
      try {
        // Respect rate limiting
        const status = this.getRateLimitStatus();
        if (status.retryAfter > 0) {
          await new Promise(resolve => setTimeout(resolve, status.retryAfter * 1000));
        }

        const bibtex = await this.getBibtex(id);
        results.set(id, bibtex);
      } catch (err) {
        console.error(`[arXiv] Failed to get BibTeX for ${id}:`, err.message);
        results.set(id, `% Error: ${err.message}`);
      }
    }

    return results;
  }
};

// =============================================================================
// BibTeX Generation Helper
// =============================================================================

/**
 * Generate BibTeX entry from paper metadata
 * @param {import('../../lib/plugins/types.cjs').Paper} paper
 * @returns {string}
 */
function generateBibtex(paper) {
  const arxivId = paper.arxivId || paper.sourceId;

  // Create citation key: FirstAuthorYear
  const firstAuthor = paper.authors[0] || 'Unknown';
  const lastName = firstAuthor.split(' ').pop().replace(/[^a-zA-Z]/g, '');
  const year = paper.year || 'XXXX';
  const citeKey = `${lastName}${year}`;

  // Escape special LaTeX characters
  const escape = (str) => {
    if (!str) return '';
    return str
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/[&%$#_{}]/g, '\\$&')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}');
  };

  // Format author list for BibTeX
  const formatAuthors = (authors) => {
    return authors.map(a => {
      // Try to convert "First Last" to "Last, First"
      const parts = a.trim().split(/\s+/);
      if (parts.length >= 2) {
        const last = parts.pop();
        return `${escape(last)}, ${escape(parts.join(' '))}`;
      }
      return escape(a);
    }).join(' and ');
  };

  // Build entry
  const lines = [
    `@article{${citeKey},`,
    `  author = {${formatAuthors(paper.authors)}},`,
    `  title = {${escape(paper.title)}},`,
    `  year = {${year}},`,
    `  eprint = {${arxivId}},`,
    `  archivePrefix = {arXiv},`
  ];

  // Add primary category if available
  if (paper._arxiv?.primaryCategory) {
    lines.push(`  primaryClass = {${paper._arxiv.primaryCategory}},`);
  }

  // Add DOI if available
  if (paper.doi) {
    lines.push(`  doi = {${paper.doi}},`);
  }

  // Add journal if available
  if (paper.journal) {
    lines.push(`  journal = {${escape(paper.journal)}},`);
  }

  // Add abstract if available
  if (paper.abstract) {
    lines.push(`  abstract = {${escape(paper.abstract)}},`);
  }

  // Add keywords
  if (paper.keywords && paper.keywords.length > 0) {
    lines.push(`  keywords = {${paper.keywords.join(', ')}},`);
  }

  // Close entry (remove trailing comma from last line)
  const lastIdx = lines.length - 1;
  lines[lastIdx] = lines[lastIdx].replace(/,$/, '');
  lines.push('}');

  return lines.join('\n');
}

// =============================================================================
// Module Exports
// =============================================================================

module.exports = arxivPlugin;
