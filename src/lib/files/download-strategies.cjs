/**
 * ADS Reader - Download Strategies
 *
 * Modular download strategies for different PDF sources (arXiv, publisher, ADS).
 * Each strategy knows how to download from a specific source.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { TRUSTED_DOMAINS, DEFAULT_TIMEOUT, PDF_SOURCES } = require('./constants.cjs');

/**
 * Base downloader class with common HTTP download logic
 */
class BaseDownloader {
  /**
   * @param {Object} options - Configuration options
   * @param {number} [options.timeout=300000] - Download timeout in ms
   * @param {number} [options.maxRedirects=5] - Maximum redirects to follow
   */
  constructor(options = {}) {
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.maxRedirects = options.maxRedirects || 5;
  }

  /**
   * Download a file from URL
   * @param {string} url - URL to download from
   * @param {string} destPath - Destination file path
   * @param {Function} [onProgress] - Progress callback (bytesReceived, totalBytes)
   * @param {AbortSignal} [signal] - Abort signal for cancellation
   * @returns {Promise<{success: boolean, size?: number, error?: string}>}
   */
  download(url, destPath, onProgress, signal) {
    return new Promise((resolve, reject) => {
      this._downloadWithRedirects(url, destPath, this.maxRedirects, onProgress, signal, resolve, reject);
    });
  }

  /**
   * Internal download with redirect handling
   * @private
   */
  _downloadWithRedirects(url, destPath, redirectsLeft, onProgress, signal, resolve, reject) {
    if (redirectsLeft <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    // Check if aborted
    if (signal && signal.aborted) {
      reject(new Error('Download aborted'));
      return;
    }

    console.log(`[Downloader] Starting download: ${url}`);

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    // Check if domain is trusted (for certificate issues)
    const isTrusted = TRUSTED_DOMAINS.some(d => parsedUrl.hostname.endsWith(d));

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
      },
      // Allow expired certs for trusted academic domains
      rejectUnauthorized: !isTrusted
    };

    const req = protocol.request(options, (res) => {
      console.log(`[Downloader] Response: ${res.statusCode} ${res.headers['content-type']} (${res.headers['content-length'] || 'unknown'} bytes)`);

      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsedUrl.protocol}//${parsedUrl.host}${res.headers.location}`;
        console.log(`[Downloader] Redirecting to: ${redirectUrl}`);
        this._downloadWithRedirects(redirectUrl, destPath, redirectsLeft - 1, onProgress, signal, resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        console.log(`[Downloader] Failed: HTTP ${res.statusCode} for ${url}`);
        reject(new Error(`HTTP ${res.statusCode} from ${parsedUrl.hostname}`));
        return;
      }

      // Ensure destination directory exists
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      const file = fs.createWriteStream(destPath);
      let downloadedBytes = 0;
      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;

        // Report progress
        if (onProgress) {
          onProgress(downloadedBytes, totalBytes);
        }

        // Log progress periodically
        if (totalBytes > 0 && downloadedBytes % 100000 < chunk.length) {
          console.log(`[Downloader] Downloaded ${Math.round(downloadedBytes / 1024)}KB / ${Math.round(totalBytes / 1024)}KB`);
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          // Verify downloaded file
          this._verifyPdf(destPath)
            .then((size) => {
              console.log(`[Downloader] Download complete: ${destPath} (${size} bytes)`);
              resolve({ success: true, size, path: destPath });
            })
            .catch((err) => {
              // Clean up invalid file
              try {
                fs.unlinkSync(destPath);
              } catch (e) {
                // Ignore cleanup errors
              }
              reject(err);
            });
        });
      });

      file.on('error', (err) => {
        console.error(`[Downloader] File write error: ${err.message}`);
        try {
          fs.unlinkSync(destPath);
        } catch (e) {
          // Ignore cleanup errors
        }
        reject(err);
      });

      res.on('error', (err) => {
        console.error(`[Downloader] Response error: ${err.message}`);
        reject(err);
      });
    });

    req.on('error', (err) => {
      console.error(`[Downloader] Request error: ${err.message}`);
      reject(err);
    });

    req.setTimeout(this.timeout, () => {
      console.error('[Downloader] Download timeout');
      req.destroy();
      reject(new Error('Download timeout'));
    });

    // Handle abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Download aborted'));
      }, { once: true });
    }

    req.end();
  }

  /**
   * Verify the downloaded file is a valid PDF
   * @private
   * @param {string} filePath - Path to downloaded file
   * @returns {Promise<number>} File size
   */
  _verifyPdf(filePath) {
    return new Promise((resolve, reject) => {
      try {
        const stats = fs.statSync(filePath);

        if (stats.size < 1000) {
          reject(new Error('Downloaded file too small, likely not a valid PDF'));
          return;
        }

        // Check PDF magic bytes
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(8);
        fs.readSync(fd, buffer, 0, 8, 0);
        fs.closeSync(fd);

        const header = buffer.toString('ascii', 0, 5);
        if (header !== '%PDF-') {
          // Check if it's HTML (auth redirect)
          const content = buffer.toString();
          if (content.includes('<!DOC') || content.includes('<html')) {
            reject(new Error('Received login page instead of PDF - authentication required'));
          } else {
            reject(new Error('Downloaded file is not a valid PDF'));
          }
          return;
        }

        resolve(stats.size);
      } catch (e) {
        reject(new Error(`Failed to verify download: ${e.message}`));
      }
    });
  }
}

/**
 * ArXiv downloader - downloads PDFs from arxiv.org
 */
class ArxivDownloader extends BaseDownloader {
  /**
   * Check if this downloader can handle the paper
   * @param {Object} paper - Paper metadata
   * @returns {boolean}
   */
  canHandle(paper) {
    return !!(paper.arxiv_id || this._extractArxivId(paper));
  }

  /**
   * Get the arxiv ID from paper
   * @param {Object} paper - Paper metadata
   * @returns {string|null}
   */
  getArxivId(paper) {
    if (paper.arxiv_id) {
      return paper.arxiv_id;
    }
    return this._extractArxivId(paper);
  }

  /**
   * Extract arXiv ID from paper identifiers
   * @private
   */
  _extractArxivId(paper) {
    // Check various identifier sources
    const identifiers = paper.identifier || paper.identifiers || [];
    for (const id of identifiers) {
      if (typeof id === 'string') {
        // Match patterns like "arXiv:2401.12345" or "2401.12345"
        const match = id.match(/(?:arXiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)/i);
        if (match) return match[1];

        // Old arXiv format
        const oldMatch = id.match(/(?:arXiv:)?([a-z-]+\/\d{7}(?:v\d+)?)/i);
        if (oldMatch) return oldMatch[1];
      }
    }
    return null;
  }

  /**
   * Get the download URL for the paper
   * @param {Object} paper - Paper metadata
   * @returns {string}
   */
  getUrl(paper) {
    const arxivId = this.getArxivId(paper);
    if (!arxivId) {
      throw new Error('No arXiv ID found');
    }
    // Normalize arXiv ID (remove version suffix for URL)
    const normalizedId = arxivId.replace(/v\d+$/, '');
    return `https://arxiv.org/pdf/${normalizedId}.pdf`;
  }

  /**
   * Download PDF from arXiv
   * @param {Object} paper - Paper metadata
   * @param {string} destPath - Destination path
   * @param {Function} [onProgress] - Progress callback
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<{success: boolean, source: string, size?: number, error?: string}>}
   */
  async download(paper, destPath, onProgress, signal) {
    try {
      const url = this.getUrl(paper);
      console.log(`[ArxivDownloader] Downloading from: ${url}`);

      const result = await super.download(url, destPath, onProgress, signal);
      return {
        ...result,
        source: PDF_SOURCES.ARXIV
      };
    } catch (error) {
      return {
        success: false,
        source: PDF_SOURCES.ARXIV,
        error: error.message
      };
    }
  }
}

/**
 * Publisher downloader - downloads PDFs from publisher sites
 * Uses ADS esources to find the publisher URL and optionally applies a library proxy.
 */
class PublisherDownloader extends BaseDownloader {
  /**
   * @param {Object} options - Configuration
   * @param {string} [options.proxyUrl] - Library proxy URL prefix
   * @param {Object} [options.adsApi] - ADS API module
   * @param {string} [options.adsToken] - ADS API token
   */
  constructor(options = {}) {
    super(options);
    this.proxyUrl = options.proxyUrl;
    this.adsApi = options.adsApi;
    this.adsToken = options.adsToken;
  }

  /**
   * Set ADS API credentials (for dynamic configuration)
   * @param {Object} adsApi - ADS API module
   * @param {string} adsToken - ADS API token
   */
  setAdsCredentials(adsApi, adsToken) {
    this.adsApi = adsApi;
    this.adsToken = adsToken;
  }

  /**
   * Set library proxy URL
   * @param {string} proxyUrl - Proxy URL prefix
   */
  setProxyUrl(proxyUrl) {
    this.proxyUrl = proxyUrl;
  }

  /**
   * Check if this downloader can handle the paper
   * @param {Object} paper - Paper metadata
   * @returns {boolean}
   */
  canHandle(paper) {
    return !!(paper.doi || paper.bibcode);
  }

  /**
   * Find publisher PDF URL from ADS esources
   * @param {Object} paper - Paper metadata
   * @returns {Promise<{url: string, type: string, error?: string}|null>}
   */
  async findPdfUrl(paper) {
    if (!this.adsApi) {
      return { error: 'ADS API not configured' };
    }
    if (!this.adsToken) {
      return { error: 'ADS token not set' };
    }
    if (!paper.bibcode) {
      return { error: 'Paper has no bibcode' };
    }

    try {
      const esources = await this.adsApi.getEsources(this.adsToken, paper.bibcode);
      if (!esources || esources.length === 0) {
        return { error: `No esources from ADS for ${paper.bibcode}` };
      }

      // Look for PUB_PDF
      const availableTypes = [];
      for (const source of esources) {
        const type = source.type || source.link_type || '';
        availableTypes.push(type);
        if (type.includes('PUB_PDF') && this._isValidUrl(source.url)) {
          return { url: source.url, type: 'PUB_PDF' };
        }
      }

      return { error: `No PUB_PDF in esources (available: ${availableTypes.join(', ')})` };
    } catch (error) {
      console.error('[PublisherDownloader] Error fetching esources:', error.message);
      return { error: `ADS esources fetch failed: ${error.message}` };
    }
  }

  /**
   * Check if URL is valid HTTP(S)
   * @private
   */
  _isValidUrl(url) {
    return url && (url.startsWith('http://') || url.startsWith('https://'));
  }

  /**
   * Download PDF from publisher
   * @param {Object} paper - Paper metadata
   * @param {string} destPath - Destination path
   * @param {Function} [onProgress] - Progress callback
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<{success: boolean, source: string, size?: number, error?: string}>}
   */
  async download(paper, destPath, onProgress, signal) {
    try {
      const pdfInfo = await this.findPdfUrl(paper);
      if (!pdfInfo || pdfInfo.error) {
        return {
          success: false,
          source: PDF_SOURCES.PUBLISHER,
          error: pdfInfo?.error || 'No publisher PDF URL found'
        };
      }

      let downloadUrl = pdfInfo.url;

      // Apply library proxy if configured
      if (this.proxyUrl) {
        downloadUrl = this.proxyUrl + encodeURIComponent(pdfInfo.url);
        console.log(`[PublisherDownloader] Using proxy: ${downloadUrl}`);
      } else {
        console.log(`[PublisherDownloader] Downloading from: ${downloadUrl}`);
      }

      const result = await super.download(downloadUrl, destPath, onProgress, signal);
      return {
        ...result,
        source: PDF_SOURCES.PUBLISHER
      };
    } catch (error) {
      return {
        success: false,
        source: PDF_SOURCES.PUBLISHER,
        error: error.message
      };
    }
  }
}

/**
 * ADS Downloader - downloads PDFs from ADS (scanned papers or ADS PDF links)
 */
class AdsDownloader extends BaseDownloader {
  /**
   * @param {Object} options - Configuration
   * @param {Object} [options.adsApi] - ADS API module
   * @param {string} [options.adsToken] - ADS API token
   */
  constructor(options = {}) {
    super(options);
    this.adsApi = options.adsApi;
    this.adsToken = options.adsToken;
  }

  /**
   * Set ADS API credentials
   * @param {Object} adsApi - ADS API module
   * @param {string} adsToken - ADS API token
   */
  setAdsCredentials(adsApi, adsToken) {
    this.adsApi = adsApi;
    this.adsToken = adsToken;
  }

  /**
   * Check if this downloader can handle the paper
   * @param {Object} paper - Paper metadata
   * @returns {boolean}
   */
  canHandle(paper) {
    return !!paper.bibcode;
  }

  /**
   * Find ADS PDF URL from esources
   * @param {Object} paper - Paper metadata
   * @returns {Promise<{url: string, type: string, error?: string}|null>}
   */
  async findPdfUrl(paper) {
    if (!this.adsApi) {
      return { error: 'ADS API not configured' };
    }
    if (!this.adsToken) {
      return { error: 'ADS token not set' };
    }
    if (!paper.bibcode) {
      return { error: 'Paper has no bibcode' };
    }

    try {
      const esources = await this.adsApi.getEsources(this.adsToken, paper.bibcode);
      if (!esources || esources.length === 0) {
        return { error: `No esources from ADS for ${paper.bibcode}` };
      }

      // Look for ADS_PDF
      const availableTypes = [];
      for (const source of esources) {
        const type = source.type || source.link_type || '';
        availableTypes.push(type);
        if (type.includes('ADS_PDF') && this._isValidUrl(source.url)) {
          return { url: source.url, type: 'ADS_PDF' };
        }
      }

      return { error: `No ADS_PDF in esources (available: ${availableTypes.join(', ')})` };
    } catch (error) {
      console.error('[AdsDownloader] Error fetching esources:', error.message);
      return { error: `ADS esources fetch failed: ${error.message}` };
    }
  }

  /**
   * Check if URL is valid
   * @private
   */
  _isValidUrl(url) {
    return url && (url.startsWith('http://') || url.startsWith('https://'));
  }

  /**
   * Download PDF from ADS
   * @param {Object} paper - Paper metadata
   * @param {string} destPath - Destination path
   * @param {Function} [onProgress] - Progress callback
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<{success: boolean, source: string, size?: number, error?: string}>}
   */
  async download(paper, destPath, onProgress, signal) {
    try {
      const pdfInfo = await this.findPdfUrl(paper);
      if (!pdfInfo || pdfInfo.error) {
        return {
          success: false,
          source: PDF_SOURCES.ADS_SCAN,
          error: pdfInfo?.error || 'No ADS PDF URL found'
        };
      }

      console.log(`[AdsDownloader] Downloading from: ${pdfInfo.url}`);

      const result = await super.download(pdfInfo.url, destPath, onProgress, signal);
      return {
        ...result,
        source: PDF_SOURCES.ADS_SCAN
      };
    } catch (error) {
      return {
        success: false,
        source: PDF_SOURCES.ADS_SCAN,
        error: error.message
      };
    }
  }
}

/**
 * Download Strategy Manager
 *
 * Coordinates multiple download strategies with priority-based fallback.
 */
class DownloadStrategyManager {
  /**
   * @param {Object} strategies - Named strategy instances
   * @param {ArxivDownloader} [strategies.arxiv] - ArXiv downloader
   * @param {PublisherDownloader} [strategies.publisher] - Publisher downloader
   * @param {AdsDownloader} [strategies.ads_scan] - ADS downloader
   * @param {string[]} [priorityOrder] - Order to try sources
   */
  constructor(strategies = {}, priorityOrder = ['arxiv', 'publisher', 'ads_scan']) {
    this.strategies = strategies;
    this.priorityOrder = priorityOrder;
  }

  /**
   * Add or replace a strategy
   * @param {string} name - Strategy name
   * @param {BaseDownloader} strategy - Strategy instance
   */
  setStrategy(name, strategy) {
    this.strategies[name] = strategy;
  }

  /**
   * Set the priority order
   * @param {string[]} order - Array of strategy names
   */
  setPriorityOrder(order) {
    this.priorityOrder = order;
  }

  /**
   * Get strategy by source type
   * @param {string} sourceType - Source type (arxiv, publisher, ads_scan)
   * @returns {BaseDownloader|null}
   */
  getStrategy(sourceType) {
    return this.strategies[sourceType] || null;
  }

  /**
   * Download PDF for a paper, trying strategies in priority order
   * @param {Object} paper - Paper metadata
   * @param {string} destPath - Destination file path
   * @param {string} [preferredSource='auto'] - Preferred source to try first
   * @param {Function} [onProgress] - Progress callback
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<{success: boolean, source?: string, size?: number, error?: string}>}
   */
  async downloadForPaper(paper, destPath, preferredSource = 'auto', onProgress, signal) {
    // Build order: preferred first, then priority order
    const order = this._buildOrder(preferredSource);
    const errors = [];

    for (const sourceType of order) {
      const strategy = this.strategies[sourceType];
      if (!strategy) {
        continue;
      }

      // Check if strategy can handle this paper
      if (!strategy.canHandle(paper)) {
        console.log(`[StrategyManager] ${sourceType} cannot handle paper, skipping`);
        continue;
      }

      console.log(`[StrategyManager] Trying ${sourceType} for ${paper.bibcode || paper.arxiv_id}`);

      try {
        const result = await strategy.download(paper, destPath, onProgress, signal);

        if (result.success) {
          console.log(`[StrategyManager] Successfully downloaded via ${sourceType}`);
          return result;
        } else {
          console.log(`[StrategyManager] ${sourceType} failed: ${result.error}`);
          errors.push({ source: sourceType, error: result.error });
        }
      } catch (error) {
        console.error(`[StrategyManager] ${sourceType} error:`, error.message);
        errors.push({ source: sourceType, error: error.message });
      }
    }

    // All strategies failed
    const errorMessages = errors.map(e => `${e.source}: ${e.error}`).join('; ');
    return {
      success: false,
      error: `All download sources failed. ${errorMessages}`
    };
  }

  /**
   * Build download order based on preference
   * @private
   */
  _buildOrder(preferredSource) {
    if (preferredSource === 'auto' || !preferredSource) {
      return [...this.priorityOrder];
    }

    // Start with preferred, then add others
    const order = [preferredSource];
    for (const source of this.priorityOrder) {
      if (source !== preferredSource && !order.includes(source)) {
        order.push(source);
      }
    }
    return order;
  }
}

module.exports = {
  BaseDownloader,
  ArxivDownloader,
  PublisherDownloader,
  AdsDownloader,
  DownloadStrategyManager
};
