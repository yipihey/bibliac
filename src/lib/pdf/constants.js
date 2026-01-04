/**
 * Bibliac Core - PDF Constants
 */

/**
 * PDF source types
 */
export const PDF_SOURCE_TYPES = {
  ARXIV: 'EPRINT_PDF',
  PUBLISHER: 'PUB_PDF',
  ADS_SCAN: 'ADS_PDF'
};

/**
 * Default PDF priority order
 */
export const DEFAULT_PDF_PRIORITY = ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF'];

/**
 * Source type labels for UI
 */
export const PDF_SOURCE_LABELS = {
  'EPRINT_PDF': 'arXiv',
  'PUB_PDF': 'Publisher',
  'ADS_PDF': 'ADS Scan'
};
