/**
 * ADS Reader - Temporary PDF Cache
 *
 * In-memory LRU cache for temporarily downloaded PDFs.
 * Used for viewing PDFs from ADS search results without saving to disk.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Cache limits
const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_CACHE_ENTRIES = 20;

/**
 * LRU cache entry
 * @typedef {Object} CacheEntry
 * @property {Buffer} data - PDF data
 * @property {number} size - Size in bytes
 * @property {number} lastAccessed - Timestamp of last access
 * @property {string} source - Download source (arxiv, publisher, etc.)
 */

/**
 * Temporary PDF cache with LRU eviction
 */
class TempPdfCache {
  constructor() {
    /** @type {Map<string, CacheEntry>} */
    this.cache = new Map();
    this.currentSize = 0;
  }

  /**
   * Check if a PDF is cached
   * @param {string} bibcode - Paper bibcode
   * @returns {boolean}
   */
  has(bibcode) {
    return this.cache.has(bibcode);
  }

  /**
   * Get a cached PDF
   * @param {string} bibcode - Paper bibcode
   * @returns {CacheEntry|null}
   */
  get(bibcode) {
    const entry = this.cache.get(bibcode);
    if (entry) {
      entry.lastAccessed = Date.now();
      return entry;
    }
    return null;
  }

  /**
   * Store a PDF in the cache
   * @param {string} bibcode - Paper bibcode
   * @param {Buffer} data - PDF data
   * @param {string} source - Download source
   */
  set(bibcode, data, source) {
    const size = data.length;

    // Evict entries if needed to make room
    while (this.currentSize + size > MAX_CACHE_SIZE || this.cache.size >= MAX_CACHE_ENTRIES) {
      if (!this._evictLRU()) break;
    }

    // Remove existing entry if present
    if (this.cache.has(bibcode)) {
      this.currentSize -= this.cache.get(bibcode).size;
      this.cache.delete(bibcode);
    }

    this.cache.set(bibcode, {
      data,
      size,
      lastAccessed: Date.now(),
      source
    });
    this.currentSize += size;

    console.log(`[TempPdfCache] Cached ${bibcode} (${(size / 1024 / 1024).toFixed(2)} MB). Total: ${this.cache.size} entries, ${(this.currentSize / 1024 / 1024).toFixed(2)} MB`);
  }

  /**
   * Remove a PDF from the cache
   * @param {string} bibcode - Paper bibcode
   */
  remove(bibcode) {
    const entry = this.cache.get(bibcode);
    if (entry) {
      this.currentSize -= entry.size;
      this.cache.delete(bibcode);
    }
  }

  /**
   * Clear the entire cache
   */
  clear() {
    this.cache.clear();
    this.currentSize = 0;
    console.log('[TempPdfCache] Cache cleared');
  }

  /**
   * Evict the least recently used entry
   * @private
   * @returns {boolean} True if an entry was evicted
   */
  _evictLRU() {
    if (this.cache.size === 0) return false;

    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      this.currentSize -= entry.size;
      this.cache.delete(oldestKey);
      console.log(`[TempPdfCache] Evicted ${oldestKey} (${(entry.size / 1024 / 1024).toFixed(2)} MB)`);
      return true;
    }

    return false;
  }

  /**
   * Get cache statistics
   * @returns {{entries: number, size: number, maxSize: number, maxEntries: number}}
   */
  getStats() {
    return {
      entries: this.cache.size,
      size: this.currentSize,
      maxSize: MAX_CACHE_SIZE,
      maxEntries: MAX_CACHE_ENTRIES
    };
  }

  /**
   * Download a PDF to memory
   * @param {string} url - URL to download from
   * @param {Function} [onProgress] - Progress callback (bytesReceived, totalBytes)
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<Buffer>}
   */
  downloadToMemory(url, onProgress, signal) {
    return new Promise((resolve, reject) => {
      this._downloadWithRedirects(url, 5, onProgress, signal, resolve, reject);
    });
  }

  /**
   * Internal download with redirect handling
   * @private
   */
  _downloadWithRedirects(url, redirectsLeft, onProgress, signal, resolve, reject) {
    if (redirectsLeft <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    if (signal && signal.aborted) {
      reject(new Error('Download aborted'));
      return;
    }

    console.log(`[TempPdfCache] Downloading: ${url}`);

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    // Trusted academic domains for certificate issues
    const trustedDomains = ['arxiv.org', 'adsabs.harvard.edu', 'iop.org', 'aanda.org'];
    const isTrusted = trustedDomains.some(d => parsedUrl.hostname.endsWith(d));

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
      rejectUnauthorized: !isTrusted,
      timeout: 60000 // 60 second timeout
    };

    const req = protocol.request(options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsedUrl.protocol}//${parsedUrl.host}${res.headers.location}`;
        console.log(`[TempPdfCache] Redirecting to: ${redirectUrl}`);
        this._downloadWithRedirects(redirectUrl, redirectsLeft - 1, onProgress, signal, resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      const chunks = [];
      let bytesReceived = 0;

      res.on('data', (chunk) => {
        if (signal && signal.aborted) {
          res.destroy();
          reject(new Error('Download aborted'));
          return;
        }

        chunks.push(chunk);
        bytesReceived += chunk.length;

        if (onProgress) {
          onProgress(bytesReceived, totalBytes);
        }
      });

      res.on('end', () => {
        const data = Buffer.concat(chunks);

        // Validate PDF
        if (data.length < 1000) {
          reject(new Error('Downloaded file too small'));
          return;
        }

        const header = data.toString('ascii', 0, 5);
        if (header !== '%PDF-') {
          if (data.toString('ascii', 0, 100).includes('<!DOC') || data.toString('ascii', 0, 100).includes('<html')) {
            reject(new Error('Received login page - authentication required'));
          } else {
            reject(new Error('Downloaded file is not a valid PDF'));
          }
          return;
        }

        console.log(`[TempPdfCache] Downloaded ${(data.length / 1024 / 1024).toFixed(2)} MB`);
        resolve(data);
      });

      res.on('error', (err) => {
        reject(new Error(`Download error: ${err.message}`));
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Request error: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timeout'));
    });

    // Handle abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Download aborted'));
      });
    }

    req.end();
  }

  /**
   * Download a PDF for an ADS search paper
   * @param {Object} paper - Paper metadata from ADS search
   * @param {string} [proxyUrl] - Library proxy URL
   * @param {Function} [onProgress] - Progress callback
   * @returns {Promise<{success: boolean, data?: Buffer, source?: string, error?: string}>}
   */
  async downloadForPaper(paper, proxyUrl, onProgress) {
    const sources = this._getPdfSources(paper, proxyUrl);

    for (const { url, source, name } of sources) {
      try {
        console.log(`[TempPdfCache] Trying ${name}: ${url}`);
        const data = await this.downloadToMemory(url, onProgress);

        // Cache it
        this.set(paper.bibcode, data, source);

        return {
          success: true,
          data,
          source
        };
      } catch (error) {
        console.log(`[TempPdfCache] ${name} failed: ${error.message}`);
        continue;
      }
    }

    return {
      success: false,
      error: 'No PDF sources available or all downloads failed'
    };
  }

  /**
   * Get available PDF sources for a paper
   * @private
   */
  _getPdfSources(paper, proxyUrl) {
    const sources = [];

    // arXiv (most reliable, free)
    if (paper.arxiv_id) {
      const arxivId = paper.arxiv_id.replace(/v\d+$/, '');
      sources.push({
        url: `https://arxiv.org/pdf/${arxivId}.pdf`,
        source: 'EPRINT_PDF',
        name: 'arXiv'
      });
    }

    // Publisher via DOI
    if (paper.doi) {
      // Some publishers have direct PDF links
      // For now, we can try the DOI redirect (may require proxy)
      let pubUrl = `https://doi.org/${paper.doi}`;
      if (proxyUrl) {
        pubUrl = proxyUrl + encodeURIComponent(pubUrl);
      }
      sources.push({
        url: pubUrl,
        source: 'PUB_PDF',
        name: 'Publisher'
      });
    }

    // ADS scan (for older papers)
    if (paper.bibcode) {
      sources.push({
        url: `https://ui.adsabs.harvard.edu/link_gateway/${paper.bibcode}/ARTICLE`,
        source: 'ADS_PDF',
        name: 'ADS Article'
      });
    }

    return sources;
  }
}

// Singleton instance
const tempPdfCache = new TempPdfCache();

module.exports = {
  TempPdfCache,
  tempPdfCache
};
