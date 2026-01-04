/**
 * Bibliac - FileManager
 * Unified file management with content-addressed storage
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FILE_ROLES, FILE_STATUS } = require('./constants.cjs');

// MIME type detection based on file extension
const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.fits': 'application/fits',
  '.hdf5': 'application/x-hdf5',
  '.h5': 'application/x-hdf5',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.zip': 'application/zip'
};

class FileManager {
  /**
   * Create a FileManager instance
   * @param {string} libraryPath - Path to the library folder
   * @param {Object} database - Database module reference
   */
  constructor(libraryPath, database) {
    this.libraryPath = libraryPath;
    this.db = database;
    this.filesDir = path.join(libraryPath, 'files');
    this.papersDir = path.join(libraryPath, 'papers');
  }

  /**
   * Compute SHA-256 hash of a file
   * @param {string} filePath - Path to the file
   * @returns {Promise<string>} Hex-encoded hash
   */
  async computeHash(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Detect MIME type from file extension
   * @param {string} filePath - Path to the file
   * @returns {Promise<string>} MIME type string
   */
  async detectMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
  }

  /**
   * Get file size in bytes
   * @param {string} filePath - Path to the file
   * @returns {Promise<number>} File size in bytes
   */
  async getFileSize(filePath) {
    const stats = await fs.promises.stat(filePath);
    return stats.size;
  }

  /**
   * Ensure required directories exist
   * @returns {Promise<void>}
   */
  async ensureDirectories() {
    await fs.promises.mkdir(this.filesDir, { recursive: true });
    await fs.promises.mkdir(this.papersDir, { recursive: true });
  }

  /**
   * Get the storage path for a file based on its hash
   * Uses content-addressed storage: files/{hash_prefix}/{hash}.{ext}
   * @param {Object} fileRecord - File record with file_hash and filename
   * @returns {string} Absolute path to the file
   */
  getStoragePath(fileRecord) {
    const prefix = fileRecord.file_hash.substring(0, 2);
    return path.join(this.filesDir, prefix, fileRecord.filename);
  }

  /**
   * Get the symlink directory for a paper
   * @param {string} bibcode - Paper bibcode (or ID if no bibcode)
   * @returns {string} Path to the paper's symlink directory
   */
  getPaperDir(bibcode) {
    // Sanitize bibcode for use as directory name
    const safeBibcode = bibcode ? bibcode.replace(/[/\\:*?"<>|]/g, '_') : 'unknown';
    return path.join(this.papersDir, safeBibcode);
  }

  /**
   * Add a file from a local path
   * @param {number} paperId - Database ID of the paper
   * @param {string} filePath - Path to the source file
   * @param {Object} options - Additional options
   * @param {string} options.role - File role (from FILE_ROLES)
   * @param {string} options.sourceType - Source type (from PDF_SOURCES)
   * @param {string} options.originalName - Original filename
   * @param {string} options.sourceUrl - URL file was downloaded from
   * @param {string} options.bibcode - Paper bibcode for symlink directory
   * @returns {Promise<Object>} The created file record
   */
  async addFile(paperId, filePath, options = {}) {
    const {
      role = FILE_ROLES.OTHER,
      sourceType = null,
      originalName = null,
      sourceUrl = null,
      bibcode = null
    } = options;

    // Ensure directories exist
    await this.ensureDirectories();

    // Validate source file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`Source file not found: ${filePath}`);
    }

    // Compute file hash
    const fileHash = await this.computeHash(filePath);

    // Detect MIME type and get file size
    const mimeType = await this.detectMimeType(filePath);
    const fileSize = await this.getFileSize(filePath);

    // Determine file extension
    const ext = path.extname(filePath).toLowerCase() || '.bin';

    // Create filename: hash.ext
    const filename = `${fileHash}${ext}`;

    // Create storage directory (hash prefix)
    const prefix = fileHash.substring(0, 2);
    const storageDir = path.join(this.filesDir, prefix);
    await fs.promises.mkdir(storageDir, { recursive: true });

    // Destination path
    const destPath = path.join(storageDir, filename);

    // Check if file already exists (same hash = same content)
    if (!fs.existsSync(destPath)) {
      // Copy file to content-addressed storage
      await fs.promises.copyFile(filePath, destPath);
    }

    // Create database record
    const fileData = {
      paper_id: paperId,
      file_hash: fileHash,
      filename: filename,
      original_name: originalName || path.basename(filePath),
      mime_type: mimeType,
      file_size: fileSize,
      file_role: role,
      source_type: sourceType,
      source_url: sourceUrl,
      added_date: new Date().toISOString(),
      status: FILE_STATUS.READY,
      error_message: null,
      text_extracted: 0,
      text_path: null
    };

    const fileId = this.db.addPaperFile(paperId, fileData);

    // Create symlink for human-readable access
    if (bibcode) {
      await this.createSymlink(paperId, { ...fileData, id: fileId }, bibcode);
    }

    // Return with computed path for immediate use
    return { id: fileId, path: destPath, ...fileData };
  }

  /**
   * Create a symlink for human-readable file access
   * @param {number} paperId - Paper ID
   * @param {Object} fileRecord - File record from database
   * @param {string} bibcode - Paper bibcode for directory name
   * @returns {Promise<void>}
   */
  async createSymlink(paperId, fileRecord, bibcode) {
    try {
      const paperDir = this.getPaperDir(bibcode);
      await fs.promises.mkdir(paperDir, { recursive: true });

      // Create a meaningful symlink name
      let linkName;
      if (fileRecord.source_type) {
        linkName = `${fileRecord.source_type}${path.extname(fileRecord.filename)}`;
      } else if (fileRecord.original_name) {
        linkName = fileRecord.original_name;
      } else {
        linkName = fileRecord.filename;
      }

      const linkPath = path.join(paperDir, linkName);
      const targetPath = this.getStoragePath(fileRecord);

      // Calculate relative path from symlink to target
      const relativePath = path.relative(paperDir, targetPath);

      // Remove existing symlink if it exists
      if (fs.existsSync(linkPath)) {
        await fs.promises.unlink(linkPath);
      }

      // Create symlink
      await fs.promises.symlink(relativePath, linkPath);
    } catch (err) {
      // Log but don't fail - symlinks are convenience, not critical
      console.warn(`Failed to create symlink for file ${fileRecord.id}:`, err.message);
    }
  }

  /**
   * Remove a file from the system
   * @param {number} fileId - Database ID of the file
   * @returns {Promise<boolean>} True if removed successfully
   */
  async removeFile(fileId) {
    // Get file record
    const fileRecord = this.db.getPaperFile(fileId);
    if (!fileRecord) {
      throw new Error(`File record not found: ${fileId}`);
    }

    const fileHash = fileRecord.file_hash;

    // Check if this hash is used by other records (only if we have a hash)
    let isShared = false;
    if (fileHash) {
      const otherFiles = this.db.getFileByHash(fileHash);
      const otherRecords = Array.isArray(otherFiles) ? otherFiles : (otherFiles ? [otherFiles] : []);
      isShared = otherRecords.filter(f => f.id !== fileId).length > 0;
    }

    // Delete database record first
    this.db.deletePaperFile(fileId);

    // If no other records use this file, delete the actual file
    if (!isShared) {
      // Try new content-addressed storage location first
      if (fileHash && fileRecord.filename) {
        const storagePath = this.getStoragePath(fileRecord);
        if (fs.existsSync(storagePath)) {
          await fs.promises.unlink(storagePath);

          // Try to remove the prefix directory if empty
          const prefixDir = path.dirname(storagePath);
          try {
            const files = await fs.promises.readdir(prefixDir);
            if (files.length === 0) {
              await fs.promises.rmdir(prefixDir);
            }
          } catch (err) {
            // Ignore - directory may not be empty or already removed
          }
        }
      }

    }

    // Note: Symlink cleanup would require tracking which paper/bibcode
    // For now, symlinks become dangling and can be cleaned up separately

    return true;
  }

  /**
   * Get all files for a paper
   * @param {number} paperId - Paper ID
   * @param {Object} filters - Optional filters
   * @param {string} filters.role - Filter by file role
   * @param {string} filters.status - Filter by status
   * @param {string} filters.sourceType - Filter by source type
   * @returns {Promise<Array>} Array of file records
   */
  async getFilesForPaper(paperId, filters = {}) {
    return this.db.getPaperFiles(paperId, filters);
  }

  /**
   * Get the primary PDF for a paper
   * Priority: publisher > arxiv > ads_scan > manual > any PDF
   * @param {number} paperId - Paper ID
   * @returns {Promise<Object|null>} Primary PDF file record or null
   */
  async getPrimaryPdf(paperId) {
    const files = await this.getFilesForPaper(paperId, { role: FILE_ROLES.PDF });

    if (files.length === 0) {
      return null;
    }

    // Sort by source priority
    const priority = ['publisher', 'arxiv', 'ads_scan', 'manual'];
    files.sort((a, b) => {
      const aPriority = a.source_type ? priority.indexOf(a.source_type) : priority.length;
      const bPriority = b.source_type ? priority.indexOf(b.source_type) : priority.length;
      if (aPriority === -1) return 1;
      if (bPriority === -1) return -1;
      return aPriority - bPriority;
    });

    return files[0];
  }

  /**
   * Set a file as the primary PDF for a paper
   * This updates the source_type to 'publisher' (highest priority) to make it primary
   * @param {number} paperId - Paper ID
   * @param {number} fileId - File ID to set as primary
   * @returns {Promise<void>}
   */
  async setPrimaryPdf(paperId, fileId) {
    // Get all PDF files for this paper
    const files = await this.getFilesForPaper(paperId, { role: FILE_ROLES.PDF });

    // Find the file to set as primary
    const targetFile = files.find(f => f.id === fileId);
    if (!targetFile) {
      throw new Error(`File ${fileId} not found for paper ${paperId}`);
    }

    // If already the highest priority source type, nothing to do
    if (targetFile.source_type === 'publisher') {
      return;
    }

    // Update the source_type to 'publisher' to make it highest priority
    // This is a simple approach - a more sophisticated one would add a is_primary flag
    this.db.updatePaperFile(fileId, {
      source_type: 'publisher'
    });
  }

  /**
   * Update file status (for download tracking)
   * @param {number} fileId - File ID
   * @param {string} status - New status
   * @param {string} errorMessage - Error message if status is ERROR
   * @returns {Promise<void>}
   */
  async updateFileStatus(fileId, status, errorMessage = null) {
    this.db.updatePaperFile(fileId, {
      status: status,
      error_message: errorMessage
    });
  }

  /**
   * Mark file as having extracted text
   * @param {number} fileId - File ID
   * @param {string} textPath - Path to extracted text file
   * @returns {Promise<void>}
   */
  async markTextExtracted(fileId, textPath) {
    this.db.updatePaperFile(fileId, {
      text_extracted: 1,
      text_path: textPath
    });
  }

  /**
   * Check if a file with the given hash already exists
   * @param {string} hash - File hash
   * @returns {Promise<Object|null>} Existing file record or null
   */
  async findByHash(hash) {
    return this.db.getFileByHash(hash);
  }

  /**
   * Get a file record by ID
   * @param {number} fileId - File ID
   * @returns {Object|null} File record or null if not found
   */
  getFile(fileId) {
    const fileRecord = this.db.getPaperFile(fileId);
    if (!fileRecord) return null;

    // Add the computed path for convenience
    // Try content-addressed storage first (files with file_hash)
    if (fileRecord.file_hash && fileRecord.filename) {
      const storagePath = this.getStoragePath(fileRecord);
      if (fs.existsSync(storagePath)) {
        fileRecord.path = storagePath;
      } else {
        // Content-addressed file missing, try papers/ fallback
        const papersPath = path.join(this.papersDir, fileRecord.filename);
        if (fs.existsSync(papersPath)) {
          fileRecord.path = papersPath;
        } else {
          console.warn(`[FileManager] File not found: ${storagePath}`);
          fileRecord.path = null;
        }
      }
    } else if (fileRecord.filename) {
      // Fallback: files stored directly in papers/ directory (download pattern)
      // Files are stored as: papers/BIBCODE_SOURCETYPE.pdf
      const papersPath = path.join(this.papersDir, fileRecord.filename);
      if (fs.existsSync(papersPath)) {
        fileRecord.path = papersPath;
      } else {
        fileRecord.path = null;
      }
    } else {
      fileRecord.path = null;
    }
    return fileRecord;
  }

  /**
   * Get full path to a file's content
   * @param {number} fileId - File ID
   * @returns {Promise<string|null>} Full path or null if not found
   */
  async getFilePath(fileId) {
    const fileRecord = this.db.getPaperFile(fileId);
    if (!fileRecord || fileRecord.status !== FILE_STATUS.READY) {
      return null;
    }

    // Try content-addressed storage first
    if (fileRecord.file_hash && fileRecord.filename) {
      const storagePath = this.getStoragePath(fileRecord);
      if (fs.existsSync(storagePath)) {
        return storagePath;
      }
    }

    // Fallback: papers/ directory pattern
    if (fileRecord.filename) {
      const papersPath = path.join(this.papersDir, fileRecord.filename);
      if (fs.existsSync(papersPath)) {
        return papersPath;
      }
    }

    return null;
  }

  /**
   * Clean up orphaned files (files in storage with no database record)
   * @returns {Promise<{removed: number, errors: Array}>}
   */
  async cleanupOrphanedFiles() {
    const removed = [];
    const errors = [];

    if (!fs.existsSync(this.filesDir)) {
      return { removed: removed.length, errors };
    }

    // Get all hash prefixes
    const prefixes = await fs.promises.readdir(this.filesDir);

    for (const prefix of prefixes) {
      const prefixPath = path.join(this.filesDir, prefix);
      const stat = await fs.promises.stat(prefixPath);

      if (!stat.isDirectory()) continue;

      const files = await fs.promises.readdir(prefixPath);

      for (const file of files) {
        // Extract hash from filename (hash.ext)
        const hash = path.basename(file, path.extname(file));

        // Check if any record references this hash
        const records = this.db.getFileByHash(hash);
        const hasRecords = Array.isArray(records) ? records.length > 0 : !!records;

        if (!hasRecords) {
          try {
            await fs.promises.unlink(path.join(prefixPath, file));
            removed.push(file);
          } catch (err) {
            errors.push({ file, error: err.message });
          }
        }
      }

      // Remove empty prefix directories
      try {
        const remaining = await fs.promises.readdir(prefixPath);
        if (remaining.length === 0) {
          await fs.promises.rmdir(prefixPath);
        }
      } catch (err) {
        // Ignore
      }
    }

    return { removed: removed.length, errors };
  }
}

module.exports = { FileManager };
