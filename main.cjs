const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const Store = require('electron-store');
const { updateElectronApp, UpdateSourceType } = require('update-electron-app');

// Auto-updater state
let updateStatus = { checking: false, available: false, downloaded: false, error: null };

// Handle EPIPE errors gracefully (occurs when terminal is closed but app keeps running)
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') return; // Ignore EPIPE
  throw err;
});
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') return; // Ignore EPIPE
  throw err;
});

// Paper Files Container system
const { FileManager } = require('./src/lib/files/file-manager.cjs');
const { DownloadQueue } = require('./src/lib/files/download-queue.cjs');
const {
  ArxivDownloader,
  PublisherDownloader,
  AdsDownloader,
  DownloadStrategyManager
} = require('./src/lib/files/download-strategies.cjs');

// sql.js for reading other library databases (for paper counts)
let sqlJs = null;
async function ensureSqlJs() {
  if (!sqlJs) {
    const initSqlJs = require('sql.js');
    sqlJs = await initSqlJs();
  }
  return sqlJs;
}

// iCloud container identifier (matches iOS entitlements)
const ICLOUD_CONTAINER_ID = 'iCloud.io.adsreader.app';

/**
 * Get the iCloud container path for this app
 * @returns {string} Path to iCloud container Documents folder
 */
function getICloudContainerPath() {
  // iCloud container format: ~/Library/Mobile Documents/iCloud~{bundleId}/Documents/
  // Container ID "iCloud.io.adsreader.app" becomes folder "iCloud~io~adsreader~app"
  const folderName = ICLOUD_CONTAINER_ID.replace(/\./g, '~');
  return path.join(os.homedir(), 'Library', 'Mobile Documents', folderName, 'Documents');
}

/**
 * Check if iCloud is available on this system
 * @returns {boolean}
 */
function isICloudAvailable() {
  // Check if Mobile Documents folder exists (user is signed in to iCloud)
  const mobileDocsPath = path.join(os.homedir(), 'Library', 'Mobile Documents');
  return fs.existsSync(mobileDocsPath);
}

/**
 * Ensure iCloud container directory exists
 * @returns {boolean} Success
 */
function ensureICloudContainer() {
  const containerPath = getICloudContainerPath();
  try {
    if (!fs.existsSync(containerPath)) {
      fs.mkdirSync(containerPath, { recursive: true });
    }
    return true;
  } catch (e) {
    console.error('Failed to create iCloud container:', e);
    return false;
  }
}

/**
 * Get fallback path for iCloud-like storage when real iCloud isn't available
 * Used during development when app isn't code-signed
 */
function getICloudFallbackPath() {
  return path.join(os.homedir(), 'Documents', 'ADSReader-Cloud');
}

/**
 * Check if we can write to the iCloud container
 */
function canWriteToICloud() {
  const containerPath = getICloudContainerPath();
  const testPath = path.join(containerPath, '.write-test-' + Date.now());
  try {
    // Try to create parent directory
    if (!fs.existsSync(containerPath)) {
      fs.mkdirSync(containerPath, { recursive: true });
    }
    // Try to write a test file
    fs.writeFileSync(testPath, 'test');
    fs.unlinkSync(testPath);
    return true;
  } catch (e) {
    return false;
  }
}

// Import modules
const database = require('./src/main/database.cjs');
const pdfImport = require('./src/main/pdf-import.cjs');
const pdfDownload = require('./src/main/pdf-download.cjs');
const adsApi = require('./src/main/ads-api.cjs');
const bibtex = require('./src/main/bibtex.cjs');
const { OllamaService, PROMPTS, chunkText, cosineSimilarity, parseSummaryResponse, parseMetadataResponse } = require('./src/main/llm-service.cjs');
const { CloudLLMService, PROVIDERS: CLOUD_PROVIDERS } = require('./src/main/cloud-llm-service.cjs');

// Plugin System
const { pluginManager } = require('./src/lib/plugins/manager.cjs');
const { adsPlugin } = require('./src/plugins/ads/index.cjs');
const arxivPlugin = require('./src/plugins/arxiv/index.cjs');
const inspirePlugin = require('./src/plugins/inspire/index.cjs');

/**
 * Clean a DOI by removing common garbage suffixes and malformed paths
 * @param {string} doi - Raw DOI string
 * @returns {string} Cleaned DOI
 */
function cleanDOI(doi) {
  if (!doi) return doi;
  return doi
    .replace(/^https?:\/\/doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .replace(/\/CITE\/REFWORKS$/i, '')
    .replace(/\/abstract$/i, '')
    .replace(/\/full$/i, '')
    .replace(/\/pdf$/i, '')
    // Remove asset paths (e.g., /ASSET/.../filename.JPEG)
    .replace(/\/ASSET\/.*$/i, '')
    // Remove image file extensions and paths (e.g., /2/M_filename.GIF)
    .replace(/\/\d+\/[^\/]*\.(gif|jpeg|jpg|png|svg|webp)$/i, '')
    // Remove trailing image paths that don't start with /number/
    .replace(/\/[^\/]*\.(gif|jpeg|jpg|png|svg|webp)$/i, '')
    .trim();
}

// Optional keytar for secure API key storage (falls back to electron-store if not available)
let keytar = null;
try {
  keytar = require('keytar');
} catch (e) {
  console.log('Keytar not available, using fallback storage for API keys');
}

// Keychain service name
const KEYCHAIN_SERVICE = 'adsreader';

// Initialize LLM services (will be configured from settings)
let ollamaService = null;
let cloudService = null;
let llmService = null; // Legacy alias for backward compatibility

// Helper to send console log messages to renderer
function sendConsoleLog(message, type = 'info', details = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('console-log', { message, type, details });
  }
  // Also log to terminal (wrapped to prevent EPIPE crashes)
  try {
    console.log(`[${type.toUpperCase()}] ${message}`);
    if (details) {
      console.log(`  Details: ${details}`);
    }
  } catch (e) {
    // Ignore EPIPE errors when terminal is closed
  }
}

/**
 * Wrap a promise with a timeout
 * @param {Promise} promise - The promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [operation='Operation'] - Description for error message
 * @returns {Promise}
 */
function withTimeout(promise, ms, operation = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms)
    )
  ]);
}

// Sync state management
let syncInProgress = false;

// Initialize preferences store
const store = new Store({
  name: 'preferences',
  defaults: {
    libraryPath: null,
    windowBounds: { width: 1400, height: 900 },
    adsToken: null,
    sidebarWidth: 240,
    listWidth: 350,
    pdfZoom: 1.0,
    lastSelectedPaperId: null,
    llmConfig: {
      // Provider selection: 'ollama', 'anthropic', 'gemini', 'perplexity'
      activeProvider: 'ollama',
      // Per-provider settings
      ollama: {
        endpoint: 'http://127.0.0.1:11434',
        model: 'qwen3:30b',
        embeddingModel: 'nomic-embed-text'
      },
      anthropic: {
        model: 'claude-3-5-sonnet-20241022'
      },
      gemini: {
        model: 'gemini-1.5-flash'
      },
      perplexity: {
        model: 'llama-3.1-sonar-small-128k-online'
      },
      // Selected model for AI panel (remembers selection)
      selectedModel: null,
      // Custom summary prompt
      summaryPrompt: null,
      // Legacy fields for backward compatibility
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen3:30b',
      embeddingModel: 'nomic-embed-text'
    },
    libraryProxyUrl: null  // e.g., 'https://proxy.library.edu/login?url='
  }
});

// Migration: upgrade old llmConfig format to new multi-provider format
const llmConfig = store.get('llmConfig');
if (llmConfig) {
  let updated = false;

  // Migrate from old flat config to new provider-based config
  if (!llmConfig.activeProvider) {
    llmConfig.activeProvider = 'ollama';
    llmConfig.ollama = {
      endpoint: llmConfig.endpoint || 'http://127.0.0.1:11434',
      model: llmConfig.model || 'qwen3:30b',
      embeddingModel: llmConfig.embeddingModel || 'nomic-embed-text'
    };
    llmConfig.anthropic = { model: 'claude-3-5-sonnet-20241022' };
    llmConfig.gemini = { model: 'gemini-1.5-flash' };
    llmConfig.perplexity = { model: 'llama-3.1-sonar-small-128k-online' };
    updated = true;
  }

  // Fix localhost to 127.0.0.1 for IPv6 compatibility
  if (llmConfig.endpoint && llmConfig.endpoint.includes('localhost')) {
    llmConfig.endpoint = llmConfig.endpoint.replace('localhost', '127.0.0.1');
    updated = true;
  }
  if (llmConfig.ollama?.endpoint && llmConfig.ollama.endpoint.includes('localhost')) {
    llmConfig.ollama.endpoint = llmConfig.ollama.endpoint.replace('localhost', '127.0.0.1');
    updated = true;
  }

  // Update model if it's the old default
  if (llmConfig.model === 'qwen3:8b') {
    llmConfig.model = 'qwen3:30b';
    updated = true;
  }
  if (llmConfig.ollama?.model === 'qwen3:8b') {
    llmConfig.ollama.model = 'qwen3:30b';
    updated = true;
  }

  // Remove legacy selectedModel and derive activeProvider from it if needed
  if (llmConfig.selectedModel) {
    const [provider] = llmConfig.selectedModel.split(':');
    if (provider && ['ollama', 'anthropic', 'gemini', 'perplexity'].includes(provider)) {
      llmConfig.activeProvider = provider;
    }
    delete llmConfig.selectedModel;
    updated = true;
  }

  // Remove legacy root-level fields (now stored per-provider)
  if ('model' in llmConfig && llmConfig.ollama) {
    delete llmConfig.model;
    updated = true;
  }
  if ('endpoint' in llmConfig && llmConfig.ollama) {
    delete llmConfig.endpoint;
    updated = true;
  }
  if ('embeddingModel' in llmConfig && llmConfig.ollama) {
    delete llmConfig.embeddingModel;
    updated = true;
  }

  if (updated) {
    store.set('llmConfig', llmConfig);
  }
}

// Helper functions for secure API key storage
async function getApiKey(provider) {
  if (keytar) {
    try {
      return await keytar.getPassword(KEYCHAIN_SERVICE, `${provider}-api-key`);
    } catch (e) {
      console.error('Keytar getPassword failed:', e.message);
    }
  }
  // Fallback to electron-store (less secure)
  return store.get(`apiKeys.${provider}`);
}

async function setApiKey(provider, key) {
  if (keytar) {
    try {
      if (key) {
        await keytar.setPassword(KEYCHAIN_SERVICE, `${provider}-api-key`, key);
      } else {
        await keytar.deletePassword(KEYCHAIN_SERVICE, `${provider}-api-key`);
      }
      return true;
    } catch (e) {
      console.error('Keytar setPassword failed:', e.message);
    }
  }
  // Fallback to electron-store (less secure)
  if (key) {
    store.set(`apiKeys.${provider}`, key);
  } else {
    store.delete(`apiKeys.${provider}`);
  }
  return true;
}

async function deleteApiKey(provider) {
  return setApiKey(provider, null);
}

// Helper to extract arXiv ID from ADS identifier array
function extractArxivId(identifiers) {
  if (!identifiers || !Array.isArray(identifiers)) return null;
  for (const id of identifiers) {
    // Match patterns like "arXiv:2301.12345" or "2301.12345"
    const match = id.match(/(?:arXiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (match) return match[1];
    // Also check for old-style arXiv IDs like "astro-ph/0601001"
    const oldMatch = id.match(/(?:arXiv:)?([a-z-]+\/\d{7}(?:v\d+)?)/i);
    if (oldMatch) return oldMatch[1];
  }
  return null;
}

/**
 * Fetch ADS metadata BEFORE adding paper to database.
 * This ensures all metadata including BibTeX is available at add time.
 *
 * @param {Object} hints - Identifiers and metadata hints
 * @param {string} hints.bibcode - ADS bibcode if known
 * @param {string} hints.doi - DOI if known
 * @param {string} hints.arxiv_id - arXiv ID if known
 * @param {string} hints.textContent - Extracted text from PDF for fallback extraction
 * @param {Object} hints.extractedMetadata - Already extracted metadata (title, author, year)
 * @returns {Object|null} - Complete metadata including bibtex, or null if not found
 */
async function fetchAdsMetadataBeforeAdd(hints = {}) {
  const token = store.get('adsToken');
  if (!token) {
    console.log('[fetchAdsMetadataBeforeAdd] No ADS token available');
    return null;
  }

  try {
    let adsData = null;
    const { bibcode, doi, arxiv_id, textContent, extractedMetadata } = hints;

    // Try direct identifiers first: bibcode → DOI → arXiv
    if (bibcode) {
      console.log(`[fetchAdsMetadataBeforeAdd] Trying bibcode lookup: ${bibcode}`);
      adsData = await adsApi.getByBibcode(token, bibcode);
    }

    if (!adsData && doi) {
      const cleanedDoi = cleanDOI(doi);
      console.log(`[fetchAdsMetadataBeforeAdd] Trying DOI lookup: ${cleanedDoi}`);
      adsData = await adsApi.getByDOI(token, cleanedDoi);
    }

    if (!adsData && arxiv_id) {
      console.log(`[fetchAdsMetadataBeforeAdd] Trying arXiv lookup: ${arxiv_id}`);
      adsData = await adsApi.getByArxiv(token, arxiv_id);
    }

    // If no direct identifier worked but we have text content, try extraction
    if (!adsData && textContent) {
      console.log('[fetchAdsMetadataBeforeAdd] Trying to extract identifiers from content...');
      const contentIds = pdfImport.extractIdentifiersFromContent(textContent);
      console.log('[fetchAdsMetadataBeforeAdd] Extracted identifiers:', contentIds);

      if (contentIds.doi && !adsData) {
        const cleanedDoi = cleanDOI(contentIds.doi);
        console.log(`[fetchAdsMetadataBeforeAdd] Trying extracted DOI: ${cleanedDoi}`);
        adsData = await adsApi.getByDOI(token, cleanedDoi);
      }
      if (!adsData && contentIds.arxiv_id) {
        console.log(`[fetchAdsMetadataBeforeAdd] Trying extracted arXiv: ${contentIds.arxiv_id}`);
        adsData = await adsApi.getByArxiv(token, contentIds.arxiv_id);
      }
      if (!adsData && contentIds.bibcode) {
        console.log(`[fetchAdsMetadataBeforeAdd] Trying extracted bibcode: ${contentIds.bibcode}`);
        adsData = await adsApi.getByBibcode(token, contentIds.bibcode);
      }

      // If still no match, try LLM extraction and smart search
      if (!adsData) {
        let pdfMeta = extractedMetadata || {};

        // Try LLM extraction if service available
        const service = getLlmService();
        const connectionCheck = await service.checkConnection().catch(() => ({ connected: false }));
        if (connectionCheck.connected && textContent) {
          try {
            console.log('[fetchAdsMetadataBeforeAdd] Using LLM to extract metadata...');
            const llmResponse = await withTimeout(
              service.generate(
                PROMPTS.extractMetadata.user(textContent),
                {
                  systemPrompt: PROMPTS.extractMetadata.system,
                  temperature: 0.1,
                  maxTokens: 500,
                  noThink: true
                }
              ),
              30000,
              'LLM metadata extraction'
            );
            const llmMeta = parseMetadataResponse(llmResponse);
            console.log('[fetchAdsMetadataBeforeAdd] LLM-extracted metadata:', llmMeta);

            // Merge LLM results
            if (llmMeta.title) pdfMeta.title = llmMeta.title;
            if (llmMeta.firstAuthor) pdfMeta.firstAuthor = llmMeta.firstAuthor;
            if (llmMeta.year) pdfMeta.year = llmMeta.year;
            if (llmMeta.journal) pdfMeta.journal = llmMeta.journal;

            // Try LLM-extracted identifiers
            if (llmMeta.doi && !adsData) {
              console.log(`[fetchAdsMetadataBeforeAdd] Trying LLM-extracted DOI: ${llmMeta.doi}`);
              adsData = await adsApi.getByDOI(token, llmMeta.doi);
            }
            if (llmMeta.arxiv_id && !adsData) {
              console.log(`[fetchAdsMetadataBeforeAdd] Trying LLM-extracted arXiv: ${llmMeta.arxiv_id}`);
              adsData = await adsApi.getByArxiv(token, llmMeta.arxiv_id);
            }
          } catch (llmError) {
            console.error('[fetchAdsMetadataBeforeAdd] LLM extraction failed:', llmError.message);
          }
        }

        // Use smart multi-strategy search as last resort
        if (!adsData && (pdfMeta.title || pdfMeta.firstAuthor)) {
          console.log('[fetchAdsMetadataBeforeAdd] Using smart search with metadata...');
          try {
            adsData = await adsApi.smartSearch(token, {
              title: pdfMeta.title,
              firstAuthor: pdfMeta.firstAuthor,
              year: pdfMeta.year,
              journal: pdfMeta.journal
            });
          } catch (searchError) {
            console.error('[fetchAdsMetadataBeforeAdd] Smart search failed:', searchError.message);
          }
        }
      }
    }

    if (!adsData) {
      console.log('[fetchAdsMetadataBeforeAdd] Paper not found in ADS');
      return null;
    }

    // Convert ADS data to paper format and fetch BibTeX
    const metadata = adsApi.adsToPaper(adsData);
    let bibtexStr = null;
    try {
      bibtexStr = await adsApi.exportBibtex(token, adsData.bibcode);
    } catch (e) {
      console.error('[fetchAdsMetadataBeforeAdd] Failed to get BibTeX:', e.message);
    }

    console.log(`[fetchAdsMetadataBeforeAdd] Found paper: ${metadata.title}`);
    return {
      ...metadata,
      bibtex: bibtexStr
    };
  } catch (error) {
    console.error('[fetchAdsMetadataBeforeAdd] Error:', error.message);
    return null;
  }
}

// Helper to fetch and apply ADS metadata to a paper
async function fetchAndApplyAdsMetadata(paperId, extractedMetadata = null) {
  const token = store.get('adsToken');
  if (!token) return { success: false, reason: 'No ADS token' };

  const paper = database.getPaper(paperId);
  if (!paper) return { success: false, reason: 'Paper not found' };

  const libraryPath = store.get('libraryPath');

  try {
    let adsData = null;

    // Try to extract bibcode from existing bibtex adsurl field
    let bibcodeFromAdsUrl = null;
    if (!paper.bibcode && paper.bibtex) {
      const adsUrlMatch = paper.bibtex.match(/adsurl\s*=\s*\{([^}]+)\}/i);
      if (adsUrlMatch) {
        const adsUrl = adsUrlMatch[1];
        const absMatch = adsUrl.match(/\/abs\/([^\/\s&?]+)/);
        if (absMatch) {
          bibcodeFromAdsUrl = absMatch[1];
          console.log(`Extracted bibcode from adsurl: ${bibcodeFromAdsUrl}`);
        }
      }
    }

    // Try identifiers first: bibcode, then adsurl bibcode, then DOI, then arXiv
    if (paper.bibcode) {
      console.log(`Trying bibcode lookup: ${paper.bibcode}`);
      adsData = await adsApi.getByBibcode(token, paper.bibcode);
    } else if (bibcodeFromAdsUrl) {
      console.log(`Trying adsurl bibcode lookup: ${bibcodeFromAdsUrl}`);
      adsData = await adsApi.getByBibcode(token, bibcodeFromAdsUrl);
      if (adsData) {
        // Save the bibcode to the paper
        database.updatePaper(paperId, { bibcode: bibcodeFromAdsUrl });
      }
    } else if (paper.doi) {
      const cleanedDoi = cleanDOI(paper.doi);
      console.log(`Trying DOI lookup: ${cleanedDoi}`);
      adsData = await adsApi.getByDOI(token, cleanedDoi);
    } else if (paper.arxiv_id) {
      console.log(`Trying arXiv lookup: ${paper.arxiv_id}`);
      adsData = await adsApi.getByArxiv(token, paper.arxiv_id);
    }

    // If no identifier worked, try to extract from PDF content
    if (!adsData && paper.text_path && libraryPath) {
      const textFile = path.join(libraryPath, paper.text_path);
      if (fs.existsSync(textFile)) {
        console.log('No identifier found, trying to extract from PDF content...');
        const textContent = fs.readFileSync(textFile, 'utf-8');

        // Try to extract identifiers from content
        const contentIds = pdfImport.extractIdentifiersFromContent(textContent);
        console.log('Extracted identifiers from content:', contentIds);

        if (contentIds.doi) {
          const cleanedDoi = cleanDOI(contentIds.doi);
          console.log(`Trying extracted DOI: ${cleanedDoi}`);
          adsData = await adsApi.getByDOI(token, cleanedDoi);
          if (adsData) {
            // Update paper with found DOI (store cleaned version)
            database.updatePaper(paperId, { doi: cleanedDoi });
          }
        }
        if (!adsData && contentIds.arxiv_id) {
          console.log(`Trying extracted arXiv: ${contentIds.arxiv_id}`);
          adsData = await adsApi.getByArxiv(token, contentIds.arxiv_id);
          if (adsData) {
            database.updatePaper(paperId, { arxiv_id: contentIds.arxiv_id });
          }
        }
        if (!adsData && contentIds.bibcode) {
          console.log(`Trying extracted bibcode: ${contentIds.bibcode}`);
          adsData = await adsApi.getByBibcode(token, contentIds.bibcode);
          if (adsData) {
            database.updatePaper(paperId, { bibcode: contentIds.bibcode });
          }
        }

        // If still no match, try searching by title/author/year
        if (!adsData) {
          // First try regex-based extraction
          let pdfMeta = extractedMetadata || pdfImport.extractMetadataFromPDF(textContent);
          console.log('Regex-extracted metadata:', pdfMeta);

          // Use LLM to extract metadata if available (better than regex)
          const service = getLlmService();
          const connectionCheck = await service.checkConnection().catch(() => ({ connected: false }));
          if (connectionCheck.connected) {
            try {
              console.log('Using LLM to extract metadata...');
              const llmResponse = await withTimeout(
                service.generate(
                  PROMPTS.extractMetadata.user(textContent),
                  {
                    systemPrompt: PROMPTS.extractMetadata.system,
                    temperature: 0.1,
                    maxTokens: 500,
                    noThink: true  // Disable thinking mode for faster extraction
                  }
                ),
                30000,
                'LLM metadata extraction'
              );
              const llmMeta = parseMetadataResponse(llmResponse);
              console.log('LLM-extracted metadata:', llmMeta);

              // Merge LLM results (prefer LLM for each field if available)
              if (llmMeta.title) pdfMeta.title = llmMeta.title;
              if (llmMeta.firstAuthor) pdfMeta.firstAuthor = llmMeta.firstAuthor;
              if (llmMeta.year) pdfMeta.year = llmMeta.year;
              if (llmMeta.journal) pdfMeta.journal = llmMeta.journal;

              // Try LLM-extracted identifiers first
              if (llmMeta.doi && !adsData) {
                console.log(`Trying LLM-extracted DOI: ${llmMeta.doi}`);
                adsData = await adsApi.getByDOI(token, llmMeta.doi);
                if (adsData) {
                  database.updatePaper(paperId, { doi: llmMeta.doi });
                }
              }
              if (llmMeta.arxiv_id && !adsData) {
                console.log(`Trying LLM-extracted arXiv: ${llmMeta.arxiv_id}`);
                adsData = await adsApi.getByArxiv(token, llmMeta.arxiv_id);
                if (adsData) {
                  database.updatePaper(paperId, { arxiv_id: llmMeta.arxiv_id });
                }
              }
            } catch (llmError) {
              console.error('LLM metadata extraction failed:', llmError.message);
            }
          }

          // Use smart multi-strategy search
          if (!adsData && (pdfMeta.title || pdfMeta.firstAuthor)) {
            console.log('Using smart search with extracted metadata...');
            try {
              adsData = await adsApi.smartSearch(token, {
                title: pdfMeta.title,
                firstAuthor: pdfMeta.firstAuthor,
                year: pdfMeta.year,
                journal: pdfMeta.journal
              });
            } catch (searchError) {
              console.error('Smart search failed:', searchError.message);
            }
          }
        }
      }
    }

    if (!adsData) {
      return { success: false, reason: 'Not found in ADS' };
    }

    const metadata = adsApi.adsToPaper(adsData);
    let bibtexStr = null;
    try {
      bibtexStr = await adsApi.exportBibtex(token, adsData.bibcode);
    } catch (e) {
      console.error('Failed to get BibTeX:', e.message);
    }

    // Update paper in database
    database.updatePaper(paperId, {
      ...metadata,
      bibtex: bibtexStr
    });

    return { success: true, metadata };
  } catch (error) {
    console.error('ADS fetch error:', error.message);
    return { success: false, reason: error.message };
  }
}

let mainWindow;
let dbInitialized = false;

/**
 * Initialize library systems after database is ready
 * @param {string} libraryPath - Path to the library folder
 */
async function initializeLibrarySystems(libraryPath) {
  try {
    // Initialize Paper Files system
    initializePaperFilesSystem(libraryPath);
  } catch (error) {
    console.error('[Library] Initialization failed:', error);
  }
}

// Update window title with library name (macOS)
function updateWindowTitle(libraryName) {
  if (mainWindow && process.platform === 'darwin') {
    const title = libraryName ? `${libraryName} — ADS Reader` : 'ADS Reader';
    mainWindow.setTitle(title);
  }
}

function createWindow() {
  const { width, height } = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'ADS Reader',
    show: false
  });

  mainWindow.loadFile('src/renderer/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('resize', () => {
    const bounds = mainWindow.getBounds();
    store.set('windowBounds', { width: bounds.width, height: bounds.height });
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Toggle DevTools with Cmd+Option+I (macOS) or Ctrl+Shift+I (other)
  const { globalShortcut } = require('electron');

  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Check for Cmd+Option+I (macOS) or Ctrl+Shift+I (Windows/Linux)
    const isMac = process.platform === 'darwin';
    const toggleDevTools = (isMac && input.meta && input.alt && input.key === 'i') ||
                           (!isMac && input.control && input.shift && input.key === 'I') ||
                           input.key === 'F12';

    if (toggleDevTools && input.type === 'keyDown') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });
}

// Create library directory structure
function createLibraryStructure(libraryPath) {
  const dirs = ['papers', 'text'];

  for (const dir of dirs) {
    const dirPath = path.join(libraryPath, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  const dbPath = path.join(libraryPath, 'library.sqlite');
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, '');
  }

  const bibPath = path.join(libraryPath, 'master.bib');
  if (!fs.existsSync(bibPath)) {
    fs.writeFileSync(bibPath, '% ADS Reader Master BibTeX File\n% Auto-generated\n\n');
  }

  return true;
}

// Create a minimal database interface for importing into a new library
// This wraps a raw sql.js database with the methods needed by exportService.importLibrary
function createTempDatabaseInterface(db, libraryPath) {
  let lastPaperId = 0;
  let lastCollectionId = 0;
  let lastAnnotationId = 0;

  const saveDb = () => {}; // No-op, we save at the end

  return {
    getAllPapers() {
      const result = db.exec('SELECT * FROM papers');
      if (result.length === 0) return [];
      return result[0].values.map(row => {
        const obj = {};
        result[0].columns.forEach((col, i) => obj[col] = row[i]);
        return obj;
      });
    },

    deletePaper(id) {
      db.run('DELETE FROM papers WHERE id = ?', [id]);
    },

    getCollections() {
      const result = db.exec('SELECT * FROM collections');
      if (result.length === 0) return [];
      return result[0].values.map(row => {
        const obj = {};
        result[0].columns.forEach((col, i) => obj[col] = row[i]);
        return obj;
      });
    },

    deleteCollection(id) {
      db.run('DELETE FROM collections WHERE id = ?', [id]);
      db.run('DELETE FROM paper_collections WHERE collection_id = ?', [id]);
    },

    getPaperByBibcode(bibcode) {
      const result = db.exec('SELECT * FROM papers WHERE bibcode = ?', [bibcode]);
      if (result.length === 0 || result[0].values.length === 0) return null;
      const obj = {};
      result[0].columns.forEach((col, i) => obj[col] = result[0].values[0][i]);
      return obj;
    },

    addPaper(paper) {
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        INSERT INTO papers (bibcode, doi, arxiv_id, title, authors, year, journal, abstract, keywords,
          pdf_path, pdf_source, bibtex, read_status, rating, added_date, modified_date, citation_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run([
        paper.bibcode || null, paper.doi || null, paper.arxiv_id || null,
        paper.title || '', JSON.stringify(paper.authors || []), paper.year || null,
        paper.journal || null, paper.abstract || null, JSON.stringify(paper.keywords || []),
        paper.pdf_path || null, paper.pdf_source || null, paper.bibtex || null,
        paper.read_status || 'unread', paper.rating || 0,
        paper.added_date || now, paper.modified_date || now, paper.citation_count || 0
      ]);
      stmt.free();
      lastPaperId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      return lastPaperId;
    },

    updatePaper(id, data) {
      const fields = [];
      const values = [];
      for (const [key, val] of Object.entries(data)) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
      if (fields.length > 0) {
        values.push(id);
        db.run(`UPDATE papers SET ${fields.join(', ')} WHERE id = ?`, values);
      }
    },

    createCollection(name, parentId, isSmart, query) {
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        INSERT INTO collections (name, parent_id, is_smart, query, created_date)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run([name, parentId || null, isSmart ? 1 : 0, query || null, now]);
      stmt.free();
      lastCollectionId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      return lastCollectionId;
    },

    addPaperToCollection(paperId, collectionId) {
      try {
        db.run('INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)',
          [paperId, collectionId]);
      } catch (e) { /* Ignore duplicates */ }
    },

    createAnnotation(paperId, annotation) {
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        INSERT INTO annotations (paper_id, page_number, selection_text, selection_rects, note_content, color, pdf_source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run([
        paperId,
        annotation.page_number,
        annotation.selection_text || null,
        typeof annotation.selection_rects === 'string' ? annotation.selection_rects : JSON.stringify(annotation.selection_rects || []),
        annotation.note_content || null,
        annotation.color || '#ffeb3b',
        annotation.pdf_source || null,
        annotation.created_at || now,
        annotation.updated_at || now
      ]);
      stmt.free();
      lastAnnotationId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      return lastAnnotationId;
    },

    setPageRotations(paperId, rotations, pdfSource = null) {
      // Clear existing rotations for this paper/source
      const sourceCondition = pdfSource ? 'AND pdf_source = ?' : 'AND (pdf_source IS NULL OR pdf_source = ?)';
      const deleteParams = pdfSource ? [paperId, pdfSource] : [paperId, ''];
      db.run(`DELETE FROM pdf_page_rotations WHERE paper_id = ? ${sourceCondition}`, deleteParams);

      // Insert new rotations
      for (const [pageNum, rotation] of Object.entries(rotations)) {
        if (rotation !== 0) {
          db.run(
            `INSERT INTO pdf_page_rotations (paper_id, pdf_source, page_number, rotation) VALUES (?, ?, ?, ?)`,
            [paperId, pdfSource || '', parseInt(pageNum), rotation]
          );
        }
      }
    },

    saveDatabase() {
      // No-op - caller handles saving
    }
  };
}

// ===== Library Management IPC Handlers =====

ipcMain.handle('get-library-path', async () => {
  // First try the stored library path
  let libraryPath = store.get('libraryPath');

  // If no path but we have a current library ID, find the library and get its path
  if (!libraryPath) {
    const currentId = store.get('currentLibraryId');
    if (currentId) {
      const allLibraries = await getAllLibraries();
      const currentLib = allLibraries.find(l => l.id === currentId);
      if (currentLib && currentLib.exists) {
        libraryPath = currentLib.fullPath;
        // Update the store so it's consistent
        store.set('libraryPath', libraryPath);
      }
    }
  }

  return libraryPath;
});

ipcMain.handle('get-pdf-zoom', () => store.get('pdfZoom'));
ipcMain.handle('set-pdf-zoom', (event, zoom) => {
  store.set('pdfZoom', zoom);
  return true;
});

// App info (get-app-version already defined elsewhere)
ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  name: app.getName(),
  isPackaged: app.isPackaged
}));

// Sort preferences persistence
ipcMain.handle('get-sort-preferences', () => {
  return {
    field: store.get('sortField') || 'added',
    order: store.get('sortOrder') || 'desc'
  };
});
ipcMain.handle('set-sort-preferences', (event, field, order) => {
  store.set('sortField', field);
  store.set('sortOrder', order);
  return true;
});

// Focus mode split position persistence
ipcMain.handle('get-focus-split-position', () => {
  return store.get('focusSplitPosition') || 50;
});
ipcMain.handle('set-focus-split-position', (event, position) => {
  store.set('focusSplitPosition', position);
  return true;
});

ipcMain.handle('get-last-selected-paper', () => store.get('lastSelectedPaperId'));
ipcMain.handle('set-last-selected-paper', (event, paperId) => {
  store.set('lastSelectedPaperId', paperId);
  return true;
});

// PDF page positions persistence
ipcMain.handle('get-pdf-positions', () => store.get('pdfPagePositions') || {});
ipcMain.handle('set-pdf-position', (event, paperId, position) => {
  const positions = store.get('pdfPagePositions') || {};
  positions[paperId] = position;
  store.set('pdfPagePositions', positions);
  return true;
});

// Last viewed PDF source persistence (per paper)
ipcMain.handle('get-last-pdf-sources', () => store.get('lastPdfSources') || {});
ipcMain.handle('set-last-pdf-source', (event, paperId, sourceType) => {
  const sources = store.get('lastPdfSources') || {};
  sources[paperId] = sourceType;
  store.set('lastPdfSources', sources);
  return true;
});

ipcMain.handle('select-library-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Library Folder',
    message: 'Choose a folder for your paper library (ideally in iCloud Drive)',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Select Library Folder'
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const selectedPath = result.filePaths[0];

  try {
    createLibraryStructure(selectedPath);
    store.set('libraryPath', selectedPath);
    await database.initDatabase(selectedPath);
    dbInitialized = true;
    await initializeLibrarySystems(selectedPath);
    return selectedPath;
  } catch (error) {
    console.error('Failed to create library:', error);
    return null;
  }
});

ipcMain.handle('check-cloud-status', (event, folderPath) => {
  if (!folderPath) return { isCloud: false, provider: null };

  const lowerPath = folderPath.toLowerCase();

  if (lowerPath.includes('mobile documents') || lowerPath.includes('icloud')) {
    return { isCloud: true, provider: 'iCloud' };
  }
  if (lowerPath.includes('google drive') || lowerPath.includes('googledrive')) {
    return { isCloud: true, provider: 'Google Drive' };
  }
  if (lowerPath.includes('dropbox')) {
    return { isCloud: true, provider: 'Dropbox' };
  }
  if (lowerPath.includes('onedrive')) {
    return { isCloud: true, provider: 'OneDrive' };
  }

  return { isCloud: false, provider: null };
});

// ═══════════════════════════════════════════════════════════════════════════
// iCLOUD LIBRARY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

ipcMain.handle('get-icloud-container-path', () => {
  return getICloudContainerPath();
});

ipcMain.handle('is-icloud-available', () => {
  return isICloudAvailable();
});

// Helper function to count papers in a library folder (from database)
async function countPapersInLibrary(libraryPath) {
  try {
    // Use the database module if this is the current library
    const currentPath = store.get('libraryPath');
    if (database && libraryPath === currentPath) {
      const stats = database.getStats();
      return stats.total || 0;
    }

    // For other libraries, open their database and count
    const dbFile = path.join(libraryPath, 'library.sqlite');
    if (!fs.existsSync(dbFile)) return 0;

    const fileBuffer = fs.readFileSync(dbFile);
    if (fileBuffer.length < 100) return 0;

    const SQL = await ensureSqlJs();
    const tempDb = new SQL.Database(fileBuffer);

    try {
      const result = tempDb.exec('SELECT COUNT(*) FROM papers');
      const count = result[0]?.values[0][0] || 0;
      return count;
    } finally {
      tempDb.close();
    }
  } catch (e) {
    console.error('Error counting papers in library:', libraryPath, e.message);
    return 0;
  }
}

// Helper function to get all libraries (used internally and via IPC)
async function getAllLibraries() {
  const libraries = [];

  // Get iCloud libraries (check both real iCloud and fallback path)
  const pathsToCheck = [];

  if (isICloudAvailable()) {
    pathsToCheck.push(getICloudContainerPath());
  }

  // Also check fallback path
  const fallbackPath = getICloudFallbackPath();
  if (fs.existsSync(fallbackPath)) {
    pathsToCheck.push(fallbackPath);
  }

  for (const basePath of pathsToCheck) {
    const librariesJsonPath = path.join(basePath, 'libraries.json');

    try {
      if (fs.existsSync(librariesJsonPath)) {
        const data = JSON.parse(fs.readFileSync(librariesJsonPath, 'utf8'));
        for (const lib of data.libraries || []) {
          const libPath = path.join(basePath, lib.path);
          const exists = fs.existsSync(libPath);
          const paperCount = exists ? await countPapersInLibrary(libPath) : 0;
          // Avoid duplicates
          if (!libraries.find(l => l.id === lib.id)) {
            libraries.push({
              ...lib,
              fullPath: libPath,
              location: 'icloud',
              exists,
              paperCount
            });
          }
        }
      }
    } catch (e) {
      console.error('Failed to read libraries from:', basePath, e);
    }
  }

  // Get local libraries from preferences
  const localLibraries = store.get('localLibraries') || [];
  for (const lib of localLibraries) {
    const exists = fs.existsSync(lib.path);
    const paperCount = exists ? await countPapersInLibrary(lib.path) : 0;
    libraries.push({
      ...lib,
      fullPath: lib.path,
      location: 'local',
      exists,
      paperCount
    });
  }

  return libraries;
}

ipcMain.handle('get-all-libraries', async () => {
  return getAllLibraries();
});

ipcMain.handle('set-window-title', (event, libraryName) => {
  updateWindowTitle(libraryName);
});

ipcMain.handle('create-library', async (event, { name, location }) => {
  console.log('[create-library] Called with:', { name, location });
  try {
    const id = require('crypto').randomUUID();
    const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Library';
    let libraryPath;

    console.log('[create-library] Safe name:', safeName);

    if (location === 'icloud') {
      console.log('[create-library] Checking iCloud availability...');
      if (!isICloudAvailable()) {
        console.log('[create-library] iCloud NOT available');
        return { success: false, error: 'iCloud is not available. Make sure you are signed into iCloud.' };
      }
      console.log('[create-library] iCloud is available');

      // Check if we can actually write to iCloud (requires code signing)
      let iCloudPath;
      if (canWriteToICloud()) {
        console.log('[create-library] Can write to iCloud container');
        iCloudPath = getICloudContainerPath();
      } else {
        console.log('[create-library] Cannot write to iCloud, using fallback path');
        iCloudPath = getICloudFallbackPath();
        // Ensure fallback directory exists
        if (!fs.existsSync(iCloudPath)) {
          fs.mkdirSync(iCloudPath, { recursive: true });
        }
        sendConsoleLog('Note: Using local cloud folder (app not code-signed for iCloud)', 'warn');
      }
      libraryPath = path.join(iCloudPath, safeName);

      // Ensure unique name
      let counter = 1;
      while (fs.existsSync(libraryPath)) {
        libraryPath = path.join(iCloudPath, `${safeName} ${counter}`);
        counter++;
      }

      // Create library folder structure
      createLibraryStructure(libraryPath);

      // Update libraries.json
      const librariesJsonPath = path.join(iCloudPath, 'libraries.json');
      let data = { version: 1, libraries: [] };

      if (fs.existsSync(librariesJsonPath)) {
        try {
          data = JSON.parse(fs.readFileSync(librariesJsonPath, 'utf8'));
        } catch (e) { /* Use default */ }
      }

      data.libraries.push({
        id,
        name: safeName,
        path: path.basename(libraryPath),
        createdAt: new Date().toISOString(),
        createdOn: 'macOS'
      });

      fs.writeFileSync(librariesJsonPath, JSON.stringify(data, null, 2));

    } else {
      // Local library - let user choose folder
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Folder for New Library',
        properties: ['openDirectory', 'createDirectory']
      });

      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: 'No folder selected' };
      }

      libraryPath = result.filePaths[0];

      // Create library structure
      createLibraryStructure(libraryPath);

      // Add to local libraries
      const localLibraries = store.get('localLibraries') || [];
      localLibraries.push({
        id,
        name: safeName,
        path: libraryPath,
        createdAt: new Date().toISOString()
      });
      store.set('localLibraries', localLibraries);
    }

    console.log('[create-library] Success! id:', id, 'path:', libraryPath);
    return { success: true, id, path: libraryPath };
  } catch (error) {
    console.error('[create-library] Failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('switch-library', async (event, libraryId) => {
  try {
    // Find library by ID
    const allLibraries = await getAllLibraries();
    const library = allLibraries.find(l => l.id === libraryId);

    if (!library) {
      return { success: false, error: 'Library not found' };
    }

    if (!library.exists) {
      return { success: false, error: 'Library folder does not exist' };
    }

    // Close current database
    database.closeDatabase();
    dbInitialized = false;

    // Initialize new database
    await database.initDatabase(library.fullPath);
    dbInitialized = true;
    await initializeLibrarySystems(library.fullPath);

    // Update current library path in preferences
    store.set('libraryPath', library.fullPath);
    store.set('currentLibraryId', libraryId);

    // Update window title with library name
    updateWindowTitle(library.name);

    return { success: true, path: library.fullPath };
  } catch (error) {
    console.error('Failed to switch library:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-current-library-id', () => {
  return store.get('currentLibraryId') || null;
});

ipcMain.handle('delete-library', async (event, { libraryId, deleteFiles }) => {
  try {
    const allLibraries = await getAllLibraries();
    const library = allLibraries.find(l => l.id === libraryId);

    if (!library) {
      return { success: false, error: 'Library not found' };
    }

    // Check if deleting the current library
    const currentId = store.get('currentLibraryId');
    const isDeletingActive = currentId === libraryId;

    // If deleting active library, close the database first
    if (isDeletingActive) {
      try {
        database.closeDatabase();
        dbInitialized = false;
        fileManager = null;
        downloadQueue = null;
      } catch (e) {
        console.error('Error closing database:', e);
      }
    }

    // Delete files if requested
    if (deleteFiles && library.exists && library.fullPath) {
      try {
        fs.rmSync(library.fullPath, { recursive: true, force: true });
        sendConsoleLog(`Deleted library folder: ${library.fullPath}`, 'info');
      } catch (e) {
        console.error('Failed to delete library folder:', e);
        sendConsoleLog(`Warning: Could not delete folder: ${e.message}`, 'warn');
      }
    }

    // Remove from appropriate list
    if (library.location === 'icloud') {
      // Update libraries.json - check both iCloud path and fallback path
      const pathsToCheck = [
        path.join(getICloudContainerPath(), 'libraries.json'),
        path.join(getICloudFallbackPath(), 'libraries.json')
      ];

      for (const librariesJsonPath of pathsToCheck) {
        if (fs.existsSync(librariesJsonPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(librariesJsonPath, 'utf8'));
            const originalCount = (data.libraries || []).length;
            data.libraries = (data.libraries || []).filter(l => l.id !== libraryId);
            if (data.libraries.length !== originalCount) {
              fs.writeFileSync(librariesJsonPath, JSON.stringify(data, null, 2));
              sendConsoleLog(`Removed library from ${librariesJsonPath}`, 'info');
            }
          } catch (e) {
            console.error('Failed to update libraries.json:', e);
          }
        }
      }
    } else {
      // Remove from local libraries in preferences
      const localLibraries = store.get('localLibraries') || [];
      store.set('localLibraries', localLibraries.filter(l => l.id !== libraryId));
    }

    // If we deleted the active library, clear the current library settings
    if (isDeletingActive) {
      store.delete('currentLibraryId');
      store.delete('libraryPath');
    }

    sendConsoleLog(`Library "${library.name}" deleted`, 'success');
    return { success: true, wasActive: isDeletingActive };
  } catch (error) {
    console.error('Failed to delete library:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Get detailed file information for a library
 * Returns list of files and total size for deletion confirmation
 */
ipcMain.handle('get-library-file-info', async (event, libraryId) => {
  try {
    const allLibraries = await getAllLibraries();
    const library = allLibraries.find(l => l.id === libraryId);

    if (!library || !library.exists || !library.fullPath) {
      return { files: [], totalSize: 0, error: 'Library not found or path unavailable' };
    }

    const files = [];
    let totalSize = 0;

    function walkDir(dir, prefix = '') {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            walkDir(fullPath, relativePath);
          } else {
            try {
              const stats = fs.statSync(fullPath);
              files.push({
                path: relativePath,
                size: stats.size
              });
              totalSize += stats.size;
            } catch (e) {
              // Skip files we can't stat
            }
          }
        }
      } catch (e) {
        // Skip directories we can't read
      }
    }

    walkDir(library.fullPath);

    return {
      files,
      totalSize,
      libraryPath: library.fullPath
    };
  } catch (error) {
    console.error('Failed to get library file info:', error);
    return { files: [], totalSize: 0, error: error.message };
  }
});

// ===== Library Migration IPC Handlers =====

/**
 * Check if migration is needed for existing users
 * Returns info about existing library that isn't registered
 */
ipcMain.handle('check-migration-needed', async () => {
  const existingPath = store.get('libraryPath');
  const currentLibraryId = store.get('currentLibraryId');
  const migrationDone = store.get('migrationCompleted');

  // If migration already done or no existing path, no migration needed
  if (migrationDone || !existingPath || !fs.existsSync(existingPath)) {
    return { needed: false };
  }

  // If we already have a current library ID, the library is registered
  if (currentLibraryId) {
    return { needed: false };
  }

  // Check if this path is already in iCloud
  const iCloudPath = getICloudContainerPath();
  const isInICloud = existingPath.startsWith(iCloudPath);

  // Check if iCloud is available
  const iCloudAvailable = isICloudAvailable();

  // Get library name from path
  const libraryName = path.basename(existingPath);

  // Count papers in existing library
  let paperCount = 0;
  try {
    await database.initDatabase(existingPath);
    dbInitialized = true;
    await initializeLibrarySystems(existingPath);
    const stats = database.getStats();
    paperCount = stats.total;
  } catch (e) {
    console.error('Failed to count papers:', e);
  }

  return {
    needed: true,
    existingPath,
    libraryName,
    paperCount,
    isInICloud,
    iCloudAvailable
  };
});

/**
 * Migrate existing library to iCloud
 * Moves the library folder to iCloud container and registers it
 */
ipcMain.handle('migrate-library-to-icloud', async (event, { libraryPath }) => {
  try {
    if (!isICloudAvailable()) {
      return {
        success: false,
        error: 'iCloud container not found. Please run the iOS app first to initialize iCloud sync, or create an iCloud library from the library picker.'
      };
    }

    if (!ensureICloudContainer()) {
      return {
        success: false,
        error: 'Cannot write to iCloud container. Please check iCloud Drive is enabled and try again.'
      };
    }

    const iCloudPath = getICloudContainerPath();
    const libraryName = path.basename(libraryPath);

    // Determine target path (ensure unique name)
    let targetPath = path.join(iCloudPath, libraryName);
    let counter = 1;
    while (fs.existsSync(targetPath) && targetPath !== libraryPath) {
      targetPath = path.join(iCloudPath, `${libraryName} ${counter}`);
      counter++;
    }

    // Close database before moving
    database.closeDatabase();
    dbInitialized = false;

    // Move or copy the library folder
    if (libraryPath !== targetPath) {
      // Copy recursively then delete original (safer than move across volumes)
      copyFolderSync(libraryPath, targetPath);
      fs.rmSync(libraryPath, { recursive: true, force: true });
    }

    // Generate library ID
    const id = require('crypto').randomUUID();

    // Update libraries.json
    const librariesJsonPath = path.join(iCloudPath, 'libraries.json');
    let data = { version: 1, libraries: [] };

    if (fs.existsSync(librariesJsonPath)) {
      try {
        data = JSON.parse(fs.readFileSync(librariesJsonPath, 'utf8'));
      } catch (e) { /* Use default */ }
    }

    data.libraries.push({
      id,
      name: libraryName,
      path: path.basename(targetPath),
      createdAt: new Date().toISOString(),
      createdOn: 'macOS',
      migratedFrom: 'local'
    });

    fs.writeFileSync(librariesJsonPath, JSON.stringify(data, null, 2));

    // Update preferences
    store.set('libraryPath', targetPath);
    store.set('currentLibraryId', id);
    store.set('migrationCompleted', true);

    // Reinitialize database at new location
    await database.initDatabase(targetPath);
    dbInitialized = true;
    await initializeLibrarySystems(targetPath);

    sendConsoleLog(`Library migrated to iCloud: ${targetPath}`, 'success');

    return { success: true, path: targetPath, id };
  } catch (error) {
    console.error('Failed to migrate library to iCloud:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Register existing library as local (desktop-only)
 * Adds to localLibraries without moving
 */
ipcMain.handle('register-library-local', async (event, { libraryPath }) => {
  try {
    const id = require('crypto').randomUUID();
    const libraryName = path.basename(libraryPath);

    // Add to local libraries
    const localLibraries = store.get('localLibraries') || [];
    localLibraries.push({
      id,
      name: libraryName,
      path: libraryPath,
      createdAt: new Date().toISOString(),
      createdOn: 'macOS'
    });
    store.set('localLibraries', localLibraries);

    // Update preferences
    store.set('currentLibraryId', id);
    store.set('libraryPath', libraryPath);
    store.set('migrationCompleted', true);

    sendConsoleLog(`Library registered as local: ${libraryPath}`, 'success');

    return { success: true, path: libraryPath, id };
  } catch (error) {
    console.error('Failed to register local library:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Helper: Copy folder recursively (for cross-volume migration)
 */
function copyFolderSync(source, target) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  const items = fs.readdirSync(source);
  for (const item of items) {
    const srcPath = path.join(source, item);
    const tgtPath = path.join(target, item);
    const stat = fs.statSync(srcPath);

    if (stat.isDirectory()) {
      copyFolderSync(srcPath, tgtPath);
    } else {
      fs.copyFileSync(srcPath, tgtPath);
    }
  }
}

// ===== Conflict Detection IPC Handlers =====

/**
 * Check for iCloud sync conflicts in a library folder
 * iCloud creates files like "library 2.sqlite" or "library (conflicted copy).sqlite"
 */
ipcMain.handle('check-library-conflicts', async (event, libraryPath) => {
  if (!libraryPath || !fs.existsSync(libraryPath)) {
    return { hasConflicts: false, conflicts: [] };
  }

  try {
    const files = fs.readdirSync(libraryPath);
    const conflicts = [];

    // Patterns for conflict files (macOS iCloud)
    // - "library 2.sqlite" (numeric suffix)
    // - "library-2.sqlite" (dash + number)
    // - "library (conflicted copy from MacBook).sqlite"
    const conflictPatterns = [
      /library[\s-]\d+\.sqlite$/i,
      /library\s*\(.*conflict.*\)\.sqlite$/i,
      /library\.sqlite\s+\d+$/i
    ];

    for (const file of files) {
      for (const pattern of conflictPatterns) {
        if (pattern.test(file)) {
          const filePath = path.join(libraryPath, file);
          const stat = fs.statSync(filePath);
          conflicts.push({
            filename: file,
            path: filePath,
            modified: stat.mtime,
            size: stat.size
          });
          break;
        }
      }
    }

    return {
      hasConflicts: conflicts.length > 0,
      conflicts,
      mainDatabase: path.join(libraryPath, 'library.sqlite'),
      mainExists: fs.existsSync(path.join(libraryPath, 'library.sqlite'))
    };
  } catch (error) {
    console.error('Error checking for conflicts:', error);
    return { hasConflicts: false, conflicts: [], error: error.message };
  }
});

/**
 * Resolve a conflict by choosing which version to keep
 * @param action - 'keep-current' | 'keep-conflict' | 'backup-both'
 */
ipcMain.handle('resolve-library-conflict', async (event, { libraryPath, conflictPath, action }) => {
  try {
    const mainDbPath = path.join(libraryPath, 'library.sqlite');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (action === 'keep-current') {
      // Just delete the conflict file
      fs.unlinkSync(conflictPath);
      sendConsoleLog('Conflict resolved: kept current version', 'success');
    } else if (action === 'keep-conflict') {
      // Backup current, replace with conflict
      const backupPath = path.join(libraryPath, `library-backup-${timestamp}.sqlite`);
      if (fs.existsSync(mainDbPath)) {
        fs.renameSync(mainDbPath, backupPath);
      }
      fs.renameSync(conflictPath, mainDbPath);
      sendConsoleLog('Conflict resolved: using other device version', 'success');
    } else if (action === 'backup-both') {
      // Backup both, keep main as is
      const conflictBackup = path.join(libraryPath, `library-conflict-${timestamp}.sqlite`);
      const mainBackup = path.join(libraryPath, `library-current-${timestamp}.sqlite`);

      // Copy main to backup
      if (fs.existsSync(mainDbPath)) {
        fs.copyFileSync(mainDbPath, mainBackup);
      }

      // Move conflict to backup
      fs.renameSync(conflictPath, conflictBackup);
      sendConsoleLog('Both versions backed up. Using current version.', 'success');
    }

    // Reload database
    database.closeDatabase();
    dbInitialized = false;
    await database.initDatabase(libraryPath);
    dbInitialized = true;
    await initializeLibrarySystems(libraryPath);

    return { success: true };
  } catch (error) {
    console.error('Failed to resolve conflict:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-library-info', async (event, libraryPath) => {
  if (!libraryPath || !fs.existsSync(libraryPath)) return null;

  // Initialize database if not already done
  if (!dbInitialized) {
    try {
      await database.initDatabase(libraryPath);
      dbInitialized = true;
      await initializeLibrarySystems(libraryPath);
    } catch (error) {
      console.error('Failed to init database:', error);
    }
  }

  const stats = dbInitialized ? database.getStats() : { total: 0, unread: 0, reading: 0, read: 0 };

  return {
    path: libraryPath,
    paperCount: stats.total,
    unreadCount: stats.unread,
    readingCount: stats.reading,
    readCount: stats.read,
    hasDatabase: fs.existsSync(path.join(libraryPath, 'library.sqlite')),
    hasBibFile: fs.existsSync(path.join(libraryPath, 'master.bib'))
  };
});

// ===== Paper Management IPC Handlers =====

ipcMain.handle('import-pdfs', async () => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library selected' };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import PDFs',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });

  if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };

  const importResults = [];

  for (const filePath of result.filePaths) {
    try {
      const importResult = await pdfImport.importPDF(filePath, libraryPath);

      // Fetch ADS metadata BEFORE adding paper to database
      // This ensures BibTeX and all metadata is available immediately
      let adsMetadata = null;

      // Read text content for fallback extraction if no direct identifiers
      let textContent = null;
      if (importResult.text_path) {
        const textFile = path.join(libraryPath, importResult.text_path);
        if (fs.existsSync(textFile)) {
          textContent = fs.readFileSync(textFile, 'utf-8');
        }
      }

      console.log(`[import-pdfs] Fetching ADS metadata before adding paper...`);
      adsMetadata = await fetchAdsMetadataBeforeAdd({
        bibcode: importResult.bibcode,
        doi: importResult.doi,
        arxiv_id: importResult.arxiv_id,
        textContent: textContent,
        extractedMetadata: importResult.extractedMetadata
      });

      if (adsMetadata) {
        console.log(`[import-pdfs] Found ADS metadata: ${adsMetadata.title}`);
      } else {
        console.log(`[import-pdfs] No ADS match found, using PDF metadata only`);
      }

      // Add to database with ALL metadata (ADS data merged with PDF extraction)
      const paperId = database.addPaper({
        title: adsMetadata?.title || importResult.title,
        authors: adsMetadata?.authors,
        year: adsMetadata?.year,
        journal: adsMetadata?.journal,
        abstract: adsMetadata?.abstract,
        bibtex: adsMetadata?.bibtex,
        bibcode: adsMetadata?.bibcode || importResult.bibcode,
        doi: adsMetadata?.doi || importResult.doi,
        arxiv_id: adsMetadata?.arxiv_id || importResult.arxiv_id,
        citation_count: adsMetadata?.citation_count,
        available_sources: adsMetadata?.available_sources,
        text_path: importResult.text_path
      });

      // Register PDF in paper_files table
      if (importResult.pdf_path) {
        const filename = path.basename(importResult.pdf_path);
        const fullPath = path.join(libraryPath, importResult.pdf_path);
        database.addPaperFile(paperId, {
          filename: filename,
          original_name: path.basename(filePath),
          mime_type: 'application/pdf',
          file_size: fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0,
          file_role: 'pdf',
          source_type: 'IMPORTED',
          status: 'ready'
        });
      }

      importResults.push({ success: true, id: paperId, ...importResult });
    } catch (error) {
      importResults.push({ success: false, path: filePath, error: error.message });
    }
  }

  // Update master.bib
  const allPapers = database.getAllPapers();
  bibtex.updateMasterBib(libraryPath, allPapers);

  return { success: true, results: importResults };
});

// Unified import handler - accepts both PDFs and BibTeX files
ipcMain.handle('import-files', async () => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library selected' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported Files', extensions: ['pdf', 'bib'] },
      { name: 'PDF Files', extensions: ['pdf'] },
      { name: 'BibTeX Files', extensions: ['bib'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };

  // Separate files by type
  const pdfFiles = result.filePaths.filter(f => f.toLowerCase().endsWith('.pdf'));
  const bibFiles = result.filePaths.filter(f => f.toLowerCase().endsWith('.bib'));

  const results = { pdfs: [], bibtex: { imported: 0, skipped: 0 } };

  // Import PDFs
  for (const filePath of pdfFiles) {
    try {
      const importResult = await pdfImport.importPDF(filePath, libraryPath);

      // Fetch ADS metadata BEFORE adding paper to database
      // This ensures BibTeX and all metadata is available immediately
      let adsMetadata = null;

      // Read text content for fallback extraction if no direct identifiers
      let textContent = null;
      if (importResult.text_path) {
        const textFile = path.join(libraryPath, importResult.text_path);
        if (fs.existsSync(textFile)) {
          textContent = fs.readFileSync(textFile, 'utf-8');
        }
      }

      console.log(`[import-files] Fetching ADS metadata before adding paper...`);
      adsMetadata = await fetchAdsMetadataBeforeAdd({
        bibcode: importResult.bibcode,
        doi: importResult.doi,
        arxiv_id: importResult.arxiv_id,
        textContent: textContent,
        extractedMetadata: importResult.extractedMetadata
      });

      if (adsMetadata) {
        console.log(`[import-files] Found ADS metadata: ${adsMetadata.title}`);
      } else {
        console.log(`[import-files] No ADS match found, using PDF metadata only`);
      }

      // Add to database with ALL metadata (ADS data merged with PDF extraction)
      const paperId = database.addPaper({
        title: adsMetadata?.title || importResult.title,
        authors: adsMetadata?.authors,
        year: adsMetadata?.year,
        journal: adsMetadata?.journal,
        abstract: adsMetadata?.abstract,
        bibtex: adsMetadata?.bibtex,
        bibcode: adsMetadata?.bibcode || importResult.bibcode,
        doi: adsMetadata?.doi || importResult.doi,
        arxiv_id: adsMetadata?.arxiv_id || importResult.arxiv_id,
        citation_count: adsMetadata?.citation_count,
        available_sources: adsMetadata?.available_sources,
        text_path: importResult.text_path
      });

      // Register PDF in paper_files table
      if (importResult.pdf_path) {
        const filename = path.basename(importResult.pdf_path);
        const fullPath = path.join(libraryPath, importResult.pdf_path);
        database.addPaperFile(paperId, {
          filename: filename,
          original_name: path.basename(filePath),
          mime_type: 'application/pdf',
          file_size: fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0,
          file_role: 'pdf',
          source_type: 'IMPORTED',
          status: 'ready'
        });
      }

      results.pdfs.push({ success: true, id: paperId, ...importResult });
    } catch (error) {
      results.pdfs.push({ success: false, path: filePath, error: error.message });
    }
  }

  // Import BibTeX files
  for (const filePath of bibFiles) {
    try {
      const filename = path.basename(filePath);
      sendConsoleLog(`Importing BibTeX: ${filename}`, 'info');
      const entries = bibtex.importBibtex(filePath);

      if (entries.length > 0) {
        const bulkResult = database.addPapersBulk(entries, (progress) => {
          mainWindow.webContents.send('import-progress', {
            current: progress.current,
            total: progress.total,
            inserted: progress.inserted,
            skipped: progress.skipped,
            paper: entries[progress.current - 1]?.title || 'Processing...'
          });
        });
        results.bibtex.imported += bulkResult.inserted.length;
        results.bibtex.skipped += bulkResult.skipped.length;
        sendConsoleLog(`BibTeX import: ${bulkResult.inserted.length} added, ${bulkResult.skipped.length} skipped`, 'success');
      }
    } catch (error) {
      sendConsoleLog(`BibTeX import error: ${error.message}`, 'error');
    }
  }

  // Update master.bib once at the end
  const allPapers = database.getAllPapers();
  bibtex.updateMasterBib(libraryPath, allPapers);

  return { success: true, results };
});

ipcMain.handle('get-all-papers', (event, options) => {
  if (!dbInitialized) return [];
  const papers = database.getAllPapers(options);
  const libraryPath = store.get('libraryPath');

  // Check for PDFs on disk for papers without pdf_path set
  if (libraryPath) {
    const papersDir = path.join(libraryPath, 'papers');
    const sourceTypes = ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF', 'ATTACHED'];

    for (const paper of papers) {
      // Skip if already has pdf_path
      if (paper.pdf_path) continue;

      // Check if any PDF exists for this paper
      if (paper.bibcode) {
        const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
        for (const sourceType of sourceTypes) {
          const filename = `${baseFilename}_${sourceType}.pdf`;
          const filePath = path.join(papersDir, filename);
          if (fs.existsSync(filePath)) {
            // Found a PDF, set pdf_path for display purposes
            paper.pdf_path = `papers/${filename}`;
            // Also update database so this fix persists
            database.updatePaper(paper.id, { pdf_path: paper.pdf_path });
            break;
          }
        }
      }
    }
  }

  return papers;
});

ipcMain.handle('get-paper', (event, id) => {
  if (!dbInitialized) return null;
  return database.getPaper(id);
});

ipcMain.handle('update-paper', (event, id, updates) => {
  if (!dbInitialized) return false;
  database.updatePaper(id, updates);
  return true;
});

ipcMain.handle('delete-paper', (event, id) => {
  if (!dbInitialized) return false;
  const libraryPath = store.get('libraryPath');
  const paper = database.getPaper(id);

  if (paper) {
    pdfImport.deletePaperFiles(libraryPath, paper.pdf_path, paper.text_path);
    database.deletePaper(id);

    // Update master.bib
    const allPapers = database.getAllPapers();
    bibtex.updateMasterBib(libraryPath, allPapers);
  }
  return true;
});

// Bulk delete papers - much faster for large selections
ipcMain.handle('delete-papers-bulk', (event, ids) => {
  if (!dbInitialized) return { success: false, deleted: 0 };
  const libraryPath = store.get('libraryPath');

  let deleted = 0;
  for (const id of ids) {
    const paper = database.getPaper(id);
    if (paper) {
      // Delete files (non-blocking)
      pdfImport.deletePaperFiles(libraryPath, paper.pdf_path, paper.text_path);
      // Delete from database without saving (save = false)
      database.deletePaper(id, false);
      deleted++;
    }
  }

  // Save database once at the end
  database.saveDatabase();

  // Update master.bib once at the end
  const allPapers = database.getAllPapers();
  bibtex.updateMasterBib(libraryPath, allPapers);

  return { success: true, deleted };
});

ipcMain.handle('get-pdf-path', (event, relativePath) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath || !relativePath) return null;
  const fullPath = path.join(libraryPath, relativePath);
  // Return path only if file exists
  if (fs.existsSync(fullPath)) {
    return fullPath;
  }
  return null;
});

ipcMain.handle('search-papers', (event, query) => {
  console.log('IPC search-papers called with:', query);
  if (!dbInitialized) {
    console.log('Database not initialized');
    return [];
  }
  const libraryPath = store.get('libraryPath');
  console.log('Library path:', libraryPath);
  const results = database.searchPapersFullText(query, libraryPath);
  console.log('Search returned', results.length, 'results');
  return results;
});

// ===== ADS API IPC Handlers =====

ipcMain.handle('get-ads-token', () => store.get('adsToken'));

ipcMain.handle('set-ads-token', async (event, token) => {
  const validation = await adsApi.validateToken(token);
  if (validation.valid) {
    store.set('adsToken', token);
    return { success: true };
  }
  return { success: false, error: validation.error };
});

// Library proxy URL for accessing publisher PDFs through institutional access
const DEFAULT_LIBRARY_PROXY = 'https://stanford.idm.oclc.org/login?url=';
ipcMain.handle('get-library-proxy', () => store.get('libraryProxyUrl') || DEFAULT_LIBRARY_PROXY);

ipcMain.handle('set-library-proxy', (event, proxyUrl) => {
  // Validate and normalize the proxy URL for EZProxy format
  if (proxyUrl) {
    proxyUrl = proxyUrl.trim();
    // Common EZProxy format: https://proxy.example.edu/login?url=
    // Ensure it ends with ?url= or similar for proper URL appending
    if (proxyUrl && !proxyUrl.includes('?url=') && !proxyUrl.endsWith('=')) {
      if (proxyUrl.includes('?')) {
        proxyUrl += '&url=';
      } else {
        proxyUrl += '?url=';
      }
    }
    console.log('Saving library proxy URL:', proxyUrl);
  }
  store.set('libraryProxyUrl', proxyUrl || null);
  return { success: true };
});

// Get actual publisher URL from ADS esources (for use with library proxy)
ipcMain.handle('get-publisher-url', async (event, bibcode) => {
  const token = store.get('adsToken');
  if (!token || !bibcode) {
    return { success: false, error: 'No token or bibcode' };
  }

  try {
    const esources = await adsApi.getEsources(token, bibcode);
    if (esources && esources.length > 0) {
      // First try PUB_PDF source (direct publisher PDF)
      const pubPdf = esources.find(s =>
        s.link_type?.includes('PUB_PDF') || s.type?.includes('PUB_PDF')
      );
      if (pubPdf?.url) {
        console.log(`Found PUB_PDF: ${pubPdf.url}`);
        return { success: true, url: pubPdf.url };
      }

      // Fall back to PUB_HTML (DOI link) - proxy can handle these
      const pubHtml = esources.find(s =>
        s.link_type?.includes('PUB_HTML') || s.type?.includes('PUB_HTML')
      );
      if (pubHtml?.url) {
        // Decode URL-encoded DOI for cleaner proxy URLs
        const decodedUrl = decodeURIComponent(pubHtml.url);
        console.log(`Using PUB_HTML (DOI): ${decodedUrl}`);
        return { success: true, url: decodedUrl, isDoi: true };
      }
    }
    // No publisher URL available
    // Check if it's an arXiv-only paper
    const hasArxiv = esources && esources.some(s =>
      s.link_type?.includes('EPRINT') || s.type?.includes('EPRINT')
    );
    if (hasArxiv) {
      console.log(`No publisher URL - arXiv preprint only`);
      return { success: false, error: 'No publisher version available (arXiv preprint only)' };
    }
    console.log(`No publisher URL found for ${bibcode}`);
    return { success: false, error: 'No publisher URL available' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// PDF source priority preference
// Default order: Publisher > ADS > arXiv > Author
const defaultPdfPriority = ['PUB_PDF', 'ADS_PDF', 'EPRINT_PDF', 'AUTHOR_PDF'];

ipcMain.handle('get-pdf-priority', () => {
  return store.get('pdfSourcePriority') || defaultPdfPriority;
});

ipcMain.handle('set-pdf-priority', (event, priority) => {
  if (Array.isArray(priority) && priority.length > 0) {
    store.set('pdfSourcePriority', priority);
    console.log('Saved PDF source priority:', priority);
    return { success: true };
  }
  return { success: false, error: 'Invalid priority array' };
});

ipcMain.handle('ads-search', async (event, query, options) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };

  try {
    const result = await adsApi.search(token, query, options);
    // Transform to consistent format with papers array
    const papers = (result.docs || []).map(doc => ({
      ...adsApi.adsToPaper(doc),
      _raw: doc  // Keep raw doc for applying metadata later
    }));
    return {
      success: true,
      data: {
        papers,
        numFound: result.numFound || 0
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ads-lookup', async (event, identifier, type) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };

  try {
    let result;
    switch (type) {
      case 'bibcode':
        result = await adsApi.getByBibcode(token, identifier);
        break;
      case 'doi':
        result = await adsApi.getByDOI(token, identifier);
        break;
      case 'arxiv':
        result = await adsApi.getByArxiv(token, identifier);
        break;
      default:
        return { success: false, error: 'Unknown identifier type' };
    }

    if (result) {
      return { success: true, data: adsApi.adsToPaper(result) };
    }
    return { success: false, error: 'Paper not found' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get available PDF sources for a paper
ipcMain.handle('ads-get-esources', async (event, bibcode) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };

  sendConsoleLog(`Fetching PDF sources for ${bibcode}...`, 'info');

  try {
    const esources = await adsApi.getEsources(token, bibcode);

    // Log raw esources for debugging
    sendConsoleLog(`ADS returned ${esources.length} esource(s)`, 'info');
    for (const source of esources) {
      const linkType = source.link_type || source.type || 'unknown';
      sendConsoleLog(`  - ${linkType}: ${source.url || 'no url'}`, 'info');
    }

    // Categorize sources by type
    const sources = {
      arxiv: null,
      ads: null,
      publisher: null
    };

    let pubHtmlUrl = null;  // Track PUB_HTML as fallback

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
      } else if (linkType.includes('PUB_HTML') && !pubHtmlUrl) {
        pubHtmlUrl = url;
      }
    }

    // If no PUB_PDF but we have PUB_HTML, try to derive PDF URL
    if (!sources.publisher && pubHtmlUrl) {
      sendConsoleLog(`No PUB_PDF found, trying to derive from PUB_HTML: ${pubHtmlUrl}`, 'warn');
      const pdfUrl = convertPublisherHtmlToPdf(pubHtmlUrl);
      if (pdfUrl) {
        sources.publisher = { url: pdfUrl, type: 'PUB_PDF_DERIVED', label: 'Publisher', originalUrl: pubHtmlUrl };
        sendConsoleLog(`Derived publisher PDF URL: ${pdfUrl}`, 'success');
      } else {
        sendConsoleLog(`Could not derive PDF URL from ${pubHtmlUrl}`, 'warn');
      }
    }

    // Log final sources
    const found = Object.entries(sources).filter(([k, v]) => v).map(([k]) => k);
    sendConsoleLog(`Available sources: ${found.length > 0 ? found.join(', ') : 'none'}`, found.length > 0 ? 'success' : 'warn');

    return { success: true, data: sources };
  } catch (error) {
    sendConsoleLog(`Failed to fetch esources: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Convert publisher HTML (abstract) URLs to PDF URLs for known publishers
function convertPublisherHtmlToPdf(htmlUrl) {
  try {
    const url = new URL(htmlUrl);
    const hostname = url.hostname;
    const pathname = url.pathname;

    // APS DOI resolver (link.aps.org): /doi/DOI -> /pdf/DOI
    if (hostname.includes('link.aps.org')) {
      return htmlUrl.replace('/doi/', '/pdf/').replace('http://', 'https://');
    }

    // APS (Physical Review): /prd/abstract/DOI -> /prd/pdf/DOI
    if (hostname.includes('journals.aps.org')) {
      return htmlUrl.replace('/abstract/', '/pdf/');
    }

    // IOP Science: /article/DOI -> /article/DOI/pdf
    if (hostname.includes('iopscience.iop.org')) {
      if (!pathname.endsWith('/pdf')) {
        return htmlUrl + '/pdf';
      }
      return htmlUrl;
    }

    // Oxford Academic (OUP): use pdf-lookup with DOI
    if (hostname.includes('academic.oup.com')) {
      // Extract DOI from URL if present
      const doiMatch = pathname.match(/\/doi\/(10\.[^\/]+\/[^\/]+)/);
      if (doiMatch) {
        return `https://academic.oup.com/mnras/pdf-lookup/doi/${doiMatch[1]}`;
      }
    }

    // Wiley: /doi/abs/DOI or /doi/full/DOI -> /doi/pdfdirect/DOI
    if (hostname.includes('onlinelibrary.wiley.com')) {
      return htmlUrl.replace('/doi/abs/', '/doi/pdfdirect/').replace('/doi/full/', '/doi/pdfdirect/');
    }

    // A&A (aanda.org): /articles/DOI/abs -> /articles/DOI/pdf
    if (hostname.includes('aanda.org')) {
      return htmlUrl.replace('/abs', '/pdf');
    }

    // Springer/Nature: many have /article/DOI -> try adding .pdf or /fulltext.pdf
    if (hostname.includes('nature.com') || hostname.includes('springer.com')) {
      if (!pathname.includes('.pdf')) {
        return htmlUrl + '.pdf';
      }
    }

    // AIP (JASA, JCP, etc.): /doi/DOI -> /doi/pdf/DOI
    if (hostname.includes('pubs.aip.org')) {
      if (!pathname.includes('/pdf/')) {
        return htmlUrl.replace('/doi/', '/doi/pdf/');
      }
    }

    // Annual Reviews: /doi/abs/DOI -> /doi/pdf/DOI
    if (hostname.includes('annualreviews.org')) {
      return htmlUrl.replace('/doi/abs/', '/doi/pdf/');
    }

    // Science (AAAS): similar to above
    if (hostname.includes('science.org')) {
      if (!pathname.includes('/pdf/')) {
        return htmlUrl.replace('/doi/', '/doi/pdf/');
      }
    }

    // No known pattern - return null
    return null;
  } catch (e) {
    console.error('Error converting publisher URL:', e.message);
    return null;
  }
}

// ============ PDF/ATTACHMENT HANDLERS ============

// Download PDF from a specific source
ipcMain.handle('download-pdf-from-source', async (event, paperId, sourceType) => {
  const token = store.get('adsToken');
  const libraryPath = store.get('libraryPath');
  const proxyUrl = store.get('libraryProxyUrl');

  if (!libraryPath) return { success: false, error: 'No library path configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const paper = database.getPaper(paperId);
  if (!paper) return { success: false, error: 'Paper not found' };
  if (!paper.bibcode) return { success: false, error: 'Paper has no bibcode' };

  sendConsoleLog(`Downloading ${sourceType} PDF for ${paper.bibcode}...`, 'info');

  try {
    // Get esources
    const esources = await adsApi.getEsources(token, paper.bibcode);
    if (!esources || esources.length === 0) {
      sendConsoleLog(`No esources available for ${paper.bibcode}`, 'error');
      return { success: false, error: 'No PDF sources available' };
    }

    // Find the requested source type
    let targetSource = null;
    let pubHtmlUrl = null;
    const typeMap = {
      'arxiv': 'EPRINT_PDF',
      'ads': 'ADS_PDF',
      'publisher': 'PUB_PDF'
    };
    const targetType = typeMap[sourceType];

    for (const source of esources) {
      const linkType = source.link_type || source.type || '';
      if (linkType.includes(targetType) && source.url && source.url.startsWith('http')) {
        targetSource = source;
        break;
      }
      // Track PUB_HTML as fallback for publisher downloads
      if (sourceType === 'publisher' && linkType.includes('PUB_HTML') && source.url) {
        pubHtmlUrl = source.url;
      }
    }

    // If no direct PDF URL for publisher, try to derive from PUB_HTML
    if (!targetSource && sourceType === 'publisher' && pubHtmlUrl) {
      sendConsoleLog(`No PUB_PDF found, trying to derive from PUB_HTML...`, 'info');
      const derivedUrl = convertPublisherHtmlToPdf(pubHtmlUrl);
      if (derivedUrl) {
        targetSource = { url: derivedUrl, link_type: 'PUB_PDF_DERIVED' };
        sendConsoleLog(`Derived PDF URL: ${derivedUrl}`, 'success');
      }
    }

    if (!targetSource) {
      sendConsoleLog(`${sourceType} PDF not found in esources`, 'error');
      return { success: false, error: `${sourceType} PDF not available` };
    }

    // Generate source-specific filename for display/symlink
    const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
    const originalName = `${baseFilename}_${targetType}.pdf`;

    // Check if this source's PDF already exists in paper_files
    const existingFiles = database.getPaperFiles(paperId, { sourceType: targetType });
    if (existingFiles.length > 0) {
      const existingPath = fileManager ? fileManager.getFile(existingFiles[0].id)?.path : null;
      sendConsoleLog(`${sourceType} PDF already downloaded`, 'success');
      return { success: true, path: existingPath, source: sourceType, alreadyExists: true };
    }

    // Download the PDF
    let downloadUrl = targetSource.url;

    // Apply proxy for publisher PDFs if configured
    if (sourceType === 'publisher' && proxyUrl) {
      // Resolve ADS link_gateway redirects to get actual publisher URL
      try {
        const resolvedUrl = await pdfDownload.resolveRedirects(targetSource.url);
        downloadUrl = proxyUrl + encodeURIComponent(resolvedUrl);
        sendConsoleLog(`Using library proxy: ${resolvedUrl}`, 'info');
      } catch (e) {
        downloadUrl = proxyUrl + encodeURIComponent(targetSource.url);
        sendConsoleLog(`Using library proxy (unresolved): ${targetSource.url}`, 'info');
      }
    }

    sendConsoleLog(`Downloading from: ${downloadUrl}`, 'info');

    // Helper function to download and add via FileManager
    const downloadAndAddFile = async (url, sourceTypeVal, displayName) => {
      const tempPath = path.join(os.tmpdir(), `adsreader_download_${Date.now()}.pdf`);
      try {
        await pdfDownload.downloadFile(url, tempPath);

        // Add via FileManager (computes hash, stores in content-addressed location, creates symlink)
        const result = await fileManager.addFile(paperId, tempPath, {
          role: 'pdf',
          sourceType: sourceTypeVal,
          originalName: displayName,
          sourceUrl: url,
          bibcode: paper.bibcode
        });

        return { success: true, fileId: result.id, path: result.path };
      } finally {
        // Clean up temp file
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      }
    };

    try {
      const result = await downloadAndAddFile(downloadUrl, targetType, originalName);
      sendConsoleLog(`Downloaded ${sourceType} PDF successfully`, 'success');
      return { success: true, path: result.path, source: sourceType, fileId: result.fileId };
    } catch (downloadError) {
      // If publisher download failed (auth required), try fallback sources
      if (sourceType === 'publisher' && downloadError.message.includes('authentication')) {
        sendConsoleLog(`Publisher requires authentication, trying fallback sources...`, 'warn');

        // Try arXiv first
        const arxivSource = esources.find(s => (s.link_type || s.type || '').includes('EPRINT_PDF'));
        if (arxivSource && arxivSource.url) {
          sendConsoleLog(`Trying arXiv fallback...`, 'info');
          try {
            // arXiv URLs need .pdf extension
            let arxivUrl = arxivSource.url;
            if (!arxivUrl.endsWith('.pdf')) {
              arxivUrl = arxivUrl.replace('/abs/', '/pdf/');
              if (!arxivUrl.endsWith('.pdf')) arxivUrl += '.pdf';
            }
            const arxivName = `${baseFilename}_EPRINT_PDF.pdf`;
            const result = await downloadAndAddFile(arxivUrl, 'EPRINT_PDF', arxivName);
            sendConsoleLog(`Downloaded from arXiv (fallback)`, 'success');
            return { success: true, path: result.path, source: 'arxiv', fallback: true, fileId: result.fileId };
          } catch (arxivError) {
            sendConsoleLog(`arXiv fallback failed: ${arxivError.message}`, 'warn');
          }
        }

        // Try ADS scan
        const adsSource = esources.find(s => (s.link_type || s.type || '').includes('ADS_PDF'));
        if (adsSource && adsSource.url) {
          sendConsoleLog(`Trying ADS fallback...`, 'info');
          try {
            const adsName = `${baseFilename}_ADS_PDF.pdf`;
            const result = await downloadAndAddFile(adsSource.url, 'ADS_PDF', adsName);
            sendConsoleLog(`Downloaded from ADS (fallback)`, 'success');
            return { success: true, path: result.path, source: 'ads', fallback: true, fileId: result.fileId };
          } catch (adsError) {
            sendConsoleLog(`ADS fallback failed: ${adsError.message}`, 'warn');
          }
        }

        // All fallbacks failed
        sendConsoleLog(`All download sources failed`, 'error');
        return { success: false, error: 'Publisher requires authentication and no fallback sources available' };
      }

      throw downloadError;
    }
  } catch (error) {
    sendConsoleLog(`Download failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Sync cancellation flag
let syncCancelled = false;

// Cancel sync handler
ipcMain.handle('ads-cancel-sync', () => {
  syncCancelled = true;
  sendConsoleLog('Sync cancelled by user', 'warn');
  return { success: true };
});

// Sync selected papers with ADS - optimized bulk sync with parallel processing
ipcMain.handle('ads-sync-papers', async (event, paperIds = null) => {
  // Prevent concurrent syncs
  if (syncInProgress) {
    sendConsoleLog('Sync already in progress, please wait', 'warn');
    return { success: false, error: 'Sync already in progress' };
  }
  syncInProgress = true;

  // Reset cancel flag at start
  syncCancelled = false;

  const token = store.get('adsToken');
  if (!token) {
    syncInProgress = false;
    return { success: false, error: 'No ADS API token configured' };
  }
  if (!dbInitialized) {
    syncInProgress = false;
    return { success: false, error: 'Database not initialized' };
  }

  const libraryPath = store.get('libraryPath');

  // Reset sync stats
  adsApi.resetSyncStats();

  // Get papers to sync - either specified IDs or all papers
  let papersToSync;
  if (paperIds && paperIds.length > 0) {
    papersToSync = paperIds.map(id => database.getPaper(id)).filter(p => p);
  } else {
    papersToSync = database.getAllPapers();
  }

  // Separate papers with and without bibcodes
  const papersWithBibcode = papersToSync.filter(p => p.bibcode);
  const papersWithoutBibcode = papersToSync.filter(p => !p.bibcode && (p.doi || p.arxiv_id));
  const papersNoIdentifier = papersToSync.filter(p => !p.bibcode && !p.doi && !p.arxiv_id);

  sendConsoleLog(`Sync: ${papersWithBibcode.length} with bibcode, ${papersWithoutBibcode.length} with doi/arxiv, ${papersNoIdentifier.length} with no ID`, 'info');
  if (papersNoIdentifier.length > 0) {
    papersNoIdentifier.forEach(p => sendConsoleLog(`No identifier: "${p.title?.substring(0, 40)}..."`, 'warn'));
  }

  const results = {
    total: papersToSync.length,
    updated: 0,
    failed: 0,
    skipped: 0,
    errors: []
  };

  // Helper to merge ADS metadata with existing paper data
  // Only updates fields where ADS has data; preserves existing values when ADS is empty
  const mergeMetadata = (existing, adsMetadata) => {
    const merged = {};
    const allKeys = new Set([...Object.keys(existing), ...Object.keys(adsMetadata)]);

    for (const key of allKeys) {
      const adsValue = adsMetadata[key];
      const existingValue = existing[key];

      // Check if ADS has a meaningful value
      const adsHasValue = adsValue !== null && adsValue !== undefined &&
        adsValue !== '' &&
        !(Array.isArray(adsValue) && adsValue.length === 0);

      if (adsHasValue) {
        // ADS has data - use it
        merged[key] = adsValue;
      } else if (existingValue !== undefined) {
        // ADS doesn't have data but paper does - keep existing
        merged[key] = existingValue;
      }
      // If neither has data, don't include the key
    }

    return merged;
  };

  // Helper to process a single paper (for parallel execution)
  const processPaper = async (paper, adsData, bibtexMap = null) => {
    const bibcode = adsData.bibcode;
    const shortTitle = paper.title?.substring(0, 35) || 'Untitled';

    try {
      sendConsoleLog(`[${bibcode}] Updating metadata...`, 'info');
      const adsMetadata = adsApi.adsToPaper(adsData);

      // Merge ADS metadata with existing paper data (preserves existing values when ADS is empty)
      const mergedMetadata = mergeMetadata(paper, adsMetadata);

      // Get BibTeX from pre-fetched map or existing
      let bibtexStr = bibtexMap?.get(adsData.bibcode) || paper.bibtex;

      // Update paper metadata (don't save yet - batch save at end)
      database.updatePaper(paper.id, {
        ...mergedMetadata,
        bibtex: bibtexStr
      }, false);

      // Store available PDF sources as metadata (don't download during sync)
      try {
        const esources = await adsApi.getEsources(token, bibcode);
        const availableSources = (esources || [])
          .filter(e => e && ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF'].includes(e.link_type?.split('|').pop() || e.type))
          .map(e => {
            const linkType = e.link_type?.split('|').pop() || e.type;
            if (linkType === 'EPRINT_PDF') return 'arxiv';
            if (linkType === 'PUB_PDF') return 'publisher';
            if (linkType === 'ADS_PDF') return 'ads_scan';
            return null;
          })
          .filter(Boolean);

        if (availableSources.length > 0) {
          database.updatePaper(paper.id, {
            available_sources: JSON.stringify(availableSources)
          }, false);
          sendConsoleLog(`[${bibcode}] Available PDF sources: ${availableSources.join(', ')}`, 'info');
        }
      } catch (e) {
        // Esources fetch is non-critical, log and continue
        sendConsoleLog(`[${bibcode}] Could not fetch esources: ${e?.message || e}`, 'warn');
      }

      sendConsoleLog(`[${bibcode}] ✓ Done`, 'success');
      return { success: true };
    } catch (error) {
      // Extract error message from various error types
      const errorMessage = error?.message || (typeof error === 'string' ? error : JSON.stringify(error) || 'Unknown error');
      const errorStack = error?.stack || '';

      // Build detailed error report
      const details = [
        `Paper: ${bibcode}`,
        `Error: ${errorMessage}`,
        errorStack ? `\nStack Trace:\n${errorStack}` : '',
        `\nTimestamp: ${new Date().toISOString()}`
      ].filter(Boolean).join('\n');

      sendConsoleLog(`[${bibcode}] ✗ Error: ${errorMessage}`, 'error', details);
      return { success: false, error: errorMessage };
    }
  };

  // Process papers with bibcodes using batch lookup
  if (papersWithBibcode.length > 0) {
    const bibcodes = papersWithBibcode.map(p => p.bibcode);
    sendConsoleLog(`Batch fetching ${bibcodes.length} papers from ADS...`, 'info');

    // Batch fetch all metadata at once
    const adsResults = await adsApi.getByBibcodes(token, bibcodes);
    // Create map with both exact bibcode and normalized (no dots) for flexible matching
    const adsMap = new Map();
    const adsMapNormalized = new Map();
    for (const r of adsResults) {
      adsMap.set(r.bibcode, r);
      adsMapNormalized.set(r.bibcode.replace(/\./g, ''), r);
    }
    sendConsoleLog(`Fetched metadata for ${adsResults.length}/${bibcodes.length} papers`, 'success');

    // Log any bibcodes that weren't found
    if (adsResults.length < bibcodes.length) {
      const foundBibcodes = new Set(adsResults.map(r => r.bibcode));
      const missing = bibcodes.filter(b => !foundBibcodes.has(b) && !adsMapNormalized.has(b.replace(/\./g, '')));
      if (missing.length > 0) {
        sendConsoleLog(`Missing from ADS: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`, 'warn');
      }
    }

    // Batch fetch all BibTeX at once (much faster than individual calls)
    let bibtexMap = new Map();
    try {
      sendConsoleLog(`Fetching BibTeX entries...`, 'info');
      const bibtexStr = await adsApi.exportBibtex(token, bibcodes);
      // Parse the combined bibtex to map by bibcode
      if (bibtexStr) {
        // Split by @ to get individual entries
        const entries = bibtexStr.split(/(?=@)/);
        for (const entry of entries) {
          if (!entry.trim()) continue;
          // Try to extract bibcode from adsurl field first
          const adsurlMatch = entry.match(/adsurl\s*=\s*\{[^}]*\/abs\/([^}\/]+)/i);
          if (adsurlMatch) {
            const extractedBibcode = adsurlMatch[1];
            // Find matching bibcode in our list
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
      sendConsoleLog(`Got BibTeX for ${bibtexMap.size} papers`, 'success');
    } catch (e) {
      sendConsoleLog(`BibTeX fetch failed: ${e.message}`, 'warn');
    }

    // Process papers in parallel with higher concurrency
    const CONCURRENCY = 10;
    sendConsoleLog(`Processing ${papersWithBibcode.length} papers (${CONCURRENCY} at a time)...`, 'info');

    for (let i = 0; i < papersWithBibcode.length; i += CONCURRENCY) {
      // Check for cancellation
      if (syncCancelled) {
        sendConsoleLog('Sync cancelled', 'warn');
        break;
      }
      const batch = papersWithBibcode.slice(i, i + CONCURRENCY);
      const batchNum = Math.floor(i / CONCURRENCY) + 1;
      const totalBatches = Math.ceil(papersWithBibcode.length / CONCURRENCY);

      const currentStats = adsApi.getSyncStats();
      sendConsoleLog(`Batch ${batchNum}/${totalBatches} (${adsApi.formatBytes(currentStats.bytesReceived)} received)`, 'info');

      // Send progress update
      mainWindow.webContents.send('ads-sync-progress', {
        current: i + 1,
        total: papersToSync.length,
        paper: `Batch ${batchNum}/${totalBatches} (${adsApi.formatBytes(currentStats.bytesReceived)})`
      });

      const promises = batch.map(async (paper) => {
        // Try exact match first, then normalized (no dots)
        let adsData = adsMap.get(paper.bibcode);
        if (!adsData) {
          adsData = adsMapNormalized.get(paper.bibcode.replace(/\./g, ''));
        }
        // Also try looking up by DOI if we have it and bibcode failed
        if (!adsData && paper.doi) {
          try {
            const cleanDoi = paper.doi.replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:/i, '');
            sendConsoleLog(`[${paper.bibcode}] Trying DOI fallback: ${cleanDoi}`, 'info');
            adsData = await adsApi.getByDOI(token, cleanDoi);
            if (adsData) {
              sendConsoleLog(`[${paper.bibcode}] Found via DOI: ${adsData.bibcode}`, 'success');
            } else {
              sendConsoleLog(`[${paper.bibcode}] DOI lookup returned no results`, 'warn');
            }
          } catch (e) {
            sendConsoleLog(`[${paper.bibcode}] DOI lookup failed: ${e.message}`, 'warn');
          }
        } else if (!adsData) {
          sendConsoleLog(`[${paper.bibcode}] No DOI available for fallback`, 'info');
        }
        if (!adsData) {
          sendConsoleLog(`[${paper.bibcode}] Not found in ADS`, 'error');
          results.failed++;
          results.errors.push({ paper: paper.title, error: 'Not found in ADS' });
          return;
        }

        const result = await processPaper(paper, adsData, bibtexMap);
        if (result.success) {
          results.updated++;
        } else {
          results.failed++;
          results.errors.push({ paper: paper.title, error: result.error });
        }
      });

      await Promise.all(promises);

      // Small delay between batches to avoid rate limits
      if (i + CONCURRENCY < papersWithBibcode.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  // Process papers without bibcode (need individual lookup by DOI/arXiv)
  for (let i = 0; i < papersWithoutBibcode.length; i++) {
    // Check for cancellation
    if (syncCancelled) {
      sendConsoleLog('Sync cancelled', 'warn');
      break;
    }
    const paper = papersWithoutBibcode[i];
    sendConsoleLog(`Syncing: "${paper.title?.substring(0, 40)}..." (doi=${paper.doi || 'none'}, arxiv=${paper.arxiv_id || 'none'})`, 'info');

    mainWindow.webContents.send('ads-sync-progress', {
      current: papersWithBibcode.length + i + 1,
      total: papersToSync.length,
      paper: paper.title
    });

    try {
      let adsData = null;
      if (paper.doi) {
        const cleanedDoi = cleanDOI(paper.doi);
        sendConsoleLog(`Trying DOI: ${cleanedDoi}`, 'info');
        adsData = await adsApi.getByDOI(token, cleanedDoi);
        if (adsData) {
          sendConsoleLog(`Found via DOI: ${cleanedDoi}`, 'success');
        }
      }
      if (!adsData && paper.arxiv_id) {
        adsData = await adsApi.getByArxiv(token, paper.arxiv_id);
        if (adsData) {
          sendConsoleLog(`Found via arXiv: ${paper.arxiv_id}`, 'success');
        }
      }

      // Fallback to smart search if DOI/arXiv lookup failed
      if (!adsData && paper.title) {
        let firstAuthor = null;
        if (paper.authors) {
          // Handle both string and array formats
          let authorStr = Array.isArray(paper.authors) ? paper.authors[0] : paper.authors;
          if (authorStr) {
            // If multiple authors separated by ' and ' or ';', take the first
            authorStr = authorStr.split(/ and |;/)[0].trim();
            if (authorStr.includes(',')) {
              // "Last, First" format
              firstAuthor = authorStr.split(',')[0].trim();
            } else {
              // "First Last" format - take last word as surname
              const parts = authorStr.trim().split(/\s+/);
              if (parts.length > 0) {
                firstAuthor = parts[parts.length - 1];
              }
            }
          }
        }
        sendConsoleLog(`Trying smart search for "${paper.title?.substring(0, 30)}..." (author: ${firstAuthor || 'none'})`, 'info');
        adsData = await adsApi.smartSearch(token, {
          title: paper.title,
          firstAuthor: firstAuthor,
          year: paper.year,
          journal: paper.journal
        });
        if (adsData) {
          sendConsoleLog(`Found via smart search: ${adsData.bibcode}`, 'success');
        }
      }

      if (!adsData) {
        sendConsoleLog(`Not found on ADS, skipping`, 'warn');
        results.skipped++;
        continue;
      }

      // Check if another paper already has this bibcode (duplicate detection)
      const existingPaper = database.getPaperByBibcode(adsData.bibcode);
      if (existingPaper && existingPaper.id !== paper.id) {
        sendConsoleLog(`DUPLICATE: This paper already exists in your library!`, 'warn');
        sendConsoleLog(`  Current: "${paper.title?.substring(0, 50)}..." (ID: ${paper.id})`, 'info');
        sendConsoleLog(`  Existing: "${existingPaper.title?.substring(0, 50)}..." (ID: ${existingPaper.id})`, 'info');
        sendConsoleLog(`  Bibcode: ${adsData.bibcode}`, 'info');
        sendConsoleLog(`  Consider deleting the duplicate entry.`, 'info');
        results.skipped++;
        continue;
      }

      // Update bibcode for future syncs
      database.updatePaper(paper.id, { bibcode: adsData.bibcode }, false);

      const result = await processPaper(paper, adsData);
      if (result.success) {
        results.updated++;
      } else {
        results.failed++;
        results.errors.push({ paper: paper.title, error: result.error });
      }
    } catch (error) {
      sendConsoleLog(`Error syncing "${paper.title?.substring(0, 30)}...": ${error.message}`, 'error');
      console.error('Full sync error:', error);
      results.failed++;
      results.errors.push({ paper: paper.title, error: error.message });
    }
  }

  // Process papers with no identifier using advanced lookup strategies
  if (papersNoIdentifier.length > 0) {
    sendConsoleLog(`Trying advanced lookup for ${papersNoIdentifier.length} papers without identifiers...`, 'info');

    for (let i = 0; i < papersNoIdentifier.length; i++) {
      // Check for cancellation
      if (syncCancelled) {
        sendConsoleLog('Sync cancelled', 'warn');
        break;
      }
      const paper = papersNoIdentifier[i];
      const shortTitle = paper.title?.substring(0, 40) || 'Untitled';

      mainWindow.webContents.send('ads-sync-progress', {
        current: papersWithBibcode.length + papersWithoutBibcode.length + i + 1,
        total: papersToSync.length,
        paper: `Lookup: ${shortTitle}...`
      });

      try {
        let adsData = null;

        // Strategy 1: Try to extract bibcode from adsurl in bibtex
        if (paper.bibtex) {
          const adsUrlMatch = paper.bibtex.match(/adsurl\s*=\s*\{([^}]+)\}/i);
          if (adsUrlMatch) {
            const adsUrl = adsUrlMatch[1];
            const absMatch = adsUrl.match(/\/abs\/([^\/\s&?]+)/);
            if (absMatch) {
              const bibcodeFromUrl = absMatch[1];
              sendConsoleLog(`[${shortTitle}] Trying bibcode from adsurl: ${bibcodeFromUrl}`, 'info');
              adsData = await adsApi.getByBibcode(token, bibcodeFromUrl);
              if (adsData) {
                database.updatePaper(paper.id, { bibcode: bibcodeFromUrl }, false);
              }
            }
          }
        }

        // Strategy 2: Try to extract identifiers from PDF text content
        if (!adsData && paper.text_path && libraryPath) {
          const textFile = path.join(libraryPath, paper.text_path);
          if (fs.existsSync(textFile)) {
            sendConsoleLog(`[${shortTitle}] Extracting identifiers from PDF...`, 'info');
            const textContent = fs.readFileSync(textFile, 'utf-8');
            const contentIds = pdfImport.extractIdentifiersFromContent(textContent);

            if (contentIds.doi) {
              // Clean DOI
              let cleanDoi = contentIds.doi
                .replace(/\/CITE\/REFWORKS$/i, '')
                .replace(/\/abstract$/i, '')
                .replace(/\/full$/i, '')
                .replace(/\/pdf$/i, '')
                .trim();
              sendConsoleLog(`[${shortTitle}] Trying extracted DOI: ${cleanDoi}`, 'info');
              adsData = await adsApi.getByDOI(token, cleanDoi);
              if (adsData) {
                database.updatePaper(paper.id, { doi: cleanDoi }, false);
              }
            }
            if (!adsData && contentIds.arxiv_id) {
              sendConsoleLog(`[${shortTitle}] Trying extracted arXiv: ${contentIds.arxiv_id}`, 'info');
              adsData = await adsApi.getByArxiv(token, contentIds.arxiv_id);
              if (adsData) {
                database.updatePaper(paper.id, { arxiv_id: contentIds.arxiv_id }, false);
              }
            }
            if (!adsData && contentIds.bibcode) {
              sendConsoleLog(`[${shortTitle}] Trying extracted bibcode: ${contentIds.bibcode}`, 'info');
              adsData = await adsApi.getByBibcode(token, contentIds.bibcode);
            }

            // Strategy 3: Use LLM to extract metadata if available
            if (!adsData) {
              let pdfMeta = pdfImport.extractMetadataFromPDF(textContent);

              const service = getLlmService();
              const connectionCheck = await service.checkConnection().catch(() => ({ connected: false }));
              if (connectionCheck.connected) {
                try {
                  sendConsoleLog(`[${shortTitle}] Using LLM to extract metadata...`, 'info');
                  const llmResponse = await withTimeout(
                    service.generate(
                      PROMPTS.extractMetadata.user(textContent.substring(0, 8000)),
                      {
                        systemPrompt: PROMPTS.extractMetadata.system,
                        temperature: 0.1,
                        maxTokens: 500,
                        noThink: true
                      }
                    ),
                    30000,
                    'LLM metadata extraction'
                  );
                  const llmMeta = parseMetadataResponse(llmResponse);

                  // Merge LLM results
                  if (llmMeta.title) pdfMeta.title = llmMeta.title;
                  if (llmMeta.firstAuthor) pdfMeta.firstAuthor = llmMeta.firstAuthor;
                  if (llmMeta.year) pdfMeta.year = llmMeta.year;
                  if (llmMeta.journal) pdfMeta.journal = llmMeta.journal;

                  // Try LLM-extracted identifiers
                  if (llmMeta.doi && !adsData) {
                    sendConsoleLog(`[${shortTitle}] Trying LLM-extracted DOI: ${llmMeta.doi}`, 'info');
                    adsData = await adsApi.getByDOI(token, llmMeta.doi);
                    if (adsData) {
                      database.updatePaper(paper.id, { doi: llmMeta.doi }, false);
                    }
                  }
                  if (llmMeta.arxiv_id && !adsData) {
                    sendConsoleLog(`[${shortTitle}] Trying LLM-extracted arXiv: ${llmMeta.arxiv_id}`, 'info');
                    adsData = await adsApi.getByArxiv(token, llmMeta.arxiv_id);
                    if (adsData) {
                      database.updatePaper(paper.id, { arxiv_id: llmMeta.arxiv_id }, false);
                    }
                  }
                } catch (llmError) {
                  sendConsoleLog(`[${shortTitle}] LLM extraction failed: ${llmError.message}`, 'warn');
                }
              }

              // Use extracted metadata for smart search
              if (!adsData && (pdfMeta.title || pdfMeta.firstAuthor)) {
                sendConsoleLog(`[${shortTitle}] Trying smart search with PDF metadata...`, 'info');
                adsData = await adsApi.smartSearch(token, {
                  title: pdfMeta.title || paper.title,
                  firstAuthor: pdfMeta.firstAuthor,
                  year: pdfMeta.year || paper.year,
                  journal: pdfMeta.journal || paper.journal
                });
              }
            }
          }
        }

        // Strategy 4: Fall back to basic smart search using paper metadata
        if (!adsData && paper.title) {
          let firstAuthor = null;
          if (paper.authors) {
            // Handle both string and array formats
            let authorStr = Array.isArray(paper.authors) ? paper.authors[0] : paper.authors;
            if (authorStr) {
              // If multiple authors separated by ' and ' or ';', take the first
              authorStr = authorStr.split(/ and |;/)[0].trim();
              if (authorStr.includes(',')) {
                firstAuthor = authorStr.split(',')[0].trim();
              } else {
                const parts = authorStr.trim().split(/\s+/);
                if (parts.length > 0) {
                  firstAuthor = parts[parts.length - 1];
                }
              }
            }
          }

          sendConsoleLog(`[${shortTitle}] Trying smart search (author=${firstAuthor || 'none'}, year=${paper.year || 'none'})`, 'info');
          adsData = await adsApi.smartSearch(token, {
            title: paper.title,
            firstAuthor: firstAuthor,
            year: paper.year,
            journal: paper.journal
          });
        }

        if (adsData) {
          sendConsoleLog(`[${shortTitle}] Found: ${adsData.bibcode}`, 'success');

          // Check if another paper already has this bibcode (duplicate detection)
          const existingPaper = database.getPaperByBibcode(adsData.bibcode);
          if (existingPaper && existingPaper.id !== paper.id) {
            sendConsoleLog(`DUPLICATE: This paper already exists in your library!`, 'warn');
            sendConsoleLog(`  Current: "${paper.title?.substring(0, 50)}..." (ID: ${paper.id})`, 'info');
            sendConsoleLog(`  Existing: "${existingPaper.title?.substring(0, 50)}..." (ID: ${existingPaper.id})`, 'info');
            sendConsoleLog(`  Bibcode: ${adsData.bibcode}`, 'info');
            sendConsoleLog(`  Consider deleting the duplicate entry.`, 'info');
            results.skipped++;
            continue;
          }

          database.updatePaper(paper.id, { bibcode: adsData.bibcode }, false);

          const result = await processPaper(paper, adsData);
          if (result.success) {
            results.updated++;
          } else {
            results.failed++;
            results.errors.push({ paper: paper.title, error: result.error });
          }
        } else {
          sendConsoleLog(`[${shortTitle}] No match found`, 'warn');
          results.skipped++;
        }
      } catch (error) {
        sendConsoleLog(`[${shortTitle}] Lookup failed: ${error.message}`, 'error');
        results.failed++;
        results.errors.push({ paper: paper.title, error: error.message });
      }
    }
  }

  // Save database once at the end
  database.saveDatabase();

  // Update master.bib once at the end
  bibtex.updateMasterBib(libraryPath, database.getAllPapers());

  // Send completion with data stats
  const stats = adsApi.getSyncStats();
  const cancelled = syncCancelled;
  sendConsoleLog(`Sync ${cancelled ? 'cancelled' : 'complete'}: ${results.updated} updated, ${results.skipped} skipped, ${results.failed} failed (${adsApi.formatBytes(stats.bytesReceived)} received)`,
    cancelled ? 'warn' : (results.failed > 0 ? 'warn' : 'success'));
  mainWindow.webContents.send('ads-sync-progress', { done: true, results, cancelled });

  // Release sync lock
  syncInProgress = false;

  return { success: true, results, cancelled };
});

// Update citation counts only (lightweight sync - just gets citation_count from ADS)
ipcMain.handle('ads-update-citation-counts', async (event, paperIds = null) => {
  const token = store.get('adsToken');
  if (!token) {
    return { success: false, error: 'No ADS API token configured' };
  }
  if (!dbInitialized) {
    return { success: false, error: 'Database not initialized' };
  }

  // Get papers to update
  let papers;
  if (paperIds && paperIds.length > 0) {
    papers = paperIds.map(id => database.getPaper(id)).filter(p => p && p.bibcode);
  } else {
    papers = database.getAllPapers().filter(p => p.bibcode);
  }

  if (papers.length === 0) {
    return { success: true, updated: 0 };
  }

  sendConsoleLog(`Updating citation counts for ${papers.length} papers...`, 'info');

  const bibcodes = papers.map(p => p.bibcode);

  try {
    // Batch fetch just bibcode and citation_count
    const adsResults = await adsApi.getByBibcodes(token, bibcodes, {
      fields: 'bibcode,citation_count'
    });

    const adsMap = new Map();
    for (const r of adsResults) {
      adsMap.set(r.bibcode, r.citation_count || 0);
      // Also try normalized bibcode
      adsMap.set(r.bibcode.replace(/\./g, ''), r.citation_count || 0);
    }

    let updated = 0;
    for (const paper of papers) {
      const count = adsMap.get(paper.bibcode) ?? adsMap.get(paper.bibcode.replace(/\./g, ''));
      if (count !== undefined && count !== paper.citation_count) {
        database.updatePaper(paper.id, { citation_count: count }, false);
        updated++;
      }
    }

    database.saveDatabase();
    sendConsoleLog(`Updated citation counts for ${updated} papers`, 'success');

    return { success: true, updated, total: papers.length };
  } catch (error) {
    sendConsoleLog(`Citation count update failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// ===== ADS Search & Import IPC Handlers =====

ipcMain.handle('ads-import-search', async (event, query, options = {}) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };

  try {
    sendConsoleLog(`ADS search: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`, 'info');
    const result = await adsApi.search(token, query, {
      rows: options.rows || 1000,
      start: options.start || 0,
      sort: options.sort || 'date desc'
    });

    sendConsoleLog(`ADS found ${result.numFound} results`, 'success');

    // Check which papers are already in library
    const papers = result.docs.map(doc => {
      const paper = adsApi.adsToPaper(doc);
      paper.inLibrary = dbInitialized && database.getPaperByBibcode(doc.bibcode) !== null;
      return paper;
    });

    return {
      success: true,
      data: {
        papers,
        numFound: result.numFound,
        start: result.start || 0
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ads-import-papers', async (event, selectedPapers) => {
  const token = store.get('adsToken');
  const libraryPath = store.get('libraryPath');

  if (!token) return { success: false, error: 'No ADS API token configured' };
  if (!libraryPath) return { success: false, error: 'No library selected' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  sendConsoleLog(`ADS import: ${selectedPapers.length} papers selected`, 'info');

  const results = {
    imported: [],
    skipped: [],
    failed: []
  };

  // Phase 1: Filter out duplicates (quick, no network calls)
  const papersToImport = [];
  for (const paper of selectedPapers) {
    if (paper.bibcode) {
      const existing = database.getPaperByBibcode(paper.bibcode);
      if (existing) {
        sendConsoleLog(`[${paper.bibcode}] Already in library, skipping`, 'info');
        results.skipped.push({ paper, reason: 'Already in library' });
        continue;
      }
    }
    papersToImport.push(paper);
  }

  if (papersToImport.length === 0) {
    mainWindow.webContents.send('import-complete', results);
    return { success: true, results };
  }

  sendConsoleLog(`Importing ${papersToImport.length} new papers...`, 'info');

  // Phase 2: Batch fetch all BibTeX entries in one call (much faster)
  const bibcodes = papersToImport.filter(p => p.bibcode).map(p => p.bibcode);
  let bibtexMap = new Map();

  if (bibcodes.length > 0) {
    try {
      sendConsoleLog(`Batch fetching BibTeX for ${bibcodes.length} papers...`, 'info');
      const bibtexStr = await adsApi.exportBibtex(token, bibcodes);
      if (bibtexStr) {
        // Parse the combined bibtex to map by bibcode
        const entries = bibtexStr.split(/(?=@)/);
        for (const entry of entries) {
          if (!entry.trim()) continue;
          // Try to extract bibcode from adsurl field
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
      sendConsoleLog(`Got BibTeX for ${bibtexMap.size} papers`, 'success');
    } catch (e) {
      sendConsoleLog(`Batch BibTeX fetch failed: ${e.message}`, 'warn');
    }
  }

  // Phase 3: Process papers in parallel batches (10 at a time)
  const CONCURRENCY = 10;
  sendConsoleLog(`Processing ${papersToImport.length} papers (${CONCURRENCY} at a time)...`, 'info');

  // Helper to process a single paper
  const processPaper = async (paper, index) => {
    try {
      let processedPaper = { ...paper };

      // If we only have bibcode, fetch full metadata from ADS
      if (paper.bibcode && !paper.title) {
        const metadata = await adsApi.getByBibcode(token, paper.bibcode);
        if (metadata) {
          processedPaper = {
            bibcode: metadata.bibcode,
            doi: metadata.doi?.[0],
            arxiv_id: extractArxivId(metadata.identifier),
            title: metadata.title?.[0],
            authors: metadata.author,
            year: parseInt(metadata.year) || null,
            journal: metadata.pub,
            abstract: metadata.abstract,
            keywords: metadata.keyword
          };
        }
      }

      // Fetch available PDF sources
      let availableSources = [];
      if (processedPaper.bibcode) {
        try {
          const esources = await adsApi.getEsources(token, processedPaper.bibcode);
          availableSources = (esources || [])
            .filter(e => e && ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF'].some(t => (e.link_type || e.type || '').includes(t)))
            .map(e => {
              const linkType = (e.link_type || e.type || '').split('|').pop();
              if (linkType === 'EPRINT_PDF') return 'arxiv';
              if (linkType === 'PUB_PDF') return 'publisher';
              if (linkType === 'ADS_PDF') return 'ads_scan';
              return null;
            })
            .filter(Boolean);
        } catch (e) {
          // Esources fetch failed, not critical
        }
      }

      // Get BibTeX from batch-fetched map
      const bibtexStr = bibtexMap.get(processedPaper.bibcode) || null;

      // Add paper to database
      const paperId = database.addPaper({
        bibcode: processedPaper.bibcode,
        doi: processedPaper.doi,
        arxiv_id: processedPaper.arxiv_id,
        title: processedPaper.title,
        authors: processedPaper.authors,
        year: processedPaper.year,
        journal: processedPaper.journal,
        abstract: processedPaper.abstract,
        keywords: processedPaper.keywords,
        pdf_path: null,
        text_path: null,
        bibtex: bibtexStr,
        available_sources: availableSources.length > 0 ? JSON.stringify(availableSources) : null
      });

      // Remove from reading list if present (paper is now in library)
      if (processedPaper.bibcode && database.isInReadingList(processedPaper.bibcode)) {
        const cache = getReadingListCache();
        if (cache) cache.remove(processedPaper.bibcode);
        database.removeFromReadingList(processedPaper.bibcode);
      }

      sendConsoleLog(`[${processedPaper.bibcode}] ✓ Imported`, 'success');
      return {
        success: true,
        paper: processedPaper,
        id: paperId,
        hasPdf: false,
        availableSources
      };
    } catch (error) {
      sendConsoleLog(`[${paper.bibcode || 'unknown'}] ✗ Import failed: ${error.message}`, 'error');
      return { success: false, paper, error: error.message };
    }
  };

  // Process in batches
  for (let i = 0; i < papersToImport.length; i += CONCURRENCY) {
    const batch = papersToImport.slice(i, i + CONCURRENCY);
    const batchNum = Math.floor(i / CONCURRENCY) + 1;
    const totalBatches = Math.ceil(papersToImport.length / CONCURRENCY);

    // Send progress update
    mainWindow.webContents.send('import-progress', {
      current: i + 1,
      total: papersToImport.length + results.skipped.length,
      paper: `Batch ${batchNum}/${totalBatches}`
    });

    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map((paper, idx) => processPaper(paper, i + idx))
    );

    // Collect results
    for (const result of batchResults) {
      if (result.success) {
        results.imported.push(result);
      } else {
        results.failed.push({ paper: result.paper, error: result.error });
      }
    }

    // Small delay between batches to avoid rate limits
    if (i + CONCURRENCY < papersToImport.length) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  // Update master.bib
  const allPapers = database.getAllPapers();
  bibtex.updateMasterBib(libraryPath, allPapers);

  // Send completion
  mainWindow.webContents.send('import-complete', results);

  return { success: true, results };
});

// ===== BibTeX IPC Handlers =====

ipcMain.handle('copy-cite', (event, paperIdOrIds, style) => {
  if (!dbInitialized) return { success: false };

  // Support both single paper ID and array of IDs
  const paperIds = Array.isArray(paperIdOrIds) ? paperIdOrIds : [paperIdOrIds];
  const papers = paperIds.map(id => database.getPaper(id)).filter(p => p);

  if (papers.length === 0) return { success: false };

  // Use multi-cite for multiple papers, single cite for one
  const citeCmd = papers.length > 1
    ? bibtex.getMultiCiteCommand(papers, style)
    : bibtex.getCiteCommand(papers[0], style);

  clipboard.writeText(citeCmd);
  return { success: true, command: citeCmd };
});

ipcMain.handle('export-bibtex', async (event, paperIds) => {
  if (!dbInitialized) return { success: false };

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export BibTeX',
    defaultPath: 'export.bib',
    filters: [{ name: 'BibTeX', extensions: ['bib'] }]
  });

  if (result.canceled) return { success: false, canceled: true };

  const papers = paperIds.map(id => database.getPaper(id)).filter(p => p);
  bibtex.exportBibtex(papers, result.filePath);

  return { success: true, path: result.filePath };
});

ipcMain.handle('save-bibtex-file', async (event, content) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export BibTeX',
    defaultPath: 'references.bib',
    filters: [{ name: 'BibTeX', extensions: ['bib'] }]
  });

  if (result.canceled) return { success: false, canceled: true };

  const fs = require('fs');
  fs.writeFileSync(result.filePath, content, 'utf8');

  return { success: true, path: result.filePath };
});

// Save edited BibTeX and update paper metadata
ipcMain.handle('save-bibtex', async (event, paperId, bibtexString) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    // Parse BibTeX to extract metadata
    const parsed = bibtex.parseSingleBibtexEntry(bibtexString);

    // Build updates object with bibtex and any parsed fields
    const updates = {
      bibtex: bibtexString
    };

    // Only update fields that were successfully parsed
    if (parsed) {
      if (parsed.title) updates.title = parsed.title;
      if (parsed.authors) updates.authors = parsed.authors;
      if (parsed.year) updates.year = parsed.year;
      if (parsed.journal) updates.journal = parsed.journal;
      if (parsed.doi) updates.doi = parsed.doi;
      if (parsed.arxiv_id) updates.arxiv_id = parsed.arxiv_id;
      if (parsed.abstract) updates.abstract = parsed.abstract;
      // Don't overwrite bibcode from BibTeX - it should remain stable
    }

    database.updatePaper(paperId, updates);

    // Return the updated paper
    const updatedPaper = database.getPaper(paperId);
    return { success: true, paper: updatedPaper };
  } catch (error) {
    console.error('Error saving BibTeX:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('import-bibtex', async () => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library selected' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import BibTeX',
    properties: ['openFile'],
    filters: [{ name: 'BibTeX', extensions: ['bib'] }]
  });

  if (result.canceled) return { success: false, canceled: true };

  try {
    // Parse BibTeX file - this now includes import_source and import_source_key
    const filename = path.basename(result.filePaths[0]);
    sendConsoleLog(`Importing BibTeX: ${filename}`, 'info');
    const entries = bibtex.importBibtex(result.filePaths[0]);

    if (entries.length === 0) {
      sendConsoleLog(`No entries found in ${filename}`, 'warn');
      return { success: true, imported: 0, skipped: 0, message: 'No entries found in file' };
    }
    sendConsoleLog(`Found ${entries.length} entries in ${filename}`, 'info');

    // Send initial progress
    mainWindow.webContents.send('import-progress', {
      current: 0,
      total: entries.length,
      paper: 'Starting import...'
    });

    // Use bulk insert for fast import
    const bulkResult = database.addPapersBulk(entries, (progress) => {
      mainWindow.webContents.send('import-progress', {
        current: progress.current,
        total: progress.total,
        inserted: progress.inserted,
        skipped: progress.skipped,
        paper: entries[progress.current - 1]?.title || 'Processing...'
      });
    });

    // Update master.bib once at the end
    const allPapers = database.getAllPapers();
    bibtex.updateMasterBib(libraryPath, allPapers);

    // Send completion
    sendConsoleLog(`Import complete: ${bulkResult.inserted.length} added, ${bulkResult.skipped.length} skipped`,
      bulkResult.inserted.length > 0 ? 'success' : 'info');
    mainWindow.webContents.send('import-complete', {
      imported: bulkResult.inserted.length,
      skipped: bulkResult.skipped.length
    });

    return {
      success: true,
      imported: bulkResult.inserted.length,
      skipped: bulkResult.skipped.length,
      details: {
        inserted: bulkResult.inserted,
        skipped: bulkResult.skipped
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Import BibTeX from file path (for drag & drop)
ipcMain.handle('import-bibtex-from-path', async (event, filePath) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library selected' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    const filename = path.basename(filePath);
    sendConsoleLog(`Importing BibTeX: ${filename}`, 'info');
    const entries = bibtex.importBibtex(filePath);  // Already sets import_source

    if (entries.length === 0) {
      sendConsoleLog(`No entries found in ${filename}`, 'warn');
      return { success: true, imported: 0, skipped: 0 };
    }
    sendConsoleLog(`Found ${entries.length} entries in ${filename}`, 'info');

    mainWindow.webContents.send('import-progress', {
      current: 0, total: entries.length, paper: 'Starting import...'
    });

    const bulkResult = database.addPapersBulk(entries, (progress) => {
      mainWindow.webContents.send('import-progress', {
        current: progress.current, total: progress.total,
        inserted: progress.inserted, skipped: progress.skipped,
        paper: entries[progress.current - 1]?.title || 'Processing...'
      });
    });

    const allPapers = database.getAllPapers();
    bibtex.updateMasterBib(libraryPath, allPapers);

    sendConsoleLog(`Import complete: ${bulkResult.inserted.length} added, ${bulkResult.skipped.length} skipped`,
      bulkResult.inserted.length > 0 ? 'success' : 'info');
    mainWindow.webContents.send('import-complete', {
      imported: bulkResult.inserted.length, skipped: bulkResult.skipped.length
    });

    return {
      success: true,
      imported: bulkResult.inserted.length,
      skipped: bulkResult.skipped.length
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ===== Library Export/Import IPC Handlers =====

const exportService = require('./src/main/export-service.cjs');
const bookExportService = require('./src/main/book-export-service.cjs');

ipcMain.handle('get-export-stats', () => {
  if (!dbInitialized) return null;
  const libraryPath = store.get('libraryPath');
  return exportService.getExportStats(database, libraryPath);
});

ipcMain.handle('export-library', async (event, options) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library selected' };

  // Determine save path - use library name for filename
  const safeLibraryName = (options.libraryName || 'My Library').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  let savePath = options.targetPath;
  if (options.forSharing) {
    // Export to temp directory for sharing
    savePath = path.join(os.tmpdir(), `${safeLibraryName}.adslib`);
  } else if (!savePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Library',
      defaultPath: `${safeLibraryName}.adslib`,
      filters: [{ name: 'ADS Library', extensions: ['adslib'] }]
    });
    if (result.canceled) return { success: false, canceled: true };
    savePath = result.filePath;
  }

  try {
    sendConsoleLog('Starting library export...', 'info');

    const result = await exportService.exportLibrary(
      options,
      database,
      libraryPath,
      savePath,
      (phase, current, total) => {
        mainWindow.webContents.send('export-progress', { phase, current, total });
      }
    );

    sendConsoleLog(`Library exported to ${path.basename(savePath)}`, 'success');
    return result;
  } catch (error) {
    console.error('Export failed:', error);
    sendConsoleLog(`Export failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// ===== Book Export IPC Handler =====

ipcMain.handle('export-book', async (event, options) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library selected' };

  const { paperIds, bookTitle, lastPdfSources, forSharing } = options;

  // Get paper data with PDF paths
  const papers = [];
  for (const id of paperIds) {
    const paper = database.getPaper(id);
    if (!paper) continue;

    // Determine preferred PDF path
    const pdfPath = getPreferredPdfPath(paper, lastPdfSources?.[id], libraryPath);
    papers.push({
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      abstract: paper.abstract,
      bibtex: paper.bibtex,
      pdfPath
    });
  }

  if (papers.length === 0) {
    return { success: false, error: 'No valid papers to export' };
  }

  // Determine save path
  const safeTitle = (bookTitle || 'Merged Papers').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  let savePath;

  if (forSharing) {
    savePath = path.join(os.tmpdir(), `${safeTitle}.pdf`);
  } else {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Book',
      defaultPath: `${safeTitle}.pdf`,
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
    });
    if (result.canceled) return { success: false, canceled: true };
    savePath = result.filePath;
  }

  try {
    sendConsoleLog(`Exporting ${papers.length} papers as book...`, 'info');

    const pdfBytes = await bookExportService.exportBook({
      papers,
      bookTitle,
      onProgress: (phase, current, total) => {
        mainWindow.webContents.send('book-export-progress', { phase, current, total });
      }
    });

    fs.writeFileSync(savePath, pdfBytes);
    sendConsoleLog(`Book exported to ${path.basename(savePath)}`, 'success');

    return { success: true, path: savePath };
  } catch (error) {
    console.error('Book export failed:', error);
    sendConsoleLog(`Book export failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Helper to get preferred PDF path for a paper
function getPreferredPdfPath(paper, lastSource, libraryPath) {
  const papersDir = path.join(libraryPath, 'papers');

  // Check lastPdfSources preference
  if (lastSource) {
    if (lastSource.startsWith('ATTACHMENT:')) {
      const filename = lastSource.substring('ATTACHMENT:'.length);
      const attPath = path.join(papersDir, filename);
      if (fs.existsSync(attPath)) return attPath;
    } else if (lastSource === 'LEGACY' && paper.pdf_path) {
      const legacyPath = path.join(libraryPath, paper.pdf_path);
      if (fs.existsSync(legacyPath)) return legacyPath;
    } else if (paper.bibcode) {
      const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
      const sourcePath = path.join(papersDir, `${baseFilename}_${lastSource}.pdf`);
      if (fs.existsSync(sourcePath)) return sourcePath;
    }
  }

  // Try standard sources in order
  if (paper.bibcode) {
    const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
    for (const source of ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF']) {
      const sourcePath = path.join(papersDir, `${baseFilename}_${source}.pdf`);
      if (fs.existsSync(sourcePath)) return sourcePath;
    }
  }

  // Fallback to legacy pdf_path
  if (paper.pdf_path) {
    const legacyPath = path.join(libraryPath, paper.pdf_path);
    if (fs.existsSync(legacyPath)) return legacyPath;
  }

  return null;
}

ipcMain.handle('preview-library-import', async (event, filePath) => {
  try {
    // If no file path provided, show open dialog
    let targetPath = filePath;
    if (!targetPath) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import Library',
        properties: ['openFile'],
        filters: [{ name: 'ADS Library', extensions: ['adslib'] }]
      });
      if (result.canceled) return { success: false, canceled: true };
      targetPath = result.filePaths[0];
    }

    const preview = await exportService.previewImport(targetPath);
    return { success: true, filePath: targetPath, ...preview };
  } catch (error) {
    console.error('Preview failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('import-library', async (event, options) => {
  const { mode, libraryName } = options;

  // Handle "new" mode - create a new library and import there
  if (mode === 'new') {
    try {
      sendConsoleLog(`Creating new library "${libraryName}" from import...`, 'info');

      // Determine where to create the library (prefer iCloud)
      let iCloudPath;
      if (isICloudAvailable() && canWriteToICloud()) {
        iCloudPath = getICloudContainerPath();
      } else if (isICloudAvailable()) {
        iCloudPath = getICloudFallbackPath();
        if (!fs.existsSync(iCloudPath)) {
          fs.mkdirSync(iCloudPath, { recursive: true });
        }
      } else {
        // Fallback to Documents
        iCloudPath = path.join(app.getPath('documents'), 'ADS Reader Libraries');
        if (!fs.existsSync(iCloudPath)) {
          fs.mkdirSync(iCloudPath, { recursive: true });
        }
      }

      // Create unique library name
      const safeName = (libraryName || 'Imported Library').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
      let newLibraryPath = path.join(iCloudPath, safeName);
      let counter = 1;
      while (fs.existsSync(newLibraryPath)) {
        newLibraryPath = path.join(iCloudPath, `${safeName} ${counter}`);
        counter++;
      }

      // Create library folder structure
      createLibraryStructure(newLibraryPath);

      // Use sql.js directly to create a fresh database for the new library
      const initSqlJs = require('sql.js');
      const { applySchema } = require('./src/shared/database-schema.cjs');
      const SQL = await initSqlJs();
      const newDb = new SQL.Database();
      applySchema(newDb);

      // Create a minimal database interface for the import
      const tempDbInterface = createTempDatabaseInterface(newDb, newLibraryPath);

      // Import into the new library
      const result = await exportService.importLibrary(
        { ...options, mode: 'merge' }, // Force merge mode since it's a new empty library
        tempDbInterface,
        newLibraryPath,
        (phase, current, total) => {
          mainWindow.webContents.send('import-library-progress', { phase, current, total });
        }
      );

      // Save the new database to disk
      const dbData = newDb.export();
      const dbBuffer = Buffer.from(dbData);
      fs.writeFileSync(path.join(newLibraryPath, 'library.sqlite'), dbBuffer);

      // Add to libraries.json
      const librariesJsonPath = path.join(iCloudPath, 'libraries.json');
      let data = { version: 1, libraries: [] };
      if (fs.existsSync(librariesJsonPath)) {
        try {
          data = JSON.parse(fs.readFileSync(librariesJsonPath, 'utf8'));
        } catch (e) { /* Use default */ }
      }

      const id = require('crypto').randomUUID();
      data.libraries.push({
        id,
        name: path.basename(newLibraryPath),
        path: path.basename(newLibraryPath),
        createdAt: new Date().toISOString(),
        createdOn: 'macOS',
        importedFrom: options.filePath ? path.basename(options.filePath) : 'import'
      });

      fs.writeFileSync(librariesJsonPath, JSON.stringify(data, null, 2));

      sendConsoleLog(
        `Library "${path.basename(newLibraryPath)}" created with ${result.papersImported} papers`,
        'success'
      );

      return { success: true, libraryPath: newLibraryPath, ...result };
    } catch (error) {
      console.error('Import to new library failed:', error);
      sendConsoleLog(`Import failed: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  }

  // Handle "merge" mode - add to current library
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library selected' };

  try {
    sendConsoleLog(`Adding to current library...`, 'info');

    const result = await exportService.importLibrary(
      options,
      database,
      libraryPath,
      (phase, current, total) => {
        mainWindow.webContents.send('import-library-progress', { phase, current, total });
      }
    );

    sendConsoleLog(
      `Import complete: ${result.papersImported} papers, ${result.pdfsImported} PDFs, ${result.annotationsImported} annotations`,
      'success'
    );

    return { success: true, ...result };
  } catch (error) {
    console.error('Import failed:', error);
    sendConsoleLog(`Import failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('share-file-native', async (event, filePath, title) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'File not found' };
  }

  // On macOS, use native share sheet via Swift helper
  if (process.platform === 'darwin') {
    // Path to the Swift share helper (bundled with the app)
    let helperPath;
    if (app.isPackaged) {
      // In packaged app, helper is in Resources/native/
      helperPath = path.join(process.resourcesPath, 'native', 'ShareHelper');
    } else {
      // In development, helper is in project root
      helperPath = path.join(__dirname, 'native', 'ShareHelper');
    }

    // Check if helper exists
    if (!fs.existsSync(helperPath)) {
      // Fallback to Finder if helper not available
      sendConsoleLog('Share helper not found, using Finder fallback', 'warn');
      shell.showItemInFolder(filePath);
      return { success: true, method: 'finder' };
    }

    return new Promise((resolve) => {
      const child = spawn(helperPath, [filePath]);
      let output = '';
      let errorOutput = '';

      child.stdout.on('data', (data) => { output += data.toString(); });
      child.stderr.on('data', (data) => { errorOutput += data.toString(); });

      child.on('close', (code) => {
        if (output.includes('SUCCESS')) {
          sendConsoleLog('File shared successfully', 'success');
          resolve({ success: true, method: 'native-picker' });
        } else if (output.includes('CANCELLED')) {
          resolve({ success: true, canceled: true });
        } else if (output.includes('TIMEOUT')) {
          resolve({ success: false, error: 'Share timed out' });
        } else {
          sendConsoleLog(`Share helper error: ${errorOutput || output}`, 'error');
          resolve({ success: false, error: errorOutput || output || 'Unknown error' });
        }
      });

      child.on('error', (err) => {
        sendConsoleLog(`Failed to launch share helper: ${err.message}`, 'error');
        // Fallback to Finder
        shell.showItemInFolder(filePath);
        resolve({ success: true, method: 'finder' });
      });
    });
  }

  return { success: false, error: 'Not supported on this platform' };
});

ipcMain.handle('compose-email', async (event, { to, subject, body, attachmentPath }) => {
  // Encode for mailto URL
  const encodedSubject = encodeURIComponent(subject || '');
  const encodedBody = encodeURIComponent(body || '');
  const encodedTo = encodeURIComponent(to || '');

  const mailtoUrl = `mailto:${encodedTo}?subject=${encodedSubject}&body=${encodedBody}`;

  // Show the file in Finder for easy attachment
  if (attachmentPath && fs.existsSync(attachmentPath)) {
    shell.showItemInFolder(attachmentPath);
  }

  // Open mail client
  shell.openExternal(mailtoUrl);

  return { success: true };
});

// ===== Collections IPC Handlers =====

ipcMain.handle('get-collections', () => {
  if (!dbInitialized) return [];
  return database.getCollections();
});

ipcMain.handle('create-collection', (event, name, parentId, isSmart, query) => {
  if (!dbInitialized) return null;
  return database.createCollection(name, parentId, isSmart, query);
});

ipcMain.handle('delete-collection', (event, collectionId) => {
  if (!dbInitialized) return false;
  database.deleteCollection(collectionId);
  return true;
});

ipcMain.handle('add-paper-to-collection', (event, paperId, collectionId) => {
  if (!dbInitialized) return false;
  database.addPaperToCollection(paperId, collectionId);
  return true;
});

ipcMain.handle('remove-paper-from-collection', (event, paperId, collectionId) => {
  if (!dbInitialized) return false;
  database.removePaperFromCollection(paperId, collectionId);
  return true;
});

ipcMain.handle('get-papers-in-collection', (event, collectionId) => {
  if (!dbInitialized) return [];

  // Check if this is a smart collection
  const collection = database.getCollection(collectionId);
  if (collection && collection.is_smart) {
    const libraryPath = store.get('libraryPath');
    return database.getPapersInSmartCollection(collectionId, libraryPath);
  }

  return database.getPapersInCollection(collectionId);
});

// ===== LLM IPC Handlers =====

// Initialize or get Ollama service
function getOllamaService() {
  if (!ollamaService) {
    const config = store.get('llmConfig');
    const ollamaConfig = config.ollama || {
      endpoint: config.endpoint || 'http://127.0.0.1:11434',
      model: config.model || 'qwen3:30b',
      embeddingModel: config.embeddingModel || 'nomic-embed-text'
    };
    ollamaService = new OllamaService(ollamaConfig);
  }
  return ollamaService;
}

// Initialize or get Cloud LLM service for a specific provider
async function getCloudService(provider) {
  const config = store.get('llmConfig');
  const providerConfig = config[provider] || {};
  const apiKey = await getApiKey(provider);

  if (!cloudService || cloudService.provider !== provider) {
    cloudService = new CloudLLMService({
      provider,
      apiKey,
      model: providerConfig.model || CLOUD_PROVIDERS[provider]?.defaultModel
    });
  } else {
    cloudService.setConfig({
      provider,
      apiKey,
      model: providerConfig.model
    });
  }

  return cloudService;
}

// Get the active LLM service based on configuration
async function getActiveLlmService(overrideProvider = null) {
  const config = store.get('llmConfig');
  const provider = overrideProvider || config.activeProvider || 'ollama';

  if (provider === 'ollama') {
    return getOllamaService();
  } else {
    return await getCloudService(provider);
  }
}

// Legacy function for backward compatibility
function getLlmService() {
  if (!llmService) {
    llmService = getOllamaService();
  }
  return llmService;
}

// Get all available providers with their status
async function getAllProviders() {
  const config = store.get('llmConfig');
  const providers = [];

  // Ollama
  const ollamaConfig = config.ollama || {};
  let ollamaStatus = { connected: false };
  try {
    const ollama = getOllamaService();
    ollamaStatus = await ollama.checkConnection();
  } catch (e) {
    ollamaStatus = { connected: false, error: e.message };
  }

  providers.push({
    id: 'ollama',
    name: 'Ollama (Local)',
    type: 'local',
    configured: true, // Ollama doesn't need API key
    connected: ollamaStatus.connected,
    error: ollamaStatus.error,
    config: {
      endpoint: ollamaConfig.endpoint || 'http://127.0.0.1:11434',
      model: ollamaConfig.model,
      embeddingModel: ollamaConfig.embeddingModel
    }
  });

  // Cloud providers
  for (const [providerId, providerInfo] of Object.entries(CLOUD_PROVIDERS)) {
    const apiKey = await getApiKey(providerId);
    const providerConfig = config[providerId] || {};

    providers.push({
      id: providerId,
      name: providerInfo.name,
      type: 'cloud',
      configured: !!apiKey,
      hasApiKey: !!apiKey,
      config: {
        model: providerConfig.model || providerInfo.defaultModel
      },
      models: providerInfo.models,
      defaultModel: providerInfo.defaultModel
    });
  }

  return providers;
}

ipcMain.handle('get-llm-config', () => {
  return store.get('llmConfig');
});

ipcMain.handle('set-llm-config', async (event, config) => {
  store.set('llmConfig', config);
  // Reset services to pick up new config
  ollamaService = null;
  cloudService = null;
  llmService = null;
  return { success: true };
});

// New handler for API key management
ipcMain.handle('get-api-key', async (event, provider) => {
  const key = await getApiKey(provider);
  return key ? '***configured***' : null; // Don't send actual key to renderer
});

ipcMain.handle('set-api-key', async (event, provider, key) => {
  await setApiKey(provider, key);
  cloudService = null; // Reset to pick up new key
  return { success: true };
});

ipcMain.handle('delete-api-key', async (event, provider) => {
  await deleteApiKey(provider);
  cloudService = null;
  return { success: true };
});

// Get all providers with status
ipcMain.handle('get-all-providers', async () => {
  return await getAllProviders();
});

// Test connection for a specific provider
ipcMain.handle('test-provider-connection', async (event, provider) => {
  try {
    if (provider === 'ollama') {
      const ollama = getOllamaService();
      return await ollama.checkConnection();
    } else {
      const service = await getCloudService(provider);
      if (!service.isConfigured()) {
        return { success: false, error: 'API key not configured' };
      }
      return await service.testConnection();
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get available models for a provider
ipcMain.handle('get-provider-models', async (event, provider) => {
  if (provider === 'ollama') {
    const ollama = getOllamaService();
    return await ollama.listModels();
  } else {
    return CLOUD_PROVIDERS[provider]?.models || [];
  }
});

ipcMain.handle('check-llm-connection', async () => {
  const config = store.get('llmConfig');
  const provider = config.activeProvider || 'ollama';

  if (provider === 'ollama') {
    const service = getOllamaService();
    return await service.checkConnection();
  } else {
    try {
      const service = await getCloudService(provider);
      if (!service.isConfigured()) {
        return { connected: false, error: 'API key not configured' };
      }
      const result = await service.testConnection();
      return { connected: result.success, error: result.error };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }
});

ipcMain.handle('list-llm-models', async () => {
  // Always return Ollama models - this is used for the Ollama model dropdowns
  const service = getOllamaService();
  return await service.listModels();
});

// Get all available models across all configured providers
ipcMain.handle('get-all-models', async () => {
  const config = store.get('llmConfig');
  const allModels = [];

  // Ollama models
  try {
    const ollama = getOllamaService();
    const connectionCheck = await ollama.checkConnection();
    if (connectionCheck.connected) {
      const models = await ollama.listModels();
      allModels.push({
        provider: 'ollama',
        providerName: 'Ollama (Local)',
        connected: true,
        models: models.map(m => ({
          id: `ollama:${m.name}`,
          name: m.name,
          provider: 'ollama'
        }))
      });
    } else {
      allModels.push({
        provider: 'ollama',
        providerName: 'Ollama (Local)',
        connected: false,
        error: connectionCheck.error,
        models: []
      });
    }
  } catch (e) {
    allModels.push({
      provider: 'ollama',
      providerName: 'Ollama (Local)',
      connected: false,
      error: e.message,
      models: []
    });
  }

  // Cloud providers
  for (const [providerId, providerInfo] of Object.entries(CLOUD_PROVIDERS)) {
    const apiKey = await getApiKey(providerId);
    if (apiKey) {
      allModels.push({
        provider: providerId,
        providerName: providerInfo.name,
        connected: true,
        models: providerInfo.models.map(m => ({
          id: `${providerId}:${m.id}`,
          name: m.name,
          provider: providerId
        }))
      });
    }
  }

  return allModels;
});

// Get custom summary prompt
ipcMain.handle('get-summary-prompt', () => {
  const config = store.get('llmConfig');
  return config.summaryPrompt || PROMPTS.summarize.system;
});

// Set custom summary prompt
ipcMain.handle('set-summary-prompt', async (event, prompt) => {
  const config = store.get('llmConfig');
  config.summaryPrompt = prompt;
  store.set('llmConfig', config);
  return { success: true };
});

// Reset summary prompt to default
ipcMain.handle('reset-summary-prompt', async () => {
  const config = store.get('llmConfig');
  config.summaryPrompt = null;
  store.set('llmConfig', config);
  return { success: true, defaultPrompt: PROMPTS.summarize.system };
});

// Default prompts for natural language to search query translation (per plugin)
const DEFAULT_NL_PROMPTS = {
  ads: `You translate a user's natural-language request about scholarly literature into one ADS search query string. Use ADS field syntax and Boolean logic.

IMPORTANT: "recent papers" or "recent" ALWAYS means year:2025- (current year onward).

Identify:
- Topics/keywords → unfielded or title: / abstract: terms.
- Authors → author:"Last, F" (multiple authors combined with AND if all required, OR if alternatives).
- Years or time spans → year:YYYY or year:YYYY-YYYY. "Recent" means year:2025-
- Journals/venues → bibstem: or pub: when clearly specified.
- Constraints like "refereed", "review articles", "with data", etc. → appropriate filter fields (e.g. property:refereed).

Build a single Boolean expression using:
- Explicit AND, OR, NOT.
- Parentheses when mixing AND and OR.
- Quoted phrases for multi-word concepts, optionally with proximity (e.g. abs:"dark matter halo"~3 if proximity is implied).

Prefer precise fields when the user's intent is clear; otherwise let ADS use unfielded search.
Keep the query as short as possible while preserving the constraints.

Output only the final ADS query string, no explanation.`,

  arxiv: `You translate a user's natural-language request about scholarly literature into one arXiv search query string. Use arXiv API field syntax and Boolean logic.

arXiv Field Prefixes:
- ti: (title)
- au: (author - just last name works best)
- abs: (abstract)
- cat: (category, e.g. cs.AI, astro-ph.GA, hep-th, math.AG)
- all: (all fields)

Boolean operators (MUST be uppercase):
- AND (both terms required)
- OR (either term)
- ANDNOT (exclude term)

Common arXiv categories:
- Physics: astro-ph, hep-th, hep-ph, hep-ex, gr-qc, quant-ph, cond-mat, nucl-th
- Astrophysics subcategories: astro-ph.GA (galaxies), astro-ph.CO (cosmology), astro-ph.SR (stellar), astro-ph.HE (high energy), astro-ph.EP (exoplanets)
- Computer Science: cs.AI, cs.LG, cs.CL, cs.CV, cs.NE, cs.RO
- Math: math.AG, math.NT, math.CO

Examples:
- "papers on neural networks" → ti:"neural network" OR abs:"neural network"
- "LeCun's papers on deep learning" → au:lecun AND (ti:"deep learning" OR abs:"deep learning")
- "cosmology papers" → cat:astro-ph.CO
- "machine learning for astronomy" → (ti:"machine learning" OR abs:"machine learning") AND cat:astro-ph

Keep the query concise. Use quotes for multi-word phrases.
Output only the final arXiv query string, no explanation.`,

  inspire: `You translate a user's natural-language request about scholarly literature into one INSPIRE HEP search query string. Use INSPIRE (SPIRES-style) syntax.

INSPIRE Query Syntax:
- Author: a <surname> or au <surname>
  Examples: a witten, a Maldacena
- Title words: t "<phrase>" or ti "<phrase>"
  Examples: t "string theory", t higgs
- Abstract: ab <terms>
  Examples: ab supersymmetry, ab "dark matter"
- arXiv ID: eprint <id>
  Examples: eprint 2301.00001
- DOI: doi <value>
- Journal: j "<abbreviated name>"
  Examples: j "Phys.Rev.D", j "JHEP"
- Year: date <year> or date <start>-><end>
  Examples: date 2023, date 2020->2024
- Citations: topcite <N>+ (at least N citations)
  Examples: topcite 100+, topcite 1000+

Boolean operators (lowercase):
- and (both terms required)
- or (either term)
- not (exclude term)

Examples:
- "papers by Witten on string theory" → a witten and t "string theory"
- "supersymmetry papers from 2023 with 100+ citations" → ab supersymmetry and date 2023 and topcite 100+
- "ATLAS collaboration Higgs papers" → a ATLAS and t higgs
- "highly cited papers on dark matter" → ab "dark matter" and topcite 500+
- "recent QCD papers in Physical Review" → ab qcd and date 2024-> and j "Phys.Rev."

Keep the query concise. Use quotes for multi-word phrases.
Output only the final INSPIRE query string, no explanation.`
};

// Backwards compatibility alias
const DEFAULT_ADS_NL_PROMPT = DEFAULT_NL_PROMPTS.ads;

// Handler: Translate natural language to ADS query
ipcMain.handle('llm-translate-to-ads', async (event, text, systemPrompt) => {
  try {
    const config = store.get('llmConfig');
    const prompt = systemPrompt || config.adsNLPrompt || DEFAULT_ADS_NL_PROMPT;

    // Get active service
    const service = await getActiveLlmService();

    // Check connection
    const provider = config.activeProvider || 'ollama';
    if (provider === 'ollama') {
      const connectionCheck = await service.checkConnection();
      if (!connectionCheck.connected) {
        return { success: false, error: connectionCheck.error || 'Ollama not connected' };
      }
    } else if (!service.isConfigured()) {
      return { success: false, error: `${provider} API key not configured` };
    }

    // Generate the ADS query (disable thinking mode for fast response)
    const response = await service.generate(text, {
      systemPrompt: prompt,
      temperature: 0.3,
      maxTokens: 256,
      noThink: true
    });

    // Extract just the query (strip any explanation the LLM might add)
    const query = response.trim().split('\n')[0].trim();

    return { success: true, query };
  } catch (error) {
    console.error('Error translating NL to ADS:', error);
    return { success: false, error: error.message };
  }
});

// Handler: Get ADS NL prompt (legacy, redirects to plugin-specific)
ipcMain.handle('get-ads-nl-prompt', async () => {
  const config = store.get('llmConfig') || {};
  return config.adsNLPrompt || DEFAULT_NL_PROMPTS.ads;
});

// Handler: Set ADS NL prompt (legacy, redirects to plugin-specific)
ipcMain.handle('set-ads-nl-prompt', async (event, prompt) => {
  const config = store.get('llmConfig') || {};
  config.adsNLPrompt = prompt;
  store.set('llmConfig', config);
  return { success: true };
});

// Handler: Reset ADS NL prompt (legacy, redirects to plugin-specific)
ipcMain.handle('reset-ads-nl-prompt', async () => {
  const config = store.get('llmConfig') || {};
  config.adsNLPrompt = null;
  store.set('llmConfig', config);
  return { success: true, defaultPrompt: DEFAULT_NL_PROMPTS.ads };
});

// Handler: Get NL prompt for a specific plugin
ipcMain.handle('get-nl-prompt', async (event, pluginId) => {
  const config = store.get('llmConfig') || {};
  const nlPrompts = config.nlPrompts || {};

  // Plugin-specific custom prompt takes priority
  if (nlPrompts[pluginId]) {
    return nlPrompts[pluginId];
  }

  // Legacy fallback for ADS
  if (pluginId === 'ads' && config.adsNLPrompt) {
    return config.adsNLPrompt;
  }

  // Return default for plugin
  return DEFAULT_NL_PROMPTS[pluginId] || DEFAULT_NL_PROMPTS.ads;
});

// Handler: Set NL prompt for a specific plugin
ipcMain.handle('set-nl-prompt', async (event, { pluginId, prompt }) => {
  const config = store.get('llmConfig') || {};
  if (!config.nlPrompts) config.nlPrompts = {};
  config.nlPrompts[pluginId] = prompt;
  store.set('llmConfig', config);
  return { success: true };
});

// Handler: Reset NL prompt for a specific plugin
ipcMain.handle('reset-nl-prompt', async (event, pluginId) => {
  const config = store.get('llmConfig') || {};
  if (config.nlPrompts && config.nlPrompts[pluginId]) {
    delete config.nlPrompts[pluginId];
    store.set('llmConfig', config);
  }
  return { success: true, defaultPrompt: DEFAULT_NL_PROMPTS[pluginId] || DEFAULT_NL_PROMPTS.ads };
});

ipcMain.handle('llm-summarize', async (event, paperId, options = {}) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const paper = database.getPaper(paperId);
  if (!paper) return { success: false, error: 'Paper not found' };

  // Check cache first
  const cached = database.getSummary(paperId);
  if (cached) {
    return { success: true, data: cached, cached: true };
  }

  // If only checking cache, return early
  if (options.checkCacheOnly) {
    return { success: false, cached: false };
  }

  // Get provider and model from config - activeProvider is the single source of truth
  const config = store.get('llmConfig');
  const provider = options.provider || config.activeProvider || 'ollama';
  const providerConfig = config[provider] || {};
  const modelName = options.model || providerConfig.model;

  // Get the appropriate service
  let service;
  let modelId;
  if (provider === 'ollama') {
    service = getOllamaService();
    if (modelName) service.model = modelName;
    modelId = service.model;
  } else {
    service = await getCloudService(provider);
    if (modelName) service.model = modelName;
    modelId = service.model;
  }

  // Check connection
  if (provider === 'ollama') {
    const connectionCheck = await service.checkConnection();
    if (!connectionCheck.connected) {
      return { success: false, error: connectionCheck.error || 'Ollama not connected' };
    }
  } else if (!service.isConfigured()) {
    return { success: false, error: `${provider} API key not configured` };
  }

  // Get paper text content
  let fullText = null;
  const libraryPath = store.get('libraryPath');
  if (paper.text_path && libraryPath) {
    const textFile = path.join(libraryPath, paper.text_path);
    if (fs.existsSync(textFile)) {
      fullText = fs.readFileSync(textFile, 'utf-8');
    }
  }

  // Get custom or default system prompt
  const systemPrompt = config.summaryPrompt || PROMPTS.summarize.system;

  // Build prompt
  const prompt = PROMPTS.summarize.user(paper.title, paper.abstract, fullText);

  try {
    // Stream chunks to renderer
    let fullResponse = '';

    // Create onChunk handler that works for both Ollama and Cloud services
    const onChunk = (chunk) => {
      // Ollama format: { response: "text", done: bool }
      // Cloud format: { text: "text", fullText: "all text" }
      const text = chunk.response || chunk.text || '';
      if (text) {
        fullResponse += text;
        mainWindow.webContents.send('llm-stream', {
          type: 'summarize',
          paperId,
          chunk: text,
          done: chunk.done || false
        });
      }
    };

    const response = await service.generate(prompt, {
      systemPrompt,
      onChunk,
      temperature: 0.3,
      maxTokens: 1024
    });

    // Parse and cache result
    const parsed = parseSummaryResponse(fullResponse || response);
    database.saveSummary(paperId, parsed.summary, parsed.keyPoints, `${provider}:${modelId}`);

    return { success: true, data: parsed };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('llm-ask', async (event, paperId, question, options = {}) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const paper = database.getPaper(paperId);
  if (!paper) return { success: false, error: 'Paper not found' };

  // Get provider and model from config - activeProvider is the single source of truth
  const config = store.get('llmConfig');
  const provider = options.provider || config.activeProvider || 'ollama';
  const providerConfig = config[provider] || {};
  const modelName = options.model || providerConfig.model;

  // Get the appropriate service
  let service;
  let modelId;
  if (provider === 'ollama') {
    service = getOllamaService();
    if (modelName) service.model = modelName;
    modelId = service.model;
  } else {
    service = await getCloudService(provider);
    if (modelName) service.model = modelName;
    modelId = service.model;
  }

  // Check connection
  if (provider === 'ollama') {
    const connectionCheck = await service.checkConnection();
    if (!connectionCheck.connected) {
      return { success: false, error: connectionCheck.error || 'Ollama not connected' };
    }
  } else if (!service.isConfigured()) {
    return { success: false, error: `${provider} API key not configured` };
  }

  // Get paper text content
  let paperContent = paper.abstract || '';
  const libraryPath = store.get('libraryPath');
  if (paper.text_path && libraryPath) {
    const textFile = path.join(libraryPath, paper.text_path);
    if (fs.existsSync(textFile)) {
      paperContent = fs.readFileSync(textFile, 'utf-8');
    }
  }

  // Build prompt
  const prompt = PROMPTS.qa.user(question, paperContent, paper.title);

  try {
    let fullResponse = '';

    // Create onChunk handler that works for both Ollama and Cloud services
    const onChunk = (chunk) => {
      // Ollama format: { response: "text", done: bool }
      // Cloud format: { text: "text", fullText: "all text" }
      const text = chunk.response || chunk.text || '';
      if (text) {
        fullResponse += text;
        mainWindow.webContents.send('llm-stream', {
          type: 'qa',
          paperId,
          chunk: text,
          done: false
        });
      }
      // Send done signal separately to trigger markdown rendering
      if (chunk.done) {
        mainWindow.webContents.send('llm-stream', {
          type: 'qa',
          paperId,
          chunk: '',
          done: true
        });
      }
    };

    const response = await service.generate(prompt, {
      systemPrompt: PROMPTS.qa.system,
      onChunk,
      temperature: 0.5,
      maxTokens: 1024
    });

    const answer = fullResponse || response;

    // Cache the Q&A
    database.saveQA(paperId, question, answer, null, `${provider}:${modelId}`);

    return { success: true, data: { question, answer } };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('llm-explain', async (event, text, paperId = null) => {
  console.log('llm-explain called with text:', text?.substring(0, 50));
  const service = getLlmService();
  const connectionCheck = await service.checkConnection();
  if (!connectionCheck.connected) {
    console.log('Ollama not connected:', connectionCheck.error);
    return { success: false, error: connectionCheck.error || 'Ollama not connected' };
  }

  // Get optional context from paper
  let context = null;
  if (paperId && dbInitialized) {
    const paper = database.getPaper(paperId);
    if (paper) {
      context = paper.abstract;
    }
  }

  const prompt = PROMPTS.explain.user(text, context);
  console.log('Explain prompt:', prompt.substring(0, 100));

  try {
    let fullResponse = '';
    const response = await service.generate(prompt, {
      systemPrompt: PROMPTS.explain.system,
      onChunk: (chunk) => {
        // Send content chunks
        if (chunk.response) {
          fullResponse += chunk.response;
          mainWindow.webContents.send('llm-stream', {
            type: 'explain',
            chunk: chunk.response,
            done: false
          });
        }
        // Send done signal separately to trigger markdown rendering
        if (chunk.done) {
          mainWindow.webContents.send('llm-stream', {
            type: 'explain',
            chunk: '',
            done: true
          });
        }
      },
      temperature: 0.5,
      maxTokens: 2048  // Increased for models with extended thinking
    });

    console.log('Explain complete, response length:', (fullResponse || response)?.length);
    return { success: true, data: { explanation: fullResponse || response } };
  } catch (error) {
    console.error('llm-explain error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('llm-generate-embeddings', async (event, paperId) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const paper = database.getPaper(paperId);
  if (!paper) return { success: false, error: 'Paper not found' };

  // Check if already has embeddings
  if (database.hasEmbeddings(paperId)) {
    return { success: true, cached: true };
  }

  const service = getLlmService();
  const connectionCheck = await service.checkConnection();
  if (!connectionCheck.connected) {
    return { success: false, error: connectionCheck.error || 'Ollama not connected' };
  }

  // Get paper text content
  let textContent = paper.abstract || paper.title || '';
  const libraryPath = store.get('libraryPath');
  if (paper.text_path && libraryPath) {
    const textFile = path.join(libraryPath, paper.text_path);
    if (fs.existsSync(textFile)) {
      textContent = fs.readFileSync(textFile, 'utf-8');
    }
  }

  if (!textContent) {
    return { success: false, error: 'No text content available' };
  }

  try {
    // Chunk the text
    const chunks = chunkText(textContent, 2000, 100);
    const embeddings = [];

    for (let i = 0; i < chunks.length; i++) {
      mainWindow.webContents.send('llm-stream', {
        type: 'embedding',
        paperId,
        progress: { current: i + 1, total: chunks.length }
      });

      const embedding = await service.embed(chunks[i].text);
      embeddings.push({
        chunkIndex: i,
        chunkText: chunks[i].text.substring(0, 500), // Store preview
        embedding
      });
    }

    // Save to database
    database.saveEmbeddings(paperId, embeddings);

    return { success: true, chunksProcessed: chunks.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('llm-get-unindexed-papers', async () => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };
  const ids = database.getUnindexedPaperIds();
  return { success: true, paperIds: ids };
});

// Extract metadata from paper using LLM
ipcMain.handle('llm-extract-metadata', async (event, paperId) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const paper = database.getPaper(paperId);
  if (!paper) return { success: false, error: 'Paper not found' };

  const libraryPath = store.get('libraryPath');

  // Get text content
  let textContent = '';
  if (paper.text_path && libraryPath) {
    const textFile = path.join(libraryPath, paper.text_path);
    if (fs.existsSync(textFile)) {
      textContent = fs.readFileSync(textFile, 'utf-8');
    }
  }

  if (!textContent) {
    // Fall back to title/abstract
    return {
      success: true,
      metadata: {
        title: paper.title,
        firstAuthor: paper.authors?.[0]?.split(',')[0],
        year: paper.year
      },
      source: 'database'
    };
  }

  // Try LLM extraction
  const service = getLlmService();
  const connectionCheck = await service.checkConnection().catch(() => ({ connected: false }));

  if (connectionCheck.connected) {
    try {
      // Debug: show what text we're sending (first 500 chars)
      console.log('=== LLM METADATA EXTRACTION ===');
      console.log('Text sample (first 500 chars):');
      console.log(textContent.substring(0, 500));
      console.log('---');

      const llmResponse = await service.generate(
        PROMPTS.extractMetadata.user(textContent),
        {
          systemPrompt: PROMPTS.extractMetadata.system,
          temperature: 0.1,
          maxTokens: 500,
          noThink: true  // Disable thinking mode for faster extraction
        }
      );

      console.log('LLM raw response:');
      console.log(llmResponse);
      console.log('---');

      const llmMeta = parseMetadataResponse(llmResponse);

      console.log('Parsed metadata:');
      console.log(JSON.stringify(llmMeta, null, 2));
      console.log('=== END EXTRACTION ===');

      return { success: true, metadata: llmMeta, source: 'llm' };
    } catch (err) {
      console.error('LLM extraction failed:', err.message);
    }
  }

  // Fall back to regex extraction
  const pdfMeta = pdfImport.extractMetadataFromPDF(textContent);
  console.log('Regex fallback metadata:', JSON.stringify(pdfMeta, null, 2));
  return { success: true, metadata: pdfMeta, source: 'regex' };
});

// Apply ADS metadata to a paper
ipcMain.handle('apply-ads-metadata', async (event, paperId, adsDoc) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token' };

  try {
    const metadata = adsApi.adsToPaper(adsDoc);

    // Get BibTeX
    let bibtexStr = null;
    try {
      bibtexStr = await adsApi.exportBibtex(token, adsDoc.bibcode);
    } catch (e) {
      console.error('Failed to get BibTeX:', e.message);
    }

    // Update paper
    database.updatePaper(paperId, {
      ...metadata,
      bibtex: bibtexStr
    });

    // Update master.bib
    const libraryPath = store.get('libraryPath');
    const allPapers = database.getAllPapers();
    bibtex.updateMasterBib(libraryPath, allPapers);

    return { success: true, metadata };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Full import of a paper from ADS (downloads PDF, creates new entry)
ipcMain.handle('import-single-from-ads', async (event, adsDoc) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const token = store.get('adsToken');
  const libraryPath = store.get('libraryPath');

  if (!token) return { success: false, error: 'No ADS API token' };
  if (!libraryPath) return { success: false, error: 'No library selected' };

  try {
    // Convert ADS doc to paper format
    const paper = adsApi.adsToPaper(adsDoc);
    sendConsoleLog(`Importing: ${paper.bibcode} - "${paper.title?.substring(0, 40)}..."`, 'info');

    // Fetch available PDF sources (metadata only - no download)
    let availableSources = [];
    if (paper.bibcode) {
      try {
        sendConsoleLog(`[${paper.bibcode}] Fetching PDF sources...`, 'info');
        const esources = await adsApi.getEsources(token, paper.bibcode);
        availableSources = (esources || [])
          .filter(e => e && ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF'].some(t => (e.link_type || e.type || '').includes(t)))
          .map(e => {
            const linkType = (e.link_type || e.type || '').split('|').pop();
            if (linkType === 'EPRINT_PDF') return 'arxiv';
            if (linkType === 'PUB_PDF') return 'publisher';
            if (linkType === 'ADS_PDF') return 'ads_scan';
            return null;
          })
          .filter(Boolean);
        if (availableSources.length > 0) {
          sendConsoleLog(`[${paper.bibcode}] Available sources: ${availableSources.join(', ')}`, 'success');
        }
      } catch (e) {
        // Esources fetch failed, not critical
      }
    }

    // Get BibTeX
    let bibtexStr = null;
    if (adsDoc.bibcode) {
      try {
        bibtexStr = await adsApi.exportBibtex(token, adsDoc.bibcode);
        sendConsoleLog(`[${paper.bibcode}] Got BibTeX`, 'success');
      } catch (e) {
        sendConsoleLog(`[${paper.bibcode}] BibTeX fetch failed`, 'warn');
      }
    }

    // Add paper to database (metadata only - no PDF)
    const paperId = database.addPaper({
      bibcode: paper.bibcode,
      doi: paper.doi,
      arxiv_id: paper.arxiv_id,
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      journal: paper.journal,
      abstract: paper.abstract,
      keywords: paper.keywords,
      pdf_path: null,
      text_path: null,
      bibtex: bibtexStr,
      available_sources: availableSources.length > 0 ? JSON.stringify(availableSources) : null
    });

    // Update master.bib
    const allPapers = database.getAllPapers();
    bibtex.updateMasterBib(libraryPath, allPapers);

    sendConsoleLog(`[${paper.bibcode}] ✓ Import complete`, 'success');
    return {
      success: true,
      paperId,
      hasPdf: false,
      availableSources: availableSources
    };
  } catch (error) {
    sendConsoleLog(`Import failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('llm-semantic-search', async (event, query, limit = 10) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const service = getLlmService();
  const connectionCheck = await service.checkConnection();
  if (!connectionCheck.connected) {
    return { success: false, error: connectionCheck.error || 'Ollama not connected' };
  }

  try {
    // Generate query embedding
    const queryEmbedding = await service.embed(query);
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return { success: false, error: 'Failed to generate query embedding' };
    }

    // Get all embeddings from database
    const allEmbeddings = database.getAllEmbeddings();
    if (allEmbeddings.length === 0) {
      return { success: true, data: [], message: 'No papers have been indexed yet' };
    }

    // Calculate similarity scores
    const scores = allEmbeddings.map(item => ({
      paperId: item.paper_id,
      chunkText: item.chunk_text,
      similarity: cosineSimilarity(queryEmbedding, item.embedding)
    }));

    // Sort by similarity and get top results
    scores.sort((a, b) => b.similarity - a.similarity);
    const topResults = scores.slice(0, limit);

    // Group by paper and get paper details
    const paperScores = new Map();
    for (const result of topResults) {
      if (!paperScores.has(result.paperId)) {
        const paper = database.getPaper(result.paperId);
        if (paper) {
          paperScores.set(result.paperId, {
            paper,
            score: result.similarity,
            matchedChunk: result.chunkText
          });
        }
      }
    }

    const results = Array.from(paperScores.values())
      .sort((a, b) => b.score - a.score);

    return { success: true, data: results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('llm-get-qa-history', (event, paperId) => {
  if (!dbInitialized) return [];
  return database.getQAHistory(paperId);
});

ipcMain.handle('llm-clear-qa-history', (event, paperId) => {
  if (!dbInitialized) return false;
  database.clearQAHistory(paperId);
  return true;
});

ipcMain.handle('llm-delete-summary', (event, paperId) => {
  if (!dbInitialized) return false;
  database.deleteSummary(paperId);
  return true;
});

// ===== Annotations IPC Handlers =====

ipcMain.handle('get-annotations', (event, paperId) => {
  if (!dbInitialized) return [];
  return database.getAnnotations(paperId);
});

ipcMain.handle('get-annotation-counts-by-source', (event, paperId) => {
  if (!dbInitialized) return {};
  return database.getAnnotationCountsBySource(paperId);
});

// Native file drag for dragging files to Finder, Mail, etc.
ipcMain.on('start-file-drag', (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    console.error('Cannot drag file - path not found:', filePath);
    return;
  }

  // Use Electron's native drag API
  event.sender.startDrag({
    file: filePath,
    icon: path.join(__dirname, 'assets', 'icon.png') // Use app icon as drag icon
  });
});

// Open file with system default application (Preview.app for PDFs, etc.)
ipcMain.handle('open-path', async (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'File not found' };
  }

  try {
    const result = await shell.openPath(filePath);
    if (result) {
      // openPath returns an error string if failed, empty string on success
      return { success: false, error: result };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('create-annotation', (event, paperId, data) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };
  try {
    const annotation = database.createAnnotation(paperId, data);
    return { success: true, annotation };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update-annotation', (event, id, data) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };
  try {
    database.updateAnnotation(id, data);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-annotation', (event, id) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };
  try {
    database.deleteAnnotation(id);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// PDF Page Rotations
ipcMain.handle('get-page-rotations', (event, paperId, pdfSource) => {
  if (!dbInitialized) return {};
  return database.getPageRotations(paperId, pdfSource);
});

ipcMain.handle('set-page-rotation', (event, paperId, pageNumber, rotation, pdfSource) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };
  try {
    database.setPageRotation(paperId, pageNumber, rotation, pdfSource);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('export-annotations', async (event, paperId) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const paper = database.getPaper(paperId);
  if (!paper) return { success: false, error: 'Paper not found' };

  const annotations = database.getAnnotations(paperId);
  if (!annotations || annotations.length === 0) {
    return { success: false, error: 'No annotations to export' };
  }

  // Generate Markdown content
  const markdown = formatAnnotationsAsMarkdown(paper, annotations);

  // Show save dialog
  const defaultName = `${paper.bibcode || 'annotations'}_notes.md`;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Annotations',
    defaultPath: defaultName,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }

  try {
    fs.writeFileSync(result.filePath, markdown, 'utf-8');
    sendConsoleLog(`Exported ${annotations.length} annotations to ${result.filePath}`, 'success');
    return { success: true, path: result.filePath, count: annotations.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Format annotations as Markdown document
 */
function formatAnnotationsAsMarkdown(paper, annotations) {
  const lines = [];

  // Header
  lines.push(`# Annotations: ${paper.title || 'Untitled'}`);
  lines.push('');
  if (paper.authors) lines.push(`**Authors**: ${paper.authors}`);
  if (paper.bibcode) lines.push(`**Bibcode**: ${paper.bibcode}`);
  if (paper.year) lines.push(`**Year**: ${paper.year}`);
  lines.push(`**Exported**: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group annotations by page
  const byPage = {};
  for (const ann of annotations) {
    const page = ann.page_number || 0;
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push(ann);
  }

  // Sort pages
  const pages = Object.keys(byPage).map(Number).sort((a, b) => a - b);

  for (const page of pages) {
    lines.push(`## Page ${page}`);
    lines.push('');

    const pageAnns = byPage[page];
    for (let i = 0; i < pageAnns.length; i++) {
      const ann = pageAnns[i];
      const colorName = getColorName(ann.color);

      lines.push(`### Highlight ${i + 1}${colorName ? ` (${colorName})` : ''}`);
      lines.push('');

      if (ann.selection_text) {
        lines.push(`> ${ann.selection_text.replace(/\n/g, '\n> ')}`);
        lines.push('');
      }

      if (ann.note_content) {
        lines.push('**Note:**');
        lines.push('');
        lines.push(ann.note_content);
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function getColorName(hexColor) {
  const colors = {
    '#ffeb3b': 'Yellow',
    '#a5d6a7': 'Green',
    '#90caf9': 'Blue',
    '#f48fb1': 'Pink',
    '#ffcc80': 'Orange'
  };
  return colors[hexColor?.toLowerCase()] || null;
}

// ===== Attachment IPC Handlers =====
// [LEGACY] These handlers will be removed after migration to Paper Files system.
// Use paper-files:* APIs instead.

// [LEGACY] Attach files to a paper
// Use paper-files:add instead
ipcMain.handle('attach-files', async (event, paperId, bibcode) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library path configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach Files',
    properties: ['openFile', 'multiSelections']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  const papersDir = path.join(libraryPath, 'papers');
  if (!fs.existsSync(papersDir)) {
    fs.mkdirSync(papersDir, { recursive: true });
  }

  const attachments = [];
  const sanitizedBibcode = (bibcode || `paper_${paperId}`).replace(/[^a-zA-Z0-9._-]/g, '_');

  for (const filePath of result.filePaths) {
    try {
      const originalName = path.basename(filePath);
      const ext = path.extname(originalName).toLowerCase();
      const fileType = ext.slice(1) || 'unknown'; // Remove the dot

      // Generate unique filename
      let destFilename = `${sanitizedBibcode}_ATTACHMENT_${originalName}`;
      let destPath = path.join(papersDir, destFilename);

      // Handle conflicts by adding timestamp
      if (fs.existsSync(destPath)) {
        const timestamp = Date.now();
        const baseName = path.basename(originalName, ext);
        destFilename = `${sanitizedBibcode}_ATTACHMENT_${baseName}_${timestamp}${ext}`;
        destPath = path.join(papersDir, destFilename);
      }

      // Copy file
      fs.copyFileSync(filePath, destPath);

      // Add to database
      const attachment = database.addAttachment(paperId, destFilename, originalName, fileType);
      attachments.push(attachment);

      sendConsoleLog(`Attached: ${originalName}`, 'success');
    } catch (error) {
      console.error(`Failed to attach ${filePath}:`, error);
      sendConsoleLog(`Failed to attach: ${path.basename(filePath)}`, 'error');
    }
  }

  return { success: true, attachments };
});

// ============ PAPER FILES ============
// New Paper Files Container API - manages files associated with papers

// FileManager and DownloadQueue instances (initialized after library is loaded)
let fileManager = null;
let downloadQueue = null;

// Download strategy manager (initialized with Paper Files system)
let strategyManager = null;

// Initialize Paper Files system when library is loaded
function initializePaperFilesSystem(libraryPath) {
  try {
    // Initialize FileManager
    fileManager = new FileManager(libraryPath, database);

    // Initialize download strategies with configuration
    const adsToken = store.get('adsToken');
    const proxyUrl = store.get('libraryProxyUrl');
    const pdfSourcePriority = store.get('pdfSourcePriority', ['arxiv', 'publisher', 'ads_scan']);

    const strategies = {
      arxiv: new ArxivDownloader(),
      publisher: new PublisherDownloader({ proxyUrl, adsApi, adsToken }),
      ads_scan: new AdsDownloader({ adsApi, adsToken })
    };

    strategyManager = new DownloadStrategyManager(strategies, pdfSourcePriority);

    // Initialize DownloadQueue with download function and paper lookup
    downloadQueue = new DownloadQueue({
      concurrency: 2,
      downloadFn: async (paper, sourceType, onProgress, signal) => {
        const libraryPath = store.get('libraryPath');
        if (!libraryPath) {
          return { success: false, error: 'No library path configured' };
        }

        const baseFilename = (paper.bibcode || `paper_${paper.id}`).replace(/[^a-zA-Z0-9._-]/g, '_');

        // Use system temp directory for download
        const tempPath = path.join(os.tmpdir(), `adsreader_queue_${Date.now()}.pdf`);

        // Use the strategy manager to download - it may fallback to different source
        const result = await strategyManager.downloadForPaper(paper, tempPath, sourceType, onProgress, signal);

        if (result.success && fs.existsSync(tempPath)) {
          // Use ACTUAL source from result, not the originally requested sourceType
          const actualSource = result.source || sourceType;
          const sourceMap = { 'arxiv': 'EPRINT_PDF', 'publisher': 'PUB_PDF', 'ads_scan': 'ADS_PDF' };
          const normalizedSource = sourceMap[actualSource] || actualSource.toUpperCase().replace(/-/g, '_');

          const originalName = `${baseFilename}_${normalizedSource}.pdf`;

          // Check if already exists in paper_files
          const existingFiles = database.getPaperFiles(paper.id);
          const alreadyExists = existingFiles.some(f => f.source_type === normalizedSource);

          if (!alreadyExists) {
            try {
              // Add via FileManager (computes hash, stores in content-addressed location, creates symlink)
              const fileResult = await fileManager.addFile(paper.id, tempPath, {
                role: 'pdf',
                sourceType: normalizedSource,
                originalName: originalName,
                sourceUrl: result.url || null,
                bibcode: paper.bibcode
              });
              result.path = fileResult.path;
              result.fileId = fileResult.id;
            } catch (addError) {
              console.error('Failed to add file via FileManager:', addError);
              result.success = false;
              result.error = addError.message;
            }
          } else {
            // Already exists - get existing path
            const existing = existingFiles.find(f => f.source_type === normalizedSource);
            if (existing && fileManager) {
              const existingFile = fileManager.getFile(existing.id);
              result.path = existingFile?.path || null;
            }
          }

          // Clean up temp file
          try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
        } else if (fs.existsSync(tempPath)) {
          // Clean up temp file on failure
          try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
        }

        return result;
      },
      getPaperFn: async (paperId) => {
        // Look up paper by ID (number) or bibcode (string)
        if (typeof paperId === 'number') {
          return database.getPaper(paperId);
        }
        return database.getPaperByBibcode(paperId);
      }
    });

    // Set up event forwarding to renderer
    downloadQueue.on('queued', (data) => {
      mainWindow?.webContents.send('download-queue:queued', data);
    });

    downloadQueue.on('started', (data) => {
      mainWindow?.webContents.send('download-queue:started', data);
    });

    downloadQueue.on('progress', (data) => {
      mainWindow?.webContents.send('download-queue:progress', data);
    });

    downloadQueue.on('complete', (data) => {
      mainWindow?.webContents.send('download-queue:complete', data);
    });

    downloadQueue.on('error', (data) => {
      mainWindow?.webContents.send('download-queue:error', data);
    });

    downloadQueue.on('cancelled', (data) => {
      mainWindow?.webContents.send('download-queue:cancelled', data);
    });

    sendConsoleLog('Paper Files system initialized', 'info');
  } catch (error) {
    console.error('Failed to initialize Paper Files system:', error);
    sendConsoleLog(`Paper Files initialization failed: ${error.message}`, 'error');
  }
}

ipcMain.handle('paper-files:add', async (event, paperId, filePath, options = {}) => {
  // options: { role, sourceType, originalName }
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library path configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    if (!fileManager) {
      return { success: false, error: 'Paper Files system not initialized' };
    }

    const result = await fileManager.addFile(paperId, filePath, options);
    return { success: true, file: result };
  } catch (error) {
    console.error('paper-files:add error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('paper-files:remove', async (event, fileId) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    if (!fileManager) {
      return { success: false, error: 'Paper Files system not initialized' };
    }

    // Ensure fileId is an integer
    const parsedFileId = typeof fileId === 'string' ? parseInt(fileId, 10) : fileId;
    if (isNaN(parsedFileId)) {
      return { success: false, error: `Invalid file ID: ${fileId}` };
    }

    console.log(`[paper-files:remove] Removing file ${parsedFileId}`);
    await fileManager.removeFile(parsedFileId);
    sendConsoleLog(`File removed (ID: ${parsedFileId})`, 'info');
    return { success: true };
  } catch (error) {
    console.error('paper-files:remove error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('paper-files:get', async (event, fileId) => {
  if (!dbInitialized) return null;

  try {
    if (!fileManager) {
      return null;
    }

    return fileManager.getFile(fileId);
  } catch (error) {
    console.error('paper-files:get error:', error);
    return null;
  }
});

ipcMain.handle('paper-files:list', async (event, paperId, filters = {}) => {
  // filters: { role, status }
  if (!dbInitialized) return [];

  try {
    if (!fileManager) {
      return [];
    }

    const files = await fileManager.getFilesForPaper(paperId, filters);
    console.log('[paper-files:list] paperId:', paperId, 'found:', files.length, 'files:', files.map(f => ({ id: f.id, source_type: f.source_type, file_hash: f.file_hash?.substring(0, 8) })));
    return files;
  } catch (error) {
    console.error('paper-files:list error:', error);
    return [];
  }
});

ipcMain.handle('paper-files:get-primary-pdf', async (event, paperId) => {
  if (!dbInitialized) return null;

  try {
    if (!fileManager) {
      return null;
    }

    return fileManager.getPrimaryPdf(paperId);
  } catch (error) {
    console.error('paper-files:get-primary-pdf error:', error);
    return null;
  }
});

ipcMain.handle('paper-files:set-primary-pdf', async (event, paperId, fileId) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    if (!fileManager) {
      return { success: false, error: 'Paper Files system not initialized' };
    }

    await fileManager.setPrimaryPdf(paperId, fileId);
    return { success: true };
  } catch (error) {
    console.error('paper-files:set-primary-pdf error:', error);
    return { success: false, error: error.message };
  }
});

// Rescan paper files - find PDFs on disk that aren't registered in paper_files
ipcMain.handle('paper-files:rescan', async (event, paperId) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath || !dbInitialized) {
    return { success: false, error: 'Library not initialized' };
  }

  try {
    const paper = database.getPaper(paperId);
    if (!paper) {
      return { success: false, error: 'Paper not found' };
    }

    const papersDir = path.join(libraryPath, 'papers');
    if (!fs.existsSync(papersDir)) {
      return { success: true, found: 0 };
    }

    // Get currently registered files
    const registeredFiles = database.getPaperFiles(paperId);
    const registeredSources = new Set(registeredFiles.map(f => f.source_type));

    // Check for PDFs matching this paper's bibcode
    // Source types must match what download handlers use (EPRINT_PDF, PUB_PDF, etc.)
    const baseFilename = (paper.bibcode || `paper_${paper.id}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const sourceTypes = ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF', 'ATTACHED', 'IMPORTED'];

    let found = 0;
    for (const sourceType of sourceTypes) {
      const filename = `${baseFilename}_${sourceType}.pdf`;
      const filePath = path.join(papersDir, filename);

      if (fs.existsSync(filePath) && !registeredSources.has(sourceType)) {
        const stats = fs.statSync(filePath);
        database.addPaperFile(paperId, {
          filename: filename,
          original_name: filename,
          mime_type: 'application/pdf',
          file_size: stats.size,
          file_role: 'pdf',
          source_type: sourceType,
          status: 'ready'
        });
        found++;
        sendConsoleLog(`Found unregistered PDF: ${filename}`, 'info');
      }
    }

    return { success: true, found };
  } catch (error) {
    console.error('paper-files:rescan error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('paper-files:get-path', async (event, fileId) => {
  // Get absolute path to file for PDF viewer
  if (!dbInitialized) return null;

  try {
    if (!fileManager) {
      console.log('[paper-files:get-path] No fileManager');
      return null;
    }

    const file = fileManager.getFile(fileId);
    console.log('[paper-files:get-path] fileId:', fileId, 'file:', file ? { id: file.id, path: file.path, filename: file.filename, file_hash: file.file_hash?.substring(0, 8) } : null);
    // file.path is already an absolute path from getStoragePath()
    if (!file || !file.path) return null;

    return file.path;
  } catch (error) {
    console.error('paper-files:get-path error:', error);
    return null;
  }
});

// ============ PDF SOURCE HELPERS ============
// Convenience handlers that wrap paper-files for common queries

// Get list of downloaded PDF source types for a paper
ipcMain.handle('get-downloaded-pdf-sources', async (event, paperId) => {
  if (!dbInitialized) return [];

  try {
    const files = database.getPaperFiles(paperId);
    // Return unique source_type values for PDF files
    const sources = files
      .filter(f => f.file_role === 'pdf' && f.source_type)
      .map(f => f.source_type);
    return [...new Set(sources)];
  } catch (error) {
    console.error('get-downloaded-pdf-sources error:', error);
    return [];
  }
});

// Get PDF attachments for a paper
ipcMain.handle('get-pdf-attachments', async (event, paperId) => {
  if (!dbInitialized) return [];

  try {
    const files = database.getPaperFiles(paperId);
    return files.filter(f =>
      f.file_role === 'attachment' &&
      (f.mime_type === 'application/pdf' || f.filename?.toLowerCase().endsWith('.pdf'))
    );
  } catch (error) {
    console.error('get-pdf-attachments error:', error);
    return [];
  }
});

// Get all attachments for a paper
ipcMain.handle('get-attachments', async (event, paperId) => {
  if (!dbInitialized) return [];

  try {
    const files = database.getPaperFiles(paperId);
    return files.filter(f => f.file_role === 'attachment');
  } catch (error) {
    console.error('get-attachments error:', error);
    return [];
  }
});

// ============ DOWNLOAD QUEUE ============
// New Download Queue API - manages PDF download queue

ipcMain.handle('download-queue:enqueue', async (event, paperId, sourceType, priority = 0) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    if (!downloadQueue) {
      return { success: false, error: 'Download queue not initialized' };
    }

    const result = await downloadQueue.enqueue(paperId, sourceType, priority);
    return { success: true, queueItem: result };
  } catch (error) {
    console.error('download-queue:enqueue error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('download-queue:enqueue-many', async (event, paperIds, sourceType) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    if (!downloadQueue) {
      return { success: false, error: 'Download queue not initialized' };
    }

    const results = await downloadQueue.enqueueMany(paperIds, sourceType);
    return { success: true, queued: results };
  } catch (error) {
    console.error('download-queue:enqueue-many error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('download-queue:cancel', async (event, paperId) => {
  try {
    if (!downloadQueue) {
      return { success: false, error: 'Download queue not initialized' };
    }

    await downloadQueue.cancel(paperId);
    return { success: true };
  } catch (error) {
    console.error('download-queue:cancel error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('download-queue:cancel-all', async (event) => {
  try {
    if (!downloadQueue) {
      return { success: false, error: 'Download queue not initialized' };
    }

    await downloadQueue.cancelAll();
    return { success: true };
  } catch (error) {
    console.error('download-queue:cancel-all error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('download-queue:status', async (event) => {
  try {
    if (!downloadQueue) {
      return {
        pending: 0,
        active: 0,
        completed: 0,
        failed: 0,
        paused: false,
        items: []
      };
    }

    return downloadQueue.getStatus();
  } catch (error) {
    console.error('download-queue:status error:', error);
    return {
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
      paused: false,
      items: [],
      error: error.message
    };
  }
});

ipcMain.handle('download-queue:pause', async (event) => {
  try {
    if (!downloadQueue) {
      return { success: false, error: 'Download queue not initialized' };
    }

    downloadQueue.pause();
    return { success: true };
  } catch (error) {
    console.error('download-queue:pause error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('download-queue:resume', async (event) => {
  try {
    if (!downloadQueue) {
      return { success: false, error: 'Download queue not initialized' };
    }

    downloadQueue.resume();
    return { success: true };
  } catch (error) {
    console.error('download-queue:resume error:', error);
    return { success: false, error: error.message };
  }
});

// ===== Utility IPC Handlers =====

ipcMain.handle('open-external', (event, url) => {
  console.log('Opening external URL:', url);
  shell.openExternal(url);
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Download publisher PDF through authentication window
ipcMain.handle('download-publisher-pdf', async (event, paperId, publisherUrl, proxyUrl) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library path configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const paper = database.getPaper(paperId);
  if (!paper) return { success: false, error: 'Paper not found' };

  sendConsoleLog(`Opening publisher PDF auth window...`, 'info');
  sendConsoleLog(`Publisher URL: ${publisherUrl}`, 'info');

  // Construct the proxied URL
  let url = publisherUrl;
  if (proxyUrl) {
    let normalizedProxy = proxyUrl.trim();
    if (!normalizedProxy.includes('?url=') && !normalizedProxy.endsWith('=')) {
      if (normalizedProxy.includes('?')) {
        normalizedProxy += '&url=';
      } else {
        normalizedProxy += '?url=';
      }
    }
    url = normalizedProxy + publisherUrl;
    sendConsoleLog(`Using proxy: ${normalizedProxy}`, 'info');
  }

  sendConsoleLog(`Final URL: ${url}`, 'info');
  console.log('Opening auth window for publisher PDF:', url);

  // Generate source-specific filename for publisher PDF
  const baseFilename = (paper.bibcode || `paper_${paperId}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const originalName = `${baseFilename}_PUB_PDF.pdf`;
  // Use temp directory for initial download, then move to content-addressed storage
  const tempDownloadPath = path.join(os.tmpdir(), `adsreader_pub_${Date.now()}.pdf`);

  // Check if publisher PDF already exists in paper_files
  const existingFiles = database.getPaperFiles(paperId, { sourceType: 'PUB_PDF' });
  if (existingFiles.length > 0) {
    const existingPath = fileManager ? fileManager.getFile(existingFiles[0].id)?.path : null;
    sendConsoleLog(`Publisher PDF already downloaded`, 'success');
    return { success: true, path: existingPath, source: 'publisher', alreadyExists: true };
  }

  return new Promise((resolve) => {
    // Create a new window for authentication
    const authWindow = new BrowserWindow({
      width: 1000,
      height: 750,
      parent: mainWindow,
      modal: false,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        plugins: false  // Disable PDF plugin to prevent inline display
      }
    });

    authWindow.setTitle('Downloading PDF...');

    // Show loading indicator immediately
    const loadingHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            margin: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          }
          .spinner {
            width: 50px;
            height: 50px;
            border: 4px solid rgba(255,255,255,0.1);
            border-top-color: #4a9eff;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 24px;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          h2 { margin: 0 0 8px 0; font-weight: 500; }
          p { margin: 0; opacity: 0.7; font-size: 14px; }
          .status { margin-top: 24px; font-size: 13px; opacity: 0.5; }
        </style>
      </head>
      <body>
        <div class="spinner"></div>
        <h2>Downloading PDF</h2>
        <p>Connecting to publisher...</p>
        <p class="status">The download will start automatically</p>
      </body>
      </html>
    `;
    authWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);

    let downloadCompleted = false;
    let resolved = false;
    const session = authWindow.webContents.session;

    // Function to manually trigger download
    async function triggerManualDownload() {
      if (downloadCompleted || resolved) return;
      console.log('Manual download triggered');

      try {
        // First, try to click any download button on the page
        const clicked = await authWindow.webContents.executeJavaScript(`
          (function() {
            // Look for common download button patterns
            const selectors = [
              'a[href*=".pdf"]',
              'a[download]',
              'button[aria-label*="download" i]',
              'a[aria-label*="download" i]',
              '.download-pdf',
              '#download-pdf',
              'a[title*="download" i]',
              'a[title*="PDF" i]',
              '.btn-download',
              '[data-action="download"]'
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) {
                el.click();
                return true;
              }
            }
            return false;
          })()
        `);

        if (!clicked) {
          // If no download button found, try to download current URL
          const currentUrl = authWindow.webContents.getURL();
          console.log('No download button found, trying to download current URL:', currentUrl);
          authWindow.webContents.downloadURL(currentUrl);
        }
      } catch (e) {
        console.error('Manual download failed:', e.message);
      }
    }

    // Create a custom menu with Download PDF button
    const { Menu } = require('electron');
    const menuTemplate = [
      {
        label: 'Actions',
        submenu: [
          {
            label: 'Download PDF',
            accelerator: 'CmdOrCtrl+D',
            click: triggerManualDownload
          },
          {
            label: 'Reload Page',
            accelerator: 'CmdOrCtrl+R',
            click: () => authWindow.webContents.reload()
          }
        ]
      }
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    authWindow.setMenu(menu);

    // Also register keyboard shortcut directly
    authWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'd' && (input.meta || input.control)) {
        event.preventDefault();
        triggerManualDownload();
      }
    });

    async function finishWithSuccess() {
      if (resolved) return;
      resolved = true;
      downloadCompleted = true;

      try {
        // Add via FileManager (computes hash, stores in content-addressed location, creates symlink)
        const result = await fileManager.addFile(paperId, tempDownloadPath, {
          role: 'pdf',
          sourceType: 'PUB_PDF',
          originalName: originalName,
          sourceUrl: publisherUrl,
          bibcode: paper.bibcode
        });
        console.log('PDF saved successfully via FileManager:', result.path);

        // Clean up temp file
        if (fs.existsSync(tempDownloadPath)) {
          fs.unlinkSync(tempDownloadPath);
        }

        if (!authWindow.isDestroyed()) {
          authWindow.close();
        }
        resolve({ success: true, path: result.path, fileId: result.id });
      } catch (e) {
        console.error('Failed to add file via FileManager:', e);
        // Clean up temp file on error
        if (fs.existsSync(tempDownloadPath)) {
          try { fs.unlinkSync(tempDownloadPath); } catch (err) { /* ignore */ }
        }
        if (!authWindow.isDestroyed()) {
          authWindow.close();
        }
        resolve({ success: false, error: e.message });
      }
    }

    function finishWithError(error) {
      if (resolved) return;
      resolved = true;
      console.error('Download failed:', error);
      if (!authWindow.isDestroyed()) {
        authWindow.close();
      }
      resolve({ success: false, error });
    }

    function verifyPdf() {
      try {
        const stats = fs.statSync(tempDownloadPath);
        if (stats.size < 1000) {
          fs.unlinkSync(tempDownloadPath);
          return 'Downloaded file too small';
        }

        const fd = fs.openSync(tempDownloadPath, 'r');
        const buffer = Buffer.alloc(8);
        fs.readSync(fd, buffer, 0, 8, 0);
        fs.closeSync(fd);

        const header = buffer.toString('ascii', 0, 5);
        if (header === '%PDF-') {
          return null; // Valid PDF
        } else {
          fs.unlinkSync(tempDownloadPath);
          return 'Downloaded file is not a valid PDF';
        }
      } catch (e) {
        return `Failed to verify download: ${e.message}`;
      }
    }

    // Handle triggered downloads (when browser triggers a download)
    session.on('will-download', (event, item, webContents) => {
      console.log('Download triggered:', item.getFilename(), item.getMimeType());
      item.setSavePath(tempDownloadPath);

      // Update window title to show download is happening
      if (!authWindow.isDestroyed()) {
        authWindow.setTitle('Downloading PDF...');
      }

      // Track download progress
      item.on('updated', (event, state) => {
        if (state === 'progressing' && !authWindow.isDestroyed()) {
          const received = item.getReceivedBytes();
          const total = item.getTotalBytes();
          if (total > 0) {
            const percent = Math.round((received / total) * 100);
            authWindow.setTitle(`Downloading PDF... ${percent}%`);
          }
        }
      });

      item.on('done', (event, state) => {
        if (state === 'completed') {
          console.log('Download completed:', tempDownloadPath);
          const error = verifyPdf();
          if (error) {
            finishWithError(error);
          } else {
            finishWithSuccess();
          }
        } else {
          finishWithError(`Download failed: ${state}`);
        }
      });
    });

    // Track PDF URLs we've seen to avoid duplicate downloads
    let detectedPdfUrl = null;
    let downloadTriggeredForUrl = null;

    // Intercept PDF responses and force download instead of inline display
    session.webRequest.onHeadersReceived((details, callback) => {
      const contentType = details.responseHeaders['content-type'] || details.responseHeaders['Content-Type'];
      if (contentType) {
        const ct = Array.isArray(contentType) ? contentType[0] : contentType;
        if (ct.includes('application/pdf') && !downloadCompleted && details.url !== downloadTriggeredForUrl) {
          console.log('Intercepted PDF response, forcing download:', details.url);
          detectedPdfUrl = details.url;

          // Force download by changing content-disposition
          const newHeaders = { ...details.responseHeaders };
          newHeaders['content-disposition'] = [`attachment; filename="${originalName}"`];

          // Also trigger downloadURL as a backup (some sites ignore content-disposition)
          // Use setTimeout to avoid blocking the callback
          setTimeout(() => {
            if (!downloadCompleted && detectedPdfUrl && detectedPdfUrl !== downloadTriggeredForUrl) {
              // Check if window still exists before accessing webContents
              if (authWindow && !authWindow.isDestroyed()) {
                console.log('Triggering explicit downloadURL for:', detectedPdfUrl);
                downloadTriggeredForUrl = detectedPdfUrl;
                authWindow.webContents.downloadURL(detectedPdfUrl);
              }
            }
          }, 500);

          callback({
            cancel: false,
            responseHeaders: newHeaders
          });
          return;
        }
      }
      callback({ cancel: false });
    });

    // Track navigation for logging
    authWindow.webContents.on('did-navigate', (event, navigationUrl) => {
      console.log('Navigated to:', navigationUrl);
    });

    // When window is closed without download completing
    authWindow.on('closed', () => {
      if (!resolved) {
        resolve({ success: false, error: 'Window closed before download completed' });
      }
    });

    // Load the actual URL after a brief delay to show loading indicator
    setTimeout(() => {
      if (!authWindow.isDestroyed()) {
        authWindow.loadURL(url);
      }
    }, 100);
  });
});

ipcMain.handle('show-in-finder', (event, filePath) => {
  shell.showItemInFolder(filePath);
});

// ═══════════════════════════════════════════════════════════════════════════
// SMART ADS SEARCHES
// ═══════════════════════════════════════════════════════════════════════════

ipcMain.handle('smart-search-create', async (event, { name, query, sortOrder }) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    const id = database.createSmartSearch({ name, query, sortOrder });
    return { success: true, id };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('smart-search-list', async () => {
  if (!dbInitialized) return [];
  return database.getAllSmartSearches();
});

ipcMain.handle('smart-search-get', async (event, { id }) => {
  if (!dbInitialized) return null;

  const search = database.getSmartSearch(id);
  if (!search) return null;

  const results = database.getSmartSearchResultsWithLibraryStatus(id);
  return { search, results };
});

ipcMain.handle('smart-search-refresh', async (event, { id }) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const search = database.getSmartSearch(id);
  if (!search) return { success: false, error: 'Smart search not found' };

  try {
    sendConsoleLog(`Refreshing smart search: ${search.name}`, 'info');

    // Query ADS
    const result = await adsApi.search(token, search.query, {
      rows: 200,
      sort: search.sort_order || 'date desc'
    });

    // Clear old results and insert new ones
    database.clearSmartSearchResults(id);

    const now = new Date().toISOString();
    for (const doc of result.docs) {
      // Extract arXiv ID from identifier array
      let arxivId = null;
      if (doc.identifier) {
        for (const ident of doc.identifier) {
          if (ident.startsWith('arXiv:')) {
            arxivId = ident.replace('arXiv:', '');
            break;
          }
          if (/^\d{4}\.\d{4,5}/.test(ident)) {
            arxivId = ident;
            break;
          }
        }
      }

      database.addSmartSearchResult(id, {
        bibcode: doc.bibcode,
        title: doc.title?.[0] || 'Untitled',
        authors: doc.author || [],
        year: doc.year ? parseInt(doc.year) : null,
        journal: doc.pub || null,
        abstract: doc.abstract || null,
        doi: doc.doi?.[0] || null,
        arxiv_id: arxivId,
        citation_count: doc.citation_count || 0,
        cached_date: now
      });
    }

    // Update search metadata
    database.updateSmartSearch(id, {
      last_refresh_date: now,
      result_count: result.docs.length,
      error_message: null
    });

    sendConsoleLog(`Smart search refreshed: ${result.docs.length} results`, 'success');
    return { success: true, resultCount: result.docs.length };

  } catch (error) {
    database.updateSmartSearch(id, {
      error_message: error.message
    });
    sendConsoleLog(`Smart search refresh failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('smart-search-update', async (event, { id, ...updates }) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    database.updateSmartSearch(id, updates);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('smart-search-delete', async (event, { id }) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    database.deleteSmartSearch(id);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('smart-search-add-to-library', async (event, { bibcode, searchResultData }) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  // Check if already in library
  const existing = database.getPaperByBibcode(bibcode);
  if (existing) {
    return { success: true, paperId: existing.id, alreadyExists: true };
  }

  try {
    sendConsoleLog(`Adding ${bibcode} to library...`, 'info');

    // Fetch full metadata from ADS
    const adsDoc = await adsApi.getByBibcode(token, bibcode);

    if (!adsDoc) {
      return { success: false, error: 'Paper not found in ADS' };
    }

    // Extract arXiv ID
    let arxivId = null;
    if (adsDoc.identifier) {
      for (const ident of adsDoc.identifier) {
        if (ident.startsWith('arXiv:')) {
          arxivId = ident.replace('arXiv:', '');
          break;
        }
        if (/^\d{4}\.\d{4,5}/.test(ident)) {
          arxivId = ident;
          break;
        }
      }
    }

    // Fetch available PDF sources from ADS
    let availableSources = [];
    try {
      const esources = await adsApi.getEsources(token, bibcode);
      if (esources) {
        if (esources.includes('EPRINT_PDF')) availableSources.push('arxiv');
        if (esources.includes('PUB_PDF')) availableSources.push('publisher');
        if (esources.includes('ADS_PDF')) availableSources.push('ads_scan');
      }
    } catch (e) {
      // eSources fetch failed, continue without it
    }

    // Fetch BibTeX BEFORE adding paper (ensures it's available immediately)
    let bibtexStr = null;
    try {
      bibtexStr = await adsApi.exportBibtex(token, bibcode);
    } catch (e) {
      sendConsoleLog(`BibTeX fetch failed: ${e.message}`, 'warn');
    }

    // Create paper with ALL metadata including BibTeX - NO PDF download per user requirement
    const paperId = database.addPaper({
      bibcode: adsDoc.bibcode,
      doi: adsDoc.doi?.[0] || null,
      arxiv_id: arxivId,
      title: adsDoc.title?.[0] || 'Untitled',
      authors: adsDoc.author || [],
      year: adsDoc.year ? parseInt(adsDoc.year) : null,
      journal: adsDoc.pub || null,
      abstract: adsDoc.abstract || null,
      keywords: adsDoc.keyword || [],
      citation_count: adsDoc.citation_count || 0,
      bibtex: bibtexStr,
      import_source: 'ads_smart_search',
      import_source_key: bibcode,
      available_sources: availableSources.length > 0 ? JSON.stringify(availableSources) : null
    });

    sendConsoleLog(`Added ${bibcode} to library`, 'success');
    return { success: true, paperId };

  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('check-bibcodes-in-library', async (event, bibcodes) => {
  if (!dbInitialized) return [];
  return database.checkBibcodesInLibrary(bibcodes);
});

// =====================================================================
// TEMPORARY PDF CACHE (for ADS search results)
// =====================================================================

const { tempPdfCache } = require('./src/lib/files/temp-pdf-cache.cjs');

ipcMain.handle('temp-pdf-has', async (event, { bibcode }) => {
  return tempPdfCache.has(bibcode);
});

ipcMain.handle('temp-pdf-get', async (event, { bibcode }) => {
  const entry = tempPdfCache.get(bibcode);
  if (entry) {
    // Return as Uint8Array for PDF.js
    return {
      success: true,
      data: new Uint8Array(entry.data),
      source: entry.source
    };
  }
  return { success: false, error: 'Not in cache' };
});

ipcMain.handle('temp-pdf-download', async (event, { paper }) => {
  // Check cache first
  if (tempPdfCache.has(paper.bibcode)) {
    const entry = tempPdfCache.get(paper.bibcode);
    return {
      success: true,
      data: new Uint8Array(entry.data),
      source: entry.source,
      cached: true
    };
  }

  // Get proxy URL if configured
  const proxyUrl = store.get('libraryProxyUrl');

  // Download with progress
  sendConsoleLog(`Downloading temp PDF for ${paper.bibcode}...`, 'info');

  try {
    const result = await tempPdfCache.downloadForPaper(paper, proxyUrl, (received, total) => {
      // Send progress to renderer
      event.sender.send('temp-pdf-progress', {
        bibcode: paper.bibcode,
        received,
        total
      });
    });

    if (result.success) {
      sendConsoleLog(`Temp PDF downloaded: ${(result.data.length / 1024 / 1024).toFixed(2)} MB`, 'success');
      return {
        success: true,
        data: new Uint8Array(result.data),
        source: result.source
      };
    } else {
      sendConsoleLog(`Temp PDF failed: ${result.error}`, 'error');
      return result;
    }
  } catch (error) {
    sendConsoleLog(`Temp PDF error: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('temp-pdf-clear', async () => {
  tempPdfCache.clear();
  return { success: true };
});

ipcMain.handle('temp-pdf-stats', async () => {
  return tempPdfCache.getStats();
});

// ═══════════════════════════════════════════════════════════════════════════
// READING LIST
// ═══════════════════════════════════════════════════════════════════════════

const { ReadingListCache } = require('./src/lib/files/reading-list-cache.cjs');
let readingListCache = null;

function getReadingListCache() {
  const libPath = store.get('libraryPath');
  if (!readingListCache && libPath) {
    readingListCache = new ReadingListCache(libPath);
  }
  return readingListCache;
}

// Check if a paper is in the reading list
ipcMain.handle('reading-list-has', async (event, { bibcode }) => {
  return database.isInReadingList(bibcode);
});

// Get all reading list papers
ipcMain.handle('reading-list-get-all', async () => {
  return database.getReadingList();
});

// Get reading list count
ipcMain.handle('reading-list-count', async () => {
  return database.getReadingListCount();
});

// Get a single reading list paper
ipcMain.handle('reading-list-get', async (event, { bibcode }) => {
  return database.getReadingListPaper(bibcode);
});

// Add paper to reading list (with optional PDF download)
ipcMain.handle('reading-list-add', async (event, { paper, downloadPdf = true }) => {
  try {
    // Use bibcode or arxivId as identifier
    const paperId = paper.bibcode || paper.arxivId;
    if (!paperId) {
      return { success: false, error: 'Paper has no identifier (bibcode or arxivId)' };
    }

    // Check if already in library
    if (paper.bibcode && database.getPaperByBibcode(paper.bibcode)) {
      return { success: false, error: 'Paper is already in library' };
    }

    // Check if already in reading list
    if (database.isInReadingList(paperId)) {
      return { success: false, error: 'Paper is already in reading list' };
    }

    const cache = getReadingListCache();
    let pdfPath = null;
    let pdfSource = null;
    let relativePath = null;

    // Download PDF if requested
    if (downloadPdf && cache) {
      // Try to get PDF from temp cache first
      const tempEntry = tempPdfCache.get(paperId);
      if (tempEntry) {
        pdfPath = cache.save(paperId, tempEntry.data, tempEntry.source);
        pdfSource = tempEntry.source;
        relativePath = cache.getRelativePath(paperId, pdfSource);
        sendConsoleLog(`Saved PDF from temp cache to reading list: ${paperId}`, 'info');
      } else {
        // Download new PDF - for arXiv, we can download directly
        if (paper.arxivId && !paper.bibcode) {
          // Direct arXiv PDF download
          const pdfUrl = `https://arxiv.org/pdf/${paper.arxivId}.pdf`;
          try {
            const response = await fetch(pdfUrl, {
              headers: { 'User-Agent': 'ADS-Reader/1.0' },
              redirect: 'follow'
            });
            if (response.ok) {
              const buffer = Buffer.from(await response.arrayBuffer());
              pdfPath = cache.save(paperId, buffer, 'EPRINT_PDF');
              pdfSource = 'EPRINT_PDF';
              relativePath = cache.getRelativePath(paperId, pdfSource);
              sendConsoleLog(`Downloaded arXiv PDF for reading list: ${paperId}`, 'info');
            }
          } catch (e) {
            sendConsoleLog(`Failed to download arXiv PDF: ${e.message}`, 'warn');
          }
        } else {
          // Use existing download logic for ADS papers
          const proxyUrl = store.get('library_proxy_url', '');
          const result = await tempPdfCache.downloadForPaper(paper, proxyUrl);
          if (result.success) {
            pdfPath = cache.save(paperId, result.data, result.source);
            pdfSource = result.source;
            relativePath = cache.getRelativePath(paperId, pdfSource);
            sendConsoleLog(`Downloaded PDF for reading list: ${paperId}`, 'info');
          }
        }
      }
    }

    // Add to database - use paperId as bibcode for reading list
    const id = database.addToReadingList({
      ...paper,
      bibcode: paperId, // Use unified identifier
      pdf_path: relativePath,
      pdf_source: pdfSource
    });

    return {
      success: true,
      id,
      pdfPath,
      pdfSource
    };
  } catch (error) {
    sendConsoleLog(`Error adding to reading list: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Batch add papers to reading list (parallel processing)
ipcMain.handle('reading-list-add-batch', async (event, { papers, downloadPdf = true }) => {
  const CONCURRENCY = 10;
  const results = { added: [], skipped: [], failed: [] };

  sendConsoleLog(`Adding ${papers.length} papers to reading list...`, 'info');

  // Filter out papers already in library or reading list
  const papersToAdd = papers.filter(paper => {
    // Use unified identifier (bibcode for ADS, arxivId for arXiv)
    const paperId = paper.bibcode || paper.arxivId;
    if (!paperId) {
      results.failed.push({ id: 'unknown', reason: 'No identifier (bibcode or arxivId)' });
      return false;
    }
    if (paper.bibcode && database.getPaperByBibcode(paper.bibcode)) {
      results.skipped.push({ id: paperId, reason: 'Already in library' });
      return false;
    }
    if (database.isInReadingList(paperId)) {
      results.skipped.push({ id: paperId, reason: 'Already in reading list' });
      return false;
    }
    return true;
  });

  if (papersToAdd.length === 0) {
    return { success: true, results };
  }

  // Process in parallel batches
  for (let i = 0; i < papersToAdd.length; i += CONCURRENCY) {
    const batch = papersToAdd.slice(i, i + CONCURRENCY);
    const batchNum = Math.floor(i / CONCURRENCY) + 1;
    const totalBatches = Math.ceil(papersToAdd.length / CONCURRENCY);

    sendConsoleLog(`Processing batch ${batchNum}/${totalBatches} (${batch.length} papers)...`, 'info');

    const batchResults = await Promise.all(
      batch.map(async (paper) => {
        // Use unified identifier (bibcode for ADS, arxivId for arXiv)
        const paperId = paper.bibcode || paper.arxivId;

        try {
          const cache = getReadingListCache();
          let pdfPath = null, pdfSource = null, relativePath = null;

          if (downloadPdf && cache) {
            // Check temp cache first (already downloaded during search)
            const tempEntry = tempPdfCache.get(paperId);
            if (tempEntry) {
              pdfPath = cache.save(paperId, tempEntry.data, tempEntry.source);
              pdfSource = tempEntry.source;
              relativePath = cache.getRelativePath(paperId, pdfSource);
              sendConsoleLog(`Saved ${paperId} from temp cache`, 'info');
            } else if (paper.arxivId && !paper.bibcode) {
              // arXiv paper - download directly from arXiv
              try {
                const pdfUrl = `https://arxiv.org/pdf/${paper.arxivId}.pdf`;
                const response = await fetch(pdfUrl);
                if (response.ok) {
                  const data = Buffer.from(await response.arrayBuffer());
                  pdfPath = cache.save(paperId, data, 'ARXIV');
                  pdfSource = 'ARXIV';
                  relativePath = cache.getRelativePath(paperId, pdfSource);
                  sendConsoleLog(`Downloaded ${paperId} from arXiv`, 'info');
                }
              } catch (pdfErr) {
                sendConsoleLog(`Failed to download PDF for ${paperId}: ${pdfErr.message}`, 'warn');
              }
            } else {
              // ADS paper - use standard download
              const proxyUrl = store.get('library_proxy_url', '');
              const result = await tempPdfCache.downloadForPaper(paper, proxyUrl);
              if (result.success) {
                pdfPath = cache.save(paperId, result.data, result.source);
                pdfSource = result.source;
                relativePath = cache.getRelativePath(paperId, pdfSource);
                sendConsoleLog(`Downloaded ${paperId}`, 'info');
              }
            }
          }

          const id = database.addToReadingList({
            ...paper,
            bibcode: paperId, // Use unified identifier as bibcode for database
            pdf_path: relativePath,
            pdf_source: pdfSource
          });

          return { success: true, id: paperId, bibcode: paperId, pdfPath };
        } catch (error) {
          console.error(`Error adding ${paperId} to reading list:`, error);
          return { success: false, id: paperId, bibcode: paperId, error: error.message };
        }
      })
    );

    // Collect results
    for (const r of batchResults) {
      if (r.success) results.added.push(r);
      else results.failed.push(r);
    }

    // Rate limit between batches
    if (i + CONCURRENCY < papersToAdd.length) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  sendConsoleLog(`Added ${results.added.length} papers to reading list (${results.skipped.length} skipped, ${results.failed.length} failed)`, 'success');
  return { success: true, results };
});

// Remove paper from reading list
ipcMain.handle('reading-list-remove', async (event, { bibcode }) => {
  try {
    // Delete PDF file
    const cache = getReadingListCache();
    if (cache) {
      cache.remove(bibcode);
    }

    // Remove from database
    database.removeFromReadingList(bibcode);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get PDF path for reading list paper
ipcMain.handle('reading-list-get-pdf-path', async (event, { bibcode }) => {
  console.log(`[reading-list-get-pdf-path] Looking up: ${bibcode}`);
  const cache = getReadingListCache();
  if (!cache) {
    console.log(`[reading-list-get-pdf-path] No cache available`);
    return null;
  }

  const found = cache.findAny(bibcode);
  console.log(`[reading-list-get-pdf-path] ${bibcode}: ${found ? found.path : 'not found'}`);
  return found ? found.path : null;
});

// Update reading list paper (e.g., view position)
ipcMain.handle('reading-list-update', async (event, { bibcode, updates }) => {
  database.updateReadingListPaper(bibcode, updates);
  return { success: true };
});

// Promote reading list paper to library
ipcMain.handle('reading-list-promote', async (event, { bibcode }) => {
  try {
    const paper = database.getReadingListPaper(bibcode);
    if (!paper) {
      return { success: false, error: 'Paper not found in reading list' };
    }

    // Get PDF from reading list cache
    const cache = getReadingListCache();
    const pdfInfo = cache ? cache.findAny(bibcode) : null;

    // Add to library using existing flow
    const token = store.get('ads_token', '');

    // Fetch fresh metadata from ADS if we have a token
    let adsData = {};
    if (token && bibcode) {
      try {
        const searchResult = await adsApi.search(token, `bibcode:"${bibcode}"`, 'date desc', 1);
        if (searchResult.docs && searchResult.docs.length > 0) {
          const doc = searchResult.docs[0];
          adsData = {
            bibcode: doc.bibcode,
            title: Array.isArray(doc.title) ? doc.title[0] : doc.title,
            authors: doc.author || [],
            year: doc.year,
            journal: doc.pub,
            abstract: doc.abstract,
            doi: doc.doi ? doc.doi[0] : null,
            arxiv_id: doc.arxiv_id,
            citation_count: doc.citation_count || 0
          };
        }
      } catch (e) {
        sendConsoleLog(`Could not fetch ADS data for promotion: ${e.message}`, 'warn');
      }
    }

    // Merge reading list data with fresh ADS data
    const paperData = {
      ...paper,
      ...adsData,
      isReadingList: undefined
    };

    // Add paper to library
    const paperId = database.addPaper(paperData);

    // If we have a PDF, move it to the library
    if (pdfInfo && fs.existsSync(pdfInfo.path)) {
      if (fileManager) {
        // Add file to paper_files and content-addressed storage
        // Pass the file path (not buffer) - fileManager.addFile expects a path
        const fileRecord = await fileManager.addFile(paperId, pdfInfo.path, {
          originalName: `${bibcode}_${pdfInfo.source}.pdf`,
          mimeType: 'application/pdf',
          sourceType: pdfInfo.source
        });
        sendConsoleLog(`Moved PDF to library: ${bibcode}`, 'info');
      }
    }

    // Remove from reading list (including PDF)
    if (cache) {
      cache.remove(bibcode);
    }
    database.removeFromReadingList(bibcode);

    return {
      success: true,
      paperId,
      title: paperData.title
    };
  } catch (error) {
    sendConsoleLog(`Error promoting to library: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Check which bibcodes are in reading list (for batch checking)
ipcMain.handle('reading-list-check-bibcodes', async (event, { bibcodes }) => {
  return database.checkBibcodesInReadingList(bibcodes);
});

// =============================================================================
// Plugin System IPC Handlers
// =============================================================================

/**
 * Get list of all registered plugins with their info
 * Returns: Array of { id, name, icon, description, active, enabled, capabilities, auth }
 */
ipcMain.handle('plugin:list', async () => {
  try {
    const plugins = pluginManager.getPluginInfo();
    return { success: true, data: plugins };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Get the currently active plugin
 * Returns: { id, name, icon } or null if no active plugin
 */
ipcMain.handle('plugin:get-active', async () => {
  try {
    const plugin = pluginManager.getActive();
    if (!plugin) {
      return { success: true, data: null };
    }
    return {
      success: true,
      data: {
        id: plugin.id,
        name: plugin.name,
        icon: plugin.icon || ''
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Set the active plugin
 * Args: { pluginId: string }
 * Returns: { success: true }
 */
ipcMain.handle('plugin:set-active', async (event, { pluginId }) => {
  try {
    pluginManager.setActive(pluginId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Search using active or specified plugin
 * Args: { query: UnifiedQuery, pluginId?: string }
 * Returns: SearchResult { papers, totalResults, nextCursor?, metadata? }
 */
ipcMain.handle('plugin:search', async (event, { query, pluginId }) => {
  try {
    let result;
    if (pluginId) {
      // Use specific plugin
      const plugin = pluginManager.get(pluginId);
      if (!plugin) {
        return { success: false, error: `Plugin "${pluginId}" not found` };
      }
      if (!plugin.capabilities.search) {
        return { success: false, error: `Plugin "${pluginId}" does not support search` };
      }
      result = await plugin.search(query);
      // Tag results with source
      result.papers = result.papers.map(p => ({ ...p, source: plugin.id }));
    } else {
      // Use active plugin via manager (includes rate limiting)
      result = await pluginManager.search(query);
    }
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Lookup a paper by identifier (DOI, arXiv ID, bibcode, etc.)
 * Args: { identifier: string }
 * Returns: Paper | null
 */
ipcMain.handle('plugin:lookup', async (event, { identifier }) => {
  try {
    const paper = await pluginManager.lookup(identifier);
    return { success: true, data: paper };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Get available PDF sources for a paper
 * Args: { paper: Paper } - Paper object with source and sourceId
 * Returns: PdfSource[]
 */
ipcMain.handle('plugin:get-pdf-sources', async (event, { paper }) => {
  try {
    const sources = await pluginManager.getPdfSources(paper);
    return { success: true, data: sources };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Get references for a paper
 * Args: { pluginId: string, sourceId: string }
 * Returns: Paper[]
 */
ipcMain.handle('plugin:get-references', async (event, { pluginId, sourceId }) => {
  try {
    const plugin = pluginManager.get(pluginId);
    if (!plugin) {
      return { success: false, error: `Plugin "${pluginId}" not found` };
    }
    if (!plugin.capabilities.references) {
      return { success: false, error: `Plugin "${pluginId}" does not support references` };
    }
    if (typeof plugin.getReferences !== 'function') {
      return { success: false, error: `Plugin "${pluginId}" has no getReferences method` };
    }
    const references = await plugin.getReferences(sourceId);
    return { success: true, data: references };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Get citations (papers that cite this paper)
 * Args: { pluginId: string, sourceId: string }
 * Returns: Paper[]
 */
ipcMain.handle('plugin:get-citations', async (event, { pluginId, sourceId }) => {
  try {
    const plugin = pluginManager.get(pluginId);
    if (!plugin) {
      return { success: false, error: `Plugin "${pluginId}" not found` };
    }
    if (!plugin.capabilities.citations) {
      return { success: false, error: `Plugin "${pluginId}" does not support citations` };
    }
    if (typeof plugin.getCitations !== 'function') {
      return { success: false, error: `Plugin "${pluginId}" has no getCitations method` };
    }
    const citations = await plugin.getCitations(sourceId);
    return { success: true, data: citations };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Get BibTeX for a paper
 * Args: { pluginId: string, sourceId: string }
 * Returns: string (BibTeX entry)
 */
ipcMain.handle('plugin:get-bibtex', async (event, { pluginId, sourceId }) => {
  try {
    const plugin = pluginManager.get(pluginId);
    if (!plugin) {
      return { success: false, error: `Plugin "${pluginId}" not found` };
    }
    if (!plugin.capabilities.bibtex) {
      return { success: false, error: `Plugin "${pluginId}" does not support BibTeX export` };
    }
    if (typeof plugin.getBibtex !== 'function') {
      return { success: false, error: `Plugin "${pluginId}" has no getBibtex method` };
    }
    const bibtexStr = await plugin.getBibtex(sourceId);
    return { success: true, data: bibtexStr };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// =============================================================================
// End Plugin System IPC Handlers
// =============================================================================

// Create application menu
function createApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: async () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send('check-for-updates-clicked');
            }
            // For packaged apps, trigger update check
            if (app.isPackaged) {
              try {
                const { autoUpdater } = require('electron');
                autoUpdater.checkForUpdates();
              } catch (err) {
                // update-electron-app handles this internally
                console.log('Manual update check requested');
              }
            } else {
              // In development, show a dialog
              dialog.showMessageBox({
                type: 'info',
                title: 'Check for Updates',
                message: 'Auto-updates are only available in the packaged app.',
                detail: `Current version: ${app.getVersion()}\n\nTo test updates, build and package the app first.`,
                buttons: ['OK']
              });
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('switch-tab', 'settings');
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'Export Library...',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send('show-export-modal');
            }
          }
        },
        {
          label: 'Export as Book...',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send('show-export-book-modal');
            }
          }
        },
        {
          label: 'Import Library...',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send('show-import-modal');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Import BibTeX...',
          accelerator: 'CmdOrCtrl+I',
          click: async () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              const result = await require('./src/main/database.cjs');
              // Trigger via renderer
              win.webContents.send('trigger-import-bibtex');
            }
          }
        }
      ]
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },
    // View menu
    {
      label: 'View',
      submenu: [
        // Pane navigation - paper-specific tabs
        {
          label: 'PDF',
          accelerator: 'Shift+P',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('switch-tab', 'pdf');
          }
        },
        {
          label: 'Abstract',
          accelerator: 'Shift+A',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('switch-tab', 'abstract');
          }
        },
        {
          label: 'References',
          accelerator: 'Shift+R',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('switch-tab', 'refs');
          }
        },
        {
          label: 'Citations',
          accelerator: 'Shift+C',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('switch-tab', 'cites');
          }
        },
        {
          label: 'Info',
          accelerator: 'Shift+I',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('switch-tab', 'bibtex');
          }
        },
        {
          label: 'AI',
          accelerator: 'Shift+Y',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('switch-tab', 'ai');
          }
        },
        { type: 'separator' },
        // Navigation tabs
        {
          label: 'Library',
          accelerator: 'Shift+L',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('switch-tab', 'library');
          }
        },
        {
          label: 'ADS Search',
          accelerator: 'Shift+S',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('switch-tab', 'ads-search');
          }
        },
        { type: 'separator' },
        // Standard view controls
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    },
    // Help menu
    {
      role: 'help',
      submenu: [
        // Check for Updates (Windows/Linux only - macOS has it in app menu)
        ...(!isMac ? [{
          label: 'Check for Updates...',
          click: async () => {
            if (app.isPackaged) {
              try {
                const { autoUpdater } = require('electron');
                autoUpdater.checkForUpdates();
              } catch (err) {
                console.log('Manual update check requested');
              }
            } else {
              dialog.showMessageBox({
                type: 'info',
                title: 'Check for Updates',
                message: 'Auto-updates are only available in the packaged app.',
                detail: `Current version: ${app.getVersion()}\n\nTo test updates, build and package the app first.`,
                buttons: ['OK']
              });
            }
          }
        },
        { type: 'separator' }] : []),
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('show-shortcuts-modal');
          }
        },
        { type: 'separator' },
        {
          label: 'Send Feedback',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: async () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) {
              win.webContents.send('show-feedback-modal');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'ADS Reader on GitHub',
          click: async () => {
            await shell.openExternal('https://github.com/yipihey/adsreader');
          }
        },
        {
          label: 'NASA ADS',
          click: async () => {
            await shell.openExternal('https://ui.adsabs.harvard.edu');
          }
        },
        // About (Windows/Linux only - macOS has native about panel)
        ...(!isMac ? [
          { type: 'separator' },
          {
            label: 'About ADS Reader',
            click: async () => {
              dialog.showMessageBox({
                type: 'info',
                title: 'About ADS Reader',
                message: 'ADS Reader',
                detail: `Version ${app.getVersion()}\n\n© 2024 ADS Reader\n\nNASA ADS Integration • PDF.js Viewer\n\nBuilt with Electron`,
                buttons: ['OK']
              });
            }
          }
        ] : [])
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// App lifecycle
app.whenReady().then(() => {
  // Configure About panel (macOS native)
  app.setAboutPanelOptions({
    applicationName: 'ADS Reader',
    applicationVersion: app.getVersion(),
    version: '', // Build number if available
    copyright: '© 2024 ADS Reader',
    credits: 'NASA ADS Integration • PDF.js Viewer\n\nBuilt with Electron',
    website: 'https://github.com/yipihey/adsreader',
    iconPath: path.join(__dirname, 'assets', 'icon.png')
  });

  // Initialize auto-updater (only in packaged app)
  if (app.isPackaged) {
    try {
      updateElectronApp({
        updateInterval: '1 hour',
        notifyUser: true,
        logger: {
          log: (...args) => console.log('[AutoUpdater]', ...args),
          warn: (...args) => console.warn('[AutoUpdater]', ...args),
          error: (...args) => console.error('[AutoUpdater]', ...args)
        }
      });
      console.log('Auto-updater initialized');
    } catch (err) {
      console.error('Failed to initialize auto-updater:', err);
    }
  }

  createApplicationMenu();
  createWindow();

  // Initialize plugin system
  try {
    pluginManager.register(adsPlugin);
    pluginManager.register(arxivPlugin);
    pluginManager.register(inspirePlugin);
  } catch (err) {
    console.error('[PluginManager] Failed to register plugins:', err);
  }
  pluginManager.initialize().then(() => {
    console.log('[PluginManager] Plugin system initialized');
  }).catch(err => {
    console.error('[PluginManager] Failed to initialize:', err);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  database.closeDatabase();
});
