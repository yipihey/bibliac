/**
 * Bibliac - Paper Utilities (CommonJS version)
 * Shared functions for paper manipulation across desktop platform
 */

/**
 * Format byte size to human-readable string
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size (e.g., "1.5 KB", "2.3 MB")
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Extract arXiv ID from ADS identifier array
 * @param {string[]|null} identifiers - Array of identifiers from ADS
 * @returns {string|null} arXiv ID without prefix (e.g., "2401.12345")
 */
function extractArxivId(identifiers) {
  if (!identifiers) return null;

  for (const id of identifiers) {
    if (id.startsWith('arXiv:')) {
      return id.replace('arXiv:', '');
    }
    const match = id.match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Convert ADS API response document to our paper format
 * @param {Object} adsDoc - Document from ADS API response
 * @returns {Object} Paper object in our format
 */
function adsToPaper(adsDoc) {
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
 * @param {string} bibcode - ADS bibcode
 * @returns {string} Normalized bibcode
 */
function normalizeBibcode(bibcode) {
  if (!bibcode) return '';
  return bibcode.replace(/\./g, '').toLowerCase();
}

/**
 * Sanitize a bibcode for use in filenames
 * @param {string} bibcode - ADS bibcode
 * @returns {string} Safe filename component
 */
function sanitizeBibcodeForFilename(bibcode) {
  if (!bibcode) return 'unknown';
  return bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Calculate similarity between two titles
 * @param {string} title1 - First title
 * @param {string} title2 - Second title
 * @returns {number} Similarity score 0-1
 */
function titleSimilarity(title1, title2) {
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
 * Generate a PDF filename from bibcode and source type
 * @param {string} bibcode - Paper bibcode
 * @param {string} sourceType - PDF source type
 * @returns {string} Filename
 */
function generatePdfFilename(bibcode, sourceType) {
  const safeBibcode = sanitizeBibcodeForFilename(bibcode);
  return `${safeBibcode}_${sourceType}.pdf`;
}

/**
 * Parse a safe JSON string, returning null on error
 * @param {string|null} str - JSON string to parse
 * @returns {any|null} Parsed value or null
 */
function safeJsonParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

module.exports = {
  formatBytes,
  extractArxivId,
  adsToPaper,
  normalizeBibcode,
  sanitizeBibcodeForFilename,
  titleSimilarity,
  generatePdfFilename,
  safeJsonParse
};
