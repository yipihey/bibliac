/**
 * Bibliac - Capacitor API Adapter
 * Provides the same interface as window.electronAPI but for iOS/Capacitor
 *
 * This module is dynamically imported by src/renderer/api.js when running on iOS.
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { CapacitorHttp, registerPlugin } from '@capacitor/core';
import { FileOpener } from '@capacitor-community/file-opener';
import { Share } from '@capacitor/share';
import JSZip from 'jszip';

// Register native iCloud plugin
const ICloud = registerPlugin('ICloud');

// Import SQLite database module
import * as MobileDB from './mobile-database.js';

// Import shared utilities
import {
  adsToPaper,
  extractArxivId,
  safeJsonParse,
  generatePdfFilename,
  sanitizeBibcodeForFilename
} from '../shared/paper-utils.js';
import {
  ADS_API_BASE,
  ADS_SEARCH_FIELDS,
  LIBRARY_FOLDER_NAME,
  DEFAULT_PDF_PRIORITY
} from '../shared/constants.js';

// Cloud LLM service instance
let cloudLlmService = null;

// Database initialized flag
let dbInitialized = false;

// Library folder name in Documents (use constant or fallback)
const LIBRARY_FOLDER = LIBRARY_FOLDER_NAME || 'Bibliac';

// Legacy JSON file for migration
const LEGACY_PAPERS_FILE = 'papers.json';

// Database initialization and migration helpers
async function ensureLibraryExists() {
  await ensureLibraryFoldersFor(LIBRARY_FOLDER);
}

// Helper to ensure library folders exist for a given path
async function ensureLibraryFoldersFor(libPath) {
  try {
    await Filesystem.mkdir({
      path: libPath,
      directory: Directory.Documents,
      recursive: true
    });
    await Filesystem.mkdir({
      path: `${libPath}/papers`,
      directory: Directory.Documents,
      recursive: true
    });
    await Filesystem.mkdir({
      path: `${libPath}/text`,
      directory: Directory.Documents,
      recursive: true
    });
  } catch (e) {
    // Directory may already exist
  }
}

// Helper to parse esources response from ADS API (various formats)
function parseEsourcesResponse(result) {
  if (Array.isArray(result)) return result;
  if (result?.links?.records && Array.isArray(result.links.records)) return result.links.records;
  if (Array.isArray(result?.links)) return result.links;
  if (Array.isArray(result?.records)) return result.records;
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// FILESYSTEM ABSTRACTION (iCloud vs Local)
// ═══════════════════════════════════════════════════════════════════════════

// Helper to read file from either iCloud or local storage
async function fsReadFile(path, location, encoding = 'utf8') {
  if (location === 'icloud') {
    const result = await ICloud.readFile({ path, encoding });
    return result.data;
  } else {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Documents,
      encoding: encoding ? Encoding.UTF8 : undefined
    });
    return result.data;
  }
}

// Helper to write file to either iCloud or local storage
async function fsWriteFile(path, data, location, encoding = 'utf8') {
  if (location === 'icloud') {
    await ICloud.writeFile({ path, data, encoding, recursive: true });
  } else {
    await Filesystem.writeFile({
      path,
      data,
      directory: Directory.Documents,
      encoding: encoding ? Encoding.UTF8 : undefined,
      recursive: true
    });
  }
}

// Helper to delete file from either iCloud or local storage
async function fsDeleteFile(path, location) {
  if (location === 'icloud') {
    await ICloud.deleteFile({ path });
  } else {
    await Filesystem.deleteFile({
      path,
      directory: Directory.Documents
    });
  }
}

// Helper to create directory in either iCloud or local storage
async function fsMkdir(path, location) {
  if (location === 'icloud') {
    await ICloud.mkdir({ path, recursive: true });
  } else {
    await Filesystem.mkdir({
      path,
      directory: Directory.Documents,
      recursive: true
    });
  }
}

// Helper to remove directory from either iCloud or local storage
async function fsRmdir(path, location, recursive = true) {
  if (location === 'icloud') {
    await ICloud.rmdir({ path, recursive });
  } else {
    await Filesystem.rmdir({
      path,
      directory: Directory.Documents,
      recursive
    });
  }
}

// Helper to read directory from either iCloud or local storage
async function fsReaddir(path, location) {
  if (location === 'icloud') {
    const result = await ICloud.readdir({ path });
    return result.files;
  } else {
    const result = await Filesystem.readdir({
      path,
      directory: Directory.Documents
    });
    return result.files;
  }
}

// Helper to get file/directory stat from either iCloud or local storage
async function fsStat(path, location) {
  if (location === 'icloud') {
    return await ICloud.stat({ path });
  } else {
    return await Filesystem.stat({
      path,
      directory: Directory.Documents
    });
  }
}

// Helper to copy file in either iCloud or local storage
async function fsCopy(from, to, location) {
  if (location === 'icloud') {
    await ICloud.copy({ from, to });
  } else {
    await Filesystem.copy({
      from,
      to,
      directory: Directory.Documents,
      toDirectory: Directory.Documents
    });
  }
}

// Initialize SQLite database
async function initializeDatabase() {
  if (dbInitialized) return true;

  try {
    await ensureLibraryExists();
    await MobileDB.initDatabase(LIBRARY_FOLDER);
    dbInitialized = true;

    // Check for legacy JSON data and migrate if needed
    await migrateLegacyData();

    console.log('[API] SQLite database initialized');
    return true;
  } catch (error) {
    console.error('[API] Failed to initialize database:', error);
    return false;
  }
}

// Migrate legacy papers.json to SQLite
async function migrateLegacyData() {
  try {
    const result = await Filesystem.readFile({
      path: `${LIBRARY_FOLDER}/${LEGACY_PAPERS_FILE}`,
      directory: Directory.Documents,
      encoding: Encoding.UTF8
    });

    const legacyPapers = JSON.parse(result.data) || [];
    if (legacyPapers.length === 0) return;

    console.log(`[API] Migrating ${legacyPapers.length} papers from JSON to SQLite...`);

    for (const paper of legacyPapers) {
      // Check if paper already exists in SQLite
      const existing = MobileDB.getPaperByBibcode(paper.bibcode);
      if (!existing) {
        MobileDB.addPaper({
          ...paper,
          added_date: paper.date_added || paper.added_date || new Date().toISOString()
        });
      }
    }

    await MobileDB.saveDatabase();

    // Rename legacy file to prevent re-migration
    await Filesystem.rename({
      from: `${LIBRARY_FOLDER}/${LEGACY_PAPERS_FILE}`,
      to: `${LIBRARY_FOLDER}/${LEGACY_PAPERS_FILE}.migrated`,
      directory: Directory.Documents
    });

    console.log('[API] Migration complete');
  } catch (e) {
    // No legacy file or already migrated - silently ignore expected file-not-found errors
    const isExpectedError = e.message?.includes('File does not exist') ||
                           e.message?.includes("couldn't be opened") ||
                           e.message?.includes('no such file') ||
                           e.message?.includes('File not found');
    if (!isExpectedError) {
      console.log('[API] Legacy migration error:', e.message);
    }
  }
}

// extractArxivId imported from shared/paper-utils.js

// Helper to download PDF for a paper (standalone function)
// Sync cancellation flag
let syncCancelled = false;

async function downloadPaperPdf(paper, token, pdfPriority) {
  try {
    console.log('[downloadPaperPdf] Starting for', paper.bibcode);

    // Get current library path from database
    const currentLibraryPath = MobileDB.getLibraryPath() || LIBRARY_FOLDER;
    console.log('[downloadPaperPdf] Using library path:', currentLibraryPath);

    // Ensure library folders exist
    await ensureLibraryFoldersFor(currentLibraryPath);

    // Get e-sources from ADS
    const esourcesUrl = `${ADS_API_BASE}/resolver/${paper.bibcode}/esources`;
    console.log('[downloadPaperPdf] Fetching e-sources from', esourcesUrl);

    let links = [];
    try {
      const response = await CapacitorHttp.get({
        url: esourcesUrl,
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      console.log('[downloadPaperPdf] E-sources response status:', response.status);

      if (response.status === 200) {
        links = response.data?.links || [];
      }
    } catch (e) {
      console.log('[downloadPaperPdf] E-sources fetch failed, will try fallback:', e.message);
    }

    console.log('[downloadPaperPdf] Available links:', links.map(l => l.type));

    // If no esources but paper has arxiv_id, try direct arXiv download
    if (links.length === 0 && paper.arxiv_id) {
      console.log('[downloadPaperPdf] No esources, trying direct arXiv download for', paper.arxiv_id);
      emit('consoleLog', { message: `[${paper.bibcode}] Trying direct arXiv download...`, level: 'info' });

      const pdfUrl = `https://arxiv.org/pdf/${paper.arxiv_id}.pdf`;
      const filename = `${paper.bibcode.replace(/\//g, '_')}_EPRINT_PDF.pdf`;
      const filePath = `${currentLibraryPath}/papers/${filename}`;

      try {
        const downloadResult = await Filesystem.downloadFile({
          url: pdfUrl,
          path: filePath,
          directory: Directory.Documents,
          progress: true
        });

        if (downloadResult.path) {
          return {
            success: true,
            path: `papers/${filename}`,
            source: 'EPRINT_PDF'
          };
        }
      } catch (e) {
        console.error('[downloadPaperPdf] Direct arXiv download failed:', e);
        emit('consoleLog', { message: `[${paper.bibcode}] arXiv download failed: ${e.message}`, level: 'warn' });
      }

      return { success: false, error: 'arXiv download failed' };
    }

    // Try sources in priority order
    for (const sourceType of pdfPriority) {
      const source = links.find(l => l.type === sourceType);
      if (!source || !source.url) continue;

      try {
        // For arXiv, construct direct PDF URL
        let pdfUrl = source.url;
        if (sourceType === 'EPRINT_PDF' && paper.arxiv_id) {
          pdfUrl = `https://arxiv.org/pdf/${paper.arxiv_id}.pdf`;
        }

        console.log('[downloadPaperPdf] Trying', sourceType, 'from', pdfUrl);
        emit('consoleLog', { message: `[${paper.bibcode}] Trying ${sourceType}...`, level: 'info' });

        // Download the PDF
        const filename = `${paper.bibcode.replace(/\//g, '_')}_${sourceType}.pdf`;
        const filePath = `${currentLibraryPath}/papers/${filename}`;

        console.log('[downloadPaperPdf] Downloading to', filePath);

        const downloadResult = await Filesystem.downloadFile({
          url: pdfUrl,
          path: filePath,
          directory: Directory.Documents,
          progress: true
        });

        console.log('[downloadPaperPdf] Download result:', downloadResult);

        if (downloadResult.path) {
          return {
            success: true,
            path: `papers/${filename}`,
            source: sourceType
          };
        }
      } catch (e) {
        console.error('[downloadPaperPdf] Download failed:', e);
        emit('consoleLog', { message: `[${paper.bibcode}] ${sourceType} download failed: ${e.message}`, level: 'warn' });
      }
    }

    return { success: false, error: 'No PDF sources available' };
  } catch (error) {
    console.error('[downloadPaperPdf] Error:', error);
    return { success: false, error: error.message };
  }
}

// adsToPaper imported from shared/paper-utils.js

// ═══════════════════════════════════════════════════════════════════════════
// BIBTEX HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a cite key from paper metadata
 * Uses bibcode if available, otherwise AuthorYear format
 */
function generateCiteKey(paper) {
  if (paper.bibcode) return paper.bibcode;

  // Extract first author's last name
  const firstAuthor = paper.authors?.split(',')[0]?.trim()?.split(' ').pop() || 'Unknown';
  const year = paper.year || 'XXXX';
  return `${firstAuthor}${year}`;
}

/**
 * Generate BibTeX entry from paper metadata
 * Used for papers without bibcode that can't be fetched from ADS
 */
function paperToBibtex(paper) {
  const key = generateCiteKey(paper);
  const authors = paper.authors || 'Unknown';
  const title = paper.title || 'Untitled';
  const year = paper.year || '';
  const journal = paper.journal || '';

  // Escape special LaTeX characters
  const escapeLatex = (str) => {
    if (!str) return '';
    return str
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/&/g, '\\&')
      .replace(/%/g, '\\%')
      .replace(/\$/g, '\\$')
      .replace(/#/g, '\\#')
      .replace(/_/g, '\\_')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}');
  };

  let bibtex = `@article{${key},\n`;
  bibtex += `  author = {${escapeLatex(authors)}},\n`;
  bibtex += `  title = {${escapeLatex(title)}},\n`;
  bibtex += `  year = {${year}}`;

  if (journal) {
    bibtex += `,\n  journal = {${escapeLatex(journal)}}`;
  }

  if (paper.doi) {
    bibtex += `,\n  doi = {${paper.doi}}`;
  }

  if (paper.arxiv_id) {
    bibtex += `,\n  eprint = {${paper.arxiv_id}},\n  archivePrefix = {arXiv}`;
  }

  bibtex += '\n}';

  return bibtex;
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE PICKER HELPER FUNCTIONS (for PDF and BibTeX import on iOS)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a File object to base64 string
 * Used for saving imported files to the filesystem
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Remove data URL prefix (e.g., "data:application/pdf;base64,")
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Parse BibTeX content and extract entries
 * Returns array of entry objects with fields like title, author, year, etc.
 */
function parseBibtexContent(content) {
  const entries = [];
  // Match BibTeX entries: @type{key, ... }
  // Use a more robust regex that handles nested braces
  const entryRegex = /@(\w+)\s*\{([^,]+),/g;
  let entryMatch;

  while ((entryMatch = entryRegex.exec(content)) !== null) {
    const type = entryMatch[1].toLowerCase();
    const key = entryMatch[2].trim();
    const startIndex = entryMatch.index;

    // Find the matching closing brace
    let braceCount = 0;
    let endIndex = startIndex;
    let foundStart = false;

    for (let i = startIndex; i < content.length; i++) {
      if (content[i] === '{') {
        braceCount++;
        foundStart = true;
      } else if (content[i] === '}') {
        braceCount--;
        if (foundStart && braceCount === 0) {
          endIndex = i + 1;
          break;
        }
      }
    }

    const rawEntry = content.substring(startIndex, endIndex);
    const body = rawEntry.substring(rawEntry.indexOf(',') + 1, rawEntry.length - 1);

    const entry = { type, key, raw: rawEntry };

    // Extract fields - handles {value}, "value", and bare numbers
    const fieldRegex = /(\w+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)"|(\d+))/g;
    let fieldMatch;

    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      const field = fieldMatch[1].toLowerCase();
      // Value can be in braces, quotes, or bare number
      const value = (fieldMatch[2] || fieldMatch[3] || fieldMatch[4] || '').trim();
      entry[field] = value;
    }

    // Try to extract bibcode from adsurl
    if (entry.adsurl) {
      const bibcodeMatch = entry.adsurl.match(/\/abs\/([^\/\s]+)/);
      if (bibcodeMatch) {
        entry.bibcode = decodeURIComponent(bibcodeMatch[1]);
      }
    }

    // Also check eprint for arXiv ID
    if (entry.eprint && !entry.arxiv_id) {
      entry.arxiv_id = entry.eprint;
    }

    entries.push(entry);
  }

  return entries;
}

// Event emitter for iOS (simple implementation)
const eventListeners = {
  consoleLog: [],
  adsSyncProgress: [],
  importProgress: [],
  importComplete: [],
  llmStream: [],
  // Download queue events
  downloadQueueProgress: [],
  downloadQueueComplete: [],
  downloadQueueError: [],
};

function emit(event, data) {
  const listeners = eventListeners[event] || [];
  console.log(`[emit] Event: ${event}, listeners: ${listeners.length}`, data);
  listeners.forEach(cb => {
    try {
      cb(data);
    } catch (e) {
      console.error(`Error in ${event} listener:`, e);
    }
  });
}

// Storage helpers (uses safeJsonParse from shared/paper-utils.js)
const Storage = {
  async get(key) {
    const result = await Preferences.get({ key });
    return safeJsonParse(result.value);
  },
  async set(key, value) {
    await Preferences.set({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value)
    });
  }
};

// Keychain helpers
const Keychain = {
  async getItem(key) {
    try {
      const value = await SecureStorage.get(key);
      console.log(`[Keychain] getItem(${key}):`, value ? '(value exists)' : 'null');
      return value;
    } catch (e) {
      console.log(`[Keychain] getItem(${key}) error:`, e.message);
      return null;
    }
  },
  async setItem(key, value) {
    console.log(`[Keychain] setItem(${key}):`, value ? '(setting value)' : 'null');
    await SecureStorage.set(key, value);
  },
  async removeItem(key) {
    console.log(`[Keychain] removeItem(${key})`);
    await SecureStorage.remove(key);
  }
};

/**
 * Create and initialize the Capacitor API
 * @returns {Promise<object>} The initialized API object
 */
export async function createCapacitorAPI() {
  try {
    console.log('[createCapacitorAPI] Starting initialization...');

    // Add iOS class to body for platform-specific CSS
    try {
      document.body.classList.add('ios');
      console.log('[createCapacitorAPI] Added iOS class to body');
    } catch (e) {
      console.warn('[createCapacitorAPI] Failed to add iOS class:', e);
    }

    // Set up haptic feedback on button taps (non-blocking)
    try {
      document.addEventListener('click', (e) => {
        if (e.target.matches('button, .btn, .primary-button, .tab-btn, .nav-item')) {
          Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
        }
      });
      console.log('[createCapacitorAPI] Set up haptic feedback');
    } catch (e) {
      console.warn('[createCapacitorAPI] Haptics setup failed:', e);
    }

    // Initialize SQLite database
    try {
      await initializeDatabase();
      console.log('[createCapacitorAPI] SQLite database initialized');
    } catch (e) {
      console.error('[createCapacitorAPI] Failed to initialize database:', e);
    }

    // Initialize cloud LLM service if configured (but don't fail if it errors)
    try {
      const cloudConfig = await Storage.get('cloudLlmConfig');
      if (cloudConfig) {
        const { CloudLLMService } = await import('../main/cloud-llm-service.js');
        const apiKey = await Keychain.getItem('cloudLlmApiKey');
        cloudLlmService = new CloudLLMService({ ...cloudConfig, apiKey });
        console.log('[createCapacitorAPI] Cloud LLM initialized');
      }
    } catch (e) {
      console.warn('[createCapacitorAPI] Failed to initialize cloud LLM:', e);
    }

    console.log('[createCapacitorAPI] Returning API object');
    // Return the API object
    return capacitorAPI;
  } catch (error) {
    console.error('[createCapacitorAPI] Critical error during initialization:', error);
    // Still return the API object even if initialization had issues
    return capacitorAPI;
  }
}

/**
 * Capacitor API implementation
 * Matches the interface of window.electronAPI from preload.js
 */
const capacitorAPI = {
  // ═══════════════════════════════════════════════════════════════════════════
  // LIBRARY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  async getLibraryPath() {
    const result = await Preferences.get({ key: 'libraryPath' });
    return result.value || null;
  },

  async selectLibraryFolder() {
    // On iOS, we automatically use a fixed folder in Documents
    try {
      await Filesystem.mkdir({
        path: LIBRARY_FOLDER,
        directory: Directory.Documents,
        recursive: true
      });
      await Filesystem.mkdir({
        path: `${LIBRARY_FOLDER}/papers`,
        directory: Directory.Documents,
        recursive: true
      });

      await Preferences.set({ key: 'libraryPath', value: LIBRARY_FOLDER });
      console.log('[API] Library folder created:', LIBRARY_FOLDER);
      return LIBRARY_FOLDER;
    } catch (error) {
      console.error('[API] Failed to create library folder:', error);
      return null;
    }
  },

  async getLibraryInfo(path) {
    if (!path) return null;
    try {
      const dbPath = `${path}/library.db`;
      try {
        await Filesystem.stat({ path: dbPath, directory: Directory.Documents });
        return { exists: true, hasDatabase: true };
      } catch {
        try {
          await Filesystem.stat({ path: path, directory: Directory.Documents });
          return { exists: true, hasDatabase: false };
        } catch {
          return null;
        }
      }
    } catch {
      return null;
    }
  },

  async checkCloudStatus(path) {
    return { isCloud: true, service: 'iCloud' };
  },

  // iCloud library management - iOS uses iCloud container by default
  async getICloudContainerPath() {
    // On iOS, we use the iCloud Documents directory directly
    return 'iCloud';
  },

  async isICloudAvailable() {
    // Use native iCloud plugin to check availability
    console.log('[API] Checking iCloud availability via native plugin...');
    console.log('[API] ICloud plugin object:', ICloud);
    try {
      const result = await ICloud.isAvailable();
      console.log('[API] iCloud isAvailable result:', JSON.stringify(result));
      return result.available;
    } catch (e) {
      console.log('[API] iCloud check failed:', e.message, e);
      return false;
    }
  },

  async getAllLibraries() {
    const libraries = [];

    // First try to read libraries.json from iCloud
    const isICloudAvailable = await this.isICloudAvailable();
    if (isICloudAvailable) {
      try {
        const result = await ICloud.readFile({
          path: 'libraries.json',
          encoding: 'utf8'
        });

        const data = JSON.parse(result.data);
        console.log('[API] Found iCloud libraries.json with', (data.libraries || []).length, 'libraries');
        for (const lib of data.libraries || []) {
          libraries.push({
            ...lib,
            fullPath: lib.path,
            location: lib.location || 'icloud',
            exists: true
          });
        }
      } catch (e) {
        // Silently ignore expected file-not-found errors for iCloud libraries.json
        const isExpectedError = e.message?.includes("couldn't be opened") ||
                               e.message?.includes('no such file') ||
                               e.message?.includes('File not found');
        if (!isExpectedError) {
          console.log('[API] Error reading iCloud libraries.json:', e.message);
        }
      }
    }

    // Also check local Documents for any local-only libraries
    try {
      const result = await Filesystem.readFile({
        path: 'libraries.json',
        directory: Directory.Documents,
        encoding: Encoding.UTF8
      });

      const data = JSON.parse(result.data);
      for (const lib of data.libraries || []) {
        // Only add if not already in the list (avoid duplicates)
        if (!libraries.find(l => l.id === lib.id)) {
          libraries.push({
            ...lib,
            fullPath: lib.path,
            location: lib.location || 'local',
            exists: true
          });
        }
      }
    } catch (e) {
      // No local libraries.json, that's ok
      if (libraries.length === 0) {
        console.log('[API] No libraries.json found in iCloud or local');
      }
    }

    return libraries;
  },

  async createLibrary(options) {
    const { name, location: requestedLocation } = options;

    try {
      const id = crypto.randomUUID();
      const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Library';

      // Check if iCloud is available
      const isICloudAvailable = await this.isICloudAvailable();

      // Use iCloud if available and requested, otherwise fall back to local
      const useICloud = isICloudAvailable && requestedLocation !== 'local';
      const location = useICloud ? 'icloud' : 'local';

      console.log(`[API] Creating library in ${location} (iCloud available: ${isICloudAvailable})`);

      // Create library folder using appropriate backend
      await fsMkdir(safeName, location);
      await fsMkdir(`${safeName}/papers`, location);
      await fsMkdir(`${safeName}/text`, location);

      // Update libraries.json (store in Documents for consistency)
      let data = { version: 1, libraries: [] };
      try {
        const result = await Filesystem.readFile({
          path: 'libraries.json',
          directory: Directory.Documents,
          encoding: Encoding.UTF8
        });
        data = JSON.parse(result.data);
      } catch (e) {
        // No existing file, use default
      }

      data.libraries.push({
        id,
        name: safeName,
        path: safeName,
        location,
        createdAt: new Date().toISOString(),
        createdOn: 'iOS'
      });

      await Filesystem.writeFile({
        path: 'libraries.json',
        directory: Directory.Documents,
        data: JSON.stringify(data, null, 2),
        encoding: Encoding.UTF8
      });

      // Store current library info
      await Preferences.set({ key: 'currentLibraryId', value: id });
      await Preferences.set({ key: 'currentLibraryLocation', value: location });

      const message = useICloud
        ? `Created iCloud library: ${safeName}`
        : `Created local library: ${safeName} (iCloud not available)`;
      emit('consoleLog', { message, level: 'success' });

      return { success: true, id, path: safeName, location };
    } catch (error) {
      console.error('[API] Failed to create library:', error);
      return { success: false, error: error.message };
    }
  },

  async switchLibrary(libraryId) {
    console.log('[API.switchLibrary] Starting for library:', libraryId);
    try {
      // Find library by ID
      console.log('[API.switchLibrary] Getting all libraries...');
      const allLibraries = await this.getAllLibraries();
      console.log('[API.switchLibrary] Found', allLibraries.length, 'libraries');
      const library = allLibraries.find(l => l.id === libraryId);

      if (!library) {
        console.error('[API.switchLibrary] Library not found:', libraryId);
        return { success: false, error: 'Library not found' };
      }
      console.log('[API.switchLibrary] Found library:', library.name, 'at', library.fullPath);

      // Close current database
      if (MobileDB.isInitialized()) {
        console.log('[API.switchLibrary] Saving and closing current database...');
        await MobileDB.saveDatabase();
        MobileDB.closeDatabase();
      }
      dbInitialized = false;

      // Initialize database with location info
      console.log('[API.switchLibrary] Initializing database at', library.fullPath);
      await MobileDB.initDatabase(library.fullPath, library.location || 'local');
      dbInitialized = true;
      console.log('[API.switchLibrary] Database initialized');

      // Save current library info
      console.log('[API.switchLibrary] Saving preferences...');
      await Preferences.set({ key: 'currentLibraryId', value: libraryId });
      await Preferences.set({ key: 'libraryPath', value: library.fullPath });
      await Preferences.set({ key: 'currentLibraryLocation', value: library.location || 'local' });

      console.log('[API.switchLibrary] Complete');
      return { success: true, path: library.fullPath, location: library.location };
    } catch (error) {
      console.error('[API.switchLibrary] Failed:', error);
      return { success: false, error: error.message };
    }
  },

  async getCurrentLibraryId() {
    const result = await Preferences.get({ key: 'currentLibraryId' });
    return result.value || null;
  },

  async deleteLibrary(options) {
    const { libraryId, deleteFiles } = options;

    try {
      const allLibraries = await this.getAllLibraries();
      const library = allLibraries.find(l => l.id === libraryId);

      if (!library) {
        return { success: false, error: 'Library not found' };
      }

      // Don't allow deleting the current library
      const currentId = await this.getCurrentLibraryId();
      if (currentId === libraryId) {
        return { success: false, error: 'Cannot delete the currently active library. Switch to another library first.' };
      }

      const location = library.location || 'local';
      console.log(`[API] Deleting library "${library.name}" from ${location}`);

      // Delete files if requested
      if (deleteFiles && library.fullPath) {
        try {
          await fsRmdir(library.fullPath, location, true);
          emit('consoleLog', { message: `Deleted library folder: ${library.fullPath}`, level: 'info' });
        } catch (e) {
          console.error('[API] Failed to delete library folder:', e);
          emit('consoleLog', { message: `Warning: Could not delete folder: ${e.message}`, level: 'warn' });
        }
      }

      // Update libraries.json in the appropriate location (iCloud or local)
      if (location === 'icloud') {
        // Update iCloud libraries.json
        try {
          const result = await ICloud.readFile({
            path: 'libraries.json',
            encoding: 'utf8'
          });
          const data = JSON.parse(result.data);
          data.libraries = (data.libraries || []).filter(l => l.id !== libraryId);

          await ICloud.writeFile({
            path: 'libraries.json',
            data: JSON.stringify(data, null, 2),
            encoding: 'utf8',
            recursive: false
          });
          console.log('[API] Updated iCloud libraries.json');
        } catch (e) {
          console.error('[API] Failed to update iCloud libraries.json:', e);
        }
      } else {
        // Update local libraries.json
        try {
          const result = await Filesystem.readFile({
            path: 'libraries.json',
            directory: Directory.Documents,
            encoding: Encoding.UTF8
          });
          const data = JSON.parse(result.data);
          data.libraries = (data.libraries || []).filter(l => l.id !== libraryId);

          await Filesystem.writeFile({
            path: 'libraries.json',
            directory: Directory.Documents,
            data: JSON.stringify(data, null, 2),
            encoding: Encoding.UTF8
          });
          console.log('[API] Updated local libraries.json');
        } catch (e) {
          console.error('[API] Failed to update local libraries.json:', e);
        }
      }

      emit('consoleLog', { message: `Library "${library.name}" deleted`, level: 'success' });
      return { success: true };
    } catch (error) {
      console.error('[API] Failed to delete library:', error);
      return { success: false, error: error.message };
    }
  },

  async getLibraryFileInfo(libraryId) {
    // Return basic info for delete modal
    try {
      const allLibraries = await this.getAllLibraries();
      const library = allLibraries.find(l => l.id === libraryId);

      if (!library) {
        return { error: 'Library not found' };
      }

      return {
        libraryPath: library.fullPath,
        totalSize: 0, // Would need to calculate
        files: []
      };
    } catch (error) {
      return { error: error.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LIBRARY MIGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  async checkMigrationNeeded() {
    // iOS: Never show migration modal - users should use iCloud library picker
    // The migration modal (Move to iCloud / Keep Local) doesn't make sense on iOS
    // where all libraries are managed through iCloud
    return { needed: false };
  },

  async migrateLibraryToICloud(options) {
    const { libraryPath } = options;

    try {
      const isAvailable = await this.isICloudAvailable();
      if (!isAvailable) {
        return { success: false, error: 'iCloud is not available' };
      }

      const libraryName = 'ADS Library';
      const id = crypto.randomUUID();

      // Create target directory in iCloud using native plugin
      await fsMkdir(libraryName, 'icloud');
      await fsMkdir(`${libraryName}/papers`, 'icloud');
      await fsMkdir(`${libraryName}/text`, 'icloud');

      // Close database before migration
      if (MobileDB.isInitialized()) {
        await MobileDB.saveDatabase();
        MobileDB.closeDatabase();
      }
      dbInitialized = false;

      // Copy files from Documents to iCloud
      const localFiles = await fsReaddir(LIBRARY_FOLDER, 'local');

      for (const file of localFiles) {
        if (file.type === 'file') {
          try {
            const encoding = file.name.endsWith('.sqlite') ? null : 'utf8';
            const content = await fsReadFile(`${LIBRARY_FOLDER}/${file.name}`, 'local', encoding);
            await fsWriteFile(`${libraryName}/${file.name}`, content, 'icloud', encoding);
          } catch (e) {
            console.log('[API] Could not copy file:', file.name, e.message);
          }
        }
      }

      // Copy PDFs
      try {
        const pdfFiles = await fsReaddir(`${LIBRARY_FOLDER}/papers`, 'local');

        for (const file of pdfFiles) {
          if (file.type === 'file') {
            const content = await fsReadFile(`${LIBRARY_FOLDER}/papers/${file.name}`, 'local', null);
            await fsWriteFile(`${libraryName}/papers/${file.name}`, content, 'icloud', null);
          }
        }
      } catch (e) {
        // Silently ignore expected directory-not-found errors
        const isExpectedError = e.message?.includes("couldn't be opened") ||
                               e.message?.includes('no such file') ||
                               e.message?.includes('File not found') ||
                               e.message?.includes('does not exist');
        if (!isExpectedError) {
          console.log('[API] PDF migration error:', e.message);
        }
      }

      // Update libraries.json in iCloud
      let data = { version: 1, libraries: [] };
      try {
        const result = await fsReadFile('libraries.json', 'icloud');
        data = JSON.parse(result);
      } catch (e) {
        // No existing file
      }

      data.libraries.push({
        id,
        name: libraryName,
        path: libraryName,
        location: 'icloud',
        createdAt: new Date().toISOString(),
        createdOn: 'iOS',
        migratedFrom: 'local'
      });

      await fsWriteFile('libraries.json', JSON.stringify(data, null, 2), 'icloud');

      // Save preferences
      await Preferences.set({ key: 'currentLibraryId', value: id });
      await Preferences.set({ key: 'libraryPath', value: libraryName });
      await Preferences.set({ key: 'currentLibraryLocation', value: 'icloud' });
      await Preferences.set({ key: 'migrationCompleted', value: 'true' });

      // Delete old local folder
      try {
        await fsRmdir(LIBRARY_FOLDER, 'local', true);
      } catch (e) {
        console.log('[API] Could not delete old local folder:', e.message);
      }

      // Reinitialize database from iCloud
      await MobileDB.initDatabaseFromICloud(libraryName);
      dbInitialized = true;

      console.log('[API] Migration to iCloud complete');
      return { success: true, path: libraryName, id };
    } catch (error) {
      console.error('[API] Failed to migrate to iCloud:', error);
      return { success: false, error: error.message };
    }
  },

  async registerLibraryLocal(options) {
    // On iOS, all libraries go to iCloud
    // This just registers the current local library for now
    return this.migrateLibraryToICloud(options);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PDF SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════

  async getPdfZoom() {
    const result = await Preferences.get({ key: 'pdfZoom' });
    return result.value ? parseFloat(result.value) : 1.0;
  },

  async setPdfZoom(zoom) {
    await Preferences.set({ key: 'pdfZoom', value: String(zoom) });
  },

  async getSortPreferences() {
    const field = await Preferences.get({ key: 'sortField' });
    const order = await Preferences.get({ key: 'sortOrder' });
    return {
      field: field.value || 'added',
      order: order.value || 'desc'
    };
  },

  async setSortPreferences(field, order) {
    await Preferences.set({ key: 'sortField', value: field });
    await Preferences.set({ key: 'sortOrder', value: order });
  },

  async getFocusSplitPosition() {
    const result = await Preferences.get({ key: 'focusSplitPosition' });
    return result.value ? parseFloat(result.value) : 50;
  },

  async setFocusSplitPosition(position) {
    await Preferences.set({ key: 'focusSplitPosition', value: String(position) });
  },

  async getPdfPositions() {
    const result = await Preferences.get({ key: 'pdfPositions' });
    return safeJsonParse(result.value) || {};
  },

  async setPdfPosition(paperId, position) {
    const positions = await this.getPdfPositions();
    positions[paperId] = position;
    await Preferences.set({ key: 'pdfPositions', value: JSON.stringify(positions) });
  },

  async getLastSelectedPaper() {
    const result = await Preferences.get({ key: 'lastSelectedPaperId' });
    return result.value ? parseInt(result.value) : null;
  },

  async setLastSelectedPaper(paperId) {
    await Preferences.set({ key: 'lastSelectedPaperId', value: String(paperId) });
  },

  async getLastPdfSources() {
    const result = await Preferences.get({ key: 'lastPdfSources' });
    return safeJsonParse(result.value) || {};
  },

  async setLastPdfSource(paperId, sourceType) {
    const sources = await this.getLastPdfSources();
    sources[paperId] = sourceType;
    await Preferences.set({ key: 'lastPdfSources', value: JSON.stringify(sources) });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ADS SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════

  async getAdsToken() {
    return await Keychain.getItem('adsToken');
  },

  async setAdsToken(token) {
    try {
      // Validate token by making a test API call
      const testResponse = await CapacitorHttp.request({
        method: 'GET',
        url: 'https://api.adsabs.harvard.edu/v1/search/query?q=bibcode:"2020ApJ...900..100D"&rows=1',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (testResponse.status !== 200) {
        return { success: false, error: `Invalid token (status ${testResponse.status})` };
      }

      // Token is valid, save it
      await Keychain.setItem('adsToken', token);
      return { success: true };
    } catch (error) {
      console.error('[API] Failed to save ADS token:', error);
      return { success: false, error: error.message };
    }
  },

  async getLibraryProxy() {
    const DEFAULT_LIBRARY_PROXY = 'https://stanford.idm.oclc.org/login?url=';
    const result = await Preferences.get({ key: 'libraryProxyUrl' });
    return result.value || DEFAULT_LIBRARY_PROXY;
  },

  async setLibraryProxy(proxyUrl) {
    try {
      await Preferences.set({ key: 'libraryProxyUrl', value: proxyUrl });
      return { success: true };
    } catch (error) {
      console.error('[API] Failed to save library proxy:', error);
      return { success: false, error: error.message };
    }
  },

  async getPdfPriority() {
    const result = await Preferences.get({ key: 'pdfPriority' });
    return safeJsonParse(result.value) || ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF'];
  },

  async setPdfPriority(priority) {
    try {
      await Preferences.set({ key: 'pdfPriority', value: JSON.stringify(priority) });
      return { success: true };
    } catch (error) {
      console.error('[API] Failed to save PDF priority:', error);
      return { success: false, error: error.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CLOUD PROVIDER API KEYS
  // ═══════════════════════════════════════════════════════════════════════════

  async getApiKey(provider) {
    try {
      const key = await Keychain.getItem(`apiKey_${provider}`);
      return key || null;
    } catch (error) {
      console.error(`[API] Failed to get API key for ${provider}:`, error);
      return null;
    }
  },

  async setApiKey(provider, key) {
    try {
      if (!key || key.trim() === '') {
        // If empty key, delete it
        await Keychain.removeItem(`apiKey_${provider}`);
        return { success: true };
      }
      await Keychain.setItem(`apiKey_${provider}`, key.trim());
      console.log(`[API] Saved API key for ${provider}`);
      return { success: true };
    } catch (error) {
      console.error(`[API] Failed to save API key for ${provider}:`, error);
      return { success: false, error: error.message };
    }
  },

  async deleteApiKey(provider) {
    try {
      await Keychain.removeItem(`apiKey_${provider}`);
      console.log(`[API] Deleted API key for ${provider}`);
      return { success: true };
    } catch (error) {
      console.error(`[API] Failed to delete API key for ${provider}:`, error);
      return { success: false, error: error.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PAPER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  async getAllPapers(options = {}) {
    try {
      if (!dbInitialized) await initializeDatabase();

      // Map sortBy to orderBy for database query
      const dbOptions = {
        orderBy: options.sortBy === 'date_added' ? 'added_date' : options.sortBy,
        order: options.sortOrder === 'desc' ? 'DESC' : 'ASC',
        search: options.search,
        readStatus: options.readStatus,
        collectionId: options.collectionId
      };

      const papers = MobileDB.getAllPapers(dbOptions);

      // Save database periodically
      await MobileDB.saveDatabase();

      return papers;
    } catch (error) {
      console.error('[API] getAllPapers error:', error);
      return [];
    }
  },

  async getPaper(id) {
    if (!dbInitialized) await initializeDatabase();
    return MobileDB.getPaper(id);
  },

  async updatePaper(id, updates) {
    try {
      if (!dbInitialized) await initializeDatabase();
      const success = MobileDB.updatePaper(id, updates);
      await MobileDB.saveDatabase();
      return { success };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async deletePaper(id) {
    try {
      if (!dbInitialized) await initializeDatabase();

      // Get paper to find PDF path
      const paper = MobileDB.getPaper(id);
      if (paper && paper.pdf_path) {
        try {
          await Filesystem.deleteFile({
            path: `${LIBRARY_FOLDER}/${paper.pdf_path}`,
            directory: Directory.Documents
          });
        } catch (e) {
          // PDF may not exist
        }
      }

      const success = MobileDB.deletePaper(id);
      await MobileDB.saveDatabase();
      return { success };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async deletePapersBulk(ids) {
    try {
      if (!dbInitialized) await initializeDatabase();
      for (const id of ids) {
        await this.deletePaper(id);
      }
      await MobileDB.saveDatabase();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async searchPapers(query) {
    try {
      if (!dbInitialized) await initializeDatabase();
      const papers = MobileDB.getAllPapers({ search: query });
      // Wrap in expected format: { paper, matchCount, matchSource, context }
      return papers.map(paper => ({
        paper,
        matchCount: 1,
        matchSource: 'search',
        context: ''
      }));
    } catch (error) {
      return [];
    }
  },

  async getPdfPath(relativePath) {
    // Return URI for PDF viewing - but only if file actually exists
    try {
      // Use current library path and location
      const currentLibraryPath = MobileDB.getLibraryPath() || LIBRARY_FOLDER;
      const location = MobileDB.getLocation?.() || 'local';
      const fullPath = relativePath.startsWith(currentLibraryPath)
        ? relativePath
        : `${currentLibraryPath}/${relativePath}`;

      // Check if file exists using appropriate filesystem
      if (location === 'icloud') {
        await ICloud.stat({ path: fullPath });
        // For iCloud, return the path directly (getPdfAsBlob will read it)
        return fullPath;
      } else {
        // Local - check and get URI
        await Filesystem.stat({
          path: fullPath,
          directory: Directory.Documents
        });
        const result = await Filesystem.getUri({
          path: fullPath,
          directory: Directory.Documents
        });
        return result.uri;
      }
    } catch {
      // File doesn't exist or error
      return null;
    }
  },

  async getPdfAsBlob(relativePath) {
    // Read PDF as Uint8Array for iOS WKWebView (file:// URLs don't work)
    // Returns Uint8Array directly for PDF.js (blob URLs don't work reliably in WKWebView)
    try {
      // Use current library path and location
      const currentLibraryPath = MobileDB.getLibraryPath() || LIBRARY_FOLDER;
      const location = MobileDB.getLocation?.() || 'local';
      const fullPath = relativePath.startsWith(currentLibraryPath)
        ? relativePath
        : `${currentLibraryPath}/${relativePath}`;

      console.log('[getPdfAsBlob] Library path:', currentLibraryPath, 'Location:', location, 'Full path:', fullPath);

      // Read file using the appropriate filesystem based on location
      let base64Data;
      if (location === 'icloud') {
        const result = await ICloud.readFile({
          path: fullPath,
          encoding: null
        });
        base64Data = result.data;
      } else {
        // Local storage - use Filesystem plugin
        const result = await Filesystem.readFile({
          path: fullPath,
          directory: Directory.Documents
        });
        base64Data = result.data;
      }

      // Convert base64 to Uint8Array (PDF.js accepts this directly)
      const byteCharacters = atob(base64Data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);

      // Return the Uint8Array directly - PDF.js can use this with { data: byteArray }
      return byteArray;
    } catch (error) {
      // Don't log "file not found" errors - these are expected on iOS when PDFs aren't synced
      if (!error.message?.includes("couldn't be opened") && !error.message?.includes('no such file') && !error.message?.includes('File not found')) {
        console.error('[getPdfAsBlob] Error:', error);
      }
      return null;
    }
  },

  async openPdfNative(relativePath) {
    // Open PDF in native iOS viewer (Quick Look)
    try {
      // Add library folder prefix if not present
      const fullPath = relativePath.startsWith(LIBRARY_FOLDER)
        ? relativePath
        : `${LIBRARY_FOLDER}/${relativePath}`;

      const result = await Filesystem.getUri({
        path: fullPath,
        directory: Directory.Documents
      });

      if (!result.uri) {
        return { success: false, error: 'PDF file not found' };
      }

      // Open with native viewer
      await FileOpener.open({
        filePath: result.uri,
        contentType: 'application/pdf',
        openWithDefault: true
      });

      return { success: true };
    } catch (error) {
      console.error('[openPdfNative] Error:', error);
      return { success: false, error: error.message };
    }
  },

  async openAttachment(filename) {
    // Open any file attachment with native app
    try {
      const fullPath = `${LIBRARY_FOLDER}/papers/${filename}`;

      const result = await Filesystem.getUri({
        path: fullPath,
        directory: Directory.Documents
      });

      if (!result.uri) {
        return { success: false, error: 'File not found' };
      }

      // Determine content type from filename
      const ext = filename.split('.').pop().toLowerCase();
      const contentTypes = {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        txt: 'text/plain',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      };
      const contentType = contentTypes[ext] || 'application/octet-stream';

      await FileOpener.open({
        filePath: result.uri,
        contentType,
        openWithDefault: true
      });

      return { success: true };
    } catch (error) {
      console.error('[openAttachment] Error:', error);
      return { success: false, error: error.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // COLLECTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async getCollections() {
    try {
      if (!dbInitialized) await initializeDatabase();
      return MobileDB.getCollections();
    } catch (error) {
      console.error('[API] getCollections error:', error);
      return [];
    }
  },

  async createCollection(name, parentId = null, isSmart = false, query = null) {
    try {
      if (!dbInitialized) await initializeDatabase();
      const id = MobileDB.createCollection(name, parentId);
      await MobileDB.saveDatabase();
      return { success: true, id };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async deleteCollection(collectionId) {
    try {
      if (!dbInitialized) await initializeDatabase();
      // TODO: Implement deleteCollection in MobileDB
      return { success: false, error: 'Not yet implemented' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async addPaperToCollection(paperId, collectionId) {
    try {
      if (!dbInitialized) await initializeDatabase();
      MobileDB.addPaperToCollection(paperId, collectionId);
      await MobileDB.saveDatabase();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async removePaperFromCollection(paperId, collectionId) {
    try {
      if (!dbInitialized) await initializeDatabase();
      MobileDB.removePaperFromCollection(paperId, collectionId);
      await MobileDB.saveDatabase();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async getPapersInCollection(collectionId) {
    try {
      if (!dbInitialized) await initializeDatabase();
      return MobileDB.getAllPapers({ collectionId });
    } catch (error) {
      return [];
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // REFERENCES & CITATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async getReferences(paperId) {
    try {
      if (!dbInitialized) await initializeDatabase();
      const refs = MobileDB.getReferences(paperId);

      // Add "inLibrary" flag for each reference
      const allPapers = MobileDB.getAllPapers();
      const libraryBibcodes = new Set(allPapers.map(p => p.bibcode).filter(Boolean));

      return refs.map(ref => ({
        ...ref,
        inLibrary: ref.bibcode ? libraryBibcodes.has(ref.bibcode) : false
      }));
    } catch (error) {
      console.error('[getReferences] Error:', error);
      return [];
    }
  },

  async getCitations(paperId) {
    try {
      if (!dbInitialized) await initializeDatabase();
      const cites = MobileDB.getCitations(paperId);

      // Add "inLibrary" flag for each citation
      const allPapers = MobileDB.getAllPapers();
      const libraryBibcodes = new Set(allPapers.map(p => p.bibcode).filter(Boolean));

      return cites.map(cite => ({
        ...cite,
        inLibrary: cite.bibcode ? libraryBibcodes.has(cite.bibcode) : false
      }));
    } catch (error) {
      console.error('[getCitations] Error:', error);
      return [];
    }
  },

  async addReferences(paperId, refs) {
    try {
      if (!dbInitialized) await initializeDatabase();
      // Normalize format - ADS returns title as array sometimes
      const normalized = refs.map(r => ({
        bibcode: r.bibcode,
        title: Array.isArray(r.title) ? r.title[0] : r.title,
        author: Array.isArray(r.author) ? r.author : (r.authors ? r.authors.split(', ') : []),
        year: r.year
      }));
      MobileDB.addReferences(paperId, normalized);
      await MobileDB.saveDatabase();
      return { success: true };
    } catch (error) {
      console.error('[addReferences] Error:', error);
      return { success: false, error: error.message };
    }
  },

  async addCitations(paperId, cites) {
    try {
      if (!dbInitialized) await initializeDatabase();
      // Normalize format - ADS returns title as array sometimes
      const normalized = cites.map(c => ({
        bibcode: c.bibcode,
        title: Array.isArray(c.title) ? c.title[0] : c.title,
        author: Array.isArray(c.author) ? c.author : (c.authors ? c.authors.split(', ') : []),
        year: c.year
      }));
      MobileDB.addCitations(paperId, normalized);
      await MobileDB.saveDatabase();
      return { success: true };
    } catch (error) {
      console.error('[addCitations] Error:', error);
      return { success: false, error: error.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ADS API INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  async adsSearch(query, options = {}) {
    try {
      const token = await this.getAdsToken();
      if (!token) {
        return { success: false, error: 'ADS token not configured. Please add your token in Settings.' };
      }

      const fields = 'bibcode,title,author,year,doi,abstract,keyword,pub,identifier,arxiv_class,citation_count';
      const rows = options.rows || 10;
      const start = options.start || 0;
      const sort = options.sort || 'date desc';

      const params = new URLSearchParams({
        q: query,
        fl: fields,
        rows: rows.toString(),
        start: start.toString(),
        sort: sort
      });

      const url = `${ADS_API_BASE}/search/query?${params}`;

      const response = await CapacitorHttp.get({
        url: url,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.status !== 200) {
        const errorText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        throw new Error(`ADS API error (${response.status}): ${errorText.substring(0, 200)}`);
      }

      const result = response.data;
      const docs = result.response?.docs || [];
      const numFound = result.response?.numFound || 0;

      // Convert to paper format
      const papers = docs.map(doc => {
        const paper = adsToPaper(doc);
        paper._raw = doc; // Keep raw data for metadata application
        return paper;
      });

      return {
        success: true,
        data: {
          papers,
          numFound,
          start: result.response?.start || 0
        }
      };
    } catch (error) {
      console.error('[adsSearch] Error:', error);
      let errorMessage = error.message;
      if (error.message === 'Load failed' || error.message.includes('Failed to fetch')) {
        errorMessage = 'Network error: Could not connect to ADS API.';
      } else if (error.message.includes('401')) {
        errorMessage = 'Invalid API token. Please check your ADS token in Settings.';
      }
      return { success: false, error: errorMessage };
    }
  },

  async adsLookup(identifier, type) {
    try {
      const token = await this.getAdsToken();
      if (!token) {
        return { success: false, error: 'ADS token not configured' };
      }

      let query;
      switch (type) {
        case 'bibcode':
          query = `bibcode:"${identifier}"`;
          break;
        case 'doi':
          query = `doi:"${identifier}"`;
          break;
        case 'arxiv':
          query = `identifier:"arXiv:${identifier}" OR identifier:"${identifier}"`;
          break;
        default:
          return { success: false, error: 'Unknown identifier type' };
      }

      const fields = 'bibcode,title,author,year,doi,abstract,keyword,pub,identifier,arxiv_class,citation_count';
      const params = new URLSearchParams({
        q: query,
        fl: fields,
        rows: '1'
      });

      const url = `${ADS_API_BASE}/search/query?${params}`;

      const response = await CapacitorHttp.get({
        url: url,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.status !== 200) {
        throw new Error(`ADS API error (${response.status})`);
      }

      const result = response.data;
      const docs = result.response?.docs || [];

      if (docs.length === 0) {
        return { success: false, error: 'Paper not found' };
      }

      return { success: true, data: adsToPaper(docs[0]) };
    } catch (error) {
      console.error('[adsLookup] Error:', error);
      return { success: false, error: error.message };
    }
  },

  async adsGetEsources(bibcode) {
    try {
      const token = await Keychain.getItem('adsToken');
      if (!token) {
        return { success: false, error: 'No ADS API token configured' };
      }

      emit('consoleLog', { message: `Fetching PDF sources for ${bibcode}...`, level: 'info' });

      const esourcesUrl = `${ADS_API_BASE}/resolver/${bibcode}/esource`;
      const response = await CapacitorHttp.get({
        url: esourcesUrl,
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.status !== 200) {
        return { success: false, error: `ADS API error: ${response.status}` };
      }

      // Parse the esources response
      const esources = parseEsourcesResponse(response.data);

      emit('consoleLog', { message: `ADS returned ${esources.length} esource(s)`, level: 'info' });

      // Categorize sources by type
      const sources = {
        arxiv: null,
        ads: null,
        publisher: null
      };

      for (const source of esources) {
        const linkType = source.link_type || source.type || '';
        const url = source.url;

        if (!url || !url.startsWith('http')) continue;

        if (linkType.includes('EPRINT_PDF') && !sources.arxiv) {
          sources.arxiv = { url, type: 'EPRINT_PDF', label: 'arXiv' };
        } else if (linkType.includes('ADS_PDF') && !sources.ads) {
          sources.ads = { url, type: 'ADS_PDF', label: 'ADS Scan' };
        } else if (linkType.includes('PUB_PDF') && !sources.publisher) {
          sources.publisher = { url, type: 'PUB_PDF', label: 'Publisher' };
        }
      }

      return { success: true, data: sources };
    } catch (error) {
      console.error('[adsGetEsources] Error:', error);
      return { success: false, error: error.message };
    }
  },

  async downloadPdfFromSource(paperId, sourceType) {
    try {
      const paper = MobileDB.getPaper(paperId);
      if (!paper) {
        return { success: false, error: 'Paper not found' };
      }
      if (!paper.bibcode) {
        return { success: false, error: 'Paper has no bibcode' };
      }

      const token = await Keychain.getItem('adsToken');
      if (!token) {
        return { success: false, error: 'No ADS API token configured' };
      }

      emit('consoleLog', { message: `Downloading ${sourceType} PDF for ${paper.bibcode}...`, level: 'info' });

      // Ensure library folders exist
      await ensureLibraryExists();

      // Get esources
      const esourcesUrl = `${ADS_API_BASE}/resolver/${paper.bibcode}/esource`;
      const response = await CapacitorHttp.get({
        url: esourcesUrl,
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.status !== 200) {
        return { success: false, error: 'Failed to get PDF sources' };
      }

      // Parse esources
      const esources = parseEsourcesResponse(response.data);

      // Map user-friendly type to ADS type
      const typeMap = {
        'arxiv': 'EPRINT_PDF',
        'ads': 'ADS_PDF',
        'publisher': 'PUB_PDF'
      };
      const adsType = typeMap[sourceType];
      if (!adsType) {
        return { success: false, error: `Unknown source type: ${sourceType}` };
      }

      // Find the requested source
      let targetSource = null;
      for (const source of esources) {
        const linkType = source.link_type || source.type || '';
        if (linkType.includes(adsType) && source.url && source.url.startsWith('http')) {
          targetSource = source;
          break;
        }
      }

      if (!targetSource) {
        emit('consoleLog', { message: `${sourceType} PDF not found in esources`, level: 'error' });
        return { success: false, error: `${sourceType} PDF not available` };
      }

      // Generate filename: bibcode_SOURCETYPE.pdf
      const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `${baseFilename}_${adsType}.pdf`;
      const filePath = `${LIBRARY_FOLDER}/papers/${filename}`;

      // Check if already exists
      try {
        await Filesystem.stat({
          path: filePath,
          directory: Directory.Documents
        });
        emit('consoleLog', { message: `${sourceType} PDF already downloaded`, level: 'success' });
        return { success: true, source: sourceType, alreadyExists: true };
      } catch (e) {
        // File doesn't exist, proceed with download
      }

      // For arXiv, construct direct PDF URL
      let pdfUrl = targetSource.url;
      if (sourceType === 'arxiv' && paper.arxiv_id) {
        pdfUrl = `https://arxiv.org/pdf/${paper.arxiv_id}.pdf`;
      }

      emit('consoleLog', { message: `Downloading from ${pdfUrl.substring(0, 50)}...`, level: 'info' });

      // Download the PDF
      const downloadResult = await Filesystem.downloadFile({
        url: pdfUrl,
        path: filePath,
        directory: Directory.Documents,
        progress: true
      });

      if (downloadResult.path) {
        // Register in paper_files table with hash for unified storage approach
        try {
          const stat = await Filesystem.stat({ path: filePath, directory: Directory.Documents });

          // Read file to compute hash (for content-addressed storage compatibility)
          let fileHash = null;
          try {
            const fileContent = await Filesystem.readFile({
              path: filePath,
              directory: Directory.Documents
            });
            if (fileContent.data) {
              fileHash = await capacitorAPI._computeFileHash(fileContent.data);
            }
          } catch (hashError) {
            console.warn('[downloadPdfFromSource] Could not compute hash:', hashError);
          }

          MobileDB.addPaperFile(paperId, {
            filename: filename,
            original_name: filename,
            file_hash: fileHash,
            mime_type: 'application/pdf',
            file_size: stat.size || 0,
            file_role: 'pdf',
            source_type: adsType,
            status: 'ready'
          });
        } catch (e) {
          console.error('[downloadPdfFromSource] Failed to register paper file:', e);
        }

        emit('consoleLog', { message: `${sourceType} PDF downloaded successfully`, level: 'success' });
        return { success: true, source: sourceType };
      }

      return { success: false, error: 'Download failed' };
    } catch (error) {
      console.error('[downloadPdfFromSource] Error:', error);
      emit('consoleLog', { message: `Download failed: ${error.message}`, level: 'error' });
      return { success: false, error: error.message };
    }
  },

  async downloadPublisherPdf(paperId, publisherUrl, proxyUrl) {
    return { success: false, error: 'Not implemented for iOS' };
  },

  async checkPdfExists(paperId, sourceType) {
    return false;
  },

  async getAttachments(paperId) {
    // Not implemented for iOS - return empty array
    return [];
  },

  async adsSyncPapers(paperIds) {
    try {
      // Reset cancellation flag at start
      syncCancelled = false;

      const token = await Keychain.getItem('adsToken');
      if (!token) {
        return { success: false, error: 'No ADS API token configured' };
      }

      if (!dbInitialized) await initializeDatabase();

      // Get papers to sync
      let papersToSync;
      if (paperIds && paperIds.length > 0) {
        papersToSync = paperIds.map(id => MobileDB.getPaper(id)).filter(p => p);
      } else {
        papersToSync = MobileDB.getAllPapers();
      }

      if (papersToSync.length === 0) {
        return { success: true, results: { total: 0, updated: 0, failed: 0 } };
      }

      // Filter papers with bibcodes
      const papersWithBibcode = papersToSync.filter(p => p.bibcode);
      const papersWithoutBibcode = papersToSync.filter(p => !p.bibcode && (p.doi || p.arxiv_id));

      emit('consoleLog', { message: `Sync: ${papersWithBibcode.length} with bibcode, ${papersWithoutBibcode.length} with doi/arxiv`, level: 'info' });

      const results = {
        total: papersToSync.length,
        updated: 0,
        failed: 0,
        errors: []
      };

      let bytesReceived = 0;

      // Helper to merge ADS metadata with existing paper
      const mergeMetadata = (existing, adsMetadata) => {
        const merged = {};
        const allKeys = new Set([...Object.keys(existing), ...Object.keys(adsMetadata)]);

        for (const key of allKeys) {
          const adsValue = adsMetadata[key];
          const existingValue = existing[key];

          const adsHasValue = adsValue !== null && adsValue !== undefined &&
            adsValue !== '' &&
            !(Array.isArray(adsValue) && adsValue.length === 0);

          if (adsHasValue) {
            merged[key] = adsValue;
          } else if (existingValue !== undefined) {
            merged[key] = existingValue;
          }
        }

        return merged;
      };

      // Helper for retry logic on 500 errors
      const fetchWithRetry = async (url, options, maxRetries = 3) => {
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const response = await CapacitorHttp.get({ url, ...options });
            if (response.status === 500 && attempt < maxRetries) {
              emit('consoleLog', { message: `ADS 500 error, retry ${attempt}/${maxRetries}...`, level: 'warn' });
              await new Promise(r => setTimeout(r, 1000 * attempt));
              continue;
            }
            bytesReceived += JSON.stringify(response.data || '').length;
            return response;
          } catch (e) {
            lastError = e;
            if (attempt < maxRetries) {
              await new Promise(r => setTimeout(r, 1000 * attempt));
            }
          }
        }
        throw lastError;
      };

      // Process papers with bibcodes
      if (papersWithBibcode.length > 0) {
        const bibcodes = papersWithBibcode.map(p => p.bibcode);
        emit('consoleLog', { message: `Batch fetching ${bibcodes.length} papers from ADS...`, level: 'info' });

        // Build batch query: bibcode:"X" OR bibcode:"Y"
        const bibcodeQuery = bibcodes.map(b => `bibcode:"${b}"`).join(' OR ');
        const fields = 'bibcode,title,author,year,doi,abstract,keyword,pub,identifier,arxiv_class,citation_count';

        const searchUrl = `${ADS_API_BASE}/search/query?q=${encodeURIComponent(bibcodeQuery)}&fl=${fields}&rows=${bibcodes.length}`;

        let adsResults = [];
        try {
          const response = await fetchWithRetry(searchUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
          });

          if (response.status === 200 && response.data?.response?.docs) {
            adsResults = response.data.response.docs;
          }
        } catch (e) {
          emit('consoleLog', { message: `Batch fetch failed: ${e.message}`, level: 'error' });
        }

        // Create lookup maps
        const adsMap = new Map();
        const adsMapNormalized = new Map();
        for (const r of adsResults) {
          adsMap.set(r.bibcode, r);
          adsMapNormalized.set(r.bibcode.replace(/\./g, ''), r);
        }

        emit('consoleLog', { message: `Fetched metadata for ${adsResults.length}/${bibcodes.length} papers`, level: 'success' });

        // Batch fetch BibTeX
        let bibtexMap = new Map();
        try {
          emit('consoleLog', { message: `Fetching BibTeX entries...`, level: 'info' });
          const bibtexResponse = await CapacitorHttp.post({
            url: `${ADS_API_BASE}/export/bibtex`,
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            data: { bibcode: bibcodes }
          });

          bytesReceived += JSON.stringify(bibtexResponse.data || '').length;

          if (bibtexResponse.status === 200 && bibtexResponse.data?.export) {
            const bibtexStr = bibtexResponse.data.export;
            // Parse combined bibtex to map by bibcode
            const entries = bibtexStr.split(/(?=@)/);
            for (const entry of entries) {
              if (!entry.trim()) continue;
              // Extract bibcode from adsurl field
              const adsurlMatch = entry.match(/adsurl\s*=\s*\{[^}]*\/abs\/([^}\/]+)/i);
              if (adsurlMatch) {
                const extractedBibcode = adsurlMatch[1];
                const matchingBibcode = bibcodes.find(b =>
                  b === extractedBibcode ||
                  b.replace(/\./g, '') === extractedBibcode.replace(/\./g, '')
                );
                if (matchingBibcode) {
                  bibtexMap.set(matchingBibcode, '@' + entry.replace(/^@/, '').trim());
                  continue;
                }
              }
              // Fallback: check if entry contains any of our bibcodes
              for (const bibcode of bibcodes) {
                if (entry.includes(bibcode) || entry.includes(bibcode.replace(/\./g, ''))) {
                  bibtexMap.set(bibcode, '@' + entry.replace(/^@/, '').trim());
                  break;
                }
              }
            }
          }
          emit('consoleLog', { message: `Got BibTeX for ${bibtexMap.size} papers`, level: 'success' });
        } catch (e) {
          emit('consoleLog', { message: `BibTeX fetch failed: ${e.message}`, level: 'warn' });
        }

        // Process each paper
        for (let i = 0; i < papersWithBibcode.length; i++) {
          // Check for cancellation
          if (syncCancelled) {
            emit('consoleLog', { message: 'Sync cancelled by user', level: 'warn' });
            emit('adsSyncProgress', {
              current: i,
              total: papersToSync.length,
              paper: 'Complete',
              bytesReceived,
              done: true,
              cancelled: true
            });
            await MobileDB.saveDatabase();
            return { success: true, results, cancelled: true };
          }

          const paper = papersWithBibcode[i];
          const bibcode = paper.bibcode;

          emit('adsSyncProgress', {
            current: i + 1,
            total: papersToSync.length,
            paper: paper.title || bibcode,
            bytesReceived
          });

          // Find ADS data
          let adsData = adsMap.get(bibcode) || adsMapNormalized.get(bibcode.replace(/\./g, ''));

          if (!adsData) {
            emit('consoleLog', { message: `[${bibcode}] Not found in ADS`, level: 'warn' });
            results.failed++;
            continue;
          }

          try {
            emit('consoleLog', { message: `[${bibcode}] Updating metadata...`, level: 'info' });
            const adsMetadata = adsToPaper(adsData);
            const mergedMetadata = mergeMetadata(paper, adsMetadata);

            // Get BibTeX
            const bibtexStr = bibtexMap.get(bibcode) || paper.bibtex;

            // Update paper metadata
            MobileDB.updatePaper(paper.id, {
              ...mergedMetadata,
              bibtex: bibtexStr
            });

            // Download PDF if paper doesn't have one yet
            if (!paper.pdf_path) {
              try {
                emit('consoleLog', { message: `[${bibcode}] Downloading PDF...`, level: 'info' });
                const pdfPriority = await capacitorAPI.getPdfPriority() || ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF'];
                const downloadResult = await downloadPaperPdf({ ...paper, ...adsMetadata }, token, pdfPriority);
                if (downloadResult.success) {
                  MobileDB.updatePaper(paper.id, {
                    pdf_path: downloadResult.path,
                    pdf_source: downloadResult.source
                  });
                  emit('consoleLog', { message: `[${bibcode}] PDF downloaded (${downloadResult.source})`, level: 'success' });
                } else {
                  emit('consoleLog', { message: `[${bibcode}] No PDF available`, level: 'warn' });
                }
              } catch (pdfErr) {
                emit('consoleLog', { message: `[${bibcode}] PDF download failed: ${pdfErr.message}`, level: 'warn' });
              }
            }

            emit('consoleLog', { message: `[${bibcode}] Done`, level: 'success' });
            results.updated++;
          } catch (e) {
            emit('consoleLog', { message: `[${bibcode}] Error: ${e.message}`, level: 'error' });
            results.failed++;
            results.errors.push({ bibcode, error: e.message });
          }
        }
      }

      // Handle papers without bibcode (DOI or arXiv lookup)
      for (const paper of papersWithoutBibcode) {
        const identifier = paper.doi || paper.arxiv_id;
        emit('consoleLog', { message: `Looking up ${identifier}...`, level: 'info' });

        try {
          let query;
          if (paper.doi) {
            query = `doi:"${paper.doi}"`;
          } else if (paper.arxiv_id) {
            query = `identifier:"arXiv:${paper.arxiv_id}"`;
          }

          const fields = 'bibcode,title,author,year,doi,abstract,keyword,pub,identifier,arxiv_class,citation_count';
          const searchUrl = `${ADS_API_BASE}/search/query?q=${encodeURIComponent(query)}&fl=${fields}&rows=1`;

          const response = await fetchWithRetry(searchUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
          });

          if (response.status === 200 && response.data?.response?.docs?.[0]) {
            const adsData = response.data.response.docs[0];
            const adsMetadata = adsToPaper(adsData);
            const mergedMetadata = mergeMetadata(paper, adsMetadata);

            MobileDB.updatePaper(paper.id, mergedMetadata);
            emit('consoleLog', { message: `[${identifier}] Found and updated`, level: 'success' });
            results.updated++;
          } else {
            emit('consoleLog', { message: `[${identifier}] Not found in ADS`, level: 'warn' });
            results.failed++;
          }
        } catch (e) {
          emit('consoleLog', { message: `[${identifier}] Error: ${e.message}`, level: 'error' });
          results.failed++;
        }
      }

      await MobileDB.saveDatabase();

      emit('consoleLog', { message: `Sync complete: ${results.updated} updated, ${results.failed} failed`, level: 'success' });
      emit('adsSyncProgress', {
        current: results.total,
        total: results.total,
        paper: 'Complete',
        bytesReceived,
        done: true,
        results: results
      });

      return { success: true, results };
    } catch (error) {
      console.error('[adsSyncPapers] Error:', error);
      emit('consoleLog', { message: `Sync failed: ${error.message}`, level: 'error' });
      return { success: false, error: error.message };
    }
  },

  async adsCancelSync() {
    syncCancelled = true;
    emit('consoleLog', { message: 'Sync cancellation requested...', level: 'warn' });
    return { success: true };
  },

  async adsGetReferences(bibcode, options = {}) {
    try {
      const token = await Keychain.getItem('adsToken');
      if (!token) {
        return { success: false, error: 'No ADS API token configured' };
      }

      const rows = options.rows || 50;
      const fields = 'bibcode,title,author,year';
      const query = `references(bibcode:"${bibcode}")`;
      const url = `${ADS_API_BASE}/search/query?q=${encodeURIComponent(query)}&fl=${fields}&rows=${rows}`;

      emit('consoleLog', { message: `Fetching references for ${bibcode}...`, level: 'info' });

      const response = await CapacitorHttp.get({
        url,
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.status !== 200) {
        return { success: false, error: `ADS API error: ${response.status}` };
      }

      const docs = response.data?.response?.docs || [];
      const references = docs.map(doc => ({
        bibcode: doc.bibcode,
        title: doc.title?.[0] || 'Untitled',
        author: doc.author || [],
        year: doc.year
      }));

      emit('consoleLog', { message: `Found ${references.length} references`, level: 'success' });

      return { success: true, data: references };
    } catch (error) {
      console.error('[adsGetReferences] Error:', error);
      return { success: false, error: error.message };
    }
  },

  async adsGetCitations(bibcode, options = {}) {
    try {
      const token = await Keychain.getItem('adsToken');
      if (!token) {
        return { success: false, error: 'No ADS API token configured' };
      }

      const rows = options.rows || 50;
      const fields = 'bibcode,title,author,year';
      const query = `citations(bibcode:"${bibcode}")`;
      const url = `${ADS_API_BASE}/search/query?q=${encodeURIComponent(query)}&fl=${fields}&rows=${rows}`;

      emit('consoleLog', { message: `Fetching citations for ${bibcode}...`, level: 'info' });

      const response = await CapacitorHttp.get({
        url,
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.status !== 200) {
        return { success: false, error: `ADS API error: ${response.status}` };
      }

      const docs = response.data?.response?.docs || [];
      const citations = docs.map(doc => ({
        bibcode: doc.bibcode,
        title: doc.title?.[0] || 'Untitled',
        author: doc.author || [],
        year: doc.year
      }));

      emit('consoleLog', { message: `Found ${citations.length} citations`, level: 'success' });

      return { success: true, data: citations };
    } catch (error) {
      console.error('[adsGetCitations] Error:', error);
      return { success: false, error: error.message };
    }
  },

  async importSingleFromAds(adsDoc) {
    try {
      if (!dbInitialized) await initializeDatabase();

      // Check if paper already exists
      if (adsDoc.bibcode) {
        const existing = MobileDB.getPaperByBibcode(adsDoc.bibcode);
        if (existing) {
          emit('consoleLog', { message: `[${adsDoc.bibcode}] Already in library`, level: 'warn' });
          return { success: false, error: 'Paper already in library', paperId: existing.id };
        }
      }

      // Convert ADS document to paper format
      const paper = adsToPaper(adsDoc);

      emit('consoleLog', { message: `Importing ${paper.bibcode || paper.title}...`, level: 'info' });

      const token = await Keychain.getItem('adsToken');

      // Fetch BibTeX from ADS
      let bibtexStr = null;
      if (token && adsDoc.bibcode) {
        try {
          const bibtexResponse = await CapacitorHttp.request({
            method: 'POST',
            url: 'https://api.adsabs.harvard.edu/v1/export/bibtex',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            data: { bibcode: [adsDoc.bibcode] }
          });
          if (bibtexResponse.status === 200 && bibtexResponse.data?.export) {
            bibtexStr = bibtexResponse.data.export;
            emit('consoleLog', { message: `[${paper.bibcode}] Got BibTeX`, level: 'success' });
          }
        } catch (e) {
          emit('consoleLog', { message: `[${paper.bibcode}] BibTeX fetch failed`, level: 'warn' });
        }
      }

      // Add to database
      const paperId = MobileDB.addPaper({
        bibcode: paper.bibcode,
        doi: paper.doi,
        arxiv_id: paper.arxiv_id,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        journal: paper.journal,
        abstract: paper.abstract,
        keywords: paper.keywords,
        citation_count: paper.citation_count || 0,
        bibtex: bibtexStr
      });

      await MobileDB.saveDatabase();

      // Fetch and store references/citations
      if (token && adsDoc.bibcode) {
        try {
          emit('consoleLog', { message: `[${paper.bibcode}] Fetching refs & cites...`, level: 'info' });

          const [refsResponse, citesResponse] = await Promise.all([
            CapacitorHttp.request({
              method: 'GET',
              url: `https://api.adsabs.harvard.edu/v1/search/query?q=references(bibcode:"${encodeURIComponent(adsDoc.bibcode)}")&fl=bibcode,title,author,year&rows=100`,
              headers: { 'Authorization': `Bearer ${token}` }
            }).catch(() => ({ data: { response: { docs: [] } } })),
            CapacitorHttp.request({
              method: 'GET',
              url: `https://api.adsabs.harvard.edu/v1/search/query?q=citations(bibcode:"${encodeURIComponent(adsDoc.bibcode)}")&fl=bibcode,title,author,year&rows=100`,
              headers: { 'Authorization': `Bearer ${token}` }
            }).catch(() => ({ data: { response: { docs: [] } } }))
          ]);

          const refs = refsResponse.data?.response?.docs || [];
          const cites = citesResponse.data?.response?.docs || [];

          emit('consoleLog', { message: `[${paper.bibcode}] Found ${refs.length} refs, ${cites.length} cites`, level: 'success' });

          // Store references
          if (refs.length > 0) {
            MobileDB.addReferences(paperId, refs.map(r => ({
              bibcode: r.bibcode,
              title: r.title?.[0],
              authors: r.author?.join(', '),
              year: r.year
            })));
          }

          // Store citations
          if (cites.length > 0) {
            MobileDB.addCitations(paperId, cites.map(c => ({
              bibcode: c.bibcode,
              title: c.title?.[0],
              authors: c.author?.join(', '),
              year: c.year
            })));
          }

          await MobileDB.saveDatabase();
        } catch (e) {
          emit('consoleLog', { message: `[${paper.bibcode}] Refs/cites fetch failed: ${e.message}`, level: 'warn' });
        }
      }

      // Download PDF
      if (token && paper.bibcode) {
        try {
          const pdfPriority = await capacitorAPI.getPdfPriority();
          const downloadResult = await downloadPaperPdf(paper, token, pdfPriority);
          if (downloadResult.success) {
            MobileDB.updatePaper(paperId, {
              pdf_path: downloadResult.path,
              pdf_source: downloadResult.source
            });
            await MobileDB.saveDatabase();
            emit('consoleLog', { message: `[${paper.bibcode}] PDF downloaded`, level: 'success' });
          }
        } catch (e) {
          emit('consoleLog', { message: `[${paper.bibcode}] PDF download failed: ${e.message}`, level: 'warn' });
        }
      }

      emit('consoleLog', { message: `[${paper.bibcode || paper.title}] ✓ Import complete`, level: 'success' });

      return { success: true, paperId, hasPdf: !!paper.pdf_path };
    } catch (error) {
      console.error('[importSingleFromAds] Error:', error);
      emit('consoleLog', { message: `Import failed: ${error.message}`, level: 'error' });
      return { success: false, error: error.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ADS IMPORT SEARCH
  // ═══════════════════════════════════════════════════════════════════════════

  async adsImportSearch(query, options = {}) {
    try {
      console.log('[adsImportSearch] Starting search for:', query);

      const token = await Keychain.getItem('adsToken');
      console.log('[adsImportSearch] Token retrieved:', token ? 'yes' : 'no');

      if (!token) {
        return { success: false, error: 'No ADS API token configured. Please add your token in Settings.' };
      }

      const fields = 'bibcode,title,author,year,doi,abstract,keyword,pub,identifier,arxiv_class,citation_count';
      const rows = options.rows || 1000;
      const start = options.start || 0;
      const sort = options.sort || 'date desc';

      const params = new URLSearchParams({
        q: query,
        fl: fields,
        rows: rows.toString(),
        start: start.toString(),
        sort: sort
      });

      const url = `${ADS_API_BASE}/search/query?${params}`;
      console.log('[adsImportSearch] Fetching URL:', url);

      emit('consoleLog', { message: `ADS search: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`, level: 'info' });

      // Use CapacitorHttp for native HTTP requests (bypasses CORS on iOS)
      const response = await CapacitorHttp.get({
        url: url,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      console.log('[adsImportSearch] Response status:', response.status);

      if (response.status !== 200) {
        const errorText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        console.error('[adsImportSearch] API error response:', errorText);
        throw new Error(`ADS API error (${response.status}): ${errorText.substring(0, 200)}`);
      }

      const result = response.data;
      console.log('[adsImportSearch] Got response with', result.response?.numFound, 'results');

      const docs = result.response?.docs || [];
      const numFound = result.response?.numFound || 0;

      emit('consoleLog', { message: `ADS found ${numFound} results`, level: 'success' });

      // Load library papers to check for duplicates
      const libraryPapers = MobileDB.getAllPapers();
      const libraryBibcodes = new Set(libraryPapers.map(p => p.bibcode).filter(Boolean));

      // Convert to paper format
      const papers = docs.map(doc => {
        const paper = adsToPaper(doc);
        paper.inLibrary = libraryBibcodes.has(doc.bibcode);
        return paper;
      });

      return {
        success: true,
        data: {
          papers,
          numFound,
          start: result.response?.start || 0
        }
      };
    } catch (error) {
      console.error('[adsImportSearch] Error:', error);
      console.error('[adsImportSearch] Error name:', error.name);
      console.error('[adsImportSearch] Error message:', error.message);

      // Provide more helpful error messages
      let errorMessage = error.message;
      if (error.message === 'Load failed' || error.message.includes('Failed to fetch')) {
        errorMessage = 'Network error: Could not connect to ADS API. Check your internet connection.';
      } else if (error.message.includes('401')) {
        errorMessage = 'Invalid API token. Please check your ADS token in Settings.';
      }

      emit('consoleLog', { message: `ADS search failed: ${errorMessage}`, level: 'error' });
      return { success: false, error: errorMessage };
    }
  },

  async adsImportPapers(papers) {
    console.log('[adsImportPapers] Starting import of', papers.length, 'papers');

    // Emit initial progress immediately so UI knows we started
    emit('importProgress', {
      current: 0,
      total: papers.length,
      paper: 'Initializing...'
    });

    const results = {
      imported: [],
      skipped: [],
      failed: []
    };

    try {
      emit('consoleLog', { message: `ADS import: ${papers.length} papers selected`, level: 'info' });

      // Get token with timeout
      console.log('[adsImportPapers] Getting token...');
      let token = null;
      try {
        token = await Promise.race([
          Keychain.getItem('adsToken'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Token fetch timeout')), 5000))
        ]);
        console.log('[adsImportPapers] Token:', token ? 'present' : 'missing');
      } catch (e) {
        console.warn('[adsImportPapers] Token fetch failed:', e.message);
      }

      // Get PDF priority with fallback
      console.log('[adsImportPapers] Getting PDF priority...');
      let pdfPriority = ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF'];
      try {
        const storedPriority = await Promise.race([
          capacitorAPI.getPdfPriority(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Priority fetch timeout')), 3000))
        ]);
        if (storedPriority && Array.isArray(storedPriority)) {
          pdfPriority = storedPriority;
        }
        console.log('[adsImportPapers] PDF priority:', pdfPriority);
      } catch (e) {
        console.warn('[adsImportPapers] Using default PDF priority:', e.message);
      }

      for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];
        console.log('[adsImportPapers] Processing paper', i + 1, ':', paper.bibcode);

        // Send progress update
        emit('importProgress', {
          current: i + 1,
          total: papers.length,
          paper: paper.title || paper.bibcode || 'Unknown'
        });

        try {
          // Check if already in library - improved duplicate detection
          if (paper.bibcode) {
            const existing = MobileDB.getPaperByBibcode(paper.bibcode);
            if (existing) {
              // Paper exists - check if it already has a PDF
              if (existing.pdf_path) {
                // Has PDF - skip entirely
                emit('consoleLog', { message: `[${paper.bibcode}] Already has PDF, skipping`, level: 'info' });
                results.skipped.push({ paper, reason: 'Already has PDF' });
                continue;
              } else {
                // No PDF - try to download PDF for existing paper
                emit('consoleLog', { message: `[${paper.bibcode}] Exists but missing PDF, attempting download...`, level: 'info' });

                if (token) {
                  try {
                    const downloadResult = await Promise.race([
                      downloadPaperPdf(paper, token, pdfPriority),
                      new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'timeout' }), 30000))
                    ]);

                    if (downloadResult.success) {
                      // Update existing paper with PDF path
                      MobileDB.updatePaper(existing.id, {
                        pdf_path: downloadResult.path,
                        pdf_source: downloadResult.source
                      });
                      await MobileDB.saveDatabase();
                      emit('consoleLog', { message: `[${paper.bibcode}] PDF downloaded for existing paper (${downloadResult.source})`, level: 'success' });
                      results.imported.push({ paper, id: existing.id, hasPdf: true, pdfSource: downloadResult.source, wasUpdate: true });
                    } else {
                      emit('consoleLog', { message: `[${paper.bibcode}] Still no PDF available`, level: 'warn' });
                      results.skipped.push({ paper, reason: 'No PDF available (existing paper)' });
                    }
                  } catch (pdfError) {
                    console.warn('[adsImportPapers] PDF download error for existing paper:', pdfError);
                    emit('consoleLog', { message: `[${paper.bibcode}] PDF download failed for existing paper`, level: 'warn' });
                    results.skipped.push({ paper, reason: 'PDF download failed (existing paper)' });
                  }
                } else {
                  emit('consoleLog', { message: `[${paper.bibcode}] No token for PDF download`, level: 'warn' });
                  results.skipped.push({ paper, reason: 'No token (existing paper)' });
                }
                continue;
              }
            }
          }

          emit('consoleLog', { message: `[${paper.bibcode || 'unknown'}] Importing...`, level: 'info' });

          // If we only have bibcode, fetch full metadata from ADS
          if (paper.bibcode && !paper.title && token) {
            try {
              emit('consoleLog', { message: `[${paper.bibcode}] Fetching metadata...`, level: 'info' });
              const metadataResponse = await CapacitorHttp.request({
                method: 'GET',
                url: `https://api.adsabs.harvard.edu/v1/search/query?q=bibcode:"${encodeURIComponent(paper.bibcode)}"&fl=bibcode,title,author,year,doi,abstract,keyword,pub,identifier,arxiv_class,citation_count&rows=1`,
                headers: { 'Authorization': `Bearer ${token}` }
              });
              const doc = metadataResponse.data?.response?.docs?.[0];
              if (doc) {
                paper = adsToPaper(doc);
                emit('consoleLog', { message: `[${paper.bibcode}] Got metadata`, level: 'success' });
              }
            } catch (e) {
              emit('consoleLog', { message: `[${paper.bibcode}] Could not fetch metadata`, level: 'warn' });
            }
          }

          // Try to download PDF (don't let PDF failures block import)
          let pdfPath = null;
          let pdfSource = null;

          if (paper.bibcode && token) {
            try {
              console.log('[adsImportPapers] Attempting PDF download for', paper.bibcode);
              const downloadResult = await Promise.race([
                downloadPaperPdf(paper, token, pdfPriority),
                new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'timeout' }), 30000))
              ]);
              console.log('[adsImportPapers] PDF download result:', downloadResult);
              if (downloadResult.success) {
                pdfPath = downloadResult.path;
                pdfSource = downloadResult.source;
                emit('consoleLog', { message: `[${paper.bibcode}] PDF downloaded (${pdfSource})`, level: 'success' });
              } else {
                emit('consoleLog', { message: `[${paper.bibcode}] No PDF available`, level: 'warn' });
              }
            } catch (pdfError) {
              console.warn('[adsImportPapers] PDF download error:', pdfError);
              emit('consoleLog', { message: `[${paper.bibcode}] PDF download failed`, level: 'warn' });
            }
          }

          // Fetch BibTeX from ADS
          let bibtexStr = null;
          if (token && paper.bibcode) {
            try {
              const bibtexResponse = await CapacitorHttp.request({
                method: 'POST',
                url: 'https://api.adsabs.harvard.edu/v1/export/bibtex',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                data: { bibcode: [paper.bibcode] }
              });
              if (bibtexResponse.status === 200 && bibtexResponse.data?.export) {
                bibtexStr = bibtexResponse.data.export;
                emit('consoleLog', { message: `[${paper.bibcode}] Got BibTeX`, level: 'success' });
              }
            } catch (e) {
              console.warn('[adsImportPapers] BibTeX fetch failed:', e.message);
            }
          }

          // Add paper to storage
          console.log('[adsImportPapers] Adding paper to storage');
          const paperId = MobileDB.addPaper({
            bibcode: paper.bibcode,
            doi: paper.doi,
            arxiv_id: paper.arxiv_id,
            title: paper.title,
            authors: paper.authors,
            year: paper.year,
            journal: paper.journal,
            abstract: paper.abstract,
            keywords: paper.keywords,
            citation_count: paper.citation_count || 0,
            pdf_path: pdfPath,
            pdf_source: pdfSource,
            bibtex: bibtexStr
          });
          console.log('[adsImportPapers] Paper added with ID:', paperId);

          // Fetch and store references/citations
          if (token && paper.bibcode) {
            try {
              emit('consoleLog', { message: `[${paper.bibcode}] Fetching refs & cites...`, level: 'info' });

              const [refsResponse, citesResponse] = await Promise.all([
                CapacitorHttp.request({
                  method: 'GET',
                  url: `https://api.adsabs.harvard.edu/v1/search/query?q=references(bibcode:"${encodeURIComponent(paper.bibcode)}")&fl=bibcode,title,author,year&rows=100`,
                  headers: { 'Authorization': `Bearer ${token}` }
                }).catch(() => ({ data: { response: { docs: [] } } })),
                CapacitorHttp.request({
                  method: 'GET',
                  url: `https://api.adsabs.harvard.edu/v1/search/query?q=citations(bibcode:"${encodeURIComponent(paper.bibcode)}")&fl=bibcode,title,author,year&rows=100`,
                  headers: { 'Authorization': `Bearer ${token}` }
                }).catch(() => ({ data: { response: { docs: [] } } }))
              ]);

              const refs = refsResponse.data?.response?.docs || [];
              const cites = citesResponse.data?.response?.docs || [];

              emit('consoleLog', { message: `[${paper.bibcode}] Found ${refs.length} refs, ${cites.length} cites`, level: 'success' });

              // Store references
              if (refs.length > 0) {
                MobileDB.addReferences(paperId, refs.map(r => ({
                  bibcode: r.bibcode,
                  title: r.title?.[0],
                  authors: r.author?.join(', '),
                  year: r.year
                })));
              }

              // Store citations
              if (cites.length > 0) {
                MobileDB.addCitations(paperId, cites.map(c => ({
                  bibcode: c.bibcode,
                  title: c.title?.[0],
                  authors: c.author?.join(', '),
                  year: c.year
                })));
              }
            } catch (e) {
              console.warn('[adsImportPapers] Refs/cites fetch failed:', e.message);
            }
          }

          // Save database after each paper
          await MobileDB.saveDatabase();

          emit('consoleLog', { message: `[${paper.bibcode}] ✓ Import complete`, level: 'success' });
          results.imported.push({
            paper,
            id: paperId,
            hasPdf: !!pdfPath,
            pdfSource
          });

        } catch (error) {
          console.error('[adsImportPapers] Paper import error:', error);
          emit('consoleLog', { message: `[${paper.bibcode || 'unknown'}] ✗ Import failed: ${error.message}`, level: 'error' });
          results.failed.push({ paper, error: error.message });
        }

        // Small delay between imports for rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      console.log('[adsImportPapers] Import complete. Results:', results);

      // Send completion
      emit('importComplete', results);

      return { success: true, results };
    } catch (error) {
      console.error('[adsImportPapers] Error:', error);
      emit('consoleLog', { message: `Import failed: ${error.message}`, level: 'error' });
      emit('importComplete', { imported: results.imported, skipped: results.skipped, failed: [...results.failed, ...papers.slice(results.imported.length + results.skipped.length + results.failed.length).map(p => ({ paper: p, error: error.message }))] });
      return { success: false, error: error.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LIBRARY EXPORT/IMPORT
  // ═══════════════════════════════════════════════════════════════════════════

  async getExportStats() {
    try {
      if (!dbInitialized) await initializeDatabase();

      const papers = MobileDB.getAllPapers();
      const collections = MobileDB.getCollections();

      let pdfCount = 0;
      let pdfSize = 0;
      let annotationCount = 0;
      let refCount = 0;
      let citeCount = 0;

      for (const paper of papers) {
        // Count PDFs
        if (paper.pdf_path) {
          try {
            const pdfPath = `${currentLibraryPath}/${paper.pdf_path}`;
            const stat = currentLibraryLocation === 'icloud'
              ? await ICloud.stat({ path: pdfPath })
              : await Filesystem.stat({ path: pdfPath, directory: Directory.Documents });
            if (stat) {
              pdfCount++;
              pdfSize += stat.size || 0;
            }
          } catch (e) {
            // PDF doesn't exist
          }
        }

        // Count annotations
        annotationCount += paper.annotation_count || 0;

        // Count refs and cites
        const refs = MobileDB.getReferences(paper.id);
        const cites = MobileDB.getCitations(paper.id);
        refCount += refs.length;
        citeCount += cites.length;
      }

      return {
        paperCount: papers.length,
        collectionCount: collections.length,
        pdfCount,
        pdfSize,
        annotationCount,
        refCount,
        citeCount
      };
    } catch (error) {
      console.error('[API] Failed to get export stats:', error);
      return { paperCount: 0, pdfCount: 0, pdfSize: 0, annotationCount: 0, refCount: 0, citeCount: 0 };
    }
  },

  async exportLibrary(options) {
    try {
      if (!dbInitialized) await initializeDatabase();

      const { includePdfs, includeRefs, includeCites, includeAnnotations } = options;

      const zip = new JSZip();

      // Get all data
      const papers = MobileDB.getAllPapers();
      const collections = MobileDB.getCollections();

      // Build library.json
      const libraryData = {
        papers: papers.map(p => ({
          bibcode: p.bibcode,
          title: p.title,
          authors: p.authors,
          year: p.year,
          pubdate: p.pubdate,
          abstract: p.abstract,
          journal: p.journal,
          volume: p.volume,
          page: p.page,
          doi: p.doi,
          arxiv_id: p.arxiv_id,
          bibtex: p.bibtex,
          rating: p.rating,
          read_status: p.read_status,
          pdf_path: p.pdf_path,
          citation_count: p.citation_count
        })),
        collections: collections.map(c => {
          const paperBibcodes = MobileDB.getPapersInCollection(c.id)
            .map(pid => papers.find(p => p.id === pid)?.bibcode)
            .filter(Boolean);
          return {
            id: c.id,
            name: c.name,
            parent_id: c.parent_id,
            is_smart: c.is_smart,
            query: c.query,
            papers: paperBibcodes
          };
        }),
        refs: {},
        cites: {},
        annotations: {}
      };

      // Add refs if requested
      if (includeRefs) {
        for (const paper of papers) {
          if (paper.bibcode) {
            const refs = MobileDB.getReferences(paper.id);
            if (refs.length > 0) {
              libraryData.refs[paper.bibcode] = refs.map(r => ({
                ref_bibcode: r.bibcode,
                ref_title: r.title,
                ref_authors: r.authors,
                ref_year: r.year
              }));
            }
          }
        }
      }

      // Add cites if requested
      if (includeCites) {
        for (const paper of papers) {
          if (paper.bibcode) {
            const cites = MobileDB.getCitations(paper.id);
            if (cites.length > 0) {
              libraryData.cites[paper.bibcode] = cites.map(c => ({
                citing_bibcode: c.bibcode,
                citing_title: c.title,
                citing_authors: c.authors,
                citing_year: c.year
              }));
            }
          }
        }
      }

      // Add annotations if requested
      if (includeAnnotations) {
        for (const paper of papers) {
          if (paper.bibcode) {
            const annotations = MobileDB.getAnnotations(paper.id);
            if (annotations.length > 0) {
              libraryData.annotations[paper.bibcode] = annotations.map(a => ({
                page_number: a.page_number,
                selection_text: a.selection_text,
                selection_rects: a.selection_rects,
                note_content: a.note_content,
                color: a.color,
                pdf_source: a.pdf_source,
                created_at: a.created_at,
                updated_at: a.updated_at
              }));
            }
          }
        }
      }

      zip.file('library.json', JSON.stringify(libraryData, null, 2));

      // Build stats for manifest
      const stats = {
        paperCount: papers.length,
        collectionCount: collections.length,
        pdfCount: 0,
        annotationCount: Object.values(libraryData.annotations).reduce((sum, anns) => sum + anns.length, 0),
        refCount: Object.values(libraryData.refs).reduce((sum, refs) => sum + refs.length, 0),
        citeCount: Object.values(libraryData.cites).reduce((sum, cites) => sum + cites.length, 0)
      };

      // Add PDFs if requested
      if (includePdfs && currentLibraryPath) {
        const papersWithPdf = papers.filter(p => p.pdf_path);

        for (let i = 0; i < papersWithPdf.length; i++) {
          const paper = papersWithPdf[i];
          try {
            const pdfPath = `${currentLibraryPath}/${paper.pdf_path}`;
            let pdfData;

            if (currentLibraryLocation === 'icloud') {
              const result = await ICloud.readFile({ path: pdfPath, encoding: null });
              pdfData = result.data; // base64
            } else {
              const result = await Filesystem.readFile({
                path: pdfPath,
                directory: Directory.Documents
              });
              pdfData = result.data; // base64
            }

            const safeBibcode = (paper.bibcode || `paper_${paper.id}`).replace(/[/\\:*?"<>|]/g, '_');
            const pdfFilename = paper.pdf_path.split('/').pop();
            zip.file(`pdfs/${safeBibcode}/${pdfFilename}`, pdfData, { base64: true });
            stats.pdfCount++;

            emit('exportProgress', { phase: 'pdfs', current: i + 1, total: papersWithPdf.length });
          } catch (e) {
            console.warn(`[Export] Failed to include PDF for ${paper.bibcode}:`, e);
          }
        }
      }

      // Build manifest
      const manifest = {
        version: 1,
        format: 'adslib',
        exportDate: new Date().toISOString(),
        exportedBy: 'Bibliac iOS',
        platform: 'iOS',
        options: { includePdfs, includeRefs, includeCites, includeAnnotations },
        stats
      };
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));

      // Generate ZIP
      const zipData = await zip.generateAsync({ type: 'base64' });

      // Save to temp location
      const filename = `ADS_Reader_Library_${new Date().toISOString().split('T')[0]}.adslib`;
      const tempPath = `${filename}`;

      await Filesystem.writeFile({
        path: tempPath,
        data: zipData,
        directory: Directory.Cache
      });

      // Get full URI for sharing
      const uriResult = await Filesystem.getUri({
        path: tempPath,
        directory: Directory.Cache
      });

      return { success: true, path: uriResult.uri, filename };
    } catch (error) {
      console.error('[API] Export failed:', error);
      return { success: false, error: error.message };
    }
  },

  async shareFileNative(filePath, title) {
    try {
      await Share.share({
        title: title || 'Bibliac Library',
        url: filePath,
        dialogTitle: 'Share Library'
      });
      return { success: true };
    } catch (error) {
      console.error('[API] Share failed:', error);
      return { success: false, error: error.message };
    }
  },

  async previewLibraryImport(filePath) {
    try {
      let zipData;

      if (filePath) {
        // Read the file
        const result = await Filesystem.readFile({
          path: filePath,
          directory: Directory.Cache
        });
        zipData = result.data;
      } else {
        // Let user pick a file - for iOS this would be handled differently
        // For now, return an error suggesting to use file picker
        return { success: false, error: 'Please select a .adslib file' };
      }

      const zip = await JSZip.loadAsync(zipData, { base64: true });

      // Read manifest
      const manifestFile = zip.file('manifest.json');
      if (!manifestFile) {
        return { success: false, error: 'Invalid .adslib file: missing manifest' };
      }
      const manifest = JSON.parse(await manifestFile.async('string'));

      // Read library to get additional stats
      const libraryFile = zip.file('library.json');
      if (!libraryFile) {
        return { success: false, error: 'Invalid .adslib file: missing library data' };
      }
      const libraryData = JSON.parse(await libraryFile.async('string'));

      return {
        success: true,
        filePath,
        stats: manifest.stats,
        exportDate: manifest.exportDate,
        exportedBy: manifest.exportedBy,
        platform: manifest.platform
      };
    } catch (error) {
      console.error('[API] Preview import failed:', error);
      return { success: false, error: error.message };
    }
  },

  async importLibrary(options) {
    try {
      if (!dbInitialized) await initializeDatabase();

      const { filePath, mode, importPdfs, importAnnotations } = options;

      // Read the ZIP file
      const result = await Filesystem.readFile({
        path: filePath,
        directory: Directory.Cache
      });

      const zip = await JSZip.loadAsync(result.data, { base64: true });

      // Read library.json
      const libraryFile = zip.file('library.json');
      if (!libraryFile) {
        return { success: false, error: 'Invalid .adslib file: missing library data' };
      }
      const libraryData = JSON.parse(await libraryFile.async('string'));

      const results = {
        papersImported: 0,
        papersSkipped: 0,
        pdfsImported: 0,
        annotationsImported: 0,
        collectionsImported: 0,
        errors: []
      };

      // If replace mode, clear existing papers
      if (mode === 'replace') {
        const existingPapers = MobileDB.getAllPapers();
        for (const paper of existingPapers) {
          MobileDB.deletePaper(paper.id, false);
        }
        const existingCollections = MobileDB.getCollections();
        for (const coll of existingCollections) {
          MobileDB.deleteCollection(coll.id);
        }
        await MobileDB.saveDatabase();
      }

      // Import papers
      const bibcodeToNewId = {};
      const papers = libraryData.papers || [];

      for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];

        emit('importLibraryProgress', { phase: 'papers', current: i + 1, total: papers.length });

        // Check for duplicates in merge mode
        if (mode === 'merge') {
          const existingPaper = paper.bibcode ? MobileDB.getPaperByBibcode(paper.bibcode) : null;
          if (existingPaper) {
            results.papersSkipped++;
            bibcodeToNewId[paper.bibcode] = existingPaper.id;
            continue;
          }
        }

        try {
          const paperToImport = { ...paper };
          if (!importPdfs) {
            paperToImport.pdf_path = null;
          }

          const newId = MobileDB.addPaper(paperToImport, false);
          results.papersImported++;

          if (paper.bibcode) {
            bibcodeToNewId[paper.bibcode] = newId;
          }
        } catch (e) {
          results.errors.push(`Failed to import: ${paper.title}`);
        }
      }

      // Import collections
      const collectionIdMap = {};
      const collections = libraryData.collections || [];

      collections.sort((a, b) => {
        if (a.parent_id === null && b.parent_id !== null) return -1;
        if (a.parent_id !== null && b.parent_id === null) return 1;
        return 0;
      });

      for (const coll of collections) {
        try {
          const parentId = coll.parent_id ? collectionIdMap[coll.parent_id] : null;
          const newCollId = MobileDB.createCollection(coll.name, parentId, coll.is_smart, coll.query);
          collectionIdMap[coll.id] = newCollId;
          results.collectionsImported++;

          for (const bibcode of coll.papers || []) {
            const paperId = bibcodeToNewId[bibcode];
            if (paperId) {
              MobileDB.addPaperToCollection(paperId, newCollId);
            }
          }
        } catch (e) {
          results.errors.push(`Failed to import collection: ${coll.name}`);
        }
      }

      // Import refs
      const refs = libraryData.refs || {};
      for (const [bibcode, paperRefs] of Object.entries(refs)) {
        const paperId = bibcodeToNewId[bibcode];
        if (paperId && paperRefs.length > 0) {
          MobileDB.addReferences(paperId, paperRefs.map(r => ({
            bibcode: r.ref_bibcode,
            title: r.ref_title,
            authors: r.ref_authors,
            year: r.ref_year
          })), false);
        }
      }

      // Import cites
      const cites = libraryData.cites || {};
      for (const [bibcode, paperCites] of Object.entries(cites)) {
        const paperId = bibcodeToNewId[bibcode];
        if (paperId && paperCites.length > 0) {
          MobileDB.addCitations(paperId, paperCites.map(c => ({
            bibcode: c.citing_bibcode,
            title: c.citing_title,
            authors: c.citing_authors,
            year: c.citing_year
          })), false);
        }
      }

      // Import annotations
      if (importAnnotations) {
        const annotations = libraryData.annotations || {};
        for (const [bibcode, paperAnnotations] of Object.entries(annotations)) {
          const paperId = bibcodeToNewId[bibcode];
          if (paperId) {
            for (const ann of paperAnnotations) {
              try {
                MobileDB.createAnnotation(paperId, {
                  page_number: ann.page_number,
                  selection_text: ann.selection_text,
                  selection_rects: ann.selection_rects,
                  note_content: ann.note_content,
                  color: ann.color,
                  pdf_source: ann.pdf_source
                });
                results.annotationsImported++;
              } catch (e) {
                // Ignore annotation errors
              }
            }
          }
        }
      }

      // Import PDFs
      if (importPdfs && currentLibraryPath) {
        const pdfFiles = Object.keys(zip.files).filter(f => f.startsWith('pdfs/') && !f.endsWith('/'));

        for (let i = 0; i < pdfFiles.length; i++) {
          const pdfPath = pdfFiles[i];
          emit('importLibraryProgress', { phase: 'pdfs', current: i + 1, total: pdfFiles.length });

          const pathParts = pdfPath.split('/');
          if (pathParts.length >= 3) {
            const bibcode = pathParts[1];
            const filename = pathParts[2];
            const paperId = bibcodeToNewId[bibcode];

            if (paperId) {
              try {
                const pdfData = await zip.file(pdfPath).async('base64');
                const destPath = `${currentLibraryPath}/papers/${filename}`;

                if (currentLibraryLocation === 'icloud') {
                  await ICloud.writeFile({ path: destPath, data: pdfData, encoding: null });
                } else {
                  await Filesystem.writeFile({
                    path: destPath,
                    data: pdfData,
                    directory: Directory.Documents
                  });
                }

                MobileDB.updatePaper(paperId, { pdf_path: `papers/${filename}` }, false);
                results.pdfsImported++;
              } catch (e) {
                results.errors.push(`Failed to import PDF: ${filename}`);
              }
            }
          }
        }
      }

      // Save database
      await MobileDB.saveDatabase();

      return { success: true, ...results };
    } catch (error) {
      console.error('[API] Import failed:', error);
      return { success: false, error: error.message };
    }
  },

  // Export/import event listeners
  onExportProgress(callback) {
    eventListeners.exportProgress = eventListeners.exportProgress || [];
    eventListeners.exportProgress.push(callback);
  },

  onLibraryImportProgress(callback) {
    eventListeners.importLibraryProgress = eventListeners.importLibraryProgress || [];
    eventListeners.importLibraryProgress.push(callback);
  },

  removeExportImportListeners() {
    eventListeners.exportProgress = [];
    eventListeners.importLibraryProgress = [];
  },

  onShowExportModal(callback) {
    // No-op on iOS - modals are triggered via UI buttons
  },

  onShowImportModal(callback) {
    // No-op on iOS - modals are triggered via UI buttons
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BIBTEX
  // ═══════════════════════════════════════════════════════════════════════════

  async copyCite(paperIds, style = 'cite') {
    try {
      if (!dbInitialized) await initializeDatabase();

      // Get papers from database
      const papers = [];
      for (const id of paperIds) {
        const paper = MobileDB.getPaper(id);
        if (paper) {
          papers.push(paper);
        }
      }

      if (papers.length === 0) {
        return { success: false, error: 'No papers found' };
      }

      // Generate cite keys
      const citeKeys = papers.map(paper => generateCiteKey(paper));

      // Format based on style
      let citeCommand;
      if (style === 'citep') {
        citeCommand = `\\citep{${citeKeys.join(',')}}`;
      } else {
        citeCommand = `\\cite{${citeKeys.join(',')}}`;
      }

      // Copy to clipboard
      await navigator.clipboard.writeText(citeCommand);

      emit('consoleLog', { message: `Copied ${style} command for ${papers.length} paper(s)`, level: 'success' });

      return { success: true };
    } catch (error) {
      console.error('[copyCite] Error:', error);
      emit('consoleLog', { message: `Copy cite failed: ${error.message}`, level: 'error' });
      return { success: false, error: error.message };
    }
  },

  async exportBibtex(paperIds) {
    try {
      if (!dbInitialized) await initializeDatabase();

      // Get papers from database
      const papers = [];
      for (const id of paperIds) {
        const paper = MobileDB.getPaper(id);
        if (paper) {
          papers.push(paper);
        }
      }

      if (papers.length === 0) {
        return { success: false, error: 'No papers found' };
      }

      emit('consoleLog', { message: `Exporting BibTeX for ${papers.length} paper(s)...`, level: 'info' });

      // Separate papers with and without bibcodes
      const papersWithBibcode = papers.filter(p => p.bibcode);
      const papersWithoutBibcode = papers.filter(p => !p.bibcode);

      const bibtexEntries = [];

      // For papers with bibcode, fetch from ADS API
      if (papersWithBibcode.length > 0) {
        const token = await Keychain.getItem('adsToken');

        if (token) {
          try {
            const bibcodes = papersWithBibcode.map(p => p.bibcode);

            const response = await CapacitorHttp.post({
              url: `${ADS_API_BASE}/export/bibtex`,
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              data: { bibcode: bibcodes }
            });

            if (response.status === 200 && response.data?.export) {
              bibtexEntries.push(response.data.export);
              emit('consoleLog', { message: `Fetched BibTeX for ${bibcodes.length} paper(s) from ADS`, level: 'success' });
            } else {
              // Fallback to local generation if ADS fails
              emit('consoleLog', { message: 'ADS BibTeX export failed, generating locally', level: 'warn' });
              for (const paper of papersWithBibcode) {
                bibtexEntries.push(paperToBibtex(paper));
              }
            }
          } catch (e) {
            console.error('[exportBibtex] ADS API error:', e);
            emit('consoleLog', { message: 'ADS BibTeX export failed, generating locally', level: 'warn' });
            // Fallback to local generation
            for (const paper of papersWithBibcode) {
              bibtexEntries.push(paperToBibtex(paper));
            }
          }
        } else {
          // No token, generate locally
          emit('consoleLog', { message: 'No ADS token, generating BibTeX locally', level: 'warn' });
          for (const paper of papersWithBibcode) {
            bibtexEntries.push(paperToBibtex(paper));
          }
        }
      }

      // For papers without bibcode, generate locally
      for (const paper of papersWithoutBibcode) {
        bibtexEntries.push(paperToBibtex(paper));
      }

      // Combine all entries
      const combinedBibtex = bibtexEntries.join('\n\n');

      emit('consoleLog', { message: `BibTeX export complete (${papers.length} entries)`, level: 'success' });

      return { success: true, bibtex: combinedBibtex };
    } catch (error) {
      console.error('[exportBibtex] Error:', error);
      emit('consoleLog', { message: `BibTeX export failed: ${error.message}`, level: 'error' });
      return { success: false, error: error.message };
    }
  },

  async saveBibtexFile(content) {
    try {
      await ensureLibraryExists();

      // Generate filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `export-${timestamp}.bib`;
      const filePath = `${LIBRARY_FOLDER}/${filename}`;

      // Write the file
      await Filesystem.writeFile({
        path: filePath,
        directory: Directory.Documents,
        data: content,
        encoding: Encoding.UTF8
      });

      emit('consoleLog', { message: `BibTeX saved to ${filename}`, level: 'success' });

      // Get the full URI for sharing
      const uri = await Filesystem.getUri({
        path: filePath,
        directory: Directory.Documents
      });

      return { success: true, path: filePath, uri: uri.uri };
    } catch (error) {
      console.error('[saveBibtexFile] Error:', error);
      emit('consoleLog', { message: `Save BibTeX failed: ${error.message}`, level: 'error' });
      return { success: false, error: error.message };
    }
  },

  /**
   * Import BibTeX file using HTML file input (works on iOS Safari/WKWebView)
   * Opens a file picker, parses BibTeX entries, creates paper entries
   */
  async importBibtex() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.bib,.bibtex,text/plain,text/x-bibtex';

      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) {
          resolve({ success: false, canceled: true });
          return;
        }

        try {
          emit('consoleLog', { message: `Reading BibTeX file: ${file.name}`, level: 'info' });

          // Read file as text
          const content = await file.text();

          // Parse BibTeX entries
          const entries = parseBibtexContent(content);
          emit('consoleLog', { message: `Found ${entries.length} BibTeX entries`, level: 'info' });

          if (entries.length === 0) {
            emit('consoleLog', { message: 'No valid BibTeX entries found', level: 'warn' });
            resolve({ success: false, error: 'No valid BibTeX entries found' });
            return;
          }

          if (!dbInitialized) await initializeDatabase();

          const results = { imported: [], skipped: [], failed: [] };

          for (const entry of entries) {
            try {
              // Check if already in library by bibcode
              if (entry.bibcode) {
                const existing = MobileDB.getPaperByBibcode(entry.bibcode);
                if (existing) {
                  results.skipped.push({ entry, reason: 'Already in library' });
                  emit('consoleLog', { message: `Skipped: ${entry.bibcode} (already in library)`, level: 'warn' });
                  continue;
                }
              }

              // Extract year as number
              const year = entry.year ? parseInt(entry.year, 10) : null;

              // Create paper entry with import source tracking
              const paperId = MobileDB.addPaper({
                title: entry.title || entry.key || 'Untitled',
                authors: entry.author || '',
                year: year,
                journal: entry.journal || entry.booktitle || '',
                doi: entry.doi || null,
                bibcode: entry.bibcode || null,
                arxiv_id: entry.arxiv_id || entry.eprint || null,
                abstract: entry.abstract || null,
                bibtex: entry.raw,
                import_source: file.name,
                import_source_key: entry.key,
                added_date: new Date().toISOString()
              });

              results.imported.push({ paperId, entry });
              emit('consoleLog', {
                message: `Imported: ${entry.title || entry.key}`,
                level: 'success'
              });
            } catch (error) {
              results.failed.push({ entry, error: error.message });
              emit('consoleLog', {
                message: `Failed: ${entry.key} - ${error.message}`,
                level: 'error'
              });
            }
          }

          await MobileDB.saveDatabase();

          emit('consoleLog', {
            message: `BibTeX import complete: ${results.imported.length} imported, ${results.skipped.length} skipped, ${results.failed.length} failed`,
            level: 'success'
          });

          resolve({ success: true, results });
        } catch (error) {
          emit('consoleLog', { message: `BibTeX import failed: ${error.message}`, level: 'error' });
          resolve({ success: false, error: error.message });
        }
      };

      input.click();
    });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PDF IMPORT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Import PDFs using HTML file input (works on iOS Safari/WKWebView)
   * Opens a file picker, lets user select PDFs, saves them to library
   */
  async importPDFs() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf,application/pdf';
      input.multiple = true;

      input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) {
          resolve({ success: false, canceled: true });
          return;
        }

        emit('consoleLog', { message: `Importing ${files.length} PDF file(s)...`, level: 'info' });

        const results = [];
        await ensureLibraryExists();
        if (!dbInitialized) await initializeDatabase();

        for (const file of files) {
          try {
            // Read file as base64
            const base64 = await fileToBase64(file);

            // Generate filename with timestamp to avoid conflicts
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const filename = `imported_${Date.now()}_${safeName}`;
            const filePath = `${LIBRARY_FOLDER}/papers/${filename}`;

            // Save to filesystem
            await Filesystem.writeFile({
              path: filePath,
              directory: Directory.Documents,
              data: base64
            });

            // Create paper entry with title from filename (remove .pdf extension)
            const title = file.name.replace(/\.pdf$/i, '');
            const paperId = MobileDB.addPaper({
              title: title,
              pdf_path: `papers/${filename}`,
              added_date: new Date().toISOString()
            });

            emit('consoleLog', { message: `Imported: ${file.name}`, level: 'success' });
            results.push({ success: true, id: paperId, filename: file.name });
          } catch (error) {
            emit('consoleLog', { message: `Failed: ${file.name} - ${error.message}`, level: 'error' });
            results.push({ success: false, filename: file.name, error: error.message });
          }
        }

        await MobileDB.saveDatabase();

        const successCount = results.filter(r => r.success).length;
        emit('consoleLog', {
          message: `PDF import complete: ${successCount}/${files.length} succeeded`,
          level: successCount === files.length ? 'success' : 'warn'
        });

        resolve({ success: true, results });
      };

      // Handle cancel - note: oncancel is not widely supported, but we handle it via timeout
      input.click();
    });
  },

  /**
   * Select PDF files without importing (returns file info)
   * Used for alternative import workflows
   */
  async selectPdfs() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf,application/pdf';
      input.multiple = true;

      input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) {
          resolve([]);
          return;
        }

        // Return file info without importing
        const fileInfos = files.map(file => ({
          name: file.name,
          size: file.size,
          type: file.type
        }));
        resolve(fileInfos);
      };

      input.click();
    });
  },

  /**
   * Select a BibTeX file (returns file path/content)
   * Used for BibTeX import workflow
   */
  async selectBibFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.bib,.bibtex,text/plain,text/x-bibtex';

      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) {
          resolve(null);
          return;
        }

        try {
          const content = await file.text();
          resolve({ name: file.name, content });
        } catch (error) {
          console.error('[selectBibFile] Error reading file:', error);
          resolve(null);
        }
      };

      input.click();
    });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM CONFIG (Multi-provider support)
  // ═══════════════════════════════════════════════════════════════════════════

  async getLlmConfig() {
    const result = await Preferences.get({ key: 'llmConfig' });
    const config = safeJsonParse(result.value) || {
      activeProvider: 'anthropic',
      selectedModel: null,
      anthropic: { model: 'claude-3-5-sonnet-20241022' },
      gemini: { model: 'gemini-1.5-flash' },
      perplexity: { model: 'llama-3.1-sonar-small-128k-online' }
    };
    return config;
  },

  async setLlmConfig(config) {
    try {
      await Preferences.set({ key: 'llmConfig', value: JSON.stringify(config) });
      return { success: true };
    } catch (error) {
      console.error('[API] Failed to save LLM config:', error);
      return { success: false, error: error.message };
    }
  },

  async checkLlmConnection() {
    // On iOS, check if any cloud provider is configured
    const anthropicKey = await Keychain.getItem('apiKey_anthropic');
    const geminiKey = await Keychain.getItem('apiKey_gemini');
    const perplexityKey = await Keychain.getItem('apiKey_perplexity');

    if (anthropicKey || geminiKey || perplexityKey) {
      return { connected: true };
    }
    return { connected: false, error: 'No cloud LLM configured. Add API key in Settings.' };
  },

  async listLlmModels() {
    // Ollama not available on iOS
    return [];
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MULTI-PROVIDER LLM SUPPORT
  // ═══════════════════════════════════════════════════════════════════════════

  async getAllProviders() {
    return [
      { id: 'anthropic', name: 'Anthropic (Claude)', available: true },
      { id: 'gemini', name: 'Google Gemini', available: true },
      { id: 'perplexity', name: 'Perplexity', available: true },
      { id: 'ollama', name: 'Ollama (Local)', available: false } // Not on iOS
    ];
  },

  async testProviderConnection(provider) {
    try {
      const apiKey = await Keychain.getItem(`apiKey_${provider}`);
      if (!apiKey) {
        return { connected: false, error: 'No API key configured' };
      }

      // Test the connection based on provider
      let testUrl, headers;

      if (provider === 'anthropic') {
        testUrl = 'https://api.anthropic.com/v1/messages';
        headers = {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        };
        // Just check if we get a valid error (auth works) or success
        const response = await CapacitorHttp.request({
          method: 'POST',
          url: testUrl,
          headers,
          data: { model: 'claude-3-5-sonnet-20241022', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
        });
        if (response.status === 200 || response.status === 201) {
          return { connected: true, provider: 'anthropic' };
        } else if (response.status === 401) {
          return { connected: false, error: 'Invalid API key' };
        } else if (response.status === 400) {
          // 400 can mean various things, but if we get here the key is probably valid
          return { connected: true, provider: 'anthropic' };
        }
        return { connected: false, error: `API error: ${response.status}` };
      }

      if (provider === 'gemini') {
        testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const response = await CapacitorHttp.request({
          method: 'GET',
          url: testUrl
        });
        if (response.status === 200) {
          return { connected: true, provider: 'gemini' };
        }
        return { connected: false, error: `API error: ${response.status}` };
      }

      if (provider === 'perplexity') {
        testUrl = 'https://api.perplexity.ai/chat/completions';
        headers = {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        };
        const response = await CapacitorHttp.request({
          method: 'POST',
          url: testUrl,
          headers,
          data: { model: 'llama-3.1-sonar-small-128k-online', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }
        });
        if (response.status === 200 || response.status === 201) {
          return { connected: true, provider: 'perplexity' };
        } else if (response.status === 401) {
          return { connected: false, error: 'Invalid API key' };
        }
        return { connected: false, error: `API error: ${response.status}` };
      }

      return { connected: false, error: 'Unknown provider' };
    } catch (error) {
      console.error(`[API] Failed to test ${provider} connection:`, error);
      return { connected: false, error: error.message };
    }
  },

  async getProviderModels(provider) {
    const models = {
      anthropic: [
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' }
      ],
      gemini: [
        { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
        { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
        { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash' }
      ],
      perplexity: [
        { id: 'llama-3.1-sonar-small-128k-online', name: 'Sonar Small (Online)' },
        { id: 'llama-3.1-sonar-large-128k-online', name: 'Sonar Large (Online)' },
        { id: 'llama-3.1-sonar-huge-128k-online', name: 'Sonar Huge (Online)' }
      ],
      ollama: [] // Not available on iOS
    };
    return models[provider] || [];
  },

  async getAllModels() {
    const providers = ['anthropic', 'gemini', 'perplexity'];
    const result = [];

    for (const provider of providers) {
      const apiKey = await Keychain.getItem(`apiKey_${provider}`);
      const models = await this.getProviderModels(provider);

      result.push({
        provider,
        providerName: provider === 'anthropic' ? 'Anthropic' :
                      provider === 'gemini' ? 'Google Gemini' : 'Perplexity',
        connected: !!apiKey,
        models: models.map(m => ({ ...m, id: `${provider}:${m.id}` }))
      });
    }

    return result;
  },

  async setSelectedModel(modelId) {
    try {
      await Preferences.set({ key: 'selectedModel', value: modelId });
      return { success: true };
    } catch (error) {
      console.error('[API] Failed to save selected model:', error);
      return { success: false, error: error.message };
    }
  },

  // Summary prompt methods
  async getSummaryPrompt() {
    const result = await Preferences.get({ key: 'summaryPrompt' });
    return result.value || this._getDefaultSummaryPrompt();
  },

  async setSummaryPrompt(prompt) {
    try {
      await Preferences.set({ key: 'summaryPrompt', value: prompt });
      return { success: true };
    } catch (error) {
      console.error('[API] Failed to save summary prompt:', error);
      return { success: false, error: error.message };
    }
  },

  async resetSummaryPrompt() {
    try {
      await Preferences.remove({ key: 'summaryPrompt' });
      return { success: true, defaultPrompt: this._getDefaultSummaryPrompt() };
    } catch (error) {
      console.error('[API] Failed to reset summary prompt:', error);
      return { success: false, error: error.message };
    }
  },

  _getDefaultSummaryPrompt() {
    return `You are an expert academic assistant. Your task is to summarize scientific papers.
Provide a clear, concise summary that captures the key contributions and findings.
Structure your response with:
1. A brief overview (2-3 sentences)
2. Key contributions or findings (bullet points)
3. Methodology highlights (if relevant)
4. Main conclusions`;
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CLOUD LLM
  // ═══════════════════════════════════════════════════════════════════════════

  async getCloudLlmConfig() {
    const result = await Preferences.get({ key: 'cloudLlmConfig' });
    const config = safeJsonParse(result.value);
    if (!config) return null;

    const apiKey = await Keychain.getItem('cloudLlmApiKey');
    return { ...config, apiKey };
  },

  async setCloudLlmConfig(config) {
    if (config.apiKey) {
      await Keychain.setItem('cloudLlmApiKey', config.apiKey);
    }
    const { apiKey, ...rest } = config;
    await Preferences.set({ key: 'cloudLlmConfig', value: JSON.stringify(rest) });

    // Update service instance
    try {
      const { CloudLLMService } = await import('../main/cloud-llm-service.js');
      cloudLlmService = new CloudLLMService(config);
    } catch (e) {
      console.warn('[API] Failed to update cloud LLM service:', e);
    }

    return { success: true };
  },

  async getCloudLlmProviders() {
    return {
      anthropic: { name: 'Anthropic', models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'] },
      gemini: { name: 'Google Gemini', models: ['gemini-2.0-flash', 'gemini-1.5-pro'] },
      perplexity: { name: 'Perplexity', models: ['sonar', 'sonar-pro'] }
    };
  },

  async checkCloudLlmConnection() {
    const config = await this.getCloudLlmConfig();
    if (!config || !config.apiKey) {
      return { success: false, error: 'No API key configured' };
    }

    try {
      // Reinitialize service with current config
      const { CloudLLMService } = await import('../main/cloud-llm-service.js');
      cloudLlmService = new CloudLLMService(config);

      // Test with a simple request
      await cloudLlmService.generate('Say "ok"', { maxTokens: 10 });
      return { success: true, provider: config.provider };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async getPreferredLlmType() {
    return 'cloud';
  },

  async setPreferredLlmType(type) {
    return { success: true };
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM FEATURES
  // ═══════════════════════════════════════════════════════════════════════════

  async llmSummarize(paperId, options = {}) {
    try {
      if (!cloudLlmService) {
        return { success: false, error: 'Cloud LLM not configured. Add API key in Settings.' };
      }

      if (!dbInitialized) await initializeDatabase();

      const paper = MobileDB.getPaper(paperId);
      if (!paper) return { success: false, error: 'Paper not found' };

      // Check for existing summary
      const existing = MobileDB.getSummary(paperId);
      if (existing && !options.regenerate) {
        return { success: true, summary: existing.summary, cached: true };
      }

      // Get paper text content
      let textContent = paper.abstract || '';
      // Could also read from text file if available

      emit('consoleLog', { message: `Summarizing: ${paper.title}...`, level: 'info' });

      // Build prompt with available information
      const authorStr = Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || 'Unknown authors');

      const prompt = `Please summarize this academic paper in 3-5 key points:

Title: ${paper.title}
Authors: ${authorStr}
Abstract: ${textContent}`;

      const response = await cloudLlmService.generate(prompt, {
        maxTokens: 1000,
        temperature: 0.3
      });

      // Save summary
      const config = await Storage.get('cloudLlmConfig');
      MobileDB.saveSummary(paperId, response, config?.model || 'unknown');
      await MobileDB.saveDatabase();

      emit('consoleLog', { message: 'Summary generated', level: 'success' });
      return { success: true, summary: response };
    } catch (error) {
      emit('consoleLog', { message: `Summarization failed: ${error.message}`, level: 'error' });
      return { success: false, error: error.message };
    }
  },

  async llmAsk(paperId, question, options = {}) {
    try {
      if (!cloudLlmService) {
        return { success: false, error: 'Cloud LLM not configured' };
      }

      if (!dbInitialized) await initializeDatabase();

      const paper = MobileDB.getPaper(paperId);
      if (!paper) return { success: false, error: 'Paper not found' };

      const authorStr = Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || 'Unknown authors');

      const prompt = `Based on this paper, please answer the question:

Title: ${paper.title}
Authors: ${authorStr}
Abstract: ${paper.abstract || 'No abstract available'}

Question: ${question}

Please provide a concise answer based on the paper content.`;

      const response = await cloudLlmService.generate(prompt, {
        maxTokens: 500,
        temperature: 0.5
      });

      // Save to history
      const config = await Storage.get('cloudLlmConfig');
      MobileDB.addQAEntry(paperId, question, response, config?.model || 'unknown');
      await MobileDB.saveDatabase();

      return { success: true, answer: response };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async llmExplain(text, paperId) {
    try {
      if (!cloudLlmService) {
        return { success: false, error: 'Cloud LLM not configured' };
      }

      const prompt = `Please explain this text from an academic paper in simpler terms:

"${text}"

Provide a clear, accessible explanation.`;

      const response = await cloudLlmService.generate(prompt, {
        maxTokens: 300,
        temperature: 0.5
      });

      return { success: true, explanation: response };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async llmGenerateEmbeddings(paperId) {
    return { success: false, error: 'Embeddings not yet implemented for iOS' };
  },

  async llmGetUnindexedPapers() {
    return [];
  },

  async llmExtractMetadata(paperId) {
    return { success: false, error: 'Metadata extraction not yet implemented for iOS' };
  },

  async llmSemanticSearch(query, limit = 10) {
    return [];
  },

  async llmGetQAHistory(paperId) {
    if (!dbInitialized) await initializeDatabase();
    return MobileDB.getQAHistory(paperId);
  },

  async llmClearQAHistory(paperId) {
    if (!dbInitialized) await initializeDatabase();
    MobileDB.clearQAHistory(paperId);
    await MobileDB.saveDatabase();
    return { success: true };
  },

  async llmDeleteSummary(paperId) {
    if (!dbInitialized) await initializeDatabase();
    MobileDB.deleteSummary(paperId);
    await MobileDB.saveDatabase();
    return { success: true };
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ANNOTATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async getAnnotations(paperId, pdfSource = null) {
    if (!dbInitialized) await initializeDatabase();
    return MobileDB.getAnnotations(paperId, pdfSource);
  },

  async getAnnotationCountsBySource(paperId) {
    if (!dbInitialized) await initializeDatabase();
    return MobileDB.getAnnotationCountsBySource(paperId);
  },

  async getDownloadedPdfSources(paperId) {
    try {
      const paper = MobileDB.getPaper(paperId);
      if (!paper || !paper.bibcode) {
        return [];
      }

      const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
      const downloadedSources = [];

      // Check for each source type: bibcode_SOURCETYPE.pdf
      const sourceTypes = ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF'];
      for (const sourceType of sourceTypes) {
        const filename = `${baseFilename}_${sourceType}.pdf`;
        const filePath = `${LIBRARY_FOLDER}/papers/${filename}`;

        try {
          await Filesystem.stat({
            path: filePath,
            directory: Directory.Documents
          });
          downloadedSources.push(sourceType);
        } catch (e) {
          // File doesn't exist
        }
      }

      return downloadedSources;
    } catch (error) {
      console.error('[getDownloadedPdfSources] Error:', error);
      return [];
    }
  },

  async getPdfAttachments(paperId) {
    // Stub for iOS - attachments not yet supported
    // Return empty array to avoid errors
    return [];
  },

  async deletePdf(paperId, sourceType) {
    try {
      const paper = MobileDB.getPaper(paperId);
      if (!paper || !paper.bibcode) {
        return { success: false, error: 'Paper not found' };
      }

      const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `${baseFilename}_${sourceType}.pdf`;
      const filePath = `${LIBRARY_FOLDER}/papers/${filename}`;

      try {
        await Filesystem.deleteFile({
          path: filePath,
          directory: Directory.Documents
        });
        emit('consoleLog', { message: `Deleted ${sourceType} PDF for ${paper.bibcode}`, level: 'info' });

        // If this was the primary PDF, clear the pdf_path
        if (paper.pdf_source === sourceType) {
          MobileDB.updatePaper(paperId, {
            pdf_path: null,
            pdf_source: null
          });
        }

        return { success: true };
      } catch (e) {
        // File may not exist
        return { success: true };
      }
    } catch (error) {
      console.error('[deletePdf] Error:', error);
      return { success: false, error: error.message };
    }
  },

  async createAnnotation(paperId, data) {
    try {
      if (!dbInitialized) await initializeDatabase();
      const id = MobileDB.createAnnotation(paperId, data);
      await MobileDB.saveDatabase();
      return { success: true, id };
    } catch (error) {
      console.error('[createAnnotation] Error:', error);
      return { success: false, error: error.message };
    }
  },

  async updateAnnotation(id, data) {
    try {
      if (!dbInitialized) await initializeDatabase();
      MobileDB.updateAnnotation(id, data);
      await MobileDB.saveDatabase();
      return { success: true };
    } catch (error) {
      console.error('[updateAnnotation] Error:', error);
      return { success: false, error: error.message };
    }
  },

  async deleteAnnotation(id) {
    try {
      if (!dbInitialized) await initializeDatabase();
      MobileDB.deleteAnnotation(id);
      await MobileDB.saveDatabase();
      return { success: true };
    } catch (error) {
      console.error('[deleteAnnotation] Error:', error);
      return { success: false, error: error.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PAPER FILES (New unified file management system)
  // ═══════════════════════════════════════════════════════════════════════════

  // Helper: compute SHA-256 hash of file data (base64)
  async _computeFileHash(base64Data) {
    try {
      // Decode base64 to ArrayBuffer
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      // Compute SHA-256
      const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (error) {
      console.error('[_computeFileHash] Error:', error);
      return null;
    }
  },

  // Helper: detect MIME type from extension
  _getMimeType(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const mimeTypes = {
      'pdf': 'application/pdf',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'csv': 'text/csv',
      'txt': 'text/plain',
      'json': 'application/json',
      'bib': 'application/x-bibtex'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  },

  // Paper Files namespace object
  paperFiles: {
    async add(paperId, filePath, options = {}) {
      // options: { role, sourceType, originalName, sourceUrl }
      try {
        if (!dbInitialized) await initializeDatabase();

        const paper = MobileDB.getPaper(paperId);
        if (!paper) {
          return { success: false, error: 'Paper not found' };
        }

        const currentLibraryPath = MobileDB.getLibraryPath() || LIBRARY_FOLDER;
        const location = MobileDB.getLocation?.() || 'local';
        const {
          role = 'pdf',
          sourceType = 'manual',
          originalName,
          sourceUrl
        } = options;

        // Read file data for hashing
        let fileData, fileSize;
        try {
          const result = location === 'icloud'
            ? await ICloud.readFile({ path: filePath, encoding: null })
            : await Filesystem.readFile({ path: filePath, directory: Directory.Documents });
          fileData = result.data;
          // Estimate size from base64 (rough)
          fileSize = Math.floor(fileData.length * 0.75);
        } catch (readError) {
          console.error('[paperFiles.add] Read error:', readError);
          return { success: false, error: `Cannot read file: ${readError.message}` };
        }

        // Compute hash
        const fileHash = await capacitorAPI._computeFileHash(fileData);

        // Check for duplicate by hash
        if (fileHash) {
          const existing = MobileDB.getFilesByHash(fileHash);
          if (existing.length > 0) {
            emit('consoleLog', { message: `File already exists (duplicate detected)`, level: 'warn' });
            // Return existing file instead of duplicating
            return { success: true, file: existing[0], duplicate: true };
          }
        }

        // Generate storage filename
        const ext = (filePath.split('.').pop() || 'pdf').toLowerCase();
        const mimeType = capacitorAPI._getMimeType(filePath);
        let storageFilename;

        if (fileHash) {
          // Content-addressed: files/{prefix}/{hash}.ext
          const hashPrefix = fileHash.substring(0, 2);
          storageFilename = `files/${hashPrefix}/${fileHash}.${ext}`;

          // Ensure directory exists
          try {
            if (location === 'icloud') {
              await ICloud.mkdir({ path: `${currentLibraryPath}/files/${hashPrefix}`, recursive: true });
            } else {
              await Filesystem.mkdir({
                path: `${currentLibraryPath}/files/${hashPrefix}`,
                directory: Directory.Documents,
                recursive: true
              });
            }
          } catch (e) { /* dir exists */ }
        } else {
          // Fallback: legacy naming
          const bibcode = paper.bibcode || `paper_${paperId}`;
          const safeBibcode = bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
          storageFilename = `papers/${safeBibcode}_${sourceType.toUpperCase()}.${ext}`;
        }

        const destPath = `${currentLibraryPath}/${storageFilename}`;

        // Copy/write file to library
        try {
          if (location === 'icloud') {
            await ICloud.writeFile({ path: destPath, data: fileData, encoding: null });
          } else {
            await Filesystem.writeFile({
              path: destPath,
              data: fileData,
              directory: Directory.Documents
            });
          }
        } catch (writeError) {
          console.error('[paperFiles.add] Write error:', writeError);
          return { success: false, error: `Cannot save file: ${writeError.message}` };
        }

        // Insert into database
        const fileRecord = {
          file_hash: fileHash,
          filename: storageFilename,
          original_name: originalName || filePath.split('/').pop(),
          mime_type: mimeType,
          file_size: fileSize,
          file_role: role,
          source_type: sourceType,
          source_url: sourceUrl || null,
          status: 'ready'
        };

        const fileId = MobileDB.addPaperFile(paperId, fileRecord);

        // Also update legacy pdf_path for backwards compatibility
        if (role === 'pdf') {
          MobileDB.updatePaper(paperId, {
            pdf_path: storageFilename,
            pdf_source: sourceType
          });
        }

        await MobileDB.saveDatabase();

        emit('consoleLog', { message: `Added file: ${originalName || storageFilename}`, level: 'success' });
        return {
          success: true,
          file: { id: fileId, paper_id: paperId, ...fileRecord }
        };
      } catch (error) {
        console.error('[paperFiles.add] Error:', error);
        return { success: false, error: error.message };
      }
    },

    async remove(fileId) {
      try {
        if (!dbInitialized) await initializeDatabase();

        // Get file record
        const file = MobileDB.getPaperFile(fileId);
        if (!file) {
          return { success: false, error: 'File not found' };
        }

        const currentLibraryPath = MobileDB.getLibraryPath() || LIBRARY_FOLDER;
        const location = MobileDB.getLocation?.() || 'local';

        // Check if this hash is used by other files (deduplication)
        let shouldDeleteFile = true;
        if (file.file_hash) {
          const filesWithHash = MobileDB.getFilesByHash(file.file_hash);
          if (filesWithHash.length > 1) {
            shouldDeleteFile = false;
            emit('consoleLog', { message: `File shared by ${filesWithHash.length} papers, keeping physical file`, level: 'info' });
          }
        }

        // Delete physical file if not shared
        if (shouldDeleteFile && file.filename) {
          const filePath = `${currentLibraryPath}/${file.filename}`;
          try {
            if (location === 'icloud') {
              await ICloud.deleteFile({ path: filePath });
            } else {
              await Filesystem.deleteFile({ path: filePath, directory: Directory.Documents });
            }
          } catch (delError) {
            console.warn('[paperFiles.remove] Could not delete file:', delError.message);
          }
        }

        // Delete database record
        MobileDB.deletePaperFile(fileId);

        // Update legacy pdf_path if this was the primary PDF
        const paper = MobileDB.getPaper(file.paper_id);
        if (paper && paper.pdf_path === file.filename) {
          // Find another PDF to set as primary
          const remainingPdfs = MobileDB.getPaperPdfs(file.paper_id);
          if (remainingPdfs.length > 0) {
            MobileDB.updatePaper(file.paper_id, {
              pdf_path: remainingPdfs[0].filename,
              pdf_source: remainingPdfs[0].source_type
            });
          } else {
            MobileDB.updatePaper(file.paper_id, {
              pdf_path: null,
              pdf_source: null
            });
          }
        }

        await MobileDB.saveDatabase();

        emit('consoleLog', { message: `Removed file`, level: 'success' });
        return { success: true };
      } catch (error) {
        console.error('[paperFiles.remove] Error:', error);
        return { success: false, error: error.message };
      }
    },

    async get(fileId) {
      try {
        if (!dbInitialized) await initializeDatabase();
        return MobileDB.getPaperFile(fileId);
      } catch (error) {
        console.error('[paperFiles.get] Error:', error);
        return null;
      }
    },

    async list(paperId, filters = {}) {
      // filters: { role, status }
      try {
        if (!dbInitialized) await initializeDatabase();

        // Get from database
        // Note: Legacy pdf_path fallback removed - use only paper_files table
        const files = MobileDB.getPaperFiles(paperId, filters);
        return files;
      } catch (error) {
        console.error('[paperFiles.list] Error:', error);
        return [];
      }
    },

    async getPrimaryPdf(paperId) {
      try {
        if (!dbInitialized) await initializeDatabase();

        // Note: Legacy pdf_path fallback removed - use only paper_files table
        const pdfs = MobileDB.getPaperPdfs(paperId);
        return pdfs.length > 0 ? pdfs[0] : null;
      } catch (error) {
        console.error('[paperFiles.getPrimaryPdf] Error:', error);
        return null;
      }
    },

    async setPrimaryPdf(paperId, fileId) {
      try {
        if (!dbInitialized) await initializeDatabase();

        const file = MobileDB.getPaperFile(fileId);
        if (!file) {
          return { success: false, error: 'File not found' };
        }

        // Update legacy pdf_path for compatibility
        MobileDB.updatePaper(paperId, {
          pdf_path: file.filename,
          pdf_source: file.source_type
        });
        await MobileDB.saveDatabase();

        emit('consoleLog', { message: `Set primary PDF to ${file.source_type || 'file'}`, level: 'success' });
        return { success: true };
      } catch (error) {
        console.error('[paperFiles.setPrimaryPdf] Error:', error);
        return { success: false, error: error.message };
      }
    },

    async getPath(fileId) {
      try {
        if (!dbInitialized) await initializeDatabase();

        const file = MobileDB.getPaperFile(fileId);
        if (!file) return null;

        const currentLibraryPath = MobileDB.getLibraryPath() || LIBRARY_FOLDER;
        return `${currentLibraryPath}/${file.filename}`;
      } catch (error) {
        console.error('[paperFiles.getPath] Error:', error);
        return null;
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DOWNLOAD QUEUE (New download queue management)
  // ═══════════════════════════════════════════════════════════════════════════

  // Download queue state stored in memory and paper_files table
  downloadQueue: {
    _queue: [],
    _active: [],
    _paused: false,
    _concurrency: 2,
    _completedCount: 0,
    _failedCount: 0,

    // Initialize queue from database (recover pending downloads)
    async _initFromDatabase() {
      try {
        if (!dbInitialized) await initializeDatabase();
        const pendingFiles = MobileDB.getPendingFiles();
        for (const file of pendingFiles) {
          this._queue.push({
            id: `file-${file.id}`,
            fileId: file.id,
            paperId: file.paper_id,
            bibcode: file.bibcode,
            sourceType: file.source_type,
            priority: 0,
            status: 'pending'
          });
        }
        if (pendingFiles.length > 0) {
          emit('consoleLog', { message: `Recovered ${pendingFiles.length} pending downloads`, level: 'info' });
        }
      } catch (error) {
        console.error('[downloadQueue._initFromDatabase] Error:', error);
      }
    },

    async enqueue(paperId, sourceType, priority = 0) {
      console.log('[downloadQueue.enqueue] Starting:', paperId, sourceType, priority);
      try {
        if (!dbInitialized) await initializeDatabase();

        const paper = MobileDB.getPaper(paperId);
        console.log('[downloadQueue.enqueue] Paper:', paper?.bibcode || 'not found');
        if (!paper) {
          return { success: false, error: 'Paper not found' };
        }

        // Normalize source type for internal use
        const normalizedSource = {
          'EPRINT_PDF': 'arxiv',
          'PUB_PDF': 'publisher',
          'ADS_PDF': 'ads_scan',
          'arxiv': 'arxiv',
          'publisher': 'publisher',
          'ads_scan': 'ads_scan'
        }[sourceType] || sourceType || 'arxiv';

        // Map to ADS source type for filename (matches desktop convention)
        const fileSourceType = {
          'arxiv': 'EPRINT_PDF',
          'publisher': 'PUB_PDF',
          'ads_scan': 'ADS_PDF'
        }[normalizedSource] || sourceType;

        // Create file record with 'queued' status
        const currentLibraryPath = MobileDB.getLibraryPath() || LIBRARY_FOLDER;
        const bibcode = paper.bibcode || `paper_${paperId}`;
        const safeBibcode = bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `papers/${safeBibcode}_${fileSourceType}.pdf`;

        const fileId = MobileDB.addPaperFile(paperId, {
          filename: filename,
          original_name: `${bibcode}_${normalizedSource}.pdf`,
          mime_type: 'application/pdf',
          file_role: 'pdf',
          source_type: normalizedSource,
          status: 'queued'
        });

        await MobileDB.saveDatabase();

        const queueItem = {
          id: `file-${fileId}`,
          fileId,
          paperId,
          bibcode: paper.bibcode,
          arxivId: paper.arxiv_id,
          doi: paper.doi,
          sourceType: normalizedSource,
          priority,
          status: 'pending'
        };

        this._queue.push(queueItem);
        this._queue.sort((a, b) => b.priority - a.priority);

        emit('consoleLog', { message: `Queued download: ${paper.bibcode || paperId} (${normalizedSource})`, level: 'info' });

        // Start processing if not paused
        if (!this._paused) {
          this._processQueue();
        }

        return { success: true, queueItem };
      } catch (error) {
        console.error('[downloadQueue.enqueue] Error:', error);
        return { success: false, error: error.message };
      }
    },

    async enqueueMany(paperIds, sourceType) {
      const results = [];
      for (const paperId of paperIds) {
        const result = await this.enqueue(paperId, sourceType, 0);
        results.push(result);
      }
      return { success: true, queued: results };
    },

    async cancel(paperId) {
      // Remove from queue
      const index = this._queue.findIndex(item => item.paperId === paperId);
      if (index !== -1) {
        const item = this._queue.splice(index, 1)[0];
        // Update database status
        if (item.fileId) {
          MobileDB.updatePaperFile(item.fileId, { status: 'cancelled' });
          await MobileDB.saveDatabase();
        }
      }
      return { success: true };
    },

    async cancelAll() {
      // Update all queued files in database
      for (const item of this._queue) {
        if (item.fileId) {
          MobileDB.updatePaperFile(item.fileId, { status: 'cancelled' });
        }
      }
      this._queue = [];
      await MobileDB.saveDatabase();
      return { success: true };
    },

    async status() {
      return {
        queued: this._queue.length,
        active: this._active.length,
        completed: this._completedCount,
        failed: this._failedCount,
        paused: this._paused,
        items: [...this._queue, ...this._active]
      };
    },

    pause() {
      this._paused = true;
      emit('consoleLog', { message: 'Download queue paused', level: 'info' });
    },

    resume() {
      this._paused = false;
      emit('consoleLog', { message: 'Download queue resumed', level: 'info' });
      this._processQueue();
    },

    // Event listener methods for the download queue
    onProgress(callback) {
      eventListeners.downloadQueueProgress.push(callback);
    },

    onComplete(callback) {
      eventListeners.downloadQueueComplete.push(callback);
    },

    onError(callback) {
      eventListeners.downloadQueueError.push(callback);
    },

    async _processQueue() {
      console.log('[downloadQueue._processQueue] Starting. Paused:', this._paused, 'Active:', this._active.length, 'Queue:', this._queue.length);
      if (this._paused) return;
      if (this._active.length >= this._concurrency) return;
      if (this._queue.length === 0) {
        // Check if queue is now empty and we had items
        if (this._completedCount > 0 || this._failedCount > 0) {
          emit('downloadQueueEmpty', {
            completed: this._completedCount,
            failed: this._failedCount
          });
        }
        return;
      }

      const item = this._queue.shift();
      console.log('[downloadQueue._processQueue] Processing item:', item?.bibcode, item?.sourceType);
      if (!item) return;

      this._active.push(item);
      item.status = 'downloading';

      // Update database status
      if (item.fileId) {
        MobileDB.updatePaperFile(item.fileId, { status: 'downloading' });
        await MobileDB.saveDatabase();
      }

      try {
        const paper = MobileDB.getPaper(item.paperId);
        if (!paper) {
          throw new Error('Paper not found');
        }

        emit('downloadQueueProgress', {
          paperId: item.paperId,
          bibcode: paper.bibcode,
          sourceType: item.sourceType,
          status: 'downloading',
          progress: 0
        });

        // Download the PDF based on source type
        const result = await this._downloadFile(paper, item.sourceType, item.fileId);

        if (result.success) {
          // Update file record with hash and path
          MobileDB.updatePaperFile(item.fileId, {
            filename: result.path,
            file_hash: result.hash,
            file_size: result.size,
            status: 'ready'
          });

          // Update legacy pdf_path
          MobileDB.updatePaper(item.paperId, {
            pdf_path: result.path,
            pdf_source: item.sourceType
          });

          await MobileDB.saveDatabase();
          this._completedCount++;

          emit('downloadQueueComplete', {
            paperId: item.paperId,
            fileId: item.fileId,
            bibcode: paper.bibcode,
            path: result.path,
            source: item.sourceType
          });
        } else {
          MobileDB.updatePaperFile(item.fileId, {
            status: 'error',
            error_message: result.error
          });
          await MobileDB.saveDatabase();
          this._failedCount++;

          emit('downloadQueueError', {
            paperId: item.paperId,
            fileId: item.fileId,
            bibcode: paper.bibcode,
            error: result.error
          });
        }
      } catch (error) {
        console.error('[downloadQueue._processQueue] Error:', error);
        if (item.fileId) {
          MobileDB.updatePaperFile(item.fileId, {
            status: 'error',
            error_message: error.message
          });
          await MobileDB.saveDatabase();
        }
        this._failedCount++;

        emit('downloadQueueError', {
          paperId: item.paperId,
          fileId: item.fileId,
          error: error.message
        });
      } finally {
        // Remove from active
        const activeIndex = this._active.findIndex(a => a.id === item.id);
        if (activeIndex !== -1) {
          this._active.splice(activeIndex, 1);
        }

        // Process next item
        this._processQueue();
      }
    },

    async _downloadFile(paper, sourceType, fileId) {
      console.log('[downloadQueue._downloadFile] Starting:', paper?.bibcode, sourceType);
      const token = await Keychain.getItem('adsToken');
      const currentLibraryPath = MobileDB.getLibraryPath() || LIBRARY_FOLDER;
      const location = MobileDB.getLocation?.() || 'local';
      const bibcode = paper.bibcode || `paper_${paper.id}`;
      const safeBibcode = bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');

      let pdfUrl = null;

      // Determine PDF URL based on source type
      if (sourceType === 'arxiv' && paper.arxiv_id) {
        pdfUrl = `https://arxiv.org/pdf/${paper.arxiv_id}.pdf`;
        console.log('[downloadQueue._downloadFile] arXiv URL:', pdfUrl);
      } else if (sourceType === 'publisher' || sourceType === 'ads_scan') {
        // Fetch e-sources from ADS
        if (!token) {
          return { success: false, error: 'ADS token not configured' };
        }

        try {
          const esourcesUrl = `${ADS_API_BASE}/resolver/${encodeURIComponent(bibcode)}/esource`;
          const response = await CapacitorHttp.get({
            url: esourcesUrl,
            headers: { 'Authorization': `Bearer ${token}` }
          });

          const links = parseEsourcesResponse(response.data);
          const sourceKey = sourceType === 'publisher' ? 'PUB_PDF' : 'ADS_PDF';
          const source = links.find(l => l.type === sourceKey || l.link_type === sourceKey);

          if (source) {
            pdfUrl = source.url || source.link;
          }
        } catch (e) {
          console.error('[downloadQueue._downloadFile] esources error:', e);
        }
      }

      if (!pdfUrl) {
        return { success: false, error: `No ${sourceType} PDF available` };
      }

      // Map to ADS source type for filename (matches desktop convention)
      const fileSourceType = {
        'arxiv': 'EPRINT_PDF',
        'publisher': 'PUB_PDF',
        'ads_scan': 'ADS_PDF'
      }[sourceType] || sourceType.toUpperCase();

      // Download the file
      const filename = `papers/${safeBibcode}_${fileSourceType}.pdf`;
      const destPath = `${currentLibraryPath}/${filename}`;
      const papersDir = `${currentLibraryPath}/papers`;

      console.log('[downloadQueue._downloadFile] Location:', location, 'Path:', destPath);

      try {
        // Create directories using iCloud-aware helper
        console.log('[downloadQueue._downloadFile] Creating directory:', papersDir);
        try {
          await fsMkdir(currentLibraryPath, location);
          console.log('[downloadQueue._downloadFile] Library dir created/exists');
        } catch (e) {
          console.log('[downloadQueue._downloadFile] Library dir mkdir:', e.message || 'exists');
        }

        try {
          await fsMkdir(papersDir, location);
          console.log('[downloadQueue._downloadFile] Papers dir created/exists');
        } catch (e) {
          console.log('[downloadQueue._downloadFile] Papers dir mkdir:', e.message || 'exists');
        }

        console.log('[downloadQueue._downloadFile] Downloading from:', pdfUrl);

        // Download file content via HTTP
        const httpResponse = await CapacitorHttp.get({
          url: pdfUrl,
          responseType: 'blob',
          headers: {
            'Accept': 'application/pdf'
          }
        });

        if (httpResponse.status !== 200) {
          return { success: false, error: `HTTP ${httpResponse.status}: Download failed` };
        }

        // Get the data - it's already base64 encoded when responseType is 'blob'
        const pdfData = httpResponse.data;
        console.log('[downloadQueue._downloadFile] Downloaded bytes:', pdfData?.length || 0);

        // Check PDF magic bytes (base64 for %PDF = JVBERi)
        if (!pdfData || !pdfData.startsWith('JVBERi')) {
          console.log('[downloadQueue._downloadFile] Invalid PDF, magic:', pdfData?.substring(0, 20));
          return { success: false, error: 'Downloaded file is not a valid PDF' };
        }

        // Write file using iCloud-aware helper
        console.log('[downloadQueue._downloadFile] Writing to:', destPath);
        await fsWriteFile(destPath, pdfData, location, null);  // null encoding = binary/base64

        // Compute hash
        const hash = await capacitorAPI._computeFileHash(pdfData);
        const size = Math.floor(pdfData.length * 0.75);  // base64 to bytes estimate

        console.log('[downloadQueue._downloadFile] Success, hash:', hash);
        return {
          success: true,
          path: filename,
          hash: hash,
          size: size
        };
      } catch (downloadError) {
        console.error('[downloadQueue._downloadFile] Error:', downloadError);
        return { success: false, error: downloadError.message };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  async openExternal(url) {
    window.open(url, '_blank');
  },

  async showInFinder(filePath) {
    // Not applicable on iOS
    return { success: false, error: 'Not available on iOS' };
  },

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  async showSaveDialog(options) {
    return { canceled: true };
  },

  async writeFile(path, content) {
    try {
      await Filesystem.writeFile({
        path,
        data: content,
        directory: Directory.Documents,
        encoding: Encoding.UTF8
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════════════════════

  onConsoleLog(callback) {
    eventListeners.consoleLog.push(callback);
  },

  removeConsoleLogListeners() {
    eventListeners.consoleLog = [];
  },

  onAdsSyncProgress(callback) {
    eventListeners.adsSyncProgress.push(callback);
  },

  removeAdsSyncListeners() {
    eventListeners.adsSyncProgress = [];
  },

  onImportProgress(callback) {
    console.log('[API] Registering importProgress listener');
    eventListeners.importProgress.push(callback);
  },

  onImportComplete(callback) {
    console.log('[API] Registering importComplete listener');
    eventListeners.importComplete.push(callback);
  },

  removeImportListeners() {
    eventListeners.importProgress = [];
    eventListeners.importComplete = [];
  },

  onLlmStream(callback) {
    eventListeners.llmStream.push(callback);
  },

  removeLlmListeners() {
    eventListeners.llmStream = [];
  },

  // Download queue event listeners
  onDownloadQueueProgress(callback) {
    eventListeners.downloadQueueProgress.push(callback);
  },

  onDownloadQueueComplete(callback) {
    eventListeners.downloadQueueComplete.push(callback);
  },

  onDownloadQueueError(callback) {
    eventListeners.downloadQueueError.push(callback);
  },

  removeDownloadQueueListeners() {
    eventListeners.downloadQueueProgress = [];
    eventListeners.downloadQueueComplete = [];
    eventListeners.downloadQueueError = [];
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PLATFORM INFO
  // ═══════════════════════════════════════════════════════════════════════════

  platform: 'ios',
};

// Export emit function for internal use (e.g., when implementing features)
export { emit };
