/**
 * ADS Reader Core - ADS API Client
 *
 * Platform-agnostic NASA ADS API client.
 * Uses an HTTP adapter for making requests.
 */

import { adsToPaper, titleSimilarity, parseEsourcesResponse } from './transforms.js';

const ADS_BASE_URL = 'https://api.adsabs.harvard.edu/v1';
const DEFAULT_FIELDS = 'bibcode,title,author,year,doi,abstract,keyword,pub,identifier,arxiv_class,citation_count';

/**
 * Create an ADS API client instance
 *
 * @param {Object} options
 * @param {string} options.token - ADS API token
 * @param {function(string, Object): Promise<Object>} options.httpGet - HTTP GET function
 * @param {function(string, Object, Object): Promise<Object>} options.httpPost - HTTP POST function
 * @param {function(string, string): void} [options.log] - Optional logging function
 * @returns {ADSApi}
 */
export function createADSApi(options) {
  return new ADSApi(options);
}

/**
 * ADS API Client Class
 */
export class ADSApi {
  /**
   * @param {Object} options
   * @param {string} options.token - ADS API token
   * @param {function} options.httpGet - HTTP GET function
   * @param {function} options.httpPost - HTTP POST function
   * @param {function} [options.log] - Optional logging function
   */
  constructor(options) {
    this.token = options.token;
    this.httpGet = options.httpGet;
    this.httpPost = options.httpPost;
    this.log = options.log || console.log;

    // Stats tracking
    this.stats = { bytesReceived: 0, requestCount: 0 };
  }

  /**
   * Reset sync statistics
   */
  resetStats() {
    this.stats = { bytesReceived: 0, requestCount: 0 };
  }

  /**
   * Get sync statistics
   * @returns {{bytesReceived: number, requestCount: number}}
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Make an authenticated request to the ADS API
   * @private
   */
  async request(endpoint, method = 'GET', body = null) {
    const url = `${ADS_BASE_URL}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };

    let result;
    if (method === 'GET') {
      result = await this.httpGet(url, { headers });
    } else {
      result = await this.httpPost(url, { headers }, body);
    }

    this.stats.requestCount++;
    if (result.data) {
      // Estimate bytes received from JSON
      const dataStr = JSON.stringify(result.data);
      this.stats.bytesReceived += dataStr.length;
    }

    if (result.status !== 200) {
      throw new Error(`ADS API error: ${result.status} - ${JSON.stringify(result.data)}`);
    }

    return result.data;
  }

  /**
   * Search ADS for papers matching a query
   * @param {string} query - ADS query string
   * @param {import('../types.js').SearchOptions} [options={}] - Search options
   * @returns {Promise<{docs: ADSDocument[], numFound: number}>}
   */
  async search(query, options = {}) {
    const fields = options.fields || DEFAULT_FIELDS;
    const rows = options.rows || 25;
    const start = options.start || 0;
    const sort = options.sort || 'date desc';

    const params = new URLSearchParams({
      q: query,
      fl: fields,
      rows: rows.toString(),
      start: start.toString(),
      sort: sort
    });

    const result = await this.request(`/search/query?${params}`);
    return result.response;
  }

  /**
   * Get paper by bibcode
   * @param {string} bibcode
   * @returns {Promise<ADSDocument|null>}
   */
  async getByBibcode(bibcode) {
    const result = await this.search(`bibcode:"${bibcode}"`, { rows: 1 });
    return result.docs[0] || null;
  }

  /**
   * Batch lookup multiple papers by bibcode
   * @param {string[]} bibcodes
   * @param {number} [batchSize=50]
   * @returns {Promise<ADSDocument[]>}
   */
  async getByBibcodes(bibcodes, batchSize = 50) {
    if (!bibcodes || bibcodes.length === 0) return [];

    const results = [];
    const cleanBibcodes = bibcodes.map(b => b.trim());

    for (let i = 0; i < cleanBibcodes.length; i += batchSize) {
      const batch = cleanBibcodes.slice(i, i + batchSize);
      const query = batch.map(b => `bibcode:"${b}"`).join(' OR ');

      // Retry up to 3 times for server errors
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await this.search(query, { rows: batch.length });
          if (result.docs) {
            results.push(...result.docs);
          }
          break;
        } catch (e) {
          const isServerError = e.message.includes('500') || e.message.includes('502') || e.message.includes('503');
          if (isServerError && attempt < 2) {
            this.log(`ADS server error, retrying in ${(attempt + 1) * 2}s...`);
            await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          } else {
            this.log(`Batch lookup failed: ${e.message}`);
            break;
          }
        }
      }
    }

    return results;
  }

  /**
   * Get paper by DOI
   * @param {string} doi
   * @returns {Promise<ADSDocument|null>}
   */
  async getByDOI(doi) {
    const result = await this.search(`doi:"${doi}"`, { rows: 1 });
    return result.docs[0] || null;
  }

  /**
   * Get paper by arXiv ID
   * @param {string} arxivId
   * @returns {Promise<ADSDocument|null>}
   */
  async getByArxiv(arxivId) {
    const normalizedId = arxivId.replace('arXiv:', '').replace('arxiv:', '');
    const result = await this.search(`arxiv:${normalizedId}`, { rows: 1 });
    return result.docs[0] || null;
  }

  /**
   * Get references (papers this paper cites)
   * @param {string} bibcode
   * @param {{rows?: number}} [options={}]
   * @returns {Promise<ADSDocument[]>}
   */
  async getReferences(bibcode, options = {}) {
    const rows = options.rows || 200;
    const result = await this.search(`references(bibcode:"${bibcode}")`, {
      fields: 'bibcode,title,author,year',
      rows
    });
    return result.docs || [];
  }

  /**
   * Get citations (papers that cite this paper)
   * @param {string} bibcode
   * @param {{rows?: number}} [options={}]
   * @returns {Promise<ADSDocument[]>}
   */
  async getCitations(bibcode, options = {}) {
    const rows = options.rows || 200;
    const result = await this.search(`citations(bibcode:"${bibcode}")`, {
      fields: 'bibcode,title,author,year',
      rows
    });
    return result.docs || [];
  }

  /**
   * Get electronic source links (PDFs, HTML)
   * @param {string} bibcode
   * @returns {Promise<EsourceRecord[]>}
   */
  async getEsources(bibcode) {
    try {
      const result = await this.request(`/resolver/${bibcode}/esource`);
      return parseEsourcesResponse(result);
    } catch (error) {
      this.log(`Error fetching esources: ${error.message}`);
      return [];
    }
  }

  /**
   * Export papers as BibTeX
   * @param {string|string[]} bibcodes
   * @returns {Promise<string>}
   */
  async exportBibtex(bibcodes) {
    if (!Array.isArray(bibcodes)) {
      bibcodes = [bibcodes];
    }
    const result = await this.request('/export/bibtex', 'POST', { bibcode: bibcodes });
    return result.export;
  }

  /**
   * Validate API token
   * @returns {Promise<{valid: boolean, error?: string}>}
   */
  async validateToken() {
    try {
      await this.search('bibcode:2020ApJ...900..100D', { rows: 1 });
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Smart search that tries multiple strategies
   * @param {Object} metadata
   * @param {string} [metadata.title]
   * @param {string} [metadata.firstAuthor]
   * @param {number|string} [metadata.year]
   * @param {string} [metadata.journal]
   * @returns {Promise<ADSDocument|null>}
   */
  async smartSearch(metadata) {
    const { title, firstAuthor, year, journal } = metadata;
    const strategies = [];

    // Strategy 1: Full title as phrase
    if (title && title.length > 10) {
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

    // Strategy 2: Title keywords + author + year
    if (title) {
      const titleWords = title
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .filter(w => !['with', 'from', 'that', 'this', 'have', 'been', 'were', 'their', 'which', 'through', 'about', 'using', 'based', 'study', 'analysis', 'observations', 'properties'].includes(w.toLowerCase()));

      if (titleWords.length > 0) {
        const searchTerms = titleWords.slice(0, 8).join(' ');
        let query = `title:(${searchTerms})`;
        if (firstAuthor) query += ` author:"^${firstAuthor}"`;
        if (year) query += ` year:${year}`;
        strategies.push({
          name: 'title_words_author_year',
          query,
          minSimilarity: 0.4
        });
      }
    }

    // Strategy 3: First author + year + distinctive words
    if (firstAuthor && year && title) {
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

    // Strategy 4: Just first author + year
    if (firstAuthor && year) {
      strategies.push({
        name: 'author_year_only',
        query: `author:"^${firstAuthor}" year:${year}`,
        minSimilarity: 0.5
      });
    }

    // Try each strategy
    for (const strategy of strategies) {
      try {
        const result = await this.search(strategy.query, { rows: 5, sort: 'score desc' });

        if (result.docs && result.docs.length > 0) {
          const scored = result.docs.map(doc => ({
            doc,
            similarity: titleSimilarity(title, doc.title?.[0] || ''),
            authorMatch: firstAuthor && doc.author?.[0]?.toLowerCase().includes(firstAuthor.toLowerCase()),
            yearMatch: year && String(doc.year) === String(year)
          }));

          scored.sort((a, b) => b.similarity - a.similarity);
          const best = scored[0];

          if (best.similarity >= strategy.minSimilarity) {
            return best.doc;
          }

          if (best.authorMatch && best.yearMatch && best.similarity >= 0.25) {
            return best.doc;
          }
        }
      } catch (err) {
        this.log(`Strategy '${strategy.name}' failed: ${err.message}`);
      }
    }

    return null;
  }
}
