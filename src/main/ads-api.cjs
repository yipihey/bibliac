// Bibliac - NASA ADS API Module
// Integration with NASA ADS (Astrophysics Data System) API

const https = require('https');
const {
  formatBytes,
  extractArxivId,
  adsToPaper,
  titleSimilarity
} = require('../shared/paper-utils.cjs');

const ADS_HOST = 'api.adsabs.harvard.edu';
const ADS_BASE_PATH = '/v1';

/**
 * @typedef {Object} ADSDocument
 * @property {string} bibcode - ADS bibcode identifier
 * @property {string[]} title - Paper title (array with single element)
 * @property {string[]} author - Author names
 * @property {string} year - Publication year (string)
 * @property {string[]} [doi] - DOI identifier(s)
 * @property {string} [pub] - Journal/publication name
 * @property {string} [abstract] - Paper abstract
 * @property {string[]} [keyword] - Keywords
 * @property {string[]} [identifier] - All identifiers (arXiv, bibcode, etc.)
 * @property {string[]} [arxiv_class] - arXiv categories
 */

/**
 * @typedef {Object} SearchOptions
 * @property {string} [fields] - Comma-separated field list (default: standard metadata fields)
 * @property {number} [rows] - Number of results (default: 25)
 * @property {number} [start] - Result offset (default: 0)
 * @property {string} [sort] - Sort order (default: "date desc")
 */

/**
 * @typedef {Object} EsourceRecord
 * @property {string} title - URL as title
 * @property {string} url - Full URL to resource
 * @property {string} link_type - Type like "ESOURCE|EPRINT_PDF", "ESOURCE|PUB_PDF", "ESOURCE|ADS_PDF"
 */

/**
 * @typedef {Object} SmartSearchMetadata
 * @property {string} [title] - Paper title for matching
 * @property {string} [firstAuthor] - First author surname
 * @property {number|string} [year] - Publication year
 * @property {string} [journal] - Journal name
 */

// Stats tracking for sync progress
let syncStats = { bytesReceived: 0, requestCount: 0 };

function resetSyncStats() {
  syncStats = { bytesReceived: 0, requestCount: 0 };
}

function getSyncStats() {
  return { ...syncStats };
}

// formatBytes imported from shared/paper-utils.cjs

// Make an API request to ADS
function adsRequest(endpoint, method, token, body = null) {
  return new Promise((resolve, reject) => {
    // Construct full path with /v1 prefix
    const fullPath = ADS_BASE_PATH + endpoint;

    const options = {
      hostname: ADS_HOST,
      path: fullPath,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
        syncStats.bytesReceived += chunk.length;
      });

      res.on('end', () => {
        syncStats.requestCount++;
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`ADS API error: ${res.statusCode} - ${data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse ADS response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Search ADS for papers matching a query
 * @param {string} token - ADS API token
 * @param {string} query - ADS query string (e.g., 'bibcode:"2024ApJ..."', 'author:"Smith"')
 * @param {SearchOptions} [options={}] - Search options
 * @returns {Promise<{docs: ADSDocument[], numFound: number}>} Search results
 */
async function search(token, query, options = {}) {
  const fields = options.fields || 'bibcode,title,author,year,doi,abstract,keyword,pub,identifier,arxiv_class,citation_count';
  const rows = options.rows || 25;
  const start = options.start || 0;

  const params = new URLSearchParams({
    q: query,
    fl: fields,
    rows: rows.toString(),
    start: start.toString(),
    sort: options.sort || 'date desc'
  });

  const result = await adsRequest(`/search/query?${params}`, 'GET', token);
  return result.response;
}

// Get paper by bibcode
async function getByBibcode(token, bibcode) {
  // Quote bibcode to handle special characters like ".."
  const result = await search(token, `bibcode:"${bibcode}"`, { rows: 1 });
  return result.docs[0] || null;
}

/**
 * Batch lookup multiple papers by bibcode
 * Processes in batches of batchSize to avoid query length limits.
 * Implements retry logic for 500/502/503 errors (up to 3 attempts with exponential backoff).
 * @param {string} token - ADS API token
 * @param {string[]} bibcodes - Array of bibcodes to look up
 * @param {Object} [options={}] - Options (fields, batchSize)
 * @returns {Promise<ADSDocument[]>} Found documents (may be fewer than input if some not found)
 */
async function getByBibcodes(token, bibcodes, options = {}) {
  if (!bibcodes || bibcodes.length === 0) return [];

  // Support legacy batchSize parameter
  const batchSize = typeof options === 'number' ? options : (options.batchSize || 50);
  const fields = typeof options === 'object' ? options.fields : undefined;

  const results = [];

  // Clean bibcodes - trim whitespace and remove any stray characters
  const cleanBibcodes = bibcodes.map(b => b.trim());

  // Process in batches to avoid query length limits
  for (let i = 0; i < cleanBibcodes.length; i += batchSize) {
    const batch = cleanBibcodes.slice(i, i + batchSize);
    const query = batch.map(b => `bibcode:"${b}"`).join(' OR ');

    console.log(`ADS query: ${query}`);

    // Retry up to 3 times for server errors
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const searchOptions = { rows: batch.length };
        if (fields) searchOptions.fields = fields;
        const result = await search(token, query, searchOptions);
        console.log(`ADS returned ${result.docs?.length || 0} results for ${batch.length} bibcodes`);
        if (result.docs) {
          results.push(...result.docs);
        }
        break; // Success, exit retry loop
      } catch (e) {
        const isServerError = e.message.includes('500') || e.message.includes('502') || e.message.includes('503');
        if (isServerError && attempt < 2) {
          console.log(`ADS server error, retrying in ${(attempt + 1) * 2}s...`);
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        } else {
          console.error(`Batch lookup failed for batch ${i / batchSize}:`, e.message);
          break;
        }
      }
    }
  }

  return results;
}

// Get paper by DOI
async function getByDOI(token, doi) {
  const result = await search(token, `doi:"${doi}"`, { rows: 1 });
  return result.docs[0] || null;
}

// Get paper by arXiv ID
async function getByArxiv(token, arxivId) {
  // Normalize arXiv ID
  const normalizedId = arxivId.replace('arXiv:', '').replace('arxiv:', '');
  const result = await search(token, `arxiv:${normalizedId}`, { rows: 1 });
  return result.docs[0] || null;
}

// Get references (papers this paper cites)
// Default to 500 to fetch all refs - papers rarely have more than this
async function getReferences(token, bibcode, options = {}) {
  const rows = options.rows || 500;
  // Quote bibcode to handle special characters like ".."
  const result = await search(token, `references(bibcode:"${bibcode}")`, {
    fields: 'bibcode,title,author,year',
    rows
  });
  return result.docs || [];
}

// Get citations (papers that cite this paper)
// Default to 50 - popular papers can have thousands of citations
async function getCitations(token, bibcode, options = {}) {
  const rows = options.rows || 50;
  // Quote bibcode to handle special characters like ".."
  const result = await search(token, `citations(bibcode:"${bibcode}")`, {
    fields: 'bibcode,title,author,year',
    rows
  });
  return result.docs || [];
}

// Export papers as BibTeX
async function exportBibtex(token, bibcodes) {
  if (!Array.isArray(bibcodes)) {
    bibcodes = [bibcodes];
  }

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.adsabs.harvard.edu',
      path: '/v1/export/bibtex',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const result = JSON.parse(data);
            resolve(result.export);
          } else {
            reject(new Error(`ADS export error: ${res.statusCode} - ${data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse ADS export response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify({ bibcode: bibcodes }));
    req.end();
  });
}

/**
 * Get electronic source links (PDFs, HTML) for a paper
 * Returns links to arXiv PDFs, publisher PDFs, and ADS scans.
 * @param {string} token - ADS API token
 * @param {string} bibcode - Paper bibcode
 * @returns {Promise<EsourceRecord[]>} Array of source records with URLs and types
 */
async function getEsources(token, bibcode) {
  try {
    // Need to call the specific esource endpoint to get actual PDF links
    // Encode bibcode to handle special chars like & in "A&A"
    const encodedBibcode = encodeURIComponent(bibcode);
    const result = await adsRequest(`/resolver/${encodedBibcode}/esource`, 'GET', token);
    console.log('Esources response:', JSON.stringify(result, null, 2));

    // Handle different response formats
    if (Array.isArray(result)) {
      return result;
    } else if (result && Array.isArray(result.links)) {
      return result.links;
    } else if (result && result.links && Array.isArray(result.links.records)) {
      // Nested structure: { links: { records: [...] } }
      return result.links.records;
    } else if (result && Array.isArray(result.records)) {
      return result.records;
    } else if (result && result.action === 'redirect' && result.link) {
      // Redirect response: { action: "redirect", link: "https://doi.org/..." }
      // Return as a pseudo-record (typically a DOI link)
      return [{
        url: result.link,
        link_type: 'ESOURCE|PUB_HTML',
        title: result.link
      }];
    }
    return [];
  } catch (error) {
    console.error('Error fetching esources:', error.message);
    return [];
  }
}

// Validate API token
async function validateToken(token) {
  try {
    // Try a simple search to validate the token
    await search(token, 'bibcode:2020ApJ...900..100D', { rows: 1 });
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// adsToPaper, extractArxivId, titleSimilarity imported from shared/paper-utils.cjs

/**
 * Smart search that tries multiple strategies to find a paper in ADS
 * Attempts exact title match, title+author+year, author+year+keywords, etc.
 * Uses title similarity scoring to validate matches.
 * @param {string} token - ADS API token
 * @param {SmartSearchMetadata} metadata - Known metadata to search with
 * @returns {Promise<ADSDocument|null>} Best matching document or null if not found
 */
async function smartSearch(token, metadata) {
  const { title, firstAuthor, year, journal } = metadata;

  console.log('Smart search with metadata:', { title, firstAuthor, year, journal });

  const strategies = [];

  // Strategy 1: Full title as phrase (most specific)
  if (title && title.length > 10) {
    // Clean title for search - remove problematic characters
    const cleanTitle = title
      .replace(/["""'']/g, '')
      .replace(/[:;]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    strategies.push({
      name: 'exact_title',
      query: `title:"${cleanTitle}"`,
      minSimilarity: 0.5
    });
  }

  // Strategy 2: Title keywords + author + year (balanced)
  if (title) {
    const titleWords = title
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .filter(w => !['with', 'from', 'that', 'this', 'have', 'been', 'were', 'their', 'which', 'through', 'about', 'using', 'based', 'study', 'analysis', 'observations', 'properties'].includes(w.toLowerCase()));

    if (titleWords.length > 0) {
      // Use more title words but as individual terms
      const searchTerms = titleWords.slice(0, 8).join(' ');
      let query = `title:(${searchTerms})`;
      if (firstAuthor) query += ` author:"^${firstAuthor}"`;  // ^ means first author
      if (year) query += ` year:${year}`;
      strategies.push({
        name: 'title_words_author_year',
        query,
        minSimilarity: 0.4
      });
    }
  }

  // Strategy 3: First author + year + key distinctive words
  if (firstAuthor && year && title) {
    // Get the most distinctive words (longer, less common)
    const distinctiveWords = title
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 5)
      .slice(0, 4)
      .join(' ');

    if (distinctiveWords) {
      strategies.push({
        name: 'author_year_keywords',
        query: `author:"^${firstAuthor}" year:${year} title:(${distinctiveWords})`,
        minSimilarity: 0.35
      });
    }
  }

  // Strategy 4: Just first author + year (broad, last resort)
  if (firstAuthor && year) {
    strategies.push({
      name: 'author_year_only',
      query: `author:"^${firstAuthor}" year:${year}`,
      minSimilarity: 0.5  // Need higher similarity since query is broad
    });
  }

  // Strategy 5: Title words only (no author/year constraint)
  if (title && title.length > 20) {
    const importantWords = title
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4)
      .slice(0, 6)
      .join(' ');

    if (importantWords) {
      strategies.push({
        name: 'title_words_only',
        query: `title:(${importantWords})`,
        minSimilarity: 0.55
      });
    }
  }

  // Try each strategy in order
  for (const strategy of strategies) {
    console.log(`Trying strategy '${strategy.name}': ${strategy.query}`);

    try {
      const result = await search(token, strategy.query, { rows: 5, sort: 'score desc' });

      if (result.docs && result.docs.length > 0) {
        // Score each candidate
        const scored = result.docs.map(doc => ({
          doc,
          similarity: titleSimilarity(title, doc.title?.[0] || ''),
          authorMatch: firstAuthor && doc.author?.[0]?.toLowerCase().includes(firstAuthor.toLowerCase()),
          yearMatch: year && String(doc.year) === String(year)
        }));

        // Sort by similarity
        scored.sort((a, b) => b.similarity - a.similarity);

        const best = scored[0];
        console.log(`Best candidate: "${best.doc.title?.[0]}" (similarity: ${best.similarity.toFixed(2)}, author: ${best.authorMatch}, year: ${best.yearMatch})`);

        // Accept if meets threshold OR has strong author+year match with reasonable similarity
        if (best.similarity >= strategy.minSimilarity) {
          console.log(`Match accepted via '${strategy.name}' strategy`);
          return best.doc;
        }

        // Also accept if author and year match with moderate similarity
        if (best.authorMatch && best.yearMatch && best.similarity >= 0.25) {
          console.log(`Match accepted via author+year confirmation`);
          return best.doc;
        }
      }
    } catch (err) {
      console.error(`Strategy '${strategy.name}' failed:`, err.message);
    }
  }

  console.log('No match found after trying all strategies');
  return null;
}

module.exports = {
  search,
  smartSearch,
  getByBibcode,
  getByBibcodes,
  getByDOI,
  getByArxiv,
  getReferences,
  getCitations,
  getEsources,
  exportBibtex,
  validateToken,
  adsToPaper,
  extractArxivId,
  resetSyncStats,
  getSyncStats,
  formatBytes
};
