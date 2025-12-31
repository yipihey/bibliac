/**
 * ADS Reader Core - PDF Utilities
 *
 * Pure functions for PDF file management.
 */

/**
 * Sanitize a bibcode for use in filenames
 * @param {string} bibcode - ADS bibcode
 * @returns {string} Safe filename component
 */
export function sanitizeBibcodeForFilename(bibcode) {
  if (!bibcode) return 'unknown';
  return bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Generate a PDF filename from bibcode and source type
 * @param {string} bibcode - Paper bibcode
 * @param {string} sourceType - PDF source type (EPRINT_PDF, PUB_PDF, ADS_PDF)
 * @returns {string} Filename like "2024ApJ___123__456A_EPRINT_PDF.pdf"
 */
export function generatePdfFilename(bibcode, sourceType) {
  const safeBibcode = sanitizeBibcodeForFilename(bibcode);
  return `${safeBibcode}_${sourceType}.pdf`;
}

/**
 * Extract source type from PDF filename
 * @param {string} filename - PDF filename
 * @returns {string|null} Source type or null
 */
export function getSourceTypeFromFilename(filename) {
  if (!filename) return null;

  if (filename.includes('_EPRINT_PDF')) return 'EPRINT_PDF';
  if (filename.includes('_PUB_PDF')) return 'PUB_PDF';
  if (filename.includes('_ADS_PDF')) return 'ADS_PDF';

  return null;
}

/**
 * Get arXiv PDF URL
 * @param {string} arxivId - arXiv ID
 * @returns {string}
 */
export function getArxivPdfUrl(arxivId) {
  return `https://arxiv.org/pdf/${arxivId}.pdf`;
}

/**
 * Get arXiv abstract URL
 * @param {string} arxivId - arXiv ID
 * @returns {string}
 */
export function getArxivAbsUrl(arxivId) {
  return `https://arxiv.org/abs/${arxivId}`;
}

/**
 * Get ADS abstract URL
 * @param {string} bibcode - ADS bibcode
 * @returns {string}
 */
export function getAdsAbsUrl(bibcode) {
  return `https://ui.adsabs.harvard.edu/abs/${bibcode}`;
}
