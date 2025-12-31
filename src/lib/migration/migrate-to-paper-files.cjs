/**
 * Migration script to move existing PDFs to the new paper_files system
 *
 * This migrates from the old structure:
 *   papers/{BIBCODE}_{SOURCETYPE}.pdf
 *
 * To the new content-addressable structure:
 *   files/{hash_prefix}/{hash}.pdf
 *
 * Also creates human-readable symlinks:
 *   papers/{bibcode}/{source_type}.pdf -> ../../files/{prefix}/{hash}.pdf
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Compute SHA-256 hash of a file
 * @param {string} filePath - Path to file
 * @returns {Promise<string>} Hex-encoded hash
 */
async function computeHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Get MIME type from file extension
 * @param {string} ext - File extension (with dot)
 * @returns {string} MIME type
 */
function getMimeType(ext) {
  const mimeTypes = {
    '.pdf': 'application/pdf',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.fits': 'application/fits',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.zip': 'application/zip'
  };
  return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * Create a symlink, handling existing files
 * @param {string} target - Target path (what the symlink points to)
 * @param {string} linkPath - Path where symlink will be created
 */
function createSymlink(target, linkPath) {
  try {
    // Remove existing file/symlink if present
    if (fs.existsSync(linkPath)) {
      fs.unlinkSync(linkPath);
    }
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (e) {
    console.log(`[Migration] Could not create symlink ${linkPath}: ${e.message}`);
    return false;
  }
}

/**
 * Migrate existing PDFs and attachments to the paper_files system
 * @param {Object} db - Database instance with required methods
 * @param {string} libraryPath - Path to library folder
 * @param {Function} [log] - Optional logging function
 * @returns {Promise<{migrated: number, skipped: number, errors: string[]}>}
 */
async function migrateToFileContainer(db, libraryPath, log = console.log) {
  log('[Migration] Starting migration to paper_files system...');

  const results = {
    migrated: 0,
    skipped: 0,
    errors: []
  };

  const papersDir = path.join(libraryPath, 'papers');
  const filesDir = path.join(libraryPath, 'files');

  // Create files directory structure
  if (!fs.existsSync(filesDir)) {
    fs.mkdirSync(filesDir, { recursive: true });
    log('[Migration] Created files directory');
  }

  // Check if papers directory exists
  if (!fs.existsSync(papersDir)) {
    log('[Migration] No papers directory found, nothing to migrate');
    db.setSchemaVersion(2);
    return results;
  }

  // Scan for existing PDFs
  let files;
  try {
    files = fs.readdirSync(papersDir).filter(f => f.endsWith('.pdf'));
  } catch (e) {
    log(`[Migration] Could not read papers directory: ${e.message}`);
    results.errors.push(`Could not read papers directory: ${e.message}`);
    return results;
  }

  log(`[Migration] Found ${files.length} PDF files to process`);

  // Map source type from filename to our normalized types
  const sourceMap = {
    'EPRINT_PDF': 'arxiv',
    'PUB_PDF': 'publisher',
    'ADS_PDF': 'ads_scan',
    'ATTACHED': 'manual'
  };

  // Process each PDF file
  for (const filename of files) {
    // Parse filename: {BIBCODE}_{SOURCETYPE}.pdf
    const match = filename.match(/^(.+)_(EPRINT_PDF|PUB_PDF|ADS_PDF|ATTACHED)\.pdf$/);
    if (!match) {
      log(`[Migration] Skipping ${filename} - unrecognized filename format`);
      results.skipped++;
      continue;
    }

    const [, bibcode, sourceType] = match;
    const filePath = path.join(papersDir, filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      log(`[Migration] Skipping ${filename} - file not found`);
      results.skipped++;
      continue;
    }

    // Find paper by bibcode
    const paper = db.getPaperByBibcode(bibcode);
    if (!paper) {
      log(`[Migration] Skipping ${filename} - no matching paper for bibcode ${bibcode}`);
      results.skipped++;
      continue;
    }

    try {
      // Compute hash
      const hash = await computeHash(filePath);
      const prefix = hash.substring(0, 2);
      const newFilename = `${hash}.pdf`;

      // Create hash directory
      const hashDir = path.join(filesDir, prefix);
      if (!fs.existsSync(hashDir)) {
        fs.mkdirSync(hashDir, { recursive: true });
      }

      // Move file to new location
      const newPath = path.join(hashDir, newFilename);
      if (!fs.existsSync(newPath)) {
        // Move the file
        fs.renameSync(filePath, newPath);
        log(`[Migration] Moved ${filename} to files/${prefix}/${newFilename}`);
      } else {
        // File with same hash already exists (duplicate)
        // Just remove the old file
        fs.unlinkSync(filePath);
        log(`[Migration] Removed duplicate ${filename} (hash already exists)`);
      }

      // Get file size
      const fileSize = fs.statSync(newPath).size;

      // Check if already in paper_files (avoid duplicates)
      const existingFiles = db.getFileByHash(hash);
      const existingFile = existingFiles.find(f => f.paper_id === paper.id);
      if (existingFile) {
        log(`[Migration] ${filename} already in paper_files, skipping database entry`);
      } else {
        // Insert into paper_files
        db.addPaperFile(paper.id, {
          file_hash: hash,
          filename: newFilename,
          original_name: filename,
          mime_type: 'application/pdf',
          file_size: fileSize,
          file_role: 'pdf',
          source_type: sourceMap[sourceType] || 'manual',
          added_date: new Date().toISOString(),
          status: 'ready'
        });
      }

      // Create human-readable symlink: papers/{bibcode}/{source_type}.pdf
      const paperDir = path.join(papersDir, bibcode.replace(/[^a-zA-Z0-9._-]/g, '_'));
      if (!fs.existsSync(paperDir)) {
        fs.mkdirSync(paperDir, { recursive: true });
      }

      const sourceLabel = sourceMap[sourceType] || 'manual';
      const symlinkPath = path.join(paperDir, `${sourceLabel}.pdf`);
      const relativeTarget = path.relative(paperDir, newPath);
      createSymlink(relativeTarget, symlinkPath);

      results.migrated++;
    } catch (e) {
      log(`[Migration] Error processing ${filename}: ${e.message}`);
      results.errors.push(`${filename}: ${e.message}`);
    }
  }

  // Migrate attachments table
  log('[Migration] Processing attachments...');
  let attachments;
  try {
    attachments = db.getAllAttachments();
  } catch (e) {
    log(`[Migration] Could not get attachments: ${e.message}`);
    attachments = [];
  }

  for (const att of attachments) {
    const filePath = path.join(papersDir, att.filename);
    if (!fs.existsSync(filePath)) {
      log(`[Migration] Attachment file not found: ${att.filename}`);
      continue;
    }

    try {
      const hash = await computeHash(filePath);
      const prefix = hash.substring(0, 2);
      const ext = path.extname(att.original_name || att.filename);
      const newFilename = `${hash}${ext}`;

      const hashDir = path.join(filesDir, prefix);
      if (!fs.existsSync(hashDir)) {
        fs.mkdirSync(hashDir, { recursive: true });
      }

      const newPath = path.join(hashDir, newFilename);
      if (!fs.existsSync(newPath)) {
        fs.renameSync(filePath, newPath);
        log(`[Migration] Moved attachment ${att.original_name} to files/${prefix}/${newFilename}`);
      } else {
        fs.unlinkSync(filePath);
        log(`[Migration] Removed duplicate attachment ${att.original_name}`);
      }

      const fileSize = fs.statSync(newPath).size;
      const mimeType = getMimeType(ext);

      // Determine file role based on type
      let fileRole = 'other';
      if (att.file_type === 'pdf' || ext.toLowerCase() === '.pdf') {
        fileRole = 'supplement';
      } else if (['.csv', '.fits', '.json', '.xml'].includes(ext.toLowerCase())) {
        fileRole = 'data';
      }

      db.addPaperFile(att.paper_id, {
        file_hash: hash,
        filename: newFilename,
        original_name: att.original_name,
        mime_type: mimeType,
        file_size: fileSize,
        file_role: fileRole,
        source_type: 'manual',
        added_date: att.added_date || new Date().toISOString(),
        status: 'ready'
      });

      results.migrated++;
    } catch (e) {
      log(`[Migration] Error processing attachment ${att.filename}: ${e.message}`);
      results.errors.push(`Attachment ${att.filename}: ${e.message}`);
    }
  }

  // Update annotations to reference paper_files (by source_type)
  // This is handled by the UI layer looking up files by paper_id + source_type

  // Set schema version to indicate migration is complete
  db.setSchemaVersion(2);

  log(`[Migration] Migration complete! Migrated: ${results.migrated}, Skipped: ${results.skipped}, Errors: ${results.errors.length}`);

  return results;
}

/**
 * Check if migration is needed
 * @param {Object} db - Database instance
 * @returns {boolean}
 */
function needsMigration(db) {
  const version = db.getSchemaVersion();
  return version < 2;
}

module.exports = {
  migrateToFileContainer,
  needsMigration,
  computeHash,
  getMimeType
};
