const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');

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
const KEYCHAIN_SERVICE = 'ads-reader';

// Initialize LLM services (will be configured from settings)
let ollamaService = null;
let cloudService = null;
let llmService = null; // Legacy alias for backward compatibility

// Helper to send console log messages to renderer
function sendConsoleLog(message, type = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('console-log', { message, type });
  }
  // Also log to terminal
  console.log(`[${type.toUpperCase()}] ${message}`);
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

    // Fetch refs/cites - wait for this to complete for reliable import
    try {
      console.log(`Fetching references and citations for bibcode: ${adsData.bibcode}`);
      const [refs, cits] = await Promise.all([
        adsApi.getReferences(token, adsData.bibcode).catch(e => {
          console.error('Failed to fetch references:', e.message);
          return [];
        }),
        adsApi.getCitations(token, adsData.bibcode).catch(e => {
          console.error('Failed to fetch citations:', e.message);
          return [];
        })
      ]);

      console.log(`Found ${refs.length} references and ${cits.length} citations`);

      database.addReferences(paperId, refs.map(r => ({
        bibcode: r.bibcode,
        title: r.title?.[0],
        authors: r.author?.join(', '),
        year: r.year
      })));

      database.addCitations(paperId, cits.map(c => ({
        bibcode: c.bibcode,
        title: c.title?.[0],
        authors: c.author?.join(', '),
        year: c.year
      })));
    } catch (e) {
      console.error('Failed to fetch refs/cites:', e.message);
    }

    return { success: true, metadata };
  } catch (error) {
    console.error('ADS fetch error:', error.message);
    return { success: false, reason: error.message };
  }
}

let mainWindow;
let dbInitialized = false;

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

// ===== Library Management IPC Handlers =====

ipcMain.handle('get-library-path', () => {
  // First try the stored library path
  let libraryPath = store.get('libraryPath');

  // If no path but we have a current library ID, find the library and get its path
  if (!libraryPath) {
    const currentId = store.get('currentLibraryId');
    if (currentId) {
      const allLibraries = getAllLibraries();
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

// Helper function to count papers in a library folder
function countPapersInLibrary(libraryPath) {
  try {
    const papersDir = path.join(libraryPath, 'papers');
    if (!fs.existsSync(papersDir)) return 0;

    const files = fs.readdirSync(papersDir);
    // Count unique bibcodes (papers may have multiple PDFs like _EPRINT_PDF, _PUB_PDF)
    const bibcodes = new Set();
    for (const file of files) {
      if (file.endsWith('.pdf')) {
        // Extract bibcode from filename (format: BIBCODE_SOURCETYPE.pdf)
        const match = file.match(/^(.+?)_(?:EPRINT_PDF|PUB_PDF|ADS_PDF)\.pdf$/);
        if (match) {
          bibcodes.add(match[1]);
        } else {
          // Fallback: count as unique paper
          bibcodes.add(file);
        }
      }
    }
    return bibcodes.size;
  } catch (e) {
    return 0;
  }
}

// Helper function to get all libraries (used internally and via IPC)
function getAllLibraries() {
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
          const paperCount = exists ? countPapersInLibrary(libPath) : 0;
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
    const paperCount = exists ? countPapersInLibrary(lib.path) : 0;
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
    const allLibraries = getAllLibraries();
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

    // Update current library path in preferences
    store.set('libraryPath', library.fullPath);
    store.set('currentLibraryId', libraryId);

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
    const allLibraries = getAllLibraries();
    const library = allLibraries.find(l => l.id === libraryId);

    if (!library) {
      return { success: false, error: 'Library not found' };
    }

    // Don't allow deleting the current library
    const currentId = store.get('currentLibraryId');
    if (currentId === libraryId) {
      return { success: false, error: 'Cannot delete the currently active library. Switch to another library first.' };
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

    sendConsoleLog(`Library "${library.name}" deleted`, 'success');
    return { success: true };
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
    const allLibraries = getAllLibraries();
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

      // Add to database
      const paperId = database.addPaper({
        title: importResult.title,
        pdf_path: importResult.pdf_path,
        text_path: importResult.text_path,
        bibcode: importResult.bibcode,
        arxiv_id: importResult.arxiv_id,
        doi: importResult.doi
      });

      // Auto-fetch ADS metadata - try even without identifiers using title/author search
      console.log(`Auto-fetching ADS metadata for paper ${paperId}...`);
      const adsResult = await fetchAndApplyAdsMetadata(paperId, importResult.extractedMetadata);
      if (adsResult.success) {
        console.log(`Successfully fetched ADS metadata for paper ${paperId}`);
      } else {
        console.log(`Could not fetch ADS metadata: ${adsResult.reason}`);
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

ipcMain.handle('ads-get-references', async (event, bibcode, options = {}) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };

  try {
    const refs = await adsApi.getReferences(token, bibcode, { rows: options.limit || 50 });
    return { success: true, data: refs };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ads-get-citations', async (event, bibcode, options = {}) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };

  try {
    const cits = await adsApi.getCitations(token, bibcode, { rows: options.limit || 50 });
    return { success: true, data: cits };
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

// Check if a PDF for a specific source already exists
ipcMain.handle('check-pdf-exists', async (event, paperId, sourceType) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return null;

  // Map source types to expected suffixes
  const sourceSuffixes = {
    publisher: '_pub.pdf',
    arxiv: '_arxiv.pdf',
    ads: '_ads.pdf',
    author: '_author.pdf'
  };

  const suffix = sourceSuffixes[sourceType];
  if (!suffix) return null;

  // Check for PDF with the source suffix
  const pdfPath = `pdfs/${paperId}${suffix}`;
  const fullPath = path.join(libraryPath, pdfPath);

  if (fs.existsSync(fullPath)) {
    return pdfPath;
  }

  return null;
});

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
    }

    if (!targetSource) {
      sendConsoleLog(`${sourceType} PDF not found in esources`, 'error');
      return { success: false, error: `${sourceType} PDF not available` };
    }

    // Generate source-specific filename
    const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${baseFilename}_${targetType}.pdf`;
    const destPath = path.join(libraryPath, 'papers', filename);
    const papersDir = path.join(libraryPath, 'papers');

    // Ensure papers directory exists
    if (!fs.existsSync(papersDir)) {
      fs.mkdirSync(papersDir, { recursive: true });
    }

    // Check if this source's PDF already exists
    if (fs.existsSync(destPath)) {
      sendConsoleLog(`${sourceType} PDF already downloaded`, 'success');
      const relativePath = `papers/${filename}`;
      return { success: true, path: destPath, source: sourceType, pdf_path: relativePath, alreadyExists: true };
    }

    // Download the PDF
    let downloadUrl = targetSource.url;

    // Apply proxy for publisher PDFs if configured
    if (sourceType === 'publisher' && proxyUrl) {
      downloadUrl = proxyUrl + encodeURIComponent(targetSource.url);
      sendConsoleLog(`Using library proxy: ${proxyUrl}`, 'info');
    }

    sendConsoleLog(`Downloading from: ${downloadUrl}`, 'info');
    await pdfDownload.downloadFile(downloadUrl, destPath);

    // Update paper with PDF path (use this source as the current/active one)
    const relativePath = `papers/${filename}`;
    database.updatePaper(paperId, { pdf_path: relativePath });

    sendConsoleLog(`Downloaded ${sourceType} PDF successfully`, 'success');
    return { success: true, path: destPath, source: sourceType, pdf_path: relativePath };
  } catch (error) {
    sendConsoleLog(`Download failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Batch download PDFs for multiple papers
ipcMain.handle('batch-download-pdfs', async (event, paperIds) => {
  const token = store.get('adsToken');
  const libraryPath = store.get('libraryPath');
  const proxyUrl = store.get('libraryProxyUrl');
  const pdfPriority = store.get('pdfPriority', ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF']);

  if (!libraryPath) return { success: false, error: 'No library path configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };
  if (!token) return { success: false, error: 'ADS token not configured' };

  const results = { success: [], failed: [], skipped: [] };
  const total = paperIds.length;

  sendConsoleLog(`Starting batch PDF download for ${total} papers...`, 'info');

  for (let i = 0; i < paperIds.length; i++) {
    const paperId = paperIds[i];
    const paper = database.getPaper(paperId);

    if (!paper) {
      results.failed.push({ paperId, error: 'Paper not found' });
      continue;
    }

    // Skip papers that already have a PDF
    if (paper.pdf_path && fs.existsSync(path.join(libraryPath, paper.pdf_path))) {
      results.skipped.push({ paperId, bibcode: paper.bibcode, reason: 'Already has PDF' });
      event.sender.send('batch-download-progress', {
        current: i + 1,
        total,
        status: 'skipped',
        bibcode: paper.bibcode
      });
      continue;
    }

    if (!paper.bibcode) {
      results.failed.push({ paperId, error: 'No bibcode' });
      event.sender.send('batch-download-progress', {
        current: i + 1,
        total,
        status: 'failed',
        error: 'No bibcode'
      });
      continue;
    }

    try {
      // Get esources
      const esources = await adsApi.getEsources(token, paper.bibcode);
      if (!esources || esources.length === 0) {
        results.failed.push({ paperId, bibcode: paper.bibcode, error: 'No PDF sources' });
        event.sender.send('batch-download-progress', {
          current: i + 1,
          total,
          status: 'failed',
          bibcode: paper.bibcode,
          error: 'No PDF sources'
        });
        continue;
      }

      // Try to download PDF based on priority
      let downloaded = false;
      for (const sourceType of pdfPriority) {
        let targetSource = null;
        for (const source of esources) {
          const linkType = source.link_type || source.type || '';
          if (linkType.includes(sourceType) && source.url && source.url.startsWith('http')) {
            targetSource = source;
            break;
          }
        }

        if (targetSource) {
          // Generate filename
          const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filename = `${baseFilename}_${sourceType}.pdf`;
          const destPath = path.join(libraryPath, 'papers', filename);

          // Ensure papers directory exists
          const papersDir = path.join(libraryPath, 'papers');
          if (!fs.existsSync(papersDir)) {
            fs.mkdirSync(papersDir, { recursive: true });
          }

          // Download
          let downloadUrl = targetSource.url;
          if (sourceType === 'PUB_PDF' && proxyUrl) {
            downloadUrl = proxyUrl + encodeURIComponent(targetSource.url);
          }

          try {
            await pdfDownload.downloadFile(downloadUrl, destPath);
            const relativePath = `papers/${filename}`;
            database.updatePaper(paperId, { pdf_path: relativePath });
            results.success.push({ paperId, bibcode: paper.bibcode, source: sourceType });
            downloaded = true;
            break;
          } catch (dlErr) {
            // Try next source type
            continue;
          }
        }
      }

      if (!downloaded) {
        results.failed.push({ paperId, bibcode: paper.bibcode, error: 'All sources failed' });
      }

      event.sender.send('batch-download-progress', {
        current: i + 1,
        total,
        status: downloaded ? 'success' : 'failed',
        bibcode: paper.bibcode
      });

      // Rate limiting - delay between downloads
      if (i < paperIds.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      results.failed.push({ paperId, bibcode: paper.bibcode, error: error.message });
      event.sender.send('batch-download-progress', {
        current: i + 1,
        total,
        status: 'failed',
        bibcode: paper.bibcode,
        error: error.message
      });
    }
  }

  sendConsoleLog(`Batch download complete: ${results.success.length} downloaded, ${results.skipped.length} skipped, ${results.failed.length} failed`, 'success');
  return { success: true, results };
});

// Attach a PDF file to a paper (copies file to library storage)
ipcMain.handle('attach-pdf-to-paper', async (event, paperId, sourcePdfPath) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library path configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const paper = database.getPaper(paperId);
  if (!paper) return { success: false, error: 'Paper not found' };

  try {
    // Ensure papers directory exists
    const papersDir = path.join(libraryPath, 'papers');
    if (!fs.existsSync(papersDir)) {
      fs.mkdirSync(papersDir, { recursive: true });
    }

    // Generate filename based on bibcode or paper ID
    const baseFilename = paper.bibcode
      ? paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_')
      : `paper_${paperId}`;
    const filename = `${baseFilename}_ATTACHED.pdf`;
    const destPath = path.join(papersDir, filename);

    // Copy the file to library storage
    fs.copyFileSync(sourcePdfPath, destPath);

    // Update database with relative path and source type
    const relativePath = `papers/${filename}`;
    database.updatePaper(paperId, { pdf_path: relativePath, pdf_source: 'ATTACHED' });

    sendConsoleLog(`Attached PDF to paper: ${paper.title?.substring(0, 40)}...`, 'success');
    return { success: true, pdfPath: relativePath, sourceType: 'ATTACHED' };
  } catch (error) {
    sendConsoleLog(`Failed to attach PDF: ${error.message}`, 'error');
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

      // Fetch refs/cites in parallel
      sendConsoleLog(`[${bibcode}] Fetching refs & cites...`, 'info');
      const [refs, cits] = await Promise.all([
        adsApi.getReferences(token, adsData.bibcode).catch(() => []),
        adsApi.getCitations(token, adsData.bibcode).catch(() => [])
      ]);

      database.addReferences(paper.id, refs.map(r => ({
        bibcode: r.bibcode,
        title: r.title?.[0],
        authors: r.author?.join(', '),
        year: r.year
      })), false);

      database.addCitations(paper.id, cits.map(c => ({
        bibcode: c.bibcode,
        title: c.title?.[0],
        authors: c.author?.join(', '),
        year: c.year
      })), false);

      if (refs.length > 0 || cits.length > 0) {
        sendConsoleLog(`[${bibcode}] Found ${refs.length} refs, ${cits.length} cites`, 'success');
      }

      // Download PDF if missing
      const pdfExists = libraryPath && paper.pdf_path && fs.existsSync(path.join(libraryPath, paper.pdf_path));
      if (!pdfExists && libraryPath) {
        try {
          const proxyUrl = store.get('libraryProxyUrl');
          const pdfPriority = store.get('pdfSourcePriority') || defaultPdfPriority;
          const downloadResult = await pdfDownload.downloadPDF(
            { ...paper, ...mergedMetadata },
            libraryPath,
            token,
            adsApi,
            proxyUrl,
            pdfPriority,
            (msg, type) => sendConsoleLog(`[${bibcode}] ${msg}`, type)
          );
          if (downloadResult.success) {
            database.updatePaper(paper.id, { pdf_path: downloadResult.pdf_path }, false);
          }
        } catch (e) {
          sendConsoleLog(`[${bibcode}] PDF download failed: ${e.message}`, 'warn');
        }
      } else if (pdfExists) {
        sendConsoleLog(`[${bibcode}] PDF exists, skipping`, 'info');
      }

      sendConsoleLog(`[${bibcode}] ✓ Done`, 'success');
      return { success: true };
    } catch (error) {
      sendConsoleLog(`[${bibcode}] ✗ Error: ${error.message}`, 'error');
      return { success: false, error: error.message };
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

  for (let i = 0; i < selectedPapers.length; i++) {
    let paper = selectedPapers[i];

    // Send progress update
    mainWindow.webContents.send('import-progress', {
      current: i + 1,
      total: selectedPapers.length,
      paper: paper.title || paper.bibcode || 'Unknown'
    });

    try {
      // Check if already in library - improved duplicate detection
      if (paper.bibcode) {
        const existing = database.getPaperByBibcode(paper.bibcode);
        if (existing) {
          // Paper exists - check if it already has a PDF
          if (existing.pdf_path) {
            // Has PDF - skip entirely
            sendConsoleLog(`[${paper.bibcode}] Already has PDF, skipping`, 'info');
            results.skipped.push({ paper, reason: 'Already has PDF' });
            continue;
          } else {
            // No PDF - try to download PDF for existing paper
            sendConsoleLog(`[${paper.bibcode}] Exists but missing PDF, attempting download...`, 'info');

            const proxyUrl = store.get('libraryProxyUrl');
            const pdfPriority = store.get('pdfSourcePriority') || defaultPdfPriority;
            const downloadResult = await pdfDownload.downloadPDF(paper, libraryPath, token, adsApi, proxyUrl, pdfPriority,
              (msg, type) => sendConsoleLog(`[${paper.bibcode}] ${msg}`, type)
            );

            if (downloadResult.success && downloadResult.path) {
              // Extract text from downloaded PDF
              const textFilename = path.basename(downloadResult.path, '.pdf') + '.txt';
              const fullTextPath = path.join(libraryPath, 'text', textFilename);

              // Ensure text directory exists
              const textDir = path.join(libraryPath, 'text');
              if (!fs.existsSync(textDir)) {
                fs.mkdirSync(textDir, { recursive: true });
              }

              await pdfImport.extractText(downloadResult.path, fullTextPath);
              const textPath = `text/${textFilename}`;

              // Update existing paper with PDF path
              database.updatePaper(existing.id, {
                pdf_path: downloadResult.pdf_path,
                text_path: textPath
              });

              sendConsoleLog(`[${paper.bibcode}] PDF downloaded for existing paper`, 'success');
              results.imported.push({ paper, id: existing.id, hasPdf: true, pdfSource: downloadResult.source, wasUpdate: true });
            } else {
              sendConsoleLog(`[${paper.bibcode}] Still no PDF available`, 'warn');
              results.skipped.push({ paper, reason: 'No PDF available (existing paper)' });
            }
            continue;
          }
        }
      }

      sendConsoleLog(`[${paper.bibcode || 'unknown'}] Importing...`, 'info');

      // If we only have bibcode, fetch full metadata from ADS
      if (paper.bibcode && !paper.title) {
        sendConsoleLog(`[${paper.bibcode}] Fetching metadata...`, 'info');
        const metadata = await adsApi.getByBibcode(token, paper.bibcode);
        if (metadata) {
          paper = {
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
        } else {
          sendConsoleLog(`[${paper.bibcode}] Could not fetch metadata`, 'warn');
        }
      }

      // Try to download PDF
      const proxyUrl = store.get('libraryProxyUrl');
      const pdfPriority = store.get('pdfSourcePriority') || defaultPdfPriority;
      const downloadResult = await pdfDownload.downloadPDF(paper, libraryPath, token, adsApi, proxyUrl, pdfPriority,
        (msg, type) => sendConsoleLog(`[${paper.bibcode}] ${msg}`, type)
      );

      let textPath = null;
      if (downloadResult.success && downloadResult.path) {
        // Extract text from downloaded PDF
        const textFilename = path.basename(downloadResult.path, '.pdf') + '.txt';
        const fullTextPath = path.join(libraryPath, 'text', textFilename);

        // Ensure text directory exists
        const textDir = path.join(libraryPath, 'text');
        if (!fs.existsSync(textDir)) {
          fs.mkdirSync(textDir, { recursive: true });
        }

        await pdfImport.extractText(downloadResult.path, fullTextPath);
        textPath = `text/${textFilename}`;
      }

      // Get BibTeX for this paper
      let bibtexStr = null;
      if (paper.bibcode) {
        try {
          bibtexStr = await adsApi.exportBibtex(token, paper.bibcode);
        } catch (e) {
          // BibTeX fetch failed, not critical
        }
      }

      if (downloadResult.success) {
        sendConsoleLog(`[${paper.bibcode}] PDF downloaded`, 'success');
      } else {
        sendConsoleLog(`[${paper.bibcode}] No PDF available`, 'warn');
      }

      // Add paper to database
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
        pdf_path: downloadResult.pdf_path || null,
        text_path: textPath,
        bibtex: bibtexStr
      });

      // Fetch and store references/citations
      if (paper.bibcode) {
        try {
          sendConsoleLog(`[${paper.bibcode}] Fetching refs & cites...`, 'info');
          const [refs, cits] = await Promise.all([
            adsApi.getReferences(token, paper.bibcode).catch(() => []),
            adsApi.getCitations(token, paper.bibcode).catch(() => [])
          ]);

          sendConsoleLog(`[${paper.bibcode}] Found ${refs.length} refs, ${cits.length} cites`, 'success');

          database.addReferences(paperId, refs.map(r => ({
            bibcode: r.bibcode,
            title: r.title?.[0],
            authors: r.author?.join(', '),
            year: r.year
          })));

          database.addCitations(paperId, cits.map(c => ({
            bibcode: c.bibcode,
            title: c.title?.[0],
            authors: c.author?.join(', '),
            year: c.year
          })));
        } catch (e) {
          sendConsoleLog(`[${paper.bibcode}] Refs/cites fetch failed`, 'warn');
        }
      }

      sendConsoleLog(`[${paper.bibcode}] ✓ Imported`, 'success');
      results.imported.push({
        paper,
        id: paperId,
        hasPdf: downloadResult.success,
        pdfSource: downloadResult.source
      });

    } catch (error) {
      sendConsoleLog(`[${paper.bibcode || 'unknown'}] ✗ Import failed: ${error.message}`, 'error');
      results.failed.push({ paper, error: error.message });
    }

    // Small delay between imports for rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
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

// ===== References/Citations IPC Handlers =====

ipcMain.handle('get-references', (event, paperId) => {
  if (!dbInitialized) return [];
  return database.getReferences(paperId);
});

ipcMain.handle('get-citations', (event, paperId) => {
  if (!dbInitialized) return [];
  return database.getCitations(paperId);
});

ipcMain.handle('add-references', (event, paperId, refs) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };
  try {
    database.addReferences(paperId, refs);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('add-citations', (event, paperId, cites) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };
  try {
    database.addCitations(paperId, cites);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
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

    // Fetch refs/cites in background
    (async () => {
      try {
        const refs = await adsApi.getReferences(token, adsDoc.bibcode);
        const cits = await adsApi.getCitations(token, adsDoc.bibcode);

        database.addReferences(paperId, refs.map(r => ({
          bibcode: r.bibcode,
          title: r.title?.[0],
          authors: r.author?.join(', '),
          year: r.year
        })));

        database.addCitations(paperId, cits.map(c => ({
          bibcode: c.bibcode,
          title: c.title?.[0],
          authors: c.author?.join(', '),
          year: c.year
        })));
      } catch (e) {
        console.error('Failed to fetch refs/cites:', e.message);
      }
    })();

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

    // Try to download PDF
    const proxyUrl = store.get('libraryProxyUrl');
    const pdfPriority = store.get('pdfSourcePriority') || defaultPdfPriority;
    const downloadResult = await pdfDownload.downloadPDF(paper, libraryPath, token, adsApi, proxyUrl, pdfPriority,
      (msg, type) => sendConsoleLog(`[${paper.bibcode}] ${msg}`, type)
    );

    let textPath = null;
    if (downloadResult.success && downloadResult.path) {
      // Extract text from downloaded PDF
      const textFilename = path.basename(downloadResult.path, '.pdf') + '.txt';
      const fullTextPath = path.join(libraryPath, 'text', textFilename);

      // Ensure text directory exists
      const textDir = path.join(libraryPath, 'text');
      if (!fs.existsSync(textDir)) {
        fs.mkdirSync(textDir, { recursive: true });
      }

      await pdfImport.extractText(downloadResult.path, fullTextPath);
      textPath = `text/${textFilename}`;
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

    if (downloadResult.success) {
      sendConsoleLog(`[${paper.bibcode}] PDF downloaded`, 'success');
    } else {
      sendConsoleLog(`[${paper.bibcode}] No PDF available`, 'warn');
    }

    // Add paper to database
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
      pdf_path: downloadResult.pdf_path || null,
      text_path: textPath,
      bibtex: bibtexStr
    });

    // Fetch and store references/citations
    if (adsDoc.bibcode) {
      try {
        sendConsoleLog(`[${paper.bibcode}] Fetching refs & cites...`, 'info');
        const [refs, cits] = await Promise.all([
          adsApi.getReferences(token, adsDoc.bibcode).catch(e => {
            return [];
          }),
          adsApi.getCitations(token, adsDoc.bibcode).catch(e => {
            return [];
          })
        ]);

        sendConsoleLog(`[${paper.bibcode}] Found ${refs.length} refs, ${cits.length} cites`, 'success');

        database.addReferences(paperId, refs.map(r => ({
          bibcode: r.bibcode,
          title: r.title?.[0],
          authors: r.author?.join(', '),
          year: r.year
        })));

        database.addCitations(paperId, cits.map(c => ({
          bibcode: c.bibcode,
          title: c.title?.[0],
          authors: c.author?.join(', '),
          year: c.year
        })));
      } catch (e) {
        sendConsoleLog(`[${paper.bibcode}] Refs/cites fetch failed`, 'warn');
      }
    }

    // Update master.bib
    const allPapers = database.getAllPapers();
    bibtex.updateMasterBib(libraryPath, allPapers);

    sendConsoleLog(`[${paper.bibcode}] ✓ Import complete`, 'success');
    return {
      success: true,
      paperId,
      hasPdf: !!downloadResult.pdf_path
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

// Get list of PDF sources that have been downloaded for a paper
ipcMain.handle('get-downloaded-pdf-sources', (event, paperId) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath || !dbInitialized) return [];

  const paper = database.getPaper(paperId);
  if (!paper || !paper.bibcode) return [];

  const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
  const papersDir = path.join(libraryPath, 'papers');
  const downloadedSources = [];

  // Check for each source type: bibcode_SOURCETYPE.pdf
  const sourceTypes = ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF', 'ATTACHED'];
  for (const sourceType of sourceTypes) {
    const filename = `${baseFilename}_${sourceType}.pdf`;
    const filePath = path.join(papersDir, filename);
    if (fs.existsSync(filePath)) {
      downloadedSources.push(sourceType);
    }
  }

  return downloadedSources;
});

ipcMain.handle('delete-pdf', (event, paperId, sourceType) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath || !dbInitialized) return false;

  const paper = database.getPaper(paperId);
  if (!paper || !paper.bibcode) return false;

  const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${baseFilename}_${sourceType}.pdf`;
  const filePath = path.join(libraryPath, 'papers', filename);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      sendConsoleLog(`Deleted PDF: ${filename}`, 'info');

      // Also delete associated text file if it exists
      const textFilename = `${baseFilename}_${sourceType}.txt`;
      const textPath = path.join(libraryPath, 'text', textFilename);
      if (fs.existsSync(textPath)) {
        fs.unlinkSync(textPath);
      }

      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to delete PDF:', error);
    return false;
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

ipcMain.handle('get-attachments', (event, paperId) => {
  if (!dbInitialized) return [];
  return database.getAttachments(paperId);
});

ipcMain.handle('open-attachment', async (event, filename) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library path configured' };

  const fullPath = path.join(libraryPath, 'papers', filename);

  if (!fs.existsSync(fullPath)) {
    return { success: false, error: 'File not found' };
  }

  try {
    await shell.openPath(fullPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-attachment', (event, attachmentId) => {
  const libraryPath = store.get('libraryPath');
  if (!libraryPath) return { success: false, error: 'No library path configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  try {
    // Get attachment info first
    const attachment = database.getAttachment(attachmentId);
    if (!attachment) {
      return { success: false, error: 'Attachment not found' };
    }

    // Delete the file
    const filePath = path.join(libraryPath, 'papers', attachment.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Delete from database
    database.deleteAttachment(attachmentId);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ===== Utility IPC Handlers =====

ipcMain.handle('open-external', (event, url) => {
  console.log('Opening external URL:', url);
  shell.openExternal(url);
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
  const filename = `${baseFilename}_PUB_PDF.pdf`;
  const destPath = path.join(libraryPath, 'papers', filename);
  const papersDir = path.join(libraryPath, 'papers');

  // Ensure papers directory exists
  if (!fs.existsSync(papersDir)) {
    fs.mkdirSync(papersDir, { recursive: true });
  }

  // Check if publisher PDF already exists
  if (fs.existsSync(destPath)) {
    sendConsoleLog(`Publisher PDF already downloaded`, 'success');
    const relativePath = `papers/${filename}`;
    database.updatePaper(paperId, { pdf_path: relativePath });
    return { success: true, path: destPath, source: 'publisher', pdf_path: relativePath, alreadyExists: true };
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

    authWindow.setTitle('Publisher PDF - Click "Download PDF" if automatic download fails');

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

    function finishWithSuccess(relativePath) {
      if (resolved) return;
      resolved = true;
      downloadCompleted = true;
      database.updatePaper(paperId, { pdf_path: relativePath });
      console.log('PDF saved successfully:', destPath);
      if (!authWindow.isDestroyed()) {
        authWindow.close();
      }
      resolve({ success: true, path: destPath, pdf_path: relativePath });
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
        const stats = fs.statSync(destPath);
        if (stats.size < 1000) {
          fs.unlinkSync(destPath);
          return 'Downloaded file too small';
        }

        const fd = fs.openSync(destPath, 'r');
        const buffer = Buffer.alloc(8);
        fs.readSync(fd, buffer, 0, 8, 0);
        fs.closeSync(fd);

        const header = buffer.toString('ascii', 0, 5);
        if (header === '%PDF-') {
          return null; // Valid PDF
        } else {
          fs.unlinkSync(destPath);
          return 'Downloaded file is not a valid PDF';
        }
      } catch (e) {
        return `Failed to verify download: ${e.message}`;
      }
    }

    // Handle triggered downloads (when browser triggers a download)
    session.on('will-download', (event, item, webContents) => {
      console.log('Download triggered:', item.getFilename(), item.getMimeType());
      item.setSavePath(destPath);

      item.on('done', (event, state) => {
        if (state === 'completed') {
          console.log('Download completed:', destPath);
          const error = verifyPdf();
          if (error) {
            finishWithError(error);
          } else {
            finishWithSuccess(`papers/${filename}`);
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
          newHeaders['content-disposition'] = [`attachment; filename="${filename}"`];

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

    // Load the URL
    authWindow.loadURL(url);
  });
});

ipcMain.handle('show-in-finder', (event, filePath) => {
  shell.showItemInFolder(filePath);
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();

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
