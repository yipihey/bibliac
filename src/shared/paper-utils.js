/**
 * ADS Reader - Paper Utilities
 * Shared functions for paper manipulation across desktop and mobile platforms
 *
 * NOTE: This file re-exports from the new core library for backwards compatibility.
 * New code should import directly from '../lib/index.js'
 */

// Re-export from core library
export { formatBytes, formatAuthors, safeJsonParse } from '../lib/utils/index.js';
export { extractArxivId, adsToPaper, normalizeBibcode, titleSimilarity } from '../lib/ads-api/index.js';
export { sanitizeBibcodeForFilename, generatePdfFilename, getSourceTypeFromFilename } from '../lib/pdf/index.js';
