/**
 * Bibliac - Paper Files Constants
 * Constants for the unified paper_files system and download queue
 */

// File roles - describes the purpose/type of file
const FILE_ROLES = {
  PDF: 'pdf',           // Primary paper PDF
  SUPPLEMENT: 'supplement', // Supplementary material
  DATA: 'data',         // Data files (CSV, HDF5, etc.)
  FIGURE: 'figure',     // Extracted or additional figures
  OTHER: 'other'        // Other file types
};

// PDF source types - where the PDF came from
const PDF_SOURCES = {
  ARXIV: 'arxiv',           // arXiv e-print
  PUBLISHER: 'publisher',   // Publisher version
  ADS_SCAN: 'ads_scan',     // ADS scanned version
  MANUAL: 'manual'          // Manually added by user
};

// File status - download/processing state
const FILE_STATUS = {
  PENDING: 'pending',       // Queued for download
  QUEUED: 'queued',         // In download queue
  DOWNLOADING: 'downloading', // Currently downloading
  READY: 'ready',           // File is available
  COMPLETE: 'complete',     // Download complete (alias for ready)
  ERROR: 'error',           // Download/processing failed
  CANCELLED: 'cancelled'    // Download was cancelled
};

// Download priority levels
const PRIORITY = {
  LOW: 0,
  NORMAL: 5,
  HIGH: 10,
  IMMEDIATE: 100
};

// Default retry policy for downloads
const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  backoff: [1000, 5000, 15000] // ms between retries
};

// Default concurrency for parallel downloads
const DEFAULT_CONCURRENCY = 2;

// Download timeout in milliseconds (5 minutes)
const DEFAULT_TIMEOUT = 300000;

// Trusted domains for certificate handling (academic sites with sometimes-expired certs)
const TRUSTED_DOMAINS = [
  'adsabs.harvard.edu',
  'articles.adsabs.harvard.edu',
  'arxiv.org'
];

module.exports = {
  FILE_ROLES,
  PDF_SOURCES,
  FILE_STATUS,
  PRIORITY,
  DEFAULT_RETRY_POLICY,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT,
  TRUSTED_DOMAINS
};
