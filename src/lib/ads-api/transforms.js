/**
 * Bibliac Core - ADS Data Transforms
 *
 * Functions for transforming ADS API data to our internal format.
 * These are pure functions with no platform dependencies.
 */

/**
 * Extract arXiv ID from ADS identifier array
 * @param {string[]|null} identifiers - Array of identifiers from ADS
 * @returns {string|null} arXiv ID without prefix (e.g., "2401.12345")
 */
export function extractArxivId(identifiers) {
  if (!identifiers) return null;

  for (const id of identifiers) {
    // Handle "arXiv:2401.12345" format
    if (id.startsWith('arXiv:')) {
      return id.replace('arXiv:', '');
    }
    // Handle bare "2401.12345" or "2401.12345v2" format
    const match = id.match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
    if (match) {
      return match[1];
    }
    // Also check for old-style arXiv IDs like "astro-ph/0601001"
    const oldMatch = id.match(/(?:arXiv:)?([a-z-]+\/\d{7}(?:v\d+)?)/i);
    if (oldMatch) return oldMatch[1];
  }
  return null;
}

/**
 * Convert ADS API response document to our paper format
 * @param {import('../types.js').ADSDocument} adsDoc - Document from ADS API response
 * @returns {Partial<import('../types.js').Paper>} Paper object in our format
 */
export function adsToPaper(adsDoc) {
  return {
    bibcode: adsDoc.bibcode,
    doi: adsDoc.doi?.[0] || null,
    arxiv_id: extractArxivId(adsDoc.identifier),
    title: adsDoc.title?.[0] || 'Untitled',
    authors: adsDoc.author || [],
    year: adsDoc.year ? parseInt(adsDoc.year) : null,
    journal: adsDoc.pub || null,
    abstract: adsDoc.abstract || null,
    keywords: adsDoc.keyword || [],
    citation_count: adsDoc.citation_count || 0
  };
}

/**
 * Normalize a bibcode for comparison
 * Removes dots and converts to lowercase
 * @param {string} bibcode - ADS bibcode
 * @returns {string} Normalized bibcode
 */
export function normalizeBibcode(bibcode) {
  if (!bibcode) return '';
  return bibcode.replace(/\./g, '').toLowerCase();
}

/**
 * Calculate similarity between two titles (for fuzzy matching)
 * @param {string} title1 - First title
 * @param {string} title2 - Second title
 * @returns {number} Similarity score 0-1
 */
export function titleSimilarity(title1, title2) {
  if (!title1 || !title2) return 0;

  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'been',
    'were', 'their', 'which', 'through', 'about', 'into', 'using', 'based'
  ]);

  const normalize = (s) => s.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter(w => !stopWords.has(w));

  const words1 = new Set(normalize(title1));
  const words2 = new Set(normalize(title2));

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = [...words1].filter(w => words2.has(w)).length;
  const union = new Set([...words1, ...words2]).size;

  return intersection / union;
}

/**
 * Parse esources response into categorized sources
 * Handles various ADS API response formats
 * @param {Object} result - Raw esources API response
 * @returns {import('../types.js').EsourceRecord[]}
 */
export function parseEsourcesResponse(result) {
  if (Array.isArray(result)) {
    return result;
  } else if (result && Array.isArray(result.links)) {
    return result.links;
  } else if (result && result.links && Array.isArray(result.links.records)) {
    return result.links.records;
  } else if (result && Array.isArray(result.records)) {
    return result.records;
  }
  return [];
}

/**
 * Categorize esources by type
 * @param {import('../types.js').EsourceRecord[]} esources
 * @returns {{arxiv: EsourceRecord|null, publisher: EsourceRecord|null, ads: EsourceRecord|null}}
 */
export function categorizeEsources(esources) {
  const sources = {
    arxiv: null,
    publisher: null,
    ads: null
  };

  for (const source of esources) {
    const linkType = source.link_type || source.type || '';
    const url = source.url;

    if (!url || !url.startsWith('http')) continue;

    if (linkType.includes('EPRINT_PDF') && !sources.arxiv) {
      sources.arxiv = { url, type: 'EPRINT_PDF', label: 'arXiv' };
    } else if (linkType.includes('ADS_PDF') && !sources.ads) {
      sources.ads = { url, type: 'ADS_PDF', label: 'ADS Scan' };
    } else if (linkType.includes('PUB_PDF') && !sources.publisher) {
      sources.publisher = { url, type: 'PUB_PDF', label: 'Publisher' };
    }
  }

  return sources;
}
