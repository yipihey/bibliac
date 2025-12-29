const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

// Import modules
const database = require('./src/main/database');
const pdfImport = require('./src/main/pdf-import');
const pdfDownload = require('./src/main/pdf-download');
const adsApi = require('./src/main/ads-api');
const bibtex = require('./src/main/bibtex');
const { OllamaService, PROMPTS, chunkText, cosineSimilarity, parseSummaryResponse, parseMetadataResponse } = require('./src/main/llm-service');

// Initialize LLM service (will be configured from settings)
let llmService = null;

// Helper to send console log messages to renderer
function sendConsoleLog(message, type = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('console-log', { message, type });
  }
  // Also log to terminal
  console.log(`[${type.toUpperCase()}] ${message}`);
}

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
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen3:30b',
      embeddingModel: 'nomic-embed-text'
    },
    libraryProxyUrl: null  // e.g., 'https://proxy.library.edu/login?url='
  }
});

// Migration: fix localhost to 127.0.0.1 for IPv6 compatibility and update model
const llmConfig = store.get('llmConfig');
if (llmConfig) {
  let updated = false;
  if (llmConfig.endpoint && llmConfig.endpoint.includes('localhost')) {
    llmConfig.endpoint = llmConfig.endpoint.replace('localhost', '127.0.0.1');
    updated = true;
  }
  // Update model if it's the old default
  if (llmConfig.model === 'qwen3:8b') {
    llmConfig.model = 'qwen3:30b';
    updated = true;
  }
  if (updated) {
    store.set('llmConfig', llmConfig);
  }
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
      console.log(`Trying DOI lookup: ${paper.doi}`);
      adsData = await adsApi.getByDOI(token, paper.doi);
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
          console.log(`Trying extracted DOI: ${contentIds.doi}`);
          adsData = await adsApi.getByDOI(token, contentIds.doi);
          if (adsData) {
            // Update paper with found DOI
            database.updatePaper(paperId, { doi: contentIds.doi });
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
              const llmResponse = await service.generate(
                PROMPTS.extractMetadata.user(textContent),
                {
                  systemPrompt: PROMPTS.extractMetadata.system,
                  temperature: 0.1,
                  maxTokens: 500,
                  noThink: true  // Disable thinking mode for faster extraction
                }
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
    title: 'SciX Reader',
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
    fs.writeFileSync(bibPath, '% SciX Reader Master BibTeX File\n% Auto-generated\n\n');
  }

  return true;
}

// ===== Library Management IPC Handlers =====

ipcMain.handle('get-library-path', () => store.get('libraryPath'));

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
  return database.getAllPapers(options);
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
  return path.join(libraryPath, relativePath);
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
ipcMain.handle('get-library-proxy', () => store.get('libraryProxyUrl'));

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

ipcMain.handle('ads-get-references', async (event, bibcode) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };

  try {
    const refs = await adsApi.getReferences(token, bibcode);
    return { success: true, data: refs };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ads-get-citations', async (event, bibcode) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };

  try {
    const cits = await adsApi.getCitations(token, bibcode);
    return { success: true, data: cits };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get available PDF sources for a paper
ipcMain.handle('ads-get-esources', async (event, bibcode) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };

  try {
    const esources = await adsApi.getEsources(token, bibcode);
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
      const pdfUrl = convertPublisherHtmlToPdf(pubHtmlUrl);
      if (pdfUrl) {
        sources.publisher = { url: pdfUrl, type: 'PUB_PDF_DERIVED', label: 'Publisher', originalUrl: pubHtmlUrl };
        console.log(`Derived publisher PDF URL: ${pdfUrl} from ${pubHtmlUrl}`);
      }
    }

    return { success: true, data: sources };
  } catch (error) {
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

  try {
    // Get esources
    const esources = await adsApi.getEsources(token, paper.bibcode);
    if (!esources || esources.length === 0) {
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
      return { success: false, error: `${sourceType} PDF not available` };
    }

    // Generate filename
    const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${baseFilename}.pdf`;
    const destPath = path.join(libraryPath, 'papers', filename);
    const papersDir = path.join(libraryPath, 'papers');

    // Ensure papers directory exists
    if (!fs.existsSync(papersDir)) {
      fs.mkdirSync(papersDir, { recursive: true });
    }

    // Delete existing file if present
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }

    // Download the PDF
    let downloadUrl = targetSource.url;

    // Apply proxy for publisher PDFs if configured
    if (sourceType === 'publisher' && proxyUrl) {
      downloadUrl = proxyUrl + encodeURIComponent(targetSource.url);
      console.log(`Using library proxy for PUB_PDF: ${downloadUrl}`);
    }

    console.log(`Downloading ${sourceType} PDF from: ${downloadUrl}`);
    await pdfDownload.downloadFile(downloadUrl, destPath);

    // Update paper with PDF path
    const relativePath = `papers/${filename}`;
    database.updatePaper(paperId, { pdf_path: relativePath });

    console.log(`Downloaded ${sourceType} PDF for ${paper.bibcode}`);
    return { success: true, path: destPath, source: sourceType, pdf_path: relativePath };
  } catch (error) {
    console.error(`Failed to download ${sourceType} PDF:`, error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ads-fetch-metadata', async (event, paperId) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  // Use the comprehensive fetchAndApplyAdsMetadata helper which includes
  // fallback search by title/author if identifiers don't work
  const result = await fetchAndApplyAdsMetadata(paperId);

  if (!result.success) {
    return { success: false, error: result.reason || 'Paper not found in ADS' };
  }

  // Get updated paper with refs/cites counts
  const paper = database.getPaper(paperId);
  const refs = database.getReferences(paperId);
  const cits = database.getCitations(paperId);

  // Update master.bib
  const libraryPath = store.get('libraryPath');
  const allPapers = database.getAllPapers();
  bibtex.updateMasterBib(libraryPath, allPapers);

  return {
    success: true,
    data: {
      ...result.metadata,
      bibtex: paper.bibtex,
      referencesCount: refs.length,
      citationsCount: cits.length
    }
  };
});

// Sync selected papers with ADS - optimized bulk sync with parallel processing
ipcMain.handle('ads-sync-papers', async (event, paperIds = null) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const libraryPath = store.get('libraryPath');

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

  // Helper to process a single paper (for parallel execution)
  const processPaper = async (paper, adsData, bibtexMap = null) => {
    const bibcode = adsData.bibcode;
    const shortTitle = paper.title?.substring(0, 35) || 'Untitled';

    try {
      sendConsoleLog(`[${bibcode}] Updating metadata...`, 'info');
      const metadata = adsApi.adsToPaper(adsData);

      // Get BibTeX from pre-fetched map or existing
      let bibtexStr = bibtexMap?.get(adsData.bibcode) || paper.bibtex;

      // Update paper metadata (don't save yet - batch save at end)
      database.updatePaper(paper.id, {
        ...metadata,
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
        sendConsoleLog(`[${bibcode}] Downloading PDF...`, 'info');
        try {
          const proxyUrl = store.get('libraryProxyUrl');
          const pdfPriority = store.get('pdfSourcePriority') || defaultPdfPriority;
          const downloadResult = await pdfDownload.downloadPDF(
            { ...paper, ...metadata },
            libraryPath,
            token,
            adsApi,
            proxyUrl,
            pdfPriority
          );
          if (downloadResult.success) {
            database.updatePaper(paper.id, { pdf_path: downloadResult.pdf_path }, false);
            sendConsoleLog(`[${bibcode}] PDF downloaded`, 'success');
          }
        } catch (e) {
          sendConsoleLog(`[${bibcode}] PDF download failed: ${e.message}`, 'warn');
        }
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
    const adsMap = new Map(adsResults.map(r => [r.bibcode, r]));
    sendConsoleLog(`Fetched metadata for ${adsResults.length}/${bibcodes.length} papers`, 'success');

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
      const batch = papersWithBibcode.slice(i, i + CONCURRENCY);
      const batchNum = Math.floor(i / CONCURRENCY) + 1;
      const totalBatches = Math.ceil(papersWithBibcode.length / CONCURRENCY);

      sendConsoleLog(`Processing batch ${batchNum}/${totalBatches}...`, 'info');

      // Send progress update
      mainWindow.webContents.send('ads-sync-progress', {
        current: i + 1,
        total: papersToSync.length,
        paper: `Processing batch ${batchNum}/${totalBatches}...`
      });

      const promises = batch.map(async (paper) => {
        const adsData = adsMap.get(paper.bibcode);
        if (!adsData) {
          sendConsoleLog(`[${paper.bibcode}] Not found in ADS, skipping`, 'warn');
          results.skipped++;
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
        adsData = await adsApi.getByDOI(token, paper.doi);
        if (adsData) {
          sendConsoleLog(`Found via DOI: ${paper.doi}`, 'success');
        }
      }
      if (!adsData && paper.arxiv_id) {
        adsData = await adsApi.getByArxiv(token, paper.arxiv_id);
        if (adsData) {
          sendConsoleLog(`Found via arXiv: ${paper.arxiv_id}`, 'success');
        }
      }

      if (!adsData) {
        sendConsoleLog(`Not found on ADS, skipping`, 'warn');
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
      }
    } catch (error) {
      results.failed++;
      results.errors.push({ paper: paper.title, error: error.message });
    }
  }

  // Save database once at the end
  database.saveDatabase();

  // Update master.bib once at the end
  bibtex.updateMasterBib(libraryPath, database.getAllPapers());

  // Send completion
  sendConsoleLog(`Sync complete: ${results.updated} updated, ${results.skipped} skipped, ${results.failed} failed`,
    results.failed > 0 ? 'warn' : 'success');
  mainWindow.webContents.send('ads-sync-progress', { done: true, results });

  return { success: true, results };
});

// ===== SciX Search & Import IPC Handlers =====

ipcMain.handle('scix-search', async (event, query, options = {}) => {
  const token = store.get('adsToken');
  if (!token) return { success: false, error: 'No ADS API token configured' };

  try {
    sendConsoleLog(`SciX search: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`, 'info');
    const result = await adsApi.search(token, query, {
      rows: options.rows || 1000,
      start: options.start || 0,
      sort: options.sort || 'date desc'
    });

    sendConsoleLog(`SciX found ${result.numFound} results`, 'success');

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

ipcMain.handle('import-from-scix', async (event, selectedPapers) => {
  const token = store.get('adsToken');
  const libraryPath = store.get('libraryPath');

  if (!token) return { success: false, error: 'No ADS API token configured' };
  if (!libraryPath) return { success: false, error: 'No library selected' };
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  sendConsoleLog(`SciX import: ${selectedPapers.length} papers selected`, 'info');

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
      // Skip if already in library
      if (paper.bibcode && database.getPaperByBibcode(paper.bibcode)) {
        sendConsoleLog(`[${paper.bibcode}] Already in library, skipping`, 'warn');
        results.skipped.push({ paper, reason: 'Already in library' });
        continue;
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
      sendConsoleLog(`[${paper.bibcode}] Downloading PDF...`, 'info');
      const proxyUrl = store.get('libraryProxyUrl');
      const downloadResult = await pdfDownload.downloadPDF(paper, libraryPath, token, adsApi, proxyUrl);

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

// ===== LLM IPC Handlers =====

// Initialize or get LLM service
function getLlmService() {
  if (!llmService) {
    const config = store.get('llmConfig');
    llmService = new OllamaService(config);
  }
  return llmService;
}

ipcMain.handle('get-llm-config', () => {
  return store.get('llmConfig');
});

ipcMain.handle('set-llm-config', async (event, config) => {
  store.set('llmConfig', config);
  // Update existing service
  if (llmService) {
    llmService.updateConfig(config);
  } else {
    llmService = new OllamaService(config);
  }
  return { success: true };
});

ipcMain.handle('check-llm-connection', async () => {
  const service = getLlmService();
  return await service.checkConnection();
});

ipcMain.handle('list-llm-models', async () => {
  const service = getLlmService();
  return await service.listModels();
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

  const service = getLlmService();
  const connectionCheck = await service.checkConnection();
  if (!connectionCheck.connected) {
    return { success: false, error: connectionCheck.error || 'Ollama not connected' };
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

  // Build prompt
  const prompt = PROMPTS.summarize.user(paper.title, paper.abstract, fullText);

  try {
    // Stream chunks to renderer
    let fullResponse = '';
    const response = await service.generate(prompt, {
      systemPrompt: PROMPTS.summarize.system,
      onChunk: (chunk) => {
        if (chunk.response) {
          fullResponse += chunk.response;
          mainWindow.webContents.send('llm-stream', {
            type: 'summarize',
            paperId,
            chunk: chunk.response,
            done: chunk.done
          });
        }
      },
      temperature: 0.3,
      maxTokens: 1024
    });

    // Parse and cache result
    const parsed = parseSummaryResponse(fullResponse || response);
    database.saveSummary(paperId, parsed.summary, parsed.keyPoints, service.model);

    return { success: true, data: parsed };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('llm-ask', async (event, paperId, question) => {
  if (!dbInitialized) return { success: false, error: 'Database not initialized' };

  const paper = database.getPaper(paperId);
  if (!paper) return { success: false, error: 'Paper not found' };

  const service = getLlmService();
  const connectionCheck = await service.checkConnection();
  if (!connectionCheck.connected) {
    return { success: false, error: connectionCheck.error || 'Ollama not connected' };
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
    const response = await service.generate(prompt, {
      systemPrompt: PROMPTS.qa.system,
      onChunk: (chunk) => {
        // Send content chunks
        if (chunk.response) {
          fullResponse += chunk.response;
          mainWindow.webContents.send('llm-stream', {
            type: 'qa',
            paperId,
            chunk: chunk.response,
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
      },
      temperature: 0.5,
      maxTokens: 1024
    });

    const answer = fullResponse || response;

    // Cache the Q&A
    database.saveQA(paperId, question, answer, null, service.model);

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
    sendConsoleLog(`[${paper.bibcode}] Downloading PDF...`, 'info');
    const proxyUrl = store.get('libraryProxyUrl');
    const downloadResult = await pdfDownload.downloadPDF(paper, libraryPath, token, adsApi, proxyUrl);

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
  }

  console.log('Opening auth window for publisher PDF:', url);

  // Generate filename
  const baseFilename = (paper.bibcode || `paper_${paperId}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${baseFilename}.pdf`;
  const destPath = path.join(libraryPath, 'papers', filename);
  const papersDir = path.join(libraryPath, 'papers');

  // Ensure papers directory exists
  if (!fs.existsSync(papersDir)) {
    fs.mkdirSync(papersDir, { recursive: true });
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
              console.log('Triggering explicit downloadURL for:', detectedPdfUrl);
              downloadTriggeredForUrl = detectedPdfUrl;
              authWindow.webContents.downloadURL(detectedPdfUrl);
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
