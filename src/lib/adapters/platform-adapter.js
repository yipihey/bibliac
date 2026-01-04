/**
 * Bibliac Core - Platform Adapter Interface
 *
 * Abstract base class defining the interface that all platform adapters must implement.
 * This allows the core library to work across Electron, Capacitor, and future platforms.
 */

/**
 * @abstract
 * @class PlatformAdapter
 *
 * Platform adapters implement this interface to provide platform-specific functionality.
 */
export class PlatformAdapter {
  /**
   * Get the platform name
   * @returns {string} Platform name ('electron', 'ios', 'web')
   */
  getPlatform() {
    throw new Error('getPlatform() must be implemented');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FILE SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Read a file as text
   * @param {string} path - File path (relative to library)
   * @returns {Promise<string|null>} File contents or null if not found
   */
  async readFile(path) {
    throw new Error('readFile() must be implemented');
  }

  /**
   * Read a file as binary (Uint8Array)
   * @param {string} path - File path (relative to library)
   * @returns {Promise<Uint8Array|null>} File contents or null if not found
   */
  async readBinaryFile(path) {
    throw new Error('readBinaryFile() must be implemented');
  }

  /**
   * Write text to a file
   * @param {string} path - File path (relative to library)
   * @param {string} content - File contents
   * @returns {Promise<void>}
   */
  async writeFile(path, content) {
    throw new Error('writeFile() must be implemented');
  }

  /**
   * Write binary data to a file
   * @param {string} path - File path (relative to library)
   * @param {Uint8Array} data - Binary data
   * @returns {Promise<void>}
   */
  async writeBinaryFile(path, data) {
    throw new Error('writeBinaryFile() must be implemented');
  }

  /**
   * Check if a file exists
   * @param {string} path - File path (relative to library)
   * @returns {Promise<boolean>}
   */
  async fileExists(path) {
    throw new Error('fileExists() must be implemented');
  }

  /**
   * Delete a file
   * @param {string} path - File path (relative to library)
   * @returns {Promise<void>}
   */
  async deleteFile(path) {
    throw new Error('deleteFile() must be implemented');
  }

  /**
   * Create a directory
   * @param {string} path - Directory path (relative to library)
   * @returns {Promise<void>}
   */
  async mkdir(path) {
    throw new Error('mkdir() must be implemented');
  }

  /**
   * List files in a directory
   * @param {string} path - Directory path (relative to library)
   * @returns {Promise<string[]>} List of file names
   */
  async listFiles(path) {
    throw new Error('listFiles() must be implemented');
  }

  /**
   * Get the full absolute path for a relative library path
   * @param {string} relativePath - Path relative to library
   * @returns {string} Absolute path
   */
  getAbsolutePath(relativePath) {
    throw new Error('getAbsolutePath() must be implemented');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HTTP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Make an HTTP GET request
   * @param {string} url - Request URL
   * @param {Object} options - Request options (headers, etc.)
   * @returns {Promise<{status: number, data: any, headers?: Object}>}
   */
  async httpGet(url, options = {}) {
    throw new Error('httpGet() must be implemented');
  }

  /**
   * Make an HTTP POST request
   * @param {string} url - Request URL
   * @param {Object} options - Request options (headers, etc.)
   * @param {any} body - Request body
   * @returns {Promise<{status: number, data: any, headers?: Object}>}
   */
  async httpPost(url, options = {}, body = null) {
    throw new Error('httpPost() must be implemented');
  }

  /**
   * Download a file from URL
   * @param {string} url - Download URL
   * @param {string} destPath - Destination path (relative to library)
   * @param {Object} [options] - Download options
   * @param {function} [options.onProgress] - Progress callback
   * @returns {Promise<{success: boolean, path?: string, error?: string}>}
   */
  async downloadFile(url, destPath, options = {}) {
    throw new Error('downloadFile() must be implemented');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURE STORAGE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get a value from secure storage (keychain/keystore)
   * @param {string} key - Storage key
   * @returns {Promise<string|null>}
   */
  async getSecureItem(key) {
    throw new Error('getSecureItem() must be implemented');
  }

  /**
   * Set a value in secure storage (keychain/keystore)
   * @param {string} key - Storage key
   * @param {string} value - Value to store
   * @returns {Promise<void>}
   */
  async setSecureItem(key, value) {
    throw new Error('setSecureItem() must be implemented');
  }

  /**
   * Delete a value from secure storage
   * @param {string} key - Storage key
   * @returns {Promise<void>}
   */
  async deleteSecureItem(key) {
    throw new Error('deleteSecureItem() must be implemented');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PREFERENCES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get a preference value
   * @param {string} key - Preference key
   * @returns {Promise<any>}
   */
  async getPreference(key) {
    throw new Error('getPreference() must be implemented');
  }

  /**
   * Set a preference value
   * @param {string} key - Preference key
   * @param {any} value - Value to store
   * @returns {Promise<void>}
   */
  async setPreference(key, value) {
    throw new Error('setPreference() must be implemented');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DATABASE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize sql.js
   * @returns {Promise<Object>} sql.js SQL object
   */
  async initSqlJs() {
    throw new Error('initSqlJs() must be implemented');
  }

  /**
   * Save database to storage
   * @param {Uint8Array} data - Database binary data
   * @returns {Promise<void>}
   */
  async saveDatabase(data) {
    throw new Error('saveDatabase() must be implemented');
  }

  /**
   * Load database from storage
   * @returns {Promise<Uint8Array|null>} Database binary data or null
   */
  async loadDatabase() {
    throw new Error('loadDatabase() must be implemented');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLATFORM FEATURES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a feature is available
   * @param {string} feature - Feature name
   * @returns {boolean}
   */
  hasFeature(feature) {
    return false;
  }

  /**
   * Open a URL in external browser
   * @param {string} url - URL to open
   * @returns {Promise<void>}
   */
  async openExternal(url) {
    throw new Error('openExternal() must be implemented');
  }

  /**
   * Copy text to clipboard
   * @param {string} text - Text to copy
   * @returns {Promise<void>}
   */
  async copyToClipboard(text) {
    throw new Error('copyToClipboard() must be implemented');
  }

  /**
   * Log a message (for debugging)
   * @param {string} message - Message to log
   * @param {'info'|'warn'|'error'} [level='info']
   */
  log(message, level = 'info') {
    console.log(`[${level.toUpperCase()}] ${message}`);
  }
}
