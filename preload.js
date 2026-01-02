/**
 * ADS Reader - Preload Script
 * Exposes IPC methods to the renderer process via window.electronAPI
 *
 * Methods are organized by category:
 * - Library Management: Library path, folder selection, cloud status
 * - PDF Settings: Zoom, page positions
 * - Paper Management: CRUD operations, import, search
 * - ADS Integration: Search, sync, references, citations, esources
 * - ADS Search: Paper search and import
 * - BibTeX: Citation copying, export, import
 * - Collections: Folder organization
 * - References/Citations: Paper relationships
 * - LLM/AI: Summarization, Q&A, embeddings, semantic search
 * - Annotations: PDF highlights and notes
 * - Utilities: External links, file operations, console logging
 */

const { contextBridge, ipcRenderer } = require('electron');

// webUtils is available in Electron 22+ for getting file paths from File objects
let webUtils;
try {
  webUtils = require('electron').webUtils;
} catch (e) {
  console.warn('webUtils not available:', e.message);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ═══════════════════════════════════════════════════════════════════════════
  // FILE UTILITIES (for drag & drop)
  // ═══════════════════════════════════════════════════════════════════════════
  getPathForFile: (file) => {
    if (webUtils && webUtils.getPathForFile) {
      return webUtils.getPathForFile(file);
    }
    // Fallback for older Electron versions - file.path might work with nodeIntegration
    return file.path || null;
  },


  // ═══════════════════════════════════════════════════════════════════════════
  // LIBRARY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════
  getLibraryPath: () => ipcRenderer.invoke('get-library-path'),
  selectLibraryFolder: () => ipcRenderer.invoke('select-library-folder'),
  checkCloudStatus: (path) => ipcRenderer.invoke('check-cloud-status', path),
  getLibraryInfo: (path) => ipcRenderer.invoke('get-library-info', path),

  // iCloud Library Management
  getICloudContainerPath: () => ipcRenderer.invoke('get-icloud-container-path'),
  isICloudAvailable: () => ipcRenderer.invoke('is-icloud-available'),
  getAllLibraries: () => ipcRenderer.invoke('get-all-libraries'),
  createLibrary: (options) => ipcRenderer.invoke('create-library', options),
  switchLibrary: (libraryId) => ipcRenderer.invoke('switch-library', libraryId),
  deleteLibrary: (options) => ipcRenderer.invoke('delete-library', options),
  getLibraryFileInfo: (libraryId) => ipcRenderer.invoke('get-library-file-info', libraryId),
  getCurrentLibraryId: () => ipcRenderer.invoke('get-current-library-id'),

  // Library Migration
  checkMigrationNeeded: () => ipcRenderer.invoke('check-migration-needed'),
  migrateLibraryToICloud: (options) => ipcRenderer.invoke('migrate-library-to-icloud', options),
  registerLibraryLocal: (options) => ipcRenderer.invoke('register-library-local', options),

  // Library Conflict Detection
  checkLibraryConflicts: (libraryPath) => ipcRenderer.invoke('check-library-conflicts', libraryPath),
  resolveLibraryConflict: (options) => ipcRenderer.invoke('resolve-library-conflict', options),

  // ═══════════════════════════════════════════════════════════════════════════
  // PDF SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════
  getPdfZoom: () => ipcRenderer.invoke('get-pdf-zoom'),
  setPdfZoom: (zoom) => ipcRenderer.invoke('set-pdf-zoom', zoom),

  // Sort preferences persistence
  getSortPreferences: () => ipcRenderer.invoke('get-sort-preferences'),
  setSortPreferences: (field, order) => ipcRenderer.invoke('set-sort-preferences', field, order),

  // Focus mode split position persistence
  getFocusSplitPosition: () => ipcRenderer.invoke('get-focus-split-position'),
  setFocusSplitPosition: (position) => ipcRenderer.invoke('set-focus-split-position', position),

  // Last selected paper persistence
  getLastSelectedPaper: () => ipcRenderer.invoke('get-last-selected-paper'),
  setLastSelectedPaper: (paperId) => ipcRenderer.invoke('set-last-selected-paper', paperId),

  // PDF page positions persistence
  getPdfPositions: () => ipcRenderer.invoke('get-pdf-positions'),
  setPdfPosition: (paperId, position) => ipcRenderer.invoke('set-pdf-position', paperId, position),

  // Last viewed PDF source persistence
  getLastPdfSources: () => ipcRenderer.invoke('get-last-pdf-sources'),
  setLastPdfSource: (paperId, sourceType) => ipcRenderer.invoke('set-last-pdf-source', paperId, sourceType),

  // ═══════════════════════════════════════════════════════════════════════════
  // PAPER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════
  importPDFs: () => ipcRenderer.invoke('import-pdfs'),
  importFiles: () => ipcRenderer.invoke('import-files'),
  getAllPapers: (options) => ipcRenderer.invoke('get-all-papers', options),
  getPaper: (id) => ipcRenderer.invoke('get-paper', id),
  updatePaper: (id, updates) => ipcRenderer.invoke('update-paper', id, updates),
  deletePaper: (id) => ipcRenderer.invoke('delete-paper', id),
  deletePapersBulk: (ids) => ipcRenderer.invoke('delete-papers-bulk', ids),
  getPdfPath: (relativePath) => ipcRenderer.invoke('get-pdf-path', relativePath),
  searchPapers: (query) => ipcRenderer.invoke('search-papers', query),

  // ═══════════════════════════════════════════════════════════════════════════
  // ADS INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════════
  getAdsToken: () => ipcRenderer.invoke('get-ads-token'),
  setAdsToken: (token) => ipcRenderer.invoke('set-ads-token', token),
  getLibraryProxy: () => ipcRenderer.invoke('get-library-proxy'),
  setLibraryProxy: (proxyUrl) => ipcRenderer.invoke('set-library-proxy', proxyUrl),
  getPdfPriority: () => ipcRenderer.invoke('get-pdf-priority'),
  setPdfPriority: (priority) => ipcRenderer.invoke('set-pdf-priority', priority),
  adsSearch: (query, options) => ipcRenderer.invoke('ads-search', query, options),
  adsLookup: (identifier, type) => ipcRenderer.invoke('ads-lookup', identifier, type),
  adsGetReferences: (bibcode, options) => ipcRenderer.invoke('ads-get-references', bibcode, options),
  adsGetCitations: (bibcode, options) => ipcRenderer.invoke('ads-get-citations', bibcode, options),
  adsGetEsources: (bibcode) => ipcRenderer.invoke('ads-get-esources', bibcode),
  downloadPdfFromSource: (paperId, sourceType) => ipcRenderer.invoke('download-pdf-from-source', paperId, sourceType),
  batchDownloadPdfs: (paperIds) => ipcRenderer.invoke('batch-download-pdfs', paperIds),
  onBatchDownloadProgress: (callback) => ipcRenderer.on('batch-download-progress', (event, data) => callback(data)),
  removeBatchDownloadListeners: () => ipcRenderer.removeAllListeners('batch-download-progress'),
  attachPdfToPaper: (paperId, pdfPath) => ipcRenderer.invoke('attach-pdf-to-paper', paperId, pdfPath),
  adsSyncPapers: (paperIds) => ipcRenderer.invoke('ads-sync-papers', paperIds),
  adsCancelSync: () => ipcRenderer.invoke('ads-cancel-sync'),
  adsUpdateCitationCounts: (paperIds) => ipcRenderer.invoke('ads-update-citation-counts', paperIds),
  onAdsSyncProgress: (callback) => ipcRenderer.on('ads-sync-progress', (event, data) => callback(data)),
  removeAdsSyncListeners: () => ipcRenderer.removeAllListeners('ads-sync-progress'),

  // ═══════════════════════════════════════════════════════════════════════════
  // ADS SEARCH & IMPORT
  // ═══════════════════════════════════════════════════════════════════════════
  adsImportSearch: (query, options) => ipcRenderer.invoke('ads-import-search', query, options),
  adsImportPapers: (papers) => ipcRenderer.invoke('ads-import-papers', papers),
  onImportProgress: (callback) => ipcRenderer.on('import-progress', (event, data) => callback(data)),
  onImportComplete: (callback) => ipcRenderer.on('import-complete', (event, data) => callback(data)),
  removeImportListeners: () => {
    ipcRenderer.removeAllListeners('import-progress');
    ipcRenderer.removeAllListeners('import-complete');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BIBTEX
  // ═══════════════════════════════════════════════════════════════════════════
  copyCite: (paperId, style) => ipcRenderer.invoke('copy-cite', paperId, style),
  exportBibtex: (paperIds) => ipcRenderer.invoke('export-bibtex', paperIds),
  saveBibtexFile: (content) => ipcRenderer.invoke('save-bibtex-file', content),
  saveBibtex: (paperId, bibtex) => ipcRenderer.invoke('save-bibtex', paperId, bibtex),
  importBibtex: () => ipcRenderer.invoke('import-bibtex'),
  importBibtexFromPath: (filePath) => ipcRenderer.invoke('import-bibtex-from-path', filePath),

  // ═══════════════════════════════════════════════════════════════════════════
  // LIBRARY EXPORT/IMPORT
  // ═══════════════════════════════════════════════════════════════════════════
  getExportStats: () => ipcRenderer.invoke('get-export-stats'),
  exportLibrary: (options) => ipcRenderer.invoke('export-library', options),
  previewLibraryImport: (filePath) => ipcRenderer.invoke('preview-library-import', filePath),
  importLibrary: (options) => ipcRenderer.invoke('import-library', options),
  shareFileNative: (filePath, title) => ipcRenderer.invoke('share-file-native', filePath, title),
  composeEmail: (options) => ipcRenderer.invoke('compose-email', options),
  onExportProgress: (callback) => ipcRenderer.on('export-progress', (event, data) => callback(data)),
  onLibraryImportProgress: (callback) => ipcRenderer.on('import-library-progress', (event, data) => callback(data)),
  removeExportImportListeners: () => {
    ipcRenderer.removeAllListeners('export-progress');
    ipcRenderer.removeAllListeners('import-library-progress');
    ipcRenderer.removeAllListeners('show-export-modal');
    ipcRenderer.removeAllListeners('show-import-modal');
  },
  onShowExportModal: (callback) => ipcRenderer.on('show-export-modal', () => callback()),
  onShowImportModal: (callback) => ipcRenderer.on('show-import-modal', () => callback()),

  // ═══════════════════════════════════════════════════════════════════════════
  // COLLECTIONS
  // ═══════════════════════════════════════════════════════════════════════════
  getCollections: () => ipcRenderer.invoke('get-collections'),
  createCollection: (name, parentId, isSmart, query) => ipcRenderer.invoke('create-collection', name, parentId, isSmart, query),
  deleteCollection: (collectionId) => ipcRenderer.invoke('delete-collection', collectionId),
  addPaperToCollection: (paperId, collectionId) => ipcRenderer.invoke('add-paper-to-collection', paperId, collectionId),
  removePaperFromCollection: (paperId, collectionId) => ipcRenderer.invoke('remove-paper-from-collection', paperId, collectionId),
  getPapersInCollection: (collectionId) => ipcRenderer.invoke('get-papers-in-collection', collectionId),

  // ═══════════════════════════════════════════════════════════════════════════
  // REFERENCES & CITATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  getReferences: (paperId) => ipcRenderer.invoke('get-references', paperId),
  getCitations: (paperId) => ipcRenderer.invoke('get-citations', paperId),
  addReferences: (paperId, refs) => ipcRenderer.invoke('add-references', paperId, refs),
  addCitations: (paperId, cites) => ipcRenderer.invoke('add-citations', paperId, cites),

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM / AI
  // ═══════════════════════════════════════════════════════════════════════════
  getLlmConfig: () => ipcRenderer.invoke('get-llm-config'),
  setLlmConfig: (config) => ipcRenderer.invoke('set-llm-config', config),
  checkLlmConnection: () => ipcRenderer.invoke('check-llm-connection'),
  listLlmModels: () => ipcRenderer.invoke('list-llm-models'),
  llmSummarize: (paperId, options) => ipcRenderer.invoke('llm-summarize', paperId, options),
  llmAsk: (paperId, question, options) => ipcRenderer.invoke('llm-ask', paperId, question, options),
  llmExplain: (text, paperId) => ipcRenderer.invoke('llm-explain', text, paperId),
  llmGenerateEmbeddings: (paperId) => ipcRenderer.invoke('llm-generate-embeddings', paperId),
  llmGetUnindexedPapers: () => ipcRenderer.invoke('llm-get-unindexed-papers'),
  llmExtractMetadata: (paperId) => ipcRenderer.invoke('llm-extract-metadata', paperId),
  applyAdsMetadata: (paperId, adsDoc) => ipcRenderer.invoke('apply-ads-metadata', paperId, adsDoc),
  importSingleFromAds: (adsDoc) => ipcRenderer.invoke('import-single-from-ads', adsDoc),
  llmSemanticSearch: (query, limit) => ipcRenderer.invoke('llm-semantic-search', query, limit),
  llmGetQAHistory: (paperId) => ipcRenderer.invoke('llm-get-qa-history', paperId),
  llmClearQAHistory: (paperId) => ipcRenderer.invoke('llm-clear-qa-history', paperId),
  llmDeleteSummary: (paperId) => ipcRenderer.invoke('llm-delete-summary', paperId),
  onLlmStream: (callback) => ipcRenderer.on('llm-stream', (event, data) => callback(data)),
  removeLlmListeners: () => ipcRenderer.removeAllListeners('llm-stream'),

  // Multi-provider LLM support
  getAllProviders: () => ipcRenderer.invoke('get-all-providers'),
  getApiKey: (provider) => ipcRenderer.invoke('get-api-key', provider),
  setApiKey: (provider, key) => ipcRenderer.invoke('set-api-key', provider, key),
  deleteApiKey: (provider) => ipcRenderer.invoke('delete-api-key', provider),
  testProviderConnection: (provider) => ipcRenderer.invoke('test-provider-connection', provider),
  getProviderModels: (provider) => ipcRenderer.invoke('get-provider-models', provider),
  getSummaryPrompt: () => ipcRenderer.invoke('get-summary-prompt'),
  setSummaryPrompt: (prompt) => ipcRenderer.invoke('set-summary-prompt', prompt),
  resetSummaryPrompt: () => ipcRenderer.invoke('reset-summary-prompt'),

  // ═══════════════════════════════════════════════════════════════════════════
  // ANNOTATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  getAnnotations: (paperId) => ipcRenderer.invoke('get-annotations', paperId),
  getAnnotationCountsBySource: (paperId) => ipcRenderer.invoke('get-annotation-counts-by-source', paperId),
  getDownloadedPdfSources: (paperId) => ipcRenderer.invoke('get-downloaded-pdf-sources', paperId),
  getPaperPdfPaths: (paperId) => ipcRenderer.invoke('get-paper-pdf-paths', paperId),
  deletePdf: (paperId, sourceType) => ipcRenderer.invoke('delete-pdf', paperId, sourceType),
  startFileDrag: (filePath) => ipcRenderer.send('start-file-drag', filePath),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
  createAnnotation: (paperId, data) => ipcRenderer.invoke('create-annotation', paperId, data),
  updateAnnotation: (id, data) => ipcRenderer.invoke('update-annotation', id, data),
  deleteAnnotation: (id) => ipcRenderer.invoke('delete-annotation', id),
  exportAnnotations: (paperId) => ipcRenderer.invoke('export-annotations', paperId),

  // PDF Page Rotations
  getPageRotations: (paperId, pdfSource) => ipcRenderer.invoke('get-page-rotations', paperId, pdfSource),
  setPageRotation: (paperId, pageNumber, rotation, pdfSource) => ipcRenderer.invoke('set-page-rotation', paperId, pageNumber, rotation, pdfSource),

  // ═══════════════════════════════════════════════════════════════════════════
  // ATTACHMENTS (LEGACY - will be removed after migration)
  // ═══════════════════════════════════════════════════════════════════════════
  attachFiles: (paperId, bibcode) => ipcRenderer.invoke('attach-files', paperId, bibcode),
  getAttachments: (paperId) => ipcRenderer.invoke('get-attachments', paperId),
  openAttachment: (filename) => ipcRenderer.invoke('open-attachment', filename),
  deleteAttachment: (attachmentId) => ipcRenderer.invoke('delete-attachment', attachmentId),

  // ═══════════════════════════════════════════════════════════════════════════
  // PAPER FILES (New unified file management system)
  // ═══════════════════════════════════════════════════════════════════════════
  paperFiles: {
    add: (paperId, filePath, options) => ipcRenderer.invoke('paper-files:add', paperId, filePath, options),
    remove: (fileId) => ipcRenderer.invoke('paper-files:remove', fileId),
    get: (fileId) => ipcRenderer.invoke('paper-files:get', fileId),
    list: (paperId, filters) => ipcRenderer.invoke('paper-files:list', paperId, filters),
    getPrimaryPdf: (paperId) => ipcRenderer.invoke('paper-files:get-primary-pdf', paperId),
    setPrimaryPdf: (paperId, fileId) => ipcRenderer.invoke('paper-files:set-primary-pdf', paperId, fileId),
    getPath: (fileId) => ipcRenderer.invoke('paper-files:get-path', fileId),
    rescan: (paperId) => ipcRenderer.invoke('paper-files:rescan', paperId),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DOWNLOAD QUEUE (New download queue management)
  // ═══════════════════════════════════════════════════════════════════════════
  downloadQueue: {
    enqueue: (paperId, sourceType, priority) => ipcRenderer.invoke('download-queue:enqueue', paperId, sourceType, priority),
    enqueueMany: (paperIds, sourceType) => ipcRenderer.invoke('download-queue:enqueue-many', paperIds, sourceType),
    cancel: (paperId) => ipcRenderer.invoke('download-queue:cancel', paperId),
    cancelAll: () => ipcRenderer.invoke('download-queue:cancel-all'),
    status: () => ipcRenderer.invoke('download-queue:status'),
    pause: () => ipcRenderer.invoke('download-queue:pause'),
    resume: () => ipcRenderer.invoke('download-queue:resume'),
    onProgress: (callback) => ipcRenderer.on('download-queue:progress', (event, data) => callback(data)),
    onComplete: (callback) => ipcRenderer.on('download-queue:complete', (event, data) => callback(data)),
    onError: (callback) => ipcRenderer.on('download-queue:error', (event, data) => callback(data)),
    removeListeners: () => {
      ipcRenderer.removeAllListeners('download-queue:progress');
      ipcRenderer.removeAllListeners('download-queue:complete');
      ipcRenderer.removeAllListeners('download-queue:error');
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  downloadPublisherPdf: (paperId, publisherUrl, proxyUrl) => ipcRenderer.invoke('download-publisher-pdf', paperId, publisherUrl, proxyUrl),
  showInFinder: (filePath) => ipcRenderer.invoke('show-in-finder', filePath),

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENTS (from main process)
  // ═══════════════════════════════════════════════════════════════════════════
  onConsoleLog: (callback) => ipcRenderer.on('console-log', (event, data) => callback(data)),
  removeConsoleLogListeners: () => ipcRenderer.removeAllListeners('console-log'),
  onShowFeedbackModal: (callback) => ipcRenderer.on('show-feedback-modal', () => callback()),

  // Platform info
  platform: process.platform
});
