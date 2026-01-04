/**
 * Bibliac - Reading List PDF Cache
 *
 * Disk-based cache for PDFs saved to the reading list.
 * Unlike tempPdfCache (in-memory, ephemeral), this persists PDFs to disk
 * until the user either removes from reading list or promotes to library.
 */

const fs = require('fs');
const path = require('path');

/**
 * Reading list PDF cache - stores PDFs on disk
 */
class ReadingListCache {
  /**
   * @param {string} libraryPath - Path to the library folder
   */
  constructor(libraryPath) {
    this.cacheDir = path.join(libraryPath, 'reading_list');
    this._ensureDir();
  }

  /**
   * Ensure the cache directory exists
   * @private
   */
  _ensureDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Sanitize bibcode for use in filename
   * @param {string} bibcode
   * @returns {string}
   */
  _sanitizeBibcode(bibcode) {
    // Replace problematic characters with underscores
    return bibcode.replace(/[\/\\:*?"<>|.]/g, '_');
  }

  /**
   * Get the filename for a PDF
   * @param {string} bibcode
   * @param {string} source - PDF source (EPRINT_PDF, PUB_PDF, ADS_PDF)
   * @returns {string}
   */
  _getFilename(bibcode, source) {
    return `${this._sanitizeBibcode(bibcode)}_${source}.pdf`;
  }

  /**
   * Get the full path for a PDF
   * @param {string} bibcode
   * @param {string} source
   * @returns {string}
   */
  getPath(bibcode, source) {
    return path.join(this.cacheDir, this._getFilename(bibcode, source));
  }

  /**
   * Check if a PDF exists in the cache
   * @param {string} bibcode
   * @param {string} source
   * @returns {boolean}
   */
  has(bibcode, source) {
    const filePath = this.getPath(bibcode, source);
    return fs.existsSync(filePath);
  }

  /**
   * Find any PDF for a bibcode (regardless of source)
   * @param {string} bibcode
   * @returns {{path: string, source: string} | null}
   */
  findAny(bibcode) {
    const sanitized = this._sanitizeBibcode(bibcode);
    const prefix = `${sanitized}_`;

    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.startsWith(prefix) && file.endsWith('.pdf')) {
          // Extract source from filename
          const source = file.slice(prefix.length, -4); // Remove prefix and .pdf
          return {
            path: path.join(this.cacheDir, file),
            source
          };
        }
      }
    } catch (e) {
      console.error('[ReadingListCache] Error reading cache dir:', e.message);
    }

    return null;
  }

  /**
   * Save a PDF to the cache
   * @param {string} bibcode
   * @param {Buffer} data - PDF data
   * @param {string} source - PDF source
   * @returns {string} - Path where PDF was saved
   */
  save(bibcode, data, source) {
    this._ensureDir();
    const filePath = this.getPath(bibcode, source);

    fs.writeFileSync(filePath, data);
    console.log(`[ReadingListCache] Saved ${bibcode} (${(data.length / 1024 / 1024).toFixed(2)} MB) to ${filePath}`);

    return filePath;
  }

  /**
   * Read a PDF from the cache
   * @param {string} bibcode
   * @param {string} source
   * @returns {Buffer | null}
   */
  read(bibcode, source) {
    const filePath = this.getPath(bibcode, source);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    return fs.readFileSync(filePath);
  }

  /**
   * Remove all PDFs for a bibcode
   * @param {string} bibcode
   */
  remove(bibcode) {
    const sanitized = this._sanitizeBibcode(bibcode);
    const prefix = `${sanitized}_`;

    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.startsWith(prefix) && file.endsWith('.pdf')) {
          const filePath = path.join(this.cacheDir, file);
          fs.unlinkSync(filePath);
          console.log(`[ReadingListCache] Removed ${filePath}`);
        }
      }
    } catch (e) {
      console.error('[ReadingListCache] Error removing PDFs:', e.message);
    }
  }

  /**
   * Get the relative path for database storage
   * @param {string} bibcode
   * @param {string} source
   * @returns {string}
   */
  getRelativePath(bibcode, source) {
    return `reading_list/${this._getFilename(bibcode, source)}`;
  }

  /**
   * Get cache statistics
   * @returns {{count: number, totalSize: number}}
   */
  getStats() {
    let count = 0;
    let totalSize = 0;

    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.pdf')) {
          count++;
          const stats = fs.statSync(path.join(this.cacheDir, file));
          totalSize += stats.size;
        }
      }
    } catch (e) {
      // Directory might not exist yet
    }

    return { count, totalSize };
  }
}

module.exports = {
  ReadingListCache
};
