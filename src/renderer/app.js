// ADS Reader - Main Renderer Application
console.log('[app.js] Loading...');

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

class ADSReader {
  constructor() {
    this.libraryPath = null;
    this.papers = [];
    this.selectedPaper = null;
    this.selectedPapers = new Set(); // Multi-select: Set of paper IDs
    this.lastClickedIndex = -1; // For shift-click range select
    this.currentView = 'all';
    this.currentCollection = null;
    this.collections = [];
    this.hasAdsToken = false;
    this.isIOS = false; // Platform detection

    // PDF state
    this.pdfDoc = null;
    this.pdfScale = 1.0; // Will be loaded from settings
    this.pageRotations = {};
    this.currentPdfSource = null; // Track which PDF source is currently loaded
    this.pdfPagePositions = {}; // Store last page position per paper ID
    this.isRendering = false; // Prevent concurrent renders
    this.pendingRender = null; // Queue next render if one is in progress

    // ADS search state
    this.adsResults = [];
    this.adsSelected = new Set();

    // Refs/Cites import state
    this.currentRefs = [];
    this.currentCites = [];
    this.selectedRefs = new Set();
    this.selectedCites = new Set();

    // LLM/AI state
    this.llmConnected = false;
    this.llmConfig = null;
    this.aiStreamingElement = null;
    this.currentPaperSummary = null;
    this.isAutoIndexing = false;

    // Sort state
    this.sortField = localStorage.getItem('sortField') || 'added';
    this.sortOrder = localStorage.getItem('sortOrder') || 'desc';

    // Annotations state
    this.annotations = [];
    this.currentAnnotation = null;
    this.pendingSelectionText = null;
    this.pendingSelectionRects = null;
    this.pendingSelectionPage = null;

    this.init();
  }

  async init() {
    // Wait for platform initialization (sets up window.electronAPI on iOS)
    if (window._platformReady) {
      try {
        await window._platformReady;
        console.log('[ADSReader] Platform ready');
      } catch (error) {
        console.error('[ADSReader] Platform initialization failed:', error);
        alert('Failed to initialize app. Please restart.');
        return;
      }
    }

    // Detect platform (iOS vs macOS/Electron)
    // Check multiple ways: API property, body class (set by platform-init.js), or Capacitor
    this.isIOS = window.electronAPI?.platform === 'ios' ||
                 document.body.classList.contains('ios') ||
                 window.Capacitor?.getPlatform?.() === 'ios';

    if (this.isIOS) {
      document.body.classList.add('ios-platform');
      console.log('[ADSReader] Running on iOS');
    }

    // Ensure electronAPI is available
    if (!window.electronAPI) {
      console.error('[ADSReader] No electronAPI available');
      alert('App initialization failed. No API available.');
      return;
    }

    this.libraryPath = await window.electronAPI.getLibraryPath();

    // Load saved PDF zoom level
    const savedZoom = await window.electronAPI.getPdfZoom();
    if (savedZoom) {
      this.pdfScale = savedZoom;
    }

    // Load saved PDF page positions
    this.pdfPagePositions = await window.electronAPI.getPdfPositions() || {};

    // Check if migration is needed for existing users
    await this.checkMigration();

    if (this.libraryPath) {
      const info = await window.electronAPI.getLibraryInfo(this.libraryPath);
      if (info) {
        this.showMainScreen(info);
        await this.loadPapers();
        await this.loadCollections();
        await this.checkAdsToken();
        await this.checkProxyStatus();
        await this.checkLlmConnection();

        // Check for sync conflicts (iCloud)
        await this.checkConflicts();

        // Restore last selected paper (with delay to ensure DOM is ready)
        const lastPaperId = await window.electronAPI.getLastSelectedPaper();
        if (lastPaperId && this.papers.find(p => p.id === lastPaperId)) {
          // Use requestAnimationFrame to ensure paper list is rendered
          requestAnimationFrame(() => {
            this.selectPaper(lastPaperId);
          });
        }
      } else {
        this.showSetupScreen();
      }
    } else {
      this.showSetupScreen();
    }

    this.setupEventListeners();
    this.setupLibraryPicker();
    document.title = 'ADS Reader';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIBRARY PICKER
  // ═══════════════════════════════════════════════════════════════════════════

  async setupLibraryPicker() {
    console.log('[setupLibraryPicker] Starting...');
    const picker = document.getElementById('library-picker');
    const currentLibrary = document.getElementById('current-library');
    const dropdown = document.getElementById('library-dropdown');
    const libraryList = document.getElementById('library-list');

    console.log('[setupLibraryPicker] Elements:', { picker: !!picker, currentLibrary: !!currentLibrary, dropdown: !!dropdown, libraryList: !!libraryList });

    if (!picker || !currentLibrary || !dropdown) {
      console.error('[setupLibraryPicker] Missing required elements, returning early!');
      return;
    }

    // Toggle dropdown on click
    currentLibrary.addEventListener('click', () => {
      picker.classList.toggle('open');
      dropdown.classList.toggle('hidden');
      if (!dropdown.classList.contains('hidden')) {
        this.loadLibraryList();
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!picker.contains(e.target)) {
        picker.classList.remove('open');
        dropdown.classList.add('hidden');
      }
    });

    // New library buttons
    const icloudBtn = document.getElementById('new-icloud-library');
    const localBtn = document.getElementById('new-local-library');

    console.log('[setupLibraryPicker] iCloud button:', icloudBtn);
    console.log('[setupLibraryPicker] Local button:', localBtn);

    if (icloudBtn) {
      icloudBtn.addEventListener('click', (e) => {
        console.log('[iCloud button] CLICKED!');
        e.stopPropagation();
        e.preventDefault();
        this.createNewLibrary('icloud');
      });
      console.log('[setupLibraryPicker] iCloud button handler attached');
    } else {
      console.error('[setupLibraryPicker] iCloud button NOT FOUND!');
    }

    if (localBtn) {
      localBtn.addEventListener('click', (e) => {
        console.log('[Local button] CLICKED!');
        e.stopPropagation();
        e.preventDefault();
        this.createNewLibrary('local');
      });
      console.log('[setupLibraryPicker] Local button handler attached');
    }

    // Load initial library info
    await this.updateLibraryPickerDisplay();
  }

  async loadLibraryList() {
    const libraryList = document.getElementById('library-list');
    if (!libraryList) return;

    try {
      const libraries = await window.electronAPI.getAllLibraries();
      const currentId = await window.electronAPI.getCurrentLibraryId();

      // Separate by location
      const iCloudLibs = libraries.filter(l => l.location === 'icloud');
      const localLibs = libraries.filter(l => l.location === 'local');

      let html = '';

      if (iCloudLibs.length > 0) {
        html += '<div class="library-section-label">iCloud</div>';
        for (const lib of iCloudLibs) {
          const isActive = lib.id === currentId;
          html += `
            <div class="library-item ${isActive ? 'active' : ''}" data-id="${lib.id}">
              <span class="lib-icon">☁️</span>
              <span class="lib-name">${this.escapeHtml(lib.name)}</span>
              <button class="lib-delete-btn" data-id="${lib.id}" title="Delete library">✕</button>
            </div>
          `;
        }
      }

      if (localLibs.length > 0) {
        html += '<div class="library-section-label">Local</div>';
        for (const lib of localLibs) {
          const isActive = lib.id === currentId;
          html += `
            <div class="library-item ${isActive ? 'active' : ''}" data-id="${lib.id}">
              <span class="lib-icon">💻</span>
              <span class="lib-name">${this.escapeHtml(lib.name)}</span>
              <button class="lib-delete-btn" data-id="${lib.id}" title="Delete library">✕</button>
            </div>
          `;
        }
      }

      if (libraries.length === 0) {
        html = '<div class="library-section-label">No libraries yet</div>';
      }

      libraryList.innerHTML = html;

      // Add click handlers for library items
      libraryList.querySelectorAll('.library-item').forEach(item => {
        item.addEventListener('click', (e) => {
          // Don't switch if clicking delete button
          if (e.target.classList.contains('lib-delete-btn')) return;
          this.switchToLibrary(item.dataset.id);
        });
      });

      // Add click handlers for delete buttons
      libraryList.querySelectorAll('.lib-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.confirmDeleteLibrary(btn.dataset.id);
        });
      });
    } catch (error) {
      console.error('Failed to load libraries:', error);
      libraryList.innerHTML = '<div class="library-section-label">Error loading libraries</div>';
    }
  }

  async updateLibraryPickerDisplay() {
    const nameEl = document.getElementById('library-name');
    const countEl = document.getElementById('library-count');
    const iconEl = document.getElementById('library-icon');

    if (!nameEl) return;

    if (this.libraryPath) {
      // Get current library info
      const libraries = await window.electronAPI.getAllLibraries?.() || [];
      const currentId = await window.electronAPI.getCurrentLibraryId?.();
      const currentLib = libraries.find(l => l.id === currentId);

      if (currentLib) {
        nameEl.textContent = currentLib.name;
        iconEl.textContent = currentLib.location === 'icloud' ? '☁️' : '💻';
      } else {
        // Fallback to path basename
        nameEl.textContent = this.libraryPath.split('/').pop() || 'Library';
        iconEl.textContent = '📁';
      }

      countEl.textContent = `${this.papers?.length || 0} papers`;
    } else {
      nameEl.textContent = 'No Library';
      countEl.textContent = 'Select or create a library';
      iconEl.textContent = '📁';
    }
  }

  async createNewLibrary(location) {
    console.log('[createNewLibrary] Called with location:', location);

    // Close the dropdown first
    document.getElementById('library-picker')?.classList.remove('open');
    document.getElementById('library-dropdown')?.classList.add('hidden');

    // Use custom prompt since Electron doesn't support native prompt()
    const name = await this.showPrompt(`Enter name for new ${location} library:`, 'My Library');
    console.log('[createNewLibrary] User entered name:', name);
    if (!name) {
      console.log('[createNewLibrary] No name entered, returning');
      return;
    }

    try {
      console.log('[createNewLibrary] Calling createLibrary API...');
      const result = await window.electronAPI.createLibrary({ name, location });
      console.log('[createNewLibrary] Result:', result);
      if (result.success) {
        this.consoleLog(`Created new ${location} library: ${name}`, 'success');

        // Switch to the new library
        await this.switchToLibrary(result.id);

        // Show main screen if we were on setup screen
        const setupScreen = document.getElementById('setup-screen');
        if (setupScreen && !setupScreen.classList.contains('hidden')) {
          this.showMainScreen({ path: result.path, name });
        }
      } else {
        this.consoleLog(`Failed to create library: ${result.error}`, 'error');
        alert(`Failed to create library: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to create library:', error);
      this.consoleLog(`Error creating library: ${error.message}`, 'error');
    }
  }

  async switchToLibrary(libraryId) {
    try {
      const result = await window.electronAPI.switchLibrary(libraryId);
      if (result.success) {
        this.libraryPath = result.path;
        this.consoleLog(`Switched to library at ${result.path}`, 'success');

        // Reload papers and collections
        await this.loadPapers();
        await this.loadCollections();
        await this.updateLibraryPickerDisplay();

        // Clear selection
        this.clearPaperDisplay();
      } else {
        this.consoleLog(`Failed to switch library: ${result.error}`, 'error');
        alert(`Failed to switch library: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to switch library:', error);
      this.consoleLog(`Error switching library: ${error.message}`, 'error');
    }

    // Close dropdown
    document.getElementById('library-picker')?.classList.remove('open');
    document.getElementById('library-dropdown')?.classList.add('hidden');
  }

  async confirmDeleteLibrary(libraryId) {
    // Find library info
    const libraries = await window.electronAPI.getAllLibraries();
    const library = libraries.find(l => l.id === libraryId);

    if (!library) {
      alert('Library not found');
      return;
    }

    // Get file info for the library
    const fileInfo = await window.electronAPI.getLibraryFileInfo(libraryId);

    // Show delete modal
    const modal = document.getElementById('delete-library-modal');
    const nameEl = document.getElementById('delete-library-name');
    const pathEl = document.getElementById('delete-library-path');
    const sizeEl = document.getElementById('delete-library-size');
    const fileListEl = document.getElementById('delete-library-file-list');
    const filesSectionEl = document.getElementById('delete-library-files-section');

    // Populate modal
    nameEl.textContent = library.name;
    pathEl.textContent = fileInfo.libraryPath || library.fullPath || 'Unknown path';
    sizeEl.textContent = `Total size: ${this.formatFileSize(fileInfo.totalSize)}`;

    // Populate file list
    if (fileInfo.files && fileInfo.files.length > 0) {
      filesSectionEl.style.display = 'block';

      // Group files by type
      const filesByType = {
        database: [],
        papers: [],
        text: [],
        other: []
      };

      for (const file of fileInfo.files) {
        if (file.path.endsWith('.sqlite')) {
          filesByType.database.push(file);
        } else if (file.path.startsWith('papers/')) {
          filesByType.papers.push(file);
        } else if (file.path.startsWith('text/')) {
          filesByType.text.push(file);
        } else {
          filesByType.other.push(file);
        }
      }

      let fileListHtml = '';

      // Show summary counts
      if (filesByType.database.length > 0) {
        fileListHtml += `<div class="file-group">
          <span class="file-group-icon">🗄️</span>
          <span class="file-group-name">Database</span>
          <span class="file-group-count">${filesByType.database.length} file(s)</span>
          <span class="file-group-size">${this.formatFileSize(filesByType.database.reduce((sum, f) => sum + f.size, 0))}</span>
        </div>`;
      }

      if (filesByType.papers.length > 0) {
        fileListHtml += `<div class="file-group">
          <span class="file-group-icon">📄</span>
          <span class="file-group-name">PDF Papers</span>
          <span class="file-group-count">${filesByType.papers.length} file(s)</span>
          <span class="file-group-size">${this.formatFileSize(filesByType.papers.reduce((sum, f) => sum + f.size, 0))}</span>
        </div>`;
      }

      if (filesByType.text.length > 0) {
        fileListHtml += `<div class="file-group">
          <span class="file-group-icon">📝</span>
          <span class="file-group-name">Extracted Text</span>
          <span class="file-group-count">${filesByType.text.length} file(s)</span>
          <span class="file-group-size">${this.formatFileSize(filesByType.text.reduce((sum, f) => sum + f.size, 0))}</span>
        </div>`;
      }

      if (filesByType.other.length > 0) {
        fileListHtml += `<div class="file-group">
          <span class="file-group-icon">📁</span>
          <span class="file-group-name">Other Files</span>
          <span class="file-group-count">${filesByType.other.length} file(s)</span>
          <span class="file-group-size">${this.formatFileSize(filesByType.other.reduce((sum, f) => sum + f.size, 0))}</span>
        </div>`;
      }

      fileListEl.innerHTML = fileListHtml;
    } else {
      filesSectionEl.style.display = 'none';
    }

    // Show modal
    modal.classList.remove('hidden');

    // Set up button handlers
    return new Promise((resolve) => {
      const deleteFilesBtn = document.getElementById('delete-library-delete-files');
      const removeOnlyBtn = document.getElementById('delete-library-remove-only');
      const cancelBtn = document.getElementById('delete-library-cancel');

      const cleanup = () => {
        modal.classList.add('hidden');
        deleteFilesBtn.removeEventListener('click', handleDeleteFiles);
        removeOnlyBtn.removeEventListener('click', handleRemoveOnly);
        cancelBtn.removeEventListener('click', handleCancel);
      };

      const handleDeleteFiles = async () => {
        cleanup();
        await this.executeDeleteLibrary(libraryId, library.name, true);
        resolve(true);
      };

      const handleRemoveOnly = async () => {
        cleanup();
        await this.executeDeleteLibrary(libraryId, library.name, false);
        resolve(true);
      };

      const handleCancel = () => {
        cleanup();
        resolve(false);
      };

      deleteFilesBtn.addEventListener('click', handleDeleteFiles);
      removeOnlyBtn.addEventListener('click', handleRemoveOnly);
      cancelBtn.addEventListener('click', handleCancel);
    });
  }

  async executeDeleteLibrary(libraryId, libraryName, deleteFiles) {
    try {
      const result = await window.electronAPI.deleteLibrary({
        libraryId,
        deleteFiles
      });

      if (result.success) {
        this.consoleLog(`Library "${libraryName}" deleted${deleteFiles ? ' with files' : ''}`, 'success');
        await this.loadLibraryList();
      } else {
        alert(`Failed to delete library: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to delete library:', error);
      alert(`Error deleting library: ${error.message}`);
    }
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Custom prompt dialog since Electron doesn't support native prompt()
  showPrompt(message, defaultValue = '') {
    return new Promise((resolve) => {
      // Create modal elements
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;';

      const dialog = document.createElement('div');
      dialog.style.cssText = 'background:var(--bg-primary,#1e1e1e);border-radius:8px;padding:20px;min-width:300px;box-shadow:0 4px 20px rgba(0,0,0,0.3);';

      const label = document.createElement('div');
      label.textContent = message;
      label.style.cssText = 'margin-bottom:12px;color:var(--text-primary,#fff);font-size:14px;';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = defaultValue;
      input.style.cssText = 'width:100%;padding:8px;border:1px solid var(--border,#444);border-radius:4px;background:var(--bg-secondary,#2d2d2d);color:var(--text-primary,#fff);font-size:14px;box-sizing:border-box;';

      const buttons = document.createElement('div');
      buttons.style.cssText = 'display:flex;gap:10px;margin-top:16px;justify-content:flex-end;';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'padding:8px 16px;border:1px solid var(--border,#444);border-radius:4px;background:transparent;color:var(--text-primary,#fff);cursor:pointer;';

      const okBtn = document.createElement('button');
      okBtn.textContent = 'OK';
      okBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:4px;background:var(--accent,#007aff);color:#fff;cursor:pointer;';

      buttons.appendChild(cancelBtn);
      buttons.appendChild(okBtn);
      dialog.appendChild(label);
      dialog.appendChild(input);
      dialog.appendChild(buttons);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      input.focus();
      input.select();

      const cleanup = () => document.body.removeChild(overlay);

      okBtn.onclick = () => { cleanup(); resolve(input.value.trim()); };
      cancelBtn.onclick = () => { cleanup(); resolve(null); };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { cleanup(); resolve(input.value.trim()); }
        if (e.key === 'Escape') { cleanup(); resolve(null); }
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIBRARY MIGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  async checkMigration() {
    try {
      const migration = await window.electronAPI.checkMigrationNeeded();

      if (migration.needed) {
        this.showMigrationModal(migration);
      }
    } catch (error) {
      console.error('Failed to check migration:', error);
    }
  }

  showMigrationModal(migration) {
    const modal = document.getElementById('migration-modal');
    const paperCountEl = document.getElementById('migration-paper-count');
    const iCloudOption = document.getElementById('migrate-icloud-option');
    const localOption = document.getElementById('migrate-local-option');
    const unavailableWarning = document.getElementById('migration-icloud-unavailable');

    if (!modal) return;

    // Update paper count
    paperCountEl.textContent = migration.paperCount || 0;

    // Handle iCloud availability
    if (!migration.iCloudAvailable) {
      iCloudOption.style.display = 'none';
      unavailableWarning.classList.remove('hidden');
    } else {
      iCloudOption.style.display = 'flex';
      unavailableWarning.classList.add('hidden');
    }

    // If already in iCloud, just register it
    if (migration.isInICloud) {
      // Auto-register as iCloud library
      this.handleMigrationChoice('icloud', migration.existingPath);
      return;
    }

    // Set up click handlers
    iCloudOption.onclick = () => this.handleMigrationChoice('icloud', migration.existingPath);
    localOption.onclick = () => this.handleMigrationChoice('local', migration.existingPath);

    // Show modal
    modal.classList.remove('hidden');
  }

  async handleMigrationChoice(choice, libraryPath) {
    const modal = document.getElementById('migration-modal');
    const optionsDiv = document.querySelector('.migration-options');
    const progressDiv = document.getElementById('migration-progress');

    try {
      // Show progress
      if (optionsDiv) optionsDiv.style.display = 'none';
      if (progressDiv) progressDiv.classList.remove('hidden');

      let result;
      if (choice === 'icloud') {
        result = await window.electronAPI.migrateLibraryToICloud({ libraryPath });
      } else {
        result = await window.electronAPI.registerLibraryLocal({ libraryPath });
      }

      if (result.success) {
        this.consoleLog(
          choice === 'icloud'
            ? 'Library migrated to iCloud successfully!'
            : 'Library registered as local.',
          'success'
        );

        // Update library path and reload
        this.libraryPath = result.path;
        await this.loadPapers();
        await this.loadCollections();
        await this.updateLibraryPickerDisplay();
      } else {
        this.consoleLog(`Migration failed: ${result.error}`, 'error');
        alert(`Migration failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Migration error:', error);
      this.consoleLog(`Migration error: ${error.message}`, 'error');
    }

    // Hide modal
    modal.classList.add('hidden');
    if (optionsDiv) optionsDiv.style.display = 'flex';
    if (progressDiv) progressDiv.classList.add('hidden');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIBRARY CONFLICT DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  async checkConflicts() {
    if (!this.libraryPath) return;

    try {
      const result = await window.electronAPI.checkLibraryConflicts?.(this.libraryPath);

      if (result?.hasConflicts && result.conflicts.length > 0) {
        this.showConflictModal(result.conflicts[0]);
      }
    } catch (error) {
      console.error('Failed to check conflicts:', error);
    }
  }

  showConflictModal(conflict) {
    const modal = document.getElementById('conflict-modal');
    const otherName = document.getElementById('conflict-other-name');
    const otherMeta = document.getElementById('conflict-other-meta');

    if (!modal) return;

    // Store current conflict for resolution
    this.currentConflict = conflict;

    // Update conflict info
    if (otherName) {
      otherName.textContent = conflict.filename;
    }
    if (otherMeta) {
      const date = new Date(conflict.modified);
      otherMeta.textContent = `Modified: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    }

    // Set up button handlers
    document.getElementById('conflict-keep-current')?.addEventListener('click', () => {
      this.resolveConflict('keep-current');
    }, { once: true });

    document.getElementById('conflict-keep-other')?.addEventListener('click', () => {
      this.resolveConflict('keep-conflict');
    }, { once: true });

    document.getElementById('conflict-backup-both')?.addEventListener('click', () => {
      this.resolveConflict('backup-both');
    }, { once: true });

    modal.classList.remove('hidden');
  }

  async resolveConflict(action) {
    const modal = document.getElementById('conflict-modal');

    try {
      const result = await window.electronAPI.resolveLibraryConflict({
        libraryPath: this.libraryPath,
        conflictPath: this.currentConflict.path,
        action
      });

      if (result.success) {
        this.consoleLog('Sync conflict resolved successfully', 'success');

        // Reload papers after resolution
        await this.loadPapers();
        await this.loadCollections();
      } else {
        this.consoleLog(`Failed to resolve conflict: ${result.error}`, 'error');
        alert(`Failed to resolve conflict: ${result.error}`);
      }
    } catch (error) {
      console.error('Conflict resolution error:', error);
      this.consoleLog(`Error resolving conflict: ${error.message}`, 'error');
    }

    // Hide modal
    modal?.classList.add('hidden');
    this.currentConflict = null;
  }

  setupEventListeners() {
    // Setup screen
    document.getElementById('select-folder-btn')?.addEventListener('click', () => this.selectLibraryFolder());
    document.getElementById('create-icloud-library-btn')?.addEventListener('click', () => this.createNewLibrary('icloud'));

    // Console panel toggle
    document.getElementById('console-header')?.addEventListener('click', () => this.toggleConsole());
    // Console starts expanded by default

    // Console panel resize
    this.setupConsoleResize();

    // Listen for console messages from main process
    window.electronAPI.onConsoleLog((data) => {
      this.consoleLog(data.message, data.type || 'info');
    });

    // Main screen
    document.getElementById('change-library-btn')?.addEventListener('click', () => this.selectLibraryFolder());
    document.getElementById('import-btn')?.addEventListener('click', () => this.importPDFs());
    document.getElementById('import-bib-btn')?.addEventListener('click', () => this.importBibFile());
    document.getElementById('add-paper-btn')?.addEventListener('click', () => this.importPDFs());
    document.getElementById('remove-paper-btn')?.addEventListener('click', () => this.removeSelectedPapers());

    // Navigation
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.addEventListener('click', () => this.setView(item.dataset.view));
    });

    // Search
    const searchInput = document.getElementById('search-input');
    let searchTimeout;
    if (searchInput) {
      console.log('Search input found, adding listener');
      searchInput.addEventListener('input', (e) => {
        console.log('Search input event:', e.target.value);
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => this.searchPapers(e.target.value), 300);
      });
    } else {
      console.log('Search input NOT found!');
    }

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // Paper actions
    document.getElementById('read-status-select')?.addEventListener('change', (e) => {
      if (this.selectedPaper) {
        this.updatePaperStatus(this.selectedPaper.id, e.target.value);
      }
    });

    document.getElementById('paper-rating-select')?.addEventListener('change', (e) => {
      if (this.selectedPaper) {
        this.updatePaperRating(this.selectedPaper.id, parseInt(e.target.value));
      }
    });

    document.getElementById('fetch-metadata-btn')?.addEventListener('click', () => this.fetchMetadata());
    document.getElementById('copy-cite-btn')?.addEventListener('click', () => this.copyCite());
    document.getElementById('open-ads-btn')?.addEventListener('click', () => this.openInADS());
    document.getElementById('copy-bibtex-btn')?.addEventListener('click', () => this.copyBibtex());
    document.getElementById('export-bibtex-btn')?.addEventListener('click', () => this.exportBibtexToFile());

    // PDF controls
    document.getElementById('zoom-in-btn')?.addEventListener('click', () => this.zoomPDF(0.1));
    document.getElementById('zoom-out-btn')?.addEventListener('click', () => this.zoomPDF(-0.1));
    document.getElementById('rotate-btn')?.addEventListener('click', () => this.rotatePage());

    // Pinch-to-zoom support for trackpads
    const pdfContainer = document.getElementById('pdf-container');
    if (pdfContainer) {
      pdfContainer.addEventListener('wheel', (e) => {
        // Detect pinch gesture (ctrlKey is set for trackpad pinch)
        if (e.ctrlKey) {
          e.preventDefault();
          // deltaY is negative for pinch-out (zoom in), positive for pinch-in (zoom out)
          const delta = e.deltaY > 0 ? -0.05 : 0.05;
          this.zoomPDF(delta);
        }
      }, { passive: false });
    }

    // Settings section toggle
    document.getElementById('settings-header')?.addEventListener('click', () => this.toggleSettings());

    // ADS settings
    document.getElementById('ads-settings-btn')?.addEventListener('click', () => this.showAdsTokenModal());
    document.getElementById('ads-cancel-btn')?.addEventListener('click', () => this.hideAdsTokenModal());
    document.getElementById('ads-save-btn')?.addEventListener('click', () => this.saveAdsToken());

    // Library Proxy settings
    document.getElementById('library-proxy-btn')?.addEventListener('click', () => this.showLibraryProxyModal());
    document.getElementById('proxy-cancel-btn')?.addEventListener('click', () => this.hideLibraryProxyModal());
    document.getElementById('proxy-save-btn')?.addEventListener('click', () => this.saveLibraryProxy());

    // Preferences
    document.getElementById('preferences-btn')?.addEventListener('click', () => this.showPreferencesModal());
    document.getElementById('preferences-cancel-btn')?.addEventListener('click', () => this.hidePreferencesModal());
    document.getElementById('preferences-save-btn')?.addEventListener('click', () => this.savePreferences());
    document.getElementById('ads-token-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      window.electronAPI.openExternal('https://ui.adsabs.harvard.edu/user/settings/token');
    });

    // Collections
    document.getElementById('add-collection-btn')?.addEventListener('click', () => this.showCollectionModal());
    document.getElementById('collection-cancel-btn')?.addEventListener('click', () => this.hideCollectionModal());
    document.getElementById('collection-save-btn')?.addEventListener('click', () => this.createCollection());

    // Reload button
    document.getElementById('reload-btn')?.addEventListener('click', () => location.reload());

    // Search clear button
    document.getElementById('search-clear-btn')?.addEventListener('click', () => {
      const searchInput = document.getElementById('search-input');
      searchInput.value = '';
      searchInput.focus();
      this.loadPapers();
    });

    // Search field shortcut buttons
    document.querySelectorAll('.search-shortcut-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const searchInput = document.getElementById('search-input');
        const insertText = btn.dataset.insert;
        const cursorPos = searchInput.selectionStart;
        const currentValue = searchInput.value;

        // Insert the field prefix at cursor position
        searchInput.value = currentValue.slice(0, cursorPos) + insertText + currentValue.slice(cursorPos);
        searchInput.focus();
        // Position cursor after the inserted text
        const newPos = cursorPos + insertText.length;
        searchInput.setSelectionRange(newPos, newPos);
      });
    });

    // ADS Search
    document.getElementById('ads-search-btn')?.addEventListener('click', () => this.showAdsSearchModal());
    document.getElementById('ads-close-btn')?.addEventListener('click', () => this.hideAdsSearchModal());
    document.getElementById('ads-search-execute-btn')?.addEventListener('click', () => this.executeAdsSearch());
    document.getElementById('ads-query-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.executeAdsSearch();
    });
    document.getElementById('ads-select-all-btn')?.addEventListener('click', () => this.adsSelectAll());
    document.getElementById('ads-select-none-btn')?.addEventListener('click', () => this.adsSelectNone());
    document.getElementById('ads-import-btn')?.addEventListener('click', () => this.importAdsSelected());

    // ADS Lookup Modal
    document.getElementById('ads-lookup-close-btn')?.addEventListener('click', () => this.hideAdsLookupModal());
    document.getElementById('ads-lookup-cancel-btn')?.addEventListener('click', () => this.hideAdsLookupModal());
    document.getElementById('ads-lookup-search-btn')?.addEventListener('click', () => this.searchAdsLookup());
    document.getElementById('ads-lookup-query')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.searchAdsLookup();
    });
    document.getElementById('ads-lookup-apply-btn')?.addEventListener('click', () => this.applyAdsLookupMetadata());

    // ADS Sync button
    document.getElementById('ads-sync-btn')?.addEventListener('click', () => this.startAdsSync());
    document.getElementById('sync-close-btn')?.addEventListener('click', () => this.hideAdsSyncModal());
    document.getElementById('ads-sync-close-btn')?.addEventListener('click', () => this.hideAdsSyncModal());
    document.getElementById('sync-cancel-btn')?.addEventListener('click', () => this.cancelAdsSync());

    // ADS lookup shortcut buttons
    document.querySelectorAll('#ads-lookup-modal .ads-shortcut-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('ads-lookup-query');
        const insert = btn.dataset.insert;
        input.value += insert;
        input.focus();
      });
    });

    // ADS shortcut buttons
    document.querySelectorAll('.ads-shortcut-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('ads-query-input');
        const insertText = btn.dataset.insert;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const value = input.value;
        input.value = value.substring(0, start) + insertText + value.substring(end);
        input.focus();
        input.selectionStart = input.selectionEnd = start + insertText.length;
      });
    });

    // ADS import progress listeners
    window.electronAPI.onImportProgress((data) => this.updateImportProgress(data));
    window.electronAPI.onImportComplete((data) => this.handleImportComplete(data));

    // Refs/Cites import controls
    document.getElementById('refs-select-all')?.addEventListener('click', () => this.selectAllRefs());
    document.getElementById('refs-select-none')?.addEventListener('click', () => this.selectNoneRefs());
    document.getElementById('refs-import-btn')?.addEventListener('click', () => this.importSelectedRefs());
    document.getElementById('cites-select-all')?.addEventListener('click', () => this.selectAllCites());
    document.getElementById('cites-select-none')?.addEventListener('click', () => this.selectNoneCites());
    document.getElementById('cites-import-btn')?.addEventListener('click', () => this.importSelectedCites());

    // Context menu
    document.getElementById('paper-list')?.addEventListener('contextmenu', (e) => this.showContextMenu(e));
    document.addEventListener('click', () => this.hideContextMenu());
    document.getElementById('ctx-add-to-collection')?.addEventListener('mouseenter', () => this.showCollectionsSubmenu());
    document.getElementById('ctx-add-to-collection')?.addEventListener('mouseleave', (e) => {
      // Don't hide if moving to submenu
      if (!e.relatedTarget?.closest('.context-submenu')) {
        setTimeout(() => this.hideCollectionsSubmenu(), 100);
      }
    });
    document.getElementById('ctx-collections-submenu')?.addEventListener('mouseleave', () => this.hideCollectionsSubmenu());
    document.getElementById('ctx-remove-from-collection')?.addEventListener('click', () => this.removeFromCurrentCollection());
    document.getElementById('ctx-delete-papers')?.addEventListener('click', () => this.removeSelectedPapers());
    document.getElementById('ctx-open-ads')?.addEventListener('click', () => this.openSelectedPaperInADS());
    document.getElementById('ctx-open-publisher')?.addEventListener('click', () => this.openPublisherPDF());
    document.getElementById('ctx-sync-paper')?.addEventListener('click', () => this.syncSelectedPapers());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => this.handleKeydown(e));

    // PDF container scroll for page tracking (throttled for performance)
    let scrollTicking = false;
    document.getElementById('pdf-container')?.addEventListener('scroll', () => {
      if (!scrollTicking) {
        requestAnimationFrame(() => {
          this.updateCurrentPage();
          scrollTicking = false;
        });
        scrollTicking = true;
      }
    });

    // AI Panel event listeners
    document.getElementById('ai-generate-summary-btn')?.addEventListener('click', () => this.generateSummary());
    document.getElementById('ai-regenerate-btn')?.addEventListener('click', () => this.regenerateSummary());
    document.getElementById('ai-ask-btn')?.addEventListener('click', () => this.askQuestion());
    document.getElementById('ai-question-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.askQuestion();
    });
    document.getElementById('ai-clear-history-btn')?.addEventListener('click', () => this.clearQAHistory());
    document.getElementById('ai-settings-link')?.addEventListener('click', () => this.showLlmModal());

    // Suggested questions - use event delegation
    document.getElementById('ai-qa-history')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('suggested-question')) {
        const question = e.target.dataset.question;
        if (question) {
          document.getElementById('ai-question-input').value = question;
          this.askQuestion();
        }
      }
    });

    // LLM Settings Modal
    document.getElementById('llm-settings-btn')?.addEventListener('click', () => this.showLlmModal());
    document.getElementById('llm-cancel-btn')?.addEventListener('click', () => this.hideLlmModal());
    document.getElementById('llm-save-btn')?.addEventListener('click', () => this.saveLlmConfig());
    document.getElementById('llm-test-btn')?.addEventListener('click', () => this.testLlmConnection());

    // LLM stream listener
    window.electronAPI.onLlmStream((data) => this.handleLlmStream(data));

    // Text selection and anchor placement for AI explain and notes
    pdfContainer?.addEventListener('mousedown', (e) => this.handlePdfMouseDown(e));
    pdfContainer?.addEventListener('mouseup', (e) => this.handlePdfMouseUp(e));
    document.getElementById('ctx-explain-text')?.addEventListener('click', () => this.explainSelectedText());
    document.getElementById('ctx-copy-text')?.addEventListener('click', () => this.copySelectedText());
    document.getElementById('ctx-add-anchor-note')?.addEventListener('click', () => this.createNoteAtAnchor());
    document.getElementById('ai-explanation-close')?.addEventListener('click', () => this.hideExplanationPopup());

    // Semantic search
    document.getElementById('ai-index-paper-btn')?.addEventListener('click', () => this.indexCurrentPaper());
    document.getElementById('ai-search-btn')?.addEventListener('click', () => this.semanticSearch());
    document.getElementById('ai-search-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.semanticSearch();
    });

    // Annotations
    document.getElementById('add-note-btn')?.addEventListener('click', () => this.createGeneralNote());
    document.getElementById('ctx-add-note')?.addEventListener('click', () => this.createNoteFromSelection());

    // Resize handles
    this.setupResizeHandlers();
  }

  setupResizeHandlers() {
    const sidebarHandle = document.getElementById('sidebar-resize');
    const listHandle = document.getElementById('list-resize');
    const sidebar = document.getElementById('sidebar');
    const listPanel = document.querySelector('.paper-list-panel');

    // Restore saved widths
    const savedSidebarWidth = localStorage.getItem('sidebarWidth');
    const savedListWidth = localStorage.getItem('listWidth');
    if (savedSidebarWidth) sidebar.style.width = savedSidebarWidth + 'px';
    if (savedListWidth) listPanel.style.width = savedListWidth + 'px';

    let isResizing = false;
    let currentHandle = null;
    let startX = 0;
    let startWidth = 0;

    const startResize = (e, handle, panel) => {
      isResizing = true;
      currentHandle = { handle, panel };
      startX = e.clientX;
      startWidth = panel.offsetWidth;
      handle.classList.add('resizing');
      document.body.classList.add('resizing');
      e.preventDefault();
    };

    const doResize = (e) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      let newWidth = startWidth + delta;
      // Constrain width
      newWidth = Math.max(150, Math.min(500, newWidth));
      currentHandle.panel.style.width = newWidth + 'px';
    };

    const stopResize = () => {
      if (!isResizing) return;
      isResizing = false;
      currentHandle.handle.classList.remove('resizing');
      document.body.classList.remove('resizing');
      // Save widths
      localStorage.setItem('sidebarWidth', sidebar.offsetWidth);
      localStorage.setItem('listWidth', listPanel.offsetWidth);
      currentHandle = null;
    };

    sidebarHandle?.addEventListener('mousedown', (e) => startResize(e, sidebarHandle, sidebar));
    listHandle?.addEventListener('mousedown', (e) => startResize(e, listHandle, listPanel));

    // Annotations panel resize (resizes from left edge, so delta is inverted)
    const annotationsHandle = document.getElementById('annotations-resize');
    const annotationsPanel = document.getElementById('annotations-panel');
    if (annotationsHandle && annotationsPanel) {
      const savedAnnotationsWidth = localStorage.getItem('annotationsWidth');
      if (savedAnnotationsWidth) annotationsPanel.style.width = savedAnnotationsWidth + 'px';

      annotationsHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        currentHandle = { handle: annotationsHandle, panel: annotationsPanel, invert: true };
        startX = e.clientX;
        startWidth = annotationsPanel.offsetWidth;
        annotationsHandle.classList.add('resizing');
        document.body.classList.add('resizing');
        e.preventDefault();
      });
    }

    const doResizeWithInvert = (e) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      const actualDelta = currentHandle.invert ? -delta : delta;
      let newWidth = startWidth + actualDelta;
      // Constrain width
      newWidth = Math.max(150, Math.min(500, newWidth));
      currentHandle.panel.style.width = newWidth + 'px';
    };

    document.removeEventListener('mousemove', doResize);
    document.addEventListener('mousemove', doResizeWithInvert);

    const stopResizeAll = () => {
      if (!isResizing) return;
      isResizing = false;
      currentHandle.handle.classList.remove('resizing');
      document.body.classList.remove('resizing');
      // Save widths
      localStorage.setItem('sidebarWidth', sidebar.offsetWidth);
      localStorage.setItem('listWidth', listPanel.offsetWidth);
      if (annotationsPanel) {
        localStorage.setItem('annotationsWidth', annotationsPanel.offsetWidth);
      }
      currentHandle = null;
    };

    document.removeEventListener('mouseup', stopResize);
    document.addEventListener('mouseup', stopResizeAll);

    // Setup sort buttons
    this.setupSortButtons();

    // Setup AI section resize handles
    this.setupAISectionResize();
  }

  setupSortButtons() {
    const sortBtns = document.querySelectorAll('.sort-btn');

    // Restore saved sort state
    sortBtns.forEach(btn => {
      const field = btn.dataset.sort;
      if (field === this.sortField) {
        btn.classList.add('active');
        btn.dataset.order = this.sortOrder;
        btn.querySelector('.sort-arrow').textContent = this.sortOrder === 'asc' ? '↑' : '↓';
      } else {
        btn.classList.remove('active');
      }
    });

    // Add click handlers
    sortBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.sort;

        if (field === this.sortField) {
          // Toggle order if same field
          this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
          // New field - use button's default order
          this.sortField = field;
          this.sortOrder = btn.dataset.order;
        }

        // Update all buttons
        sortBtns.forEach(b => {
          if (b.dataset.sort === this.sortField) {
            b.classList.add('active');
            b.querySelector('.sort-arrow').textContent = this.sortOrder === 'asc' ? '↑' : '↓';
          } else {
            b.classList.remove('active');
          }
        });

        // Save and re-render
        localStorage.setItem('sortField', this.sortField);
        localStorage.setItem('sortOrder', this.sortOrder);
        this.sortPapers();
        this.renderPaperList();
        this.scrollToSelectedPaper();
      });
    });
  }

  scrollToSelectedPaper() {
    // Scroll to keep selected paper visible (centered)
    if (this.selectedPaper) {
      const paperItem = document.querySelector(`.paper-item[data-id="${this.selectedPaper.id}"]`);
      if (paperItem) {
        paperItem.scrollIntoView({ behavior: 'auto', block: 'center' });
      }
    }
  }

  sortPapers() {
    const field = this.sortField;
    const order = this.sortOrder;
    const mult = order === 'asc' ? 1 : -1;

    this.papers.sort((a, b) => {
      let valA, valB;

      switch (field) {
        case 'added':
          valA = a.id || 0;
          valB = b.id || 0;
          break;
        case 'title':
          valA = (a.title || '').toLowerCase();
          valB = (b.title || '').toLowerCase();
          break;
        case 'author':
          valA = (a.authors?.[0] || '').toLowerCase();
          valB = (b.authors?.[0] || '').toLowerCase();
          break;
        case 'year':
          valA = parseInt(a.year) || 0;
          valB = parseInt(b.year) || 0;
          break;
        case 'journal':
          valA = (a.journal || '').toLowerCase();
          valB = (b.journal || '').toLowerCase();
          break;
        case 'rating':
          // 0 = unrated goes last, otherwise sort by rating (1=best, 4=worst)
          valA = a.rating || 5; // Unrated = 5 (goes last when ascending)
          valB = b.rating || 5;
          break;
        case 'citations':
          valA = a.citation_count || 0;
          valB = b.citation_count || 0;
          break;
        case 'bibcode':
          valA = (a.bibcode || '').toLowerCase();
          valB = (b.bibcode || '').toLowerCase();
          break;
        default:
          return 0;
      }

      if (valA < valB) return -1 * mult;
      if (valA > valB) return 1 * mult;
      return 0;
    });
  }

  setupAISectionResize() {
    const resizeHandles = document.querySelectorAll('.ai-section-resize');
    let isResizing = false;
    let currentHandle = null;
    let startY = 0;
    let startHeights = {};

    const startResize = (e, handle) => {
      isResizing = true;
      currentHandle = handle;
      startY = e.clientY;

      // Get the sections above and below this handle
      const prevSection = handle.previousElementSibling;
      const nextSection = handle.nextElementSibling;

      if (prevSection && nextSection) {
        startHeights = {
          prev: prevSection.offsetHeight,
          next: nextSection.offsetHeight
        };
        prevSection.style.flex = 'none';
        nextSection.style.flex = 'none';
        prevSection.style.height = startHeights.prev + 'px';
        nextSection.style.height = startHeights.next + 'px';
      }

      document.body.classList.add('resizing-vertical');
      e.preventDefault();
    };

    const doResize = (e) => {
      if (!isResizing || !currentHandle) return;

      const delta = e.clientY - startY;
      const prevSection = currentHandle.previousElementSibling;
      const nextSection = currentHandle.nextElementSibling;

      if (prevSection && nextSection) {
        const newPrevHeight = Math.max(80, startHeights.prev + delta);
        const newNextHeight = Math.max(80, startHeights.next - delta);

        prevSection.style.height = newPrevHeight + 'px';
        nextSection.style.height = newNextHeight + 'px';
      }
    };

    const stopResize = () => {
      if (!isResizing) return;
      isResizing = false;
      currentHandle = null;
      document.body.classList.remove('resizing-vertical');
    };

    resizeHandles.forEach(handle => {
      handle.addEventListener('mousedown', (e) => startResize(e, handle));
    });

    document.addEventListener('mousemove', doResize);
    document.addEventListener('mouseup', stopResize);
  }

  handleKeydown(e) {
    // Don't trigger shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      if (e.key === 'Escape') {
        e.target.blur();
      }
      return;
    }

    switch (e.key) {
      case '/':
        e.preventDefault();
        document.getElementById('search-input')?.focus();
        break;
      case 'j':
        this.selectNextPaper();
        break;
      case 'k':
        this.selectPreviousPaper();
        break;
      case '1':
        if (this.selectedPaper) {
          if (e.shiftKey) {
            this.updatePaperRating(this.selectedPaper.id, 1); // Seminal
          } else {
            this.updatePaperStatus(this.selectedPaper.id, 'unread');
          }
        }
        break;
      case '2':
        if (this.selectedPaper) {
          if (e.shiftKey) {
            this.updatePaperRating(this.selectedPaper.id, 2); // Important
          } else {
            this.updatePaperStatus(this.selectedPaper.id, 'reading');
          }
        }
        break;
      case '3':
        if (this.selectedPaper) {
          if (e.shiftKey) {
            this.updatePaperRating(this.selectedPaper.id, 3); // Average
          } else {
            this.updatePaperStatus(this.selectedPaper.id, 'read');
          }
        }
        break;
      case '4':
        if (this.selectedPaper && e.shiftKey) {
          this.updatePaperRating(this.selectedPaper.id, 4); // Meh
        }
        break;
      case '0':
        if (this.selectedPaper && e.shiftKey) {
          this.updatePaperRating(this.selectedPaper.id, 0); // Clear rating
        }
        break;
      case 'c':
        if (this.selectedPaper) this.copyCite();
        break;
      case 'a':
        if (e.metaKey || e.ctrlKey) {
          // Cmd+A: Select all papers
          e.preventDefault();
          this.selectAllPapers();
        } else if (this.selectedPaper) {
          this.openInADS();
        }
        break;
      case 'f':
        if (this.selectedPaper && this.hasAdsToken) this.fetchMetadata();
        break;
      case '+':
      case '=':
        this.zoomPDF(0.1);
        break;
      case '-':
        this.zoomPDF(-0.1);
        break;
      case 'r':
        this.rotatePage();
        break;
      case 'Backspace':
      case 'Delete':
        e.preventDefault();
        // If viewing a collection, delete the collection
        if (this.currentCollection) {
          this.deleteCollection(this.currentCollection);
        } else if (this.selectedPapers.size > 0) {
          this.removeSelectedPapers();
        }
        break;
    }
  }

  showSetupScreen() {
    document.getElementById('setup-screen').classList.remove('hidden');
    document.getElementById('main-screen').classList.add('hidden');

    console.log('[ADSReader] showSetupScreen called, isIOS:', this.isIOS);

    // On iOS, immediately trigger the library selection/creation flow
    if (this.isIOS) {
      console.log('[ADSReader] Scheduling iOS library flow...');
      setTimeout(() => {
        console.log('[ADSReader] iOS library flow triggered');
        this.selectOrCreateIOSLibrary();
      }, 100);
    }
  }

  showMainScreen(info) {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');
    this.updateLibraryDisplay(info);
  }

  async selectLibraryFolder() {
    // On iOS, use the iCloud library creation flow instead of folder picker
    if (this.isIOS) {
      await this.selectOrCreateIOSLibrary();
      return;
    }

    // macOS/Electron: use folder picker
    const selectedPath = await window.electronAPI.selectLibraryFolder();

    if (selectedPath) {
      this.libraryPath = selectedPath;
      const cloudStatus = await window.electronAPI.checkCloudStatus(selectedPath);

      const selectedPathEl = document.getElementById('selected-path');
      if (selectedPathEl) {
        selectedPathEl.classList.remove('hidden');
        selectedPathEl.querySelector('.path-value').textContent = selectedPath;

        const cloudStatusEl = selectedPathEl.querySelector('.cloud-status');
        if (cloudStatus.isCloud) {
          cloudStatusEl.className = 'cloud-status synced';
          cloudStatusEl.innerHTML = `☁️ Synced via ${cloudStatus.provider}`;
        } else {
          cloudStatusEl.className = 'cloud-status local';
          cloudStatusEl.innerHTML = `⚠️ Local only - consider cloud storage for sync`;
        }
      }

      const info = await window.electronAPI.getLibraryInfo(selectedPath);
      if (info) {
        setTimeout(() => {
          this.showMainScreen(info);
          this.loadPapers();
          this.loadCollections();
          this.checkAdsToken();
          this.checkProxyStatus();
        }, 300);
      }
    }
  }

  async selectOrCreateIOSLibrary() {
    console.log('[iOS] selectOrCreateIOSLibrary called');
    // Check for existing libraries first
    try {
      console.log('[iOS] Calling getAllLibraries...');
      const libraries = await window.electronAPI.getAllLibraries();
      console.log('[iOS] Libraries found:', libraries.length);

      if (libraries.length > 0) {
        // Show library picker
        this.showIOSLibraryPicker(libraries);
      } else {
        // No libraries exist - show create button
        console.log('[iOS] No libraries, showing create button');
        this.showIOSCreateLibrary();
      }
    } catch (error) {
      console.error('[iOS] Failed to get libraries:', error);
      this.showIOSCreateLibrary();
    }
  }

  showIOSCreateLibrary() {
    console.log('[iOS] showIOSCreateLibrary called');
    const setupContainer = document.querySelector('.setup-container');
    console.log('[iOS] setupContainer:', setupContainer ? 'found' : 'NOT FOUND');
    if (!setupContainer) return;

    console.log('[iOS] Updating setup container innerHTML');
    setupContainer.innerHTML = `
      <div class="setup-icon">📚</div>
      <h1>Welcome to ADS Reader</h1>
      <p class="setup-subtitle">Create your first library to get started</p>

      <div class="ios-library-actions" style="margin-top: 32px;">
        <button id="ios-create-library-btn" class="primary-button">
          Create iCloud Library
        </button>
      </div>
    `;

    document.getElementById('ios-create-library-btn')?.addEventListener('click', () => {
      this.showIOSLibraryNameInput();
    });
  }

  showIOSLibraryNameInput() {
    const setupContainer = document.querySelector('.setup-container');
    if (!setupContainer) return;

    setupContainer.innerHTML = `
      <div class="setup-icon">📚</div>
      <h1>Name Your Library</h1>
      <p class="setup-subtitle">Choose a name for your paper library</p>

      <div class="ios-name-input" style="margin-top: 24px;">
        <input type="text" id="ios-library-name" class="text-input"
               placeholder="My Library" value="My Library"
               style="width: 100%; max-width: 300px; padding: 12px; font-size: 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-primary);">
      </div>

      <div class="ios-library-actions" style="margin-top: 24px;">
        <button id="ios-confirm-create-btn" class="primary-button">
          Create Library
        </button>
      </div>
    `;

    const input = document.getElementById('ios-library-name');
    input?.focus();
    input?.select();

    document.getElementById('ios-confirm-create-btn')?.addEventListener('click', async () => {
      const name = input?.value?.trim() || 'My Library';
      await this.createIOSLibraryWithName(name);
    });

    // Also handle enter key
    input?.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        const name = input?.value?.trim() || 'My Library';
        await this.createIOSLibraryWithName(name);
      }
    });
  }

  async createIOSLibraryWithName(name) {
    try {
      const btn = document.getElementById('ios-confirm-create-btn');
      if (btn) {
        btn.textContent = 'Creating...';
        btn.disabled = true;
      }

      const result = await window.electronAPI.createLibrary({ name, location: 'icloud' });

      if (result.success) {
        console.log('[iOS] Library created:', result.id);
        await this.switchToLibrary(result.id);
      } else {
        alert(`Failed to create library: ${result.error}`);
        this.showIOSCreateLibrary();
      }
    } catch (error) {
      console.error('[iOS] Failed to create library:', error);
      alert(`Error creating library: ${error.message}`);
      this.showIOSCreateLibrary();
    }
  }

  showIOSLibraryPicker(libraries) {
    // Update setup screen to show library selection
    const setupContainer = document.querySelector('.setup-container');
    if (!setupContainer) return;

    let html = `
      <div class="setup-icon">📚</div>
      <h1>Choose Library</h1>
      <p class="setup-subtitle">Select an existing library or create a new one</p>

      <div class="ios-library-list">
    `;

    for (const lib of libraries) {
      const icon = lib.location === 'icloud' ? '☁️' : '💻';
      html += `
        <div class="ios-library-item" data-id="${lib.id}">
          <span class="lib-icon">${icon}</span>
          <div class="lib-info">
            <span class="lib-name">${this.escapeHtml(lib.name)}</span>
            <span class="lib-location">${lib.location === 'icloud' ? 'iCloud' : 'Local'}</span>
          </div>
        </div>
      `;
    }

    html += `
      </div>
      <div class="ios-library-actions">
        <button id="ios-new-library-btn" class="primary-button">
          Create New iCloud Library
        </button>
      </div>
    `;

    setupContainer.innerHTML = html;

    // Add click handlers
    setupContainer.querySelectorAll('.ios-library-item').forEach(item => {
      item.addEventListener('click', () => this.switchToLibrary(item.dataset.id));
    });

    document.getElementById('ios-new-library-btn')?.addEventListener('click', () => {
      this.createIOSLibrary();
    });
  }

  async createIOSLibrary() {
    const name = prompt('Enter library name:', 'My Library');
    if (!name) return;

    try {
      const result = await window.electronAPI.createLibrary({ name, location: 'icloud' });

      if (result.success) {
        // Switch to the new library
        await this.switchToLibrary(result.id);
      } else {
        alert(`Failed to create library: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to create iOS library:', error);
      alert(`Error creating library: ${error.message}`);
    }
  }

  updateLibraryDisplay(info) {
    if (!info) {
      console.warn('[updateLibraryDisplay] No info provided');
      return;
    }

    const paperCount = document.getElementById('paper-count');
    const unreadCount = document.getElementById('unread-count');
    const readingCount = document.getElementById('reading-count');
    const readCount = document.getElementById('read-count');
    const pathDisplay = document.getElementById('library-path-display');

    if (paperCount) paperCount.textContent = info.paperCount || 0;
    if (unreadCount) unreadCount.textContent = info.unreadCount || 0;
    if (readingCount) readingCount.textContent = info.readingCount || 0;
    if (readCount) readCount.textContent = info.readCount || 0;

    if (pathDisplay && info.path) {
      const folderName = info.path.split('/').pop();
      pathDisplay.textContent = folderName;
      pathDisplay.title = info.path;
    }
  }

  async loadPapers() {
    let options = {};

    if (this.currentView !== 'all') {
      options.readStatus = this.currentView;
    }

    this.papers = await window.electronAPI.getAllPapers(options);
    this.sortPapers();
    this.renderPaperList();
  }

  async loadCollections() {
    this.collections = await window.electronAPI.getCollections();
    this.renderCollections();
  }

  renderPaperList() {
    const listEl = document.getElementById('paper-list');
    console.log('renderPaperList called, papers:', this.papers.length);

    if (this.papers.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📚</div>
          <h3>No papers yet</h3>
          <p>Import PDFs to get started</p>
          <button class="primary-button" id="import-first-btn">Import PDF</button>
        </div>
      `;
      // Re-attach click handler for the import button
      document.getElementById('import-first-btn')?.addEventListener('click', () => this.importPDFs());
      return;
    }

    listEl.innerHTML = this.papers.map((paper, index) => `
      <div class="paper-item${this.selectedPapers.has(paper.id) ? ' selected' : ''}" data-id="${paper.id}" data-index="${index}" draggable="true">
        <div class="paper-item-title">
          <span class="paper-item-status ${paper.read_status}"></span>
          ${this.escapeHtml(paper.title || 'Untitled')}
        </div>
        <div class="paper-item-meta">
          <span class="paper-item-authors">${this.formatAuthors(paper.authors, true)}</span>
          <span>${paper.year || ''}</span>
          ${paper.citation_count > 0 ? `<span class="citation-count" title="${paper.citation_count} citations">🔗${paper.citation_count}</span>` : ''}
          ${this.getRatingEmoji(paper.rating)}
          ${paper.bibcode ? `<button class="pdf-source-btn" data-paper-id="${paper.id}" data-bibcode="${paper.bibcode}" title="PDF">📄${paper.annotation_count > 0 ? `<span class="note-badge">${paper.annotation_count}</span>` : ''}</button>` : ''}
          ${paper.is_indexed ? '<span class="indexed-indicator" title="Indexed for AI search">⚡</span>' : ''}
        </div>
      </div>
    `).join('');

    // Add click handlers with multi-select support
    listEl.querySelectorAll('.paper-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const id = parseInt(item.dataset.id);
        const index = parseInt(item.dataset.index);
        this.handlePaperClick(id, index, e);
      });

      // Drag support
      item.addEventListener('dragstart', (e) => {
        const id = parseInt(item.dataset.id);
        // If dragging an unselected item, select only it
        if (!this.selectedPapers.has(id)) {
          this.selectedPapers.clear();
          this.selectedPapers.add(id);
          this.updatePaperListSelection();
          this.updateSelectionUI();
        }
        // Set drag data
        e.dataTransfer.setData('text/plain', 'papers');
        e.dataTransfer.effectAllowed = 'move';
        // Show count in drag image
        item.classList.add('dragging');
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
      });
    });

    // Add PDF source button handlers
    listEl.querySelectorAll('.pdf-source-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // Don't trigger paper selection
        const paperId = parseInt(btn.dataset.paperId);
        const bibcode = btn.dataset.bibcode;
        await this.showPdfSourceDropdown(btn, paperId, bibcode);
      });
    });
  }

  handlePaperClick(id, index, event) {
    const isMeta = event.metaKey || event.ctrlKey;
    const isShift = event.shiftKey;

    if (isShift && this.lastClickedIndex >= 0) {
      // Shift+click: range select
      const start = Math.min(this.lastClickedIndex, index);
      const end = Math.max(this.lastClickedIndex, index);

      if (!isMeta) {
        this.selectedPapers.clear();
      }

      for (let i = start; i <= end; i++) {
        this.selectedPapers.add(this.papers[i].id);
      }
    } else if (isMeta) {
      // Cmd/Ctrl+click: toggle selection
      if (this.selectedPapers.has(id)) {
        this.selectedPapers.delete(id);
      } else {
        this.selectedPapers.add(id);
      }
      this.lastClickedIndex = index;
    } else {
      // Regular click: single select
      this.selectedPapers.clear();
      this.selectedPapers.add(id);
      this.lastClickedIndex = index;
    }

    // Update visual selection
    this.updatePaperListSelection();

    // Display the clicked paper (or first selected if available)
    if (this.selectedPapers.has(id)) {
      this.displayPaper(id);
    } else if (this.selectedPapers.size > 0) {
      this.displayPaper(Array.from(this.selectedPapers)[0]);
    } else {
      this.clearPaperDisplay();
    }

    // Update remove button state
    this.updateSelectionUI();
  }

  updatePaperListSelection() {
    document.querySelectorAll('.paper-item').forEach(item => {
      const id = parseInt(item.dataset.id);
      item.classList.toggle('selected', this.selectedPapers.has(id));
    });
  }

  updateSelectionUI() {
    const count = this.selectedPapers.size;
    const removeBtn = document.getElementById('remove-paper-btn');
    removeBtn.disabled = count === 0;
    removeBtn.textContent = count > 1 ? `−` : '−';
    removeBtn.title = count > 1 ? `Remove ${count} Papers (Backspace)` : 'Remove Paper (Backspace)';
  }

  selectAllPapers() {
    this.selectedPapers.clear();
    this.papers.forEach(p => this.selectedPapers.add(p.id));
    this.updatePaperListSelection();
    this.updateSelectionUI();
    if (this.papers.length > 0 && !this.selectedPaper) {
      this.displayPaper(this.papers[0].id);
    }
  }

  clearPaperDisplay() {
    this.selectedPaper = null;
    document.getElementById('viewer-wrapper').classList.add('hidden');
    document.getElementById('detail-placeholder').classList.remove('hidden');
    document.title = 'ADS Reader';
  }

  // Context menu methods
  showContextMenu(e) {
    const paperItem = e.target.closest('.paper-item');
    if (!paperItem) return;

    e.preventDefault();

    const id = parseInt(paperItem.dataset.id);

    // If right-clicked paper is not in selection, select only it
    if (!this.selectedPapers.has(id)) {
      this.selectedPapers.clear();
      this.selectedPapers.add(id);
      this.updatePaperListSelection();
      this.updateSelectionUI();
      this.displayPaper(id);
    }

    const menu = document.getElementById('paper-context-menu');

    // Position menu at cursor
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    // Update menu items based on context
    const removeFromCollectionItem = document.getElementById('ctx-remove-from-collection');
    if (this.currentCollection) {
      removeFromCollectionItem.classList.remove('disabled');
      removeFromCollectionItem.style.display = 'block';
    } else {
      removeFromCollectionItem.style.display = 'none';
    }

    // Update delete text based on selection count
    const deleteItem = document.getElementById('ctx-delete-papers');
    deleteItem.textContent = this.selectedPapers.size > 1
      ? `Delete ${this.selectedPapers.size} Papers`
      : 'Delete';

    menu.classList.remove('hidden');

    // Ensure menu doesn't go off screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
  }

  hideContextMenu() {
    document.getElementById('paper-context-menu').classList.add('hidden');
    this.hideCollectionsSubmenu();
  }

  showCollectionsSubmenu() {
    const submenu = document.getElementById('ctx-collections-submenu');
    const parentItem = document.getElementById('ctx-add-to-collection');
    const parentRect = parentItem.getBoundingClientRect();

    // Populate with collections
    if (this.collections.length === 0) {
      submenu.innerHTML = '<div class="context-submenu-item empty">No collections</div>';
    } else {
      submenu.innerHTML = this.collections.map(c =>
        `<div class="context-submenu-item" data-collection-id="${c.id}">${this.escapeHtml(c.name)}</div>`
      ).join('');

      // Add click handlers
      submenu.querySelectorAll('.context-submenu-item').forEach(item => {
        item.addEventListener('click', () => {
          const collectionId = parseInt(item.dataset.collectionId);
          this.addSelectedToCollection(collectionId);
          this.hideContextMenu();
        });
      });
    }

    // Position submenu
    submenu.style.top = `${parentRect.top}px`;
    submenu.style.left = `${parentRect.right + 2}px`;
    submenu.classList.remove('hidden');

    // Adjust if off screen
    const rect = submenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      submenu.style.left = `${parentRect.left - rect.width - 2}px`;
    }
  }

  hideCollectionsSubmenu() {
    document.getElementById('ctx-collections-submenu').classList.add('hidden');
  }

  async addSelectedToCollection(collectionId) {
    const collection = this.collections.find(c => c.id === collectionId);
    if (!collection) return;

    for (const paperId of this.selectedPapers) {
      await window.electronAPI.addPaperToCollection(paperId, collectionId);
    }

    // Refresh collections to update counts
    await this.loadCollections();

    // Show feedback
    const count = this.selectedPapers.size;
    const msg = count === 1 ? 'Paper added to' : `${count} papers added to`;
    console.log(`${msg} "${collection.name}"`);
  }

  async dropPapersOnCollection(collectionId) {
    if (this.selectedPapers.size === 0) return;
    await this.addSelectedToCollection(collectionId);
  }

  async removeFromCurrentCollection() {
    if (!this.currentCollection) return;

    for (const paperId of this.selectedPapers) {
      await window.electronAPI.removePaperFromCollection(paperId, this.currentCollection);
    }

    // Reload collection view
    await this.loadPapersInCollection(this.currentCollection);
    this.hideContextMenu();
  }

  renderCollections() {
    const listEl = document.getElementById('collections-list');

    if (this.collections.length === 0) {
      listEl.innerHTML = '<div class="nav-item placeholder">No collections yet</div>';
      return;
    }

    listEl.innerHTML = this.collections.map(col => `
      <div class="nav-item${this.currentCollection === col.id ? ' active' : ''}" data-collection="${col.id}">
        <button class="collection-delete-btn" data-delete-collection="${col.id}" title="Delete collection">−</button>
        <span class="nav-icon">📁</span>
        <span class="collection-name">${this.escapeHtml(col.name)}</span>
        <span class="nav-count">${col.paper_count || 0}</span>
      </div>
    `).join('');

    // Delete buttons
    listEl.querySelectorAll('.collection-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.deleteCollection);
        await this.deleteCollection(id);
      });
    });

    listEl.querySelectorAll('.nav-item[data-collection]').forEach(item => {
      const id = parseInt(item.dataset.collection);

      item.addEventListener('click', () => {
        this.selectCollection(id);
      });

      // Drag-drop support
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        item.classList.add('drag-over');
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });

      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        await this.dropPapersOnCollection(id);
      });
    });
  }

  async selectPaper(id) {
    // Single select - clears other selections
    this.selectedPapers.clear();
    this.selectedPapers.add(id);
    this.updatePaperListSelection();
    this.updateSelectionUI();

    // Scroll the selected paper into view (centered)
    const paperItem = document.querySelector(`.paper-item[data-id="${id}"]`);
    if (paperItem) {
      paperItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    await this.displayPaper(id);
  }

  async displayPaper(id) {
    // Save current scroll position before switching papers
    if (this.selectedPaper && this.pdfDoc) {
      const container = document.getElementById('pdf-container');
      const currentPage = this.getCurrentVisiblePage();
      const currentWrapper = container.querySelector(`.pdf-page-wrapper[data-page="${currentPage}"]`);

      let pageOffset = 0;
      if (currentWrapper) {
        // Calculate offset within the current page (0 = top, 1 = bottom)
        const offsetIntoPage = container.scrollTop - currentWrapper.offsetTop;
        pageOffset = offsetIntoPage / currentWrapper.offsetHeight;
      }

      const position = { page: currentPage, offset: pageOffset };
      this.pdfPagePositions[this.selectedPaper.id] = position;
      // Persist to storage
      window.electronAPI.setPdfPosition(this.selectedPaper.id, position);
    }

    const paper = this.papers.find(p => p.id === id) || await window.electronAPI.getPaper(id);
    if (!paper) return;

    this.selectedPaper = paper;

    // Save last selected paper for session persistence
    window.electronAPI.setLastSelectedPaper(id);

    // Show viewer wrapper
    document.getElementById('detail-placeholder').classList.add('hidden');
    document.getElementById('viewer-wrapper').classList.remove('hidden');

    // Update info (hidden storage)
    document.getElementById('paper-title').textContent = paper.title || 'Untitled';
    document.getElementById('paper-authors').textContent = paper.authors?.slice(0, 3).join(', ') || '';
    document.getElementById('paper-year').textContent = paper.year || '';
    document.getElementById('paper-journal').textContent = paper.journal || '';
    document.getElementById('paper-bibcode').textContent = paper.bibcode || '';
    document.getElementById('paper-doi').textContent = paper.doi ? `DOI: ${paper.doi}` : '';
    document.getElementById('paper-arxiv').textContent = paper.arxiv_id ? `arXiv: ${paper.arxiv_id}` : '';

    // Update window title with paper title and first 3 authors
    const firstAuthors = paper.authors?.slice(0, 3).map(a => a.split(',')[0]).join(', ') || '';
    const authorSuffix = paper.authors?.length > 3 ? ' et al.' : '';
    const windowTitle = paper.title
      ? `${paper.title} — ${firstAuthors}${authorSuffix}${paper.year ? ` (${paper.year})` : ''}`
      : 'ADS Reader';
    document.title = windowTitle;

    // Update bottom bar (simplified - just show journal/bibcode)
    const titleBar = document.getElementById('paper-title-bar');
    const journalInfo = [paper.journal, paper.bibcode].filter(Boolean).join(' • ');
    titleBar.textContent = journalInfo || '';
    titleBar.title = paper.bibcode || '';

    document.getElementById('read-status-select').value = paper.read_status || 'unread';
    document.getElementById('paper-rating-select').value = paper.rating || 0;

    // Update abstract
    const abstractEl = document.getElementById('abstract-content');
    if (paper.abstract) {
      abstractEl.innerHTML = `<p>${this.escapeHtml(paper.abstract)}</p>`;
    } else {
      abstractEl.innerHTML = '<p class="no-content">No abstract available. Click "Sync" to retrieve metadata from ADS.</p>';
    }

    // Update keywords
    const keywordsEl = document.getElementById('keywords-list');
    if (paper.keywords?.length) {
      keywordsEl.innerHTML = paper.keywords.map(k => `<span class="keyword-tag">${this.escapeHtml(k)}</span>`).join('');
      document.getElementById('keywords-section').classList.remove('hidden');
    } else {
      document.getElementById('keywords-section').classList.add('hidden');
    }

    // Update BibTeX
    document.getElementById('bibtex-content').value = paper.bibtex || '';

    // Load references and citations
    await this.loadReferences(paper.id);
    await this.loadCitations(paper.id);

    // Load annotations
    await this.loadAnnotations(paper.id);

    // Check current tab - stay on info tabs if already there
    const currentTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    const infoTabs = ['abstract', 'refs', 'cites', 'bibtex'];

    if (infoTabs.includes(currentTab)) {
      // Stay on current tab and refresh if multi-select
      if (this.selectedPapers.size > 1) {
        this.switchTab(currentTab); // This will trigger multi-display
      }
      // Still load PDF in background for when user switches
      await this.loadPDF(paper);
    } else {
      // Switch to PDF tab
      this.switchTab('pdf');
      await this.loadPDF(paper);
    }
  }

  async loadPDF(paper) {
    const container = document.getElementById('pdf-container');

    // Cleanup previous PDF document
    if (this.pdfDoc) {
      this.pdfDoc.destroy();
      this.pdfDoc = null;
    }

    // Reset page rotations for new document
    this.pageRotations = {};

    if (!paper.pdf_path) {
      container.innerHTML = '<div class="pdf-loading">No PDF available</div>';
      document.getElementById('total-pages').textContent = '0';
      document.getElementById('current-page').textContent = '0';
      return;
    }

    const pdfPath = await window.electronAPI.getPdfPath(paper.pdf_path);
    if (!pdfPath) {
      container.innerHTML = '<div class="pdf-loading">PDF path not found</div>';
      return;
    }

    // Show loading state
    container.innerHTML = '<div class="pdf-loading">Loading PDF...</div>';

    try {
      // Load new PDF with cache busting to ensure fresh load
      const loadingTask = pdfjsLib.getDocument({
        url: `file://${pdfPath}`,
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
        cMapPacked: true
      });

      this.pdfDoc = await loadingTask.promise;
      document.getElementById('total-pages').textContent = this.pdfDoc.numPages;

      // Get saved position if available
      const savedPos = this.pdfPagePositions[paper.id];
      const targetPage = savedPos?.page || 1;
      const pageOffset = savedPos?.offset || 0;

      document.getElementById('current-page').textContent = targetPage;

      // Render with priority on the saved page
      await this.renderAllPages(targetPage, pageOffset);
    } catch (error) {
      console.error('PDF load error:', error);
      container.innerHTML = `<div class="pdf-loading">Failed to load PDF: ${error.message}</div>`;
    }
  }

  async renderAllPages(scrollToPage = null, scrollPageOffset = 0) {
    // Generate unique render ID to detect if a newer render has started
    const renderId = Symbol('render');
    this.currentRenderId = renderId;

    const container = document.getElementById('pdf-container');
    container.innerHTML = '';

    // Use device pixel ratio for sharper rendering on high-DPI displays
    const dpr = window.devicePixelRatio || 1;

    // Build render order: target page first, then all others
    const pageOrder = [];
    const numPages = this.pdfDoc.numPages;

    if (scrollToPage && scrollToPage >= 1 && scrollToPage <= numPages) {
      pageOrder.push(scrollToPage);
      for (let i = 1; i <= numPages; i++) {
        if (i !== scrollToPage) pageOrder.push(i);
      }
    } else {
      for (let i = 1; i <= numPages; i++) {
        pageOrder.push(i);
      }
    }

    // Pre-create all wrappers in correct DOM order first
    const wrappers = {};
    for (let i = 1; i <= numPages; i++) {
      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.dataset.page = i;
      wrapper.style.display = 'block';
      wrapper.style.margin = '0 auto 8px auto';
      container.appendChild(wrapper);
      wrappers[i] = wrapper;
    }

    // Now render pages in priority order (target first)
    for (const i of pageOrder) {
      // Check if a newer render has started - if so, abort this one
      if (this.currentRenderId !== renderId) {
        return false; // Cancelled
      }
      const page = await this.pdfDoc.getPage(i);
      const rotation = this.pageRotations[i] || 0;
      const viewport = page.getViewport({ scale: this.pdfScale, rotation });

      // Get pre-created wrapper and set its size
      const wrapper = wrappers[i];
      wrapper.style.width = `${viewport.width}px`;
      wrapper.style.height = `${viewport.height}px`;

      // Create high-DPI canvas
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page';
      canvas.dataset.page = i;

      // Set display size (CSS pixels)
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      // Set actual size in memory (scaled for DPI)
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      await page.render({ canvasContext: ctx, viewport }).promise;

      wrapper.appendChild(canvas);

      // Create text layer for text selection
      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'pdf-text-layer';
      textLayerDiv.style.width = `${viewport.width}px`;
      textLayerDiv.style.height = `${viewport.height}px`;

      const textContent = await page.getTextContent();

      // Store text divs for potential future use
      const textDivs = [];

      // Render text layer using PDF.js
      const textLayer = pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport: viewport,
        textDivs: textDivs
      });

      // Wait for text layer to render
      if (textLayer.promise) {
        await textLayer.promise;
      }

      // Add end-of-content marker for better multi-line selection
      const endOfContent = document.createElement('div');
      endOfContent.className = 'endOfContent';
      textLayerDiv.appendChild(endOfContent);

      wrapper.appendChild(textLayerDiv);

      // Check again - a new render may have started during async operations
      if (this.currentRenderId !== renderId) {
        return false; // Cancelled
      }

      // Scroll to target page as soon as it's rendered (it's rendered first)
      if (scrollToPage && i === scrollToPage) {
        // Scroll to the same relative position within the page
        const offsetPixels = scrollPageOffset * wrapper.offsetHeight;
        const wrapperTop = wrapper.offsetTop;
        container.scrollTop = wrapperTop + offsetPixels;
      }
    }

    // Final check before updating UI
    if (this.currentRenderId !== renderId) return false;

    document.getElementById('zoom-level').textContent = `${Math.round(this.pdfScale * 100)}%`;

    // Render annotation highlights after pages are rendered
    this.renderHighlightsOnPdf();
    return true; // Render completed successfully
  }

  zoomPDF(delta) {
    if (!this.pdfDoc) return;

    const container = document.getElementById('pdf-container');

    // Capture target page and position within page before any rendering starts
    // Only capture if we don't already have one (from a previous cancelled render)
    if (this.zoomTargetPage === undefined) {
      this.zoomTargetPage = this.getCurrentVisiblePage();

      // Calculate offset within the current page (0 = top of page, 1 = bottom)
      const currentWrapper = container.querySelector(`.pdf-page-wrapper[data-page="${this.zoomTargetPage}"]`);
      if (currentWrapper) {
        const wrapperRect = currentWrapper.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        // How far into the page is the viewport top?
        const offsetIntoPage = containerRect.top - wrapperRect.top;
        this.zoomPageOffset = offsetIntoPage / currentWrapper.offsetHeight;
      } else {
        this.zoomPageOffset = 0;
      }
    }

    const targetPage = this.zoomTargetPage;
    const pageOffset = this.zoomPageOffset || 0;

    this.pdfScale = Math.max(0.5, Math.min(3, this.pdfScale + delta));

    this.renderAllPages(targetPage, pageOffset).then((completed) => {
      // Clear the saved page/offset now that render completed
      if (completed) {
        this.zoomTargetPage = undefined;
        this.zoomPageOffset = undefined;
      }
    });

    // Save zoom level for next session
    window.electronAPI.setPdfZoom(this.pdfScale);
  }

  rotatePage() {
    if (!this.pdfDoc) return;

    const currentPage = this.getCurrentVisiblePage();
    this.pageRotations[currentPage] = ((this.pageRotations[currentPage] || 0) + 90) % 360;
    this.renderSinglePage(currentPage);
  }

  async renderSinglePage(pageNum) {
    const page = await this.pdfDoc.getPage(pageNum);
    const rotation = this.pageRotations[pageNum] || 0;
    const viewport = page.getViewport({ scale: this.pdfScale, rotation });

    const canvas = document.querySelector(`.pdf-page[data-page="${pageNum}"]`);
    if (!canvas) return;

    // Use device pixel ratio for sharper rendering
    const dpr = window.devicePixelRatio || 1;

    // Set display size (CSS pixels)
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    // Set actual size in memory (scaled for DPI)
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  getCurrentVisiblePage() {
    const container = document.getElementById('pdf-container');
    const wrappers = container.querySelectorAll('.pdf-page-wrapper');

    if (wrappers.length === 0) return 1;

    // Use scrollTop-based calculation (much faster than getBoundingClientRect)
    const scrollTop = container.scrollTop;

    // Find page at scroll position using offsetTop (pages are in DOM order)
    for (const wrapper of wrappers) {
      const pageTop = wrapper.offsetTop;
      const pageBottom = pageTop + wrapper.offsetHeight;

      // If scroll position is within this page
      if (scrollTop < pageBottom) {
        return parseInt(wrapper.dataset.page, 10);
      }
    }

    // Fallback: last page
    return wrappers.length;
  }

  updateCurrentPage() {
    const currentPage = this.getCurrentVisiblePage();
    document.getElementById('current-page').textContent = currentPage;
  }

  async loadReferences(paperId) {
    const refs = await window.electronAPI.getReferences(paperId);
    const refsEl = document.getElementById('refs-list');
    const toolbar = document.getElementById('refs-toolbar');

    this.currentRefs = refs;
    this.selectedRefs.clear();

    if (refs.length === 0) {
      refsEl.innerHTML = '<p class="no-content">No references loaded. Click "Sync" to retrieve from ADS.</p>';
      toolbar.classList.add('hidden');
      return;
    }

    // Check which refs are already in library
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));

    toolbar.classList.remove('hidden');
    document.getElementById('refs-count').textContent = `${refs.length} references`;

    refsEl.innerHTML = refs.map((ref, index) => {
      const inLibrary = libraryBibcodes.has(ref.ref_bibcode);
      return `
        <div class="ref-item${inLibrary ? ' in-library' : ''}" data-index="${index}" data-bibcode="${ref.ref_bibcode}">
          <span class="ref-number">${index + 1}.</span>
          <input type="checkbox" class="ref-checkbox" ${inLibrary ? 'disabled' : ''}>
          <div class="ref-content">
            <div class="ref-title">${this.escapeHtml(ref.ref_title || 'Untitled')}</div>
            <div class="ref-meta">${this.formatAuthorsForList(ref.ref_authors)} ${ref.ref_year || ''}${inLibrary ? ' • In Library' : ''}</div>
          </div>
          <button class="ref-ads-btn" data-bibcode="${ref.ref_bibcode}" title="View on ADS">ADS</button>
          <button class="ref-import-btn" data-bibcode="${ref.ref_bibcode}" title="Import this paper">+</button>
        </div>
      `;
    }).join('');

    refsEl.querySelectorAll('.ref-item').forEach(item => {
      const checkbox = item.querySelector('.ref-checkbox');
      const importBtn = item.querySelector('.ref-import-btn');
      const adsBtn = item.querySelector('.ref-ads-btn');
      const index = parseInt(item.dataset.index);

      item.addEventListener('click', (e) => {
        if (e.target === checkbox || e.target === importBtn || e.target === adsBtn) return;
        if (!checkbox.disabled) {
          checkbox.checked = !checkbox.checked;
          this.toggleRefSelection(index, checkbox.checked);
        }
      });

      checkbox.addEventListener('change', () => {
        this.toggleRefSelection(index, checkbox.checked);
      });

      importBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.importSingleRef(item.dataset.bibcode, importBtn);
      });

      adsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bibcode = item.dataset.bibcode;
        if (bibcode) {
          window.electronAPI.openExternal(`https://ui.adsabs.harvard.edu/abs/${bibcode}`);
        }
      });
    });

    this.updateRefsImportButton();
  }

  async loadCitations(paperId) {
    const cites = await window.electronAPI.getCitations(paperId);
    const citesEl = document.getElementById('cites-list');
    const toolbar = document.getElementById('cites-toolbar');

    this.currentCites = cites;
    this.selectedCites.clear();

    if (cites.length === 0) {
      citesEl.innerHTML = '<p class="no-content">No citations loaded. Click "Sync" to retrieve from ADS.</p>';
      toolbar.classList.add('hidden');
      return;
    }

    // Check which cites are already in library
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));

    toolbar.classList.remove('hidden');
    document.getElementById('cites-count').textContent = `${cites.length} citations`;

    citesEl.innerHTML = cites.map((cite, index) => {
      const inLibrary = libraryBibcodes.has(cite.citing_bibcode);
      return `
        <div class="cite-item${inLibrary ? ' in-library' : ''}" data-index="${index}" data-bibcode="${cite.citing_bibcode}">
          <span class="cite-number">${index + 1}.</span>
          <input type="checkbox" class="cite-checkbox" ${inLibrary ? 'disabled' : ''}>
          <div class="cite-content">
            <div class="cite-title">${this.escapeHtml(cite.citing_title || 'Untitled')}</div>
            <div class="cite-meta">${this.formatAuthorsForList(cite.citing_authors)} ${cite.citing_year || ''}${inLibrary ? ' • In Library' : ''}</div>
          </div>
          <button class="ref-ads-btn" data-bibcode="${cite.citing_bibcode}" title="View on ADS">ADS</button>
          <button class="ref-import-btn" data-bibcode="${cite.citing_bibcode}" title="Import this paper">+</button>
        </div>
      `;
    }).join('');

    citesEl.querySelectorAll('.cite-item').forEach(item => {
      const checkbox = item.querySelector('.cite-checkbox');
      const importBtn = item.querySelector('.ref-import-btn');
      const adsBtn = item.querySelector('.ref-ads-btn');
      const index = parseInt(item.dataset.index);

      item.addEventListener('click', (e) => {
        if (e.target === checkbox || e.target === importBtn || e.target === adsBtn) return;
        if (!checkbox.disabled) {
          checkbox.checked = !checkbox.checked;
          this.toggleCiteSelection(index, checkbox.checked);
        }
      });

      checkbox.addEventListener('change', () => {
        this.toggleCiteSelection(index, checkbox.checked);
      });

      importBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.importSingleRef(item.dataset.bibcode, importBtn);
      });

      adsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bibcode = item.dataset.bibcode;
        if (bibcode) {
          window.electronAPI.openExternal(`https://ui.adsabs.harvard.edu/abs/${bibcode}`);
        }
      });
    });

    this.updateCitesImportButton();
  }

  // Refs selection methods
  toggleRefSelection(index, selected) {
    if (selected) {
      this.selectedRefs.add(index);
    } else {
      this.selectedRefs.delete(index);
    }
    this.updateRefsImportButton();
  }

  selectAllRefs() {
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));
    this.currentRefs.forEach((ref, index) => {
      if (!libraryBibcodes.has(ref.ref_bibcode)) {
        this.selectedRefs.add(index);
      }
    });
    document.querySelectorAll('.ref-checkbox:not(:disabled)').forEach(cb => cb.checked = true);
    this.updateRefsImportButton();
  }

  selectNoneRefs() {
    this.selectedRefs.clear();
    document.querySelectorAll('.ref-checkbox').forEach(cb => cb.checked = false);
    this.updateRefsImportButton();
  }

  updateRefsImportButton() {
    const btn = document.getElementById('refs-import-btn');
    const count = this.selectedRefs.size;
    btn.disabled = count === 0;
    btn.textContent = count > 0 ? `Import Selected (${count})` : 'Import Selected';
  }

  async importSelectedRefs() {
    if (this.selectedRefs.size === 0) return;

    const papers = Array.from(this.selectedRefs).map(index => {
      const ref = this.currentRefs[index];
      return { bibcode: ref.ref_bibcode };
    });

    await this.importPapersFromBibcodes(papers, 'refs');
  }

  // Cites selection methods
  toggleCiteSelection(index, selected) {
    if (selected) {
      this.selectedCites.add(index);
    } else {
      this.selectedCites.delete(index);
    }
    this.updateCitesImportButton();
  }

  selectAllCites() {
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));
    this.currentCites.forEach((cite, index) => {
      if (!libraryBibcodes.has(cite.citing_bibcode)) {
        this.selectedCites.add(index);
      }
    });
    document.querySelectorAll('.cite-checkbox:not(:disabled)').forEach(cb => cb.checked = true);
    this.updateCitesImportButton();
  }

  selectNoneCites() {
    this.selectedCites.clear();
    document.querySelectorAll('.cite-checkbox').forEach(cb => cb.checked = false);
    this.updateCitesImportButton();
  }

  updateCitesImportButton() {
    const btn = document.getElementById('cites-import-btn');
    const count = this.selectedCites.size;
    btn.disabled = count === 0;
    btn.textContent = count > 0 ? `Import Selected (${count})` : 'Import Selected';
  }

  async importSingleRef(bibcode, btn) {
    if (!bibcode) return;

    // Check if already in library
    const existing = this.papers.find(p => p.bibcode === bibcode);
    if (existing) {
      // Already in library, just switch to it
      this.selectPaper(existing.id);
      return;
    }

    const originalText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;

    try {
      // Import the paper using the ADS import
      const result = await window.electronAPI.adsImportPapers([{ bibcode }]);

      if (result.imported?.length > 0) {
        // Reload papers and select the new one
        await this.loadPapers();
        const newPaper = this.papers.find(p => p.bibcode === bibcode);
        if (newPaper) {
          this.selectPaper(newPaper.id);
        }
        btn.textContent = '✓';
      } else if (result.skipped?.length > 0) {
        btn.textContent = '✓';
      } else {
        btn.textContent = '!';
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
      }
    } catch (error) {
      console.error('Import failed:', error);
      btn.textContent = '!';
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
    }
  }

  async importSelectedCites() {
    if (this.selectedCites.size === 0) return;

    const papers = Array.from(this.selectedCites).map(index => {
      const cite = this.currentCites[index];
      return { bibcode: cite.citing_bibcode };
    });

    await this.importPapersFromBibcodes(papers, 'cites');
  }

  // Shared import method for refs/cites
  async importPapersFromBibcodes(papers, source) {
    // Show the ADS search modal for progress
    document.getElementById('ads-search-modal').classList.remove('hidden');
    document.getElementById('ads-query-input').value = `Importing ${papers.length} ${source}...`;
    document.getElementById('ads-search-execute-btn').disabled = true;
    document.getElementById('ads-results-list').innerHTML = '<p class="no-content">Fetching paper metadata from ADS...</p>';
    document.getElementById('ads-results-header').classList.add('hidden');

    const progressEl = document.getElementById('ads-progress');
    progressEl.classList.remove('hidden');

    try {
      const result = await window.electronAPI.adsImportPapers(papers);
      // Progress updates handled by onImportProgress listener
    } catch (error) {
      console.error('Import error:', error);
      document.getElementById('ads-results-list').innerHTML =
        `<p class="no-content" style="color: var(--error);">Import failed: ${error.message}</p>`;
    }
  }

  switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('hidden', pane.id !== `tab-${tabName}`);
      pane.classList.toggle('active', pane.id === `tab-${tabName}`);
    });

    // Load AI panel data when switching to AI tab
    if (tabName === 'ai' && this.selectedPaper) {
      this.loadAIPanelData();
    }

    // Handle multi-selection for info tabs
    if (this.selectedPapers.size > 1) {
      if (tabName === 'abstract') {
        this.displayMultiAbstract();
      } else if (tabName === 'refs') {
        this.displayMultiRefs();
      } else if (tabName === 'cites') {
        this.displayMultiCites();
      } else if (tabName === 'bibtex') {
        this.displayMultiBibtex();
      }
    }
  }

  // Refresh the current tab view (after sync, import, etc.)
  async refreshCurrentTabView() {
    if (!this.selectedPaper) return;

    const currentTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (!currentTab) return;

    // Reload paper data from database
    const paper = await window.electronAPI.getPaper(this.selectedPaper.id);
    if (paper) {
      // Update local reference
      this.selectedPaper = paper;
      // Update in papers array
      const index = this.papers.findIndex(p => p.id === paper.id);
      if (index >= 0) this.papers[index] = paper;
    }

    // Refresh based on current tab
    switch (currentTab) {
      case 'abstract':
        this.displayAbstract(paper);
        break;
      case 'refs':
        await this.loadReferences(paper.id);
        break;
      case 'cites':
        await this.loadCitations(paper.id);
        break;
      case 'bibtex':
        this.displayBibtex(paper);
        break;
      case 'pdf':
        // PDF usually doesn't need refresh after sync
        break;
      case 'ai':
        this.loadAIPanelData();
        break;
    }

    // Update bottom bar info
    this.updateBottomBar(paper);
  }

  // Multi-selection display methods
  displayMultiAbstract() {
    const abstractEl = document.getElementById('abstract-content');
    const papers = this.papers.filter(p => this.selectedPapers.has(p.id));

    if (papers.length === 0) return;

    const html = papers.map(paper => {
      // Format full author names
      const authors = paper.authors?.join('; ') || 'Unknown authors';
      // Build metadata line
      const metaParts = [];
      if (paper.journal) metaParts.push(paper.journal);
      if (paper.year) metaParts.push(paper.year);
      if (paper.bibcode) metaParts.push(paper.bibcode);
      const metaLine = metaParts.join(' • ');

      return `
        <div class="multi-paper-section">
          <h4>${this.escapeHtml(paper.title || 'Untitled')}</h4>
          <p class="paper-authors">${this.escapeHtml(authors)}</p>
          <p class="paper-meta">${this.escapeHtml(metaLine)}</p>
          <p class="paper-abstract">${paper.abstract ? this.escapeHtml(paper.abstract) : '<em>No abstract available</em>'}</p>
        </div>
      `;
    }).join('<hr style="margin: 16px 0; border-color: var(--border-color);">');

    abstractEl.innerHTML = html;
  }

  async displayMultiRefs() {
    const refsEl = document.getElementById('refs-list');
    const toolbar = document.getElementById('refs-toolbar');
    const papers = this.papers.filter(p => this.selectedPapers.has(p.id));

    if (papers.length === 0) return;

    refsEl.innerHTML = '<p class="no-content">Loading references...</p>';
    toolbar.classList.add('hidden');

    // Collect all references from all selected papers
    const allRefs = [];
    const seenBibcodes = new Set();

    for (const paper of papers) {
      const refs = await window.electronAPI.getReferences(paper.id);
      for (const ref of refs) {
        // Deduplicate by bibcode
        if (ref.ref_bibcode && seenBibcodes.has(ref.ref_bibcode)) continue;
        if (ref.ref_bibcode) seenBibcodes.add(ref.ref_bibcode);
        allRefs.push({ ...ref, sourcePaper: paper.title });
      }
    }

    if (allRefs.length === 0) {
      refsEl.innerHTML = `<p class="no-content">No references found for ${papers.length} selected papers.</p>`;
      return;
    }

    // Check which refs are already in library
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));

    // Store refs for selection tracking
    this.currentRefs = allRefs.map(ref => ({
      ref_bibcode: ref.ref_bibcode,
      ref_title: ref.ref_title,
      ref_authors: ref.ref_authors,
      ref_year: ref.ref_year
    }));
    this.selectedRefs.clear();

    const html = allRefs.map((ref, index) => {
      const bibcode = ref.ref_bibcode;
      const inLibrary = bibcode && libraryBibcodes.has(bibcode);
      const authors = this.formatAuthorsForList(ref.ref_authors);
      return `
        <div class="ref-item${inLibrary ? ' in-library' : ''}" data-index="${index}" data-bibcode="${bibcode || ''}">
          <span class="ref-number">${index + 1}.</span>
          <input type="checkbox" class="ref-checkbox" ${inLibrary ? 'disabled' : ''}>
          <div class="ref-content">
            <div class="ref-title">${this.escapeHtml(ref.ref_title || 'Unknown Title')}</div>
            <div class="ref-authors">${authors}</div>
            <div class="ref-meta">${[ref.ref_year, bibcode].filter(Boolean).join(' • ')}</div>
          </div>
          <button class="ref-import-btn" data-bibcode="${bibcode || ''}" title="Import this paper"${!bibcode ? ' disabled' : ''}>+</button>
        </div>
      `;
    }).join('');

    refsEl.innerHTML = html;
    toolbar.classList.remove('hidden');
    document.getElementById('refs-count').textContent = `${allRefs.length} references`;

    // Add event listeners
    refsEl.querySelectorAll('.ref-item').forEach(item => {
      const checkbox = item.querySelector('.ref-checkbox');
      const importBtn = item.querySelector('.ref-import-btn');
      const index = parseInt(item.dataset.index);

      item.addEventListener('click', (e) => {
        if (e.target === checkbox || e.target === importBtn) return;
        if (!checkbox.disabled) {
          checkbox.checked = !checkbox.checked;
          this.toggleRefSelection(index, checkbox.checked);
        }
      });

      checkbox.addEventListener('change', () => {
        this.toggleRefSelection(index, checkbox.checked);
      });

      importBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (item.dataset.bibcode) {
          await this.importSingleRef(item.dataset.bibcode, importBtn);
        }
      });
    });

    this.updateRefsImportButton();
  }

  async displayMultiCites() {
    const citesEl = document.getElementById('cites-list');
    const toolbar = document.getElementById('cites-toolbar');
    const papers = this.papers.filter(p => this.selectedPapers.has(p.id));

    if (papers.length === 0) return;

    citesEl.innerHTML = '<p class="no-content">Loading citations...</p>';
    toolbar.classList.add('hidden');

    // Collect all citations from all selected papers
    const allCites = [];
    const seenBibcodes = new Set();

    for (const paper of papers) {
      const cites = await window.electronAPI.getCitations(paper.id);
      for (const cite of cites) {
        // Deduplicate by bibcode
        if (cite.citing_bibcode && seenBibcodes.has(cite.citing_bibcode)) continue;
        if (cite.citing_bibcode) seenBibcodes.add(cite.citing_bibcode);
        allCites.push({ ...cite, sourcePaper: paper.title });
      }
    }

    if (allCites.length === 0) {
      citesEl.innerHTML = `<p class="no-content">No citations found for ${papers.length} selected papers.</p>`;
      return;
    }

    // Check which cites are already in library
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));

    // Store cites for selection tracking
    this.currentCites = allCites.map(cite => ({
      citing_bibcode: cite.citing_bibcode,
      citing_title: cite.citing_title,
      citing_authors: cite.citing_authors,
      citing_year: cite.citing_year
    }));
    this.selectedCites.clear();

    const html = allCites.map((cite, index) => {
      const bibcode = cite.citing_bibcode;
      const inLibrary = bibcode && libraryBibcodes.has(bibcode);
      const authors = this.formatAuthorsForList(cite.citing_authors);
      return `
        <div class="cite-item${inLibrary ? ' in-library' : ''}" data-index="${index}" data-bibcode="${bibcode || ''}">
          <span class="cite-number">${index + 1}.</span>
          <input type="checkbox" class="cite-checkbox" ${inLibrary ? 'disabled' : ''}>
          <div class="cite-content">
            <div class="cite-title">${this.escapeHtml(cite.citing_title || 'Unknown Title')}</div>
            <div class="cite-authors">${authors}</div>
            <div class="cite-meta">${[cite.citing_year, bibcode].filter(Boolean).join(' • ')}</div>
          </div>
          <button class="ref-import-btn" data-bibcode="${bibcode || ''}" title="Import this paper"${!bibcode ? ' disabled' : ''}>+</button>
        </div>
      `;
    }).join('');

    citesEl.innerHTML = html;
    toolbar.classList.remove('hidden');
    document.getElementById('cites-count').textContent = `${allCites.length} citations`;

    // Add event listeners
    citesEl.querySelectorAll('.cite-item').forEach(item => {
      const checkbox = item.querySelector('.cite-checkbox');
      const importBtn = item.querySelector('.ref-import-btn');
      const index = parseInt(item.dataset.index);

      item.addEventListener('click', (e) => {
        if (e.target === checkbox || e.target === importBtn) return;
        if (!checkbox.disabled) {
          checkbox.checked = !checkbox.checked;
          this.toggleCiteSelection(index, checkbox.checked);
        }
      });

      checkbox.addEventListener('change', () => {
        this.toggleCiteSelection(index, checkbox.checked);
      });

      importBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (item.dataset.bibcode) {
          await this.importSingleCite(item.dataset.bibcode, importBtn);
        }
      });
    });

    this.updateCitesImportButton();
  }

  displayMultiBibtex() {
    const bibtexEl = document.getElementById('bibtex-content');
    const papers = this.papers.filter(p => this.selectedPapers.has(p.id));

    if (papers.length === 0) return;

    const bibtexEntries = papers
      .map(p => p.bibtex)
      .filter(Boolean)
      .join('\n\n');

    bibtexEl.value = bibtexEntries || '% No BibTeX available for selected papers';
  }

  setView(view) {
    this.currentView = view;
    this.currentCollection = null;

    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.classList.toggle('active', item.dataset.view === view);
    });
    document.querySelectorAll('.nav-item[data-collection]').forEach(item => {
      item.classList.remove('active');
    });

    this.loadPapers();
  }

  async selectCollection(collectionId) {
    this.currentCollection = collectionId;
    this.currentView = null;

    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.classList.remove('active');
    });
    document.querySelectorAll('.nav-item[data-collection]').forEach(item => {
      item.classList.toggle('active', parseInt(item.dataset.collection) === collectionId);
    });

    this.papers = await window.electronAPI.getPapersInCollection(collectionId);
    this.sortPapers();
    this.renderPaperList();
  }

  async loadPapersInCollection(collectionId) {
    this.papers = await window.electronAPI.getPapersInCollection(collectionId);
    this.sortPapers();
    this.renderPaperList();
  }

  async importPDFs() {
    const result = await window.electronAPI.importPDFs();

    if (result.success && !result.canceled) {
      await this.loadPapers();
      const info = await window.electronAPI.getLibraryInfo(this.libraryPath);
      if (info) this.updateLibraryDisplay(info);

      // Select first imported paper
      if (result.results?.length > 0 && result.results[0].success) {
        this.selectPaper(result.results[0].id);
      }
    }
  }

  async importBibFile() {
    // Show loading state on button
    const btn = document.getElementById('import-bib-btn');
    const originalText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;

    try {
      const result = await window.electronAPI.importBibtex();

      if (result.success && !result.canceled) {
        await this.loadPapers();
        const info = await window.electronAPI.getLibraryInfo(this.libraryPath);
        if (info) this.updateLibraryDisplay(info);

        // Show result message
        const message = `Imported ${result.imported} papers` +
          (result.skipped > 0 ? `, skipped ${result.skipped} duplicates` : '');
        btn.textContent = `✓ ${result.imported}`;
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);

        console.log('BibTeX import result:', message);
      } else if (result.error) {
        console.error('BibTeX import error:', result.error);
        btn.textContent = '✕';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      } else {
        // Canceled
        btn.textContent = originalText;
      }
    } catch (error) {
      console.error('BibTeX import failed:', error);
      btn.textContent = '✕';
      setTimeout(() => {
        btn.textContent = originalText;
      }, 2000);
    } finally {
      btn.disabled = false;
    }
  }

  async removeSelectedPapers() {
    const count = this.selectedPapers.size;
    if (count === 0) return;

    // Build confirmation message
    let message;
    if (count === 1) {
      const paper = this.papers.find(p => this.selectedPapers.has(p.id));
      const title = paper?.title || 'Untitled';
      message = `Remove "${title}" from library?\n\nThis will delete the paper entry and its PDF file.`;
    } else {
      message = `Remove ${count} papers from library?\n\nThis will delete all paper entries and their PDF files.`;
    }

    if (!confirm(message)) {
      return;
    }

    try {
      // Use bulk delete for efficiency
      const ids = Array.from(this.selectedPapers);
      await window.electronAPI.deletePapersBulk(ids);

      // Clear selection
      this.selectedPapers.clear();
      this.selectedPaper = null;
      this.lastClickedIndex = -1;

      // Hide viewer, show placeholder
      document.getElementById('viewer-wrapper').classList.add('hidden');
      document.getElementById('detail-placeholder').classList.remove('hidden');
      document.title = 'ADS Reader';

      // Reload papers list
      await this.loadPapers();
      const info = await window.electronAPI.getLibraryInfo(this.libraryPath);
      if (info) this.updateLibraryDisplay(info);
      this.updateSelectionUI();

    } catch (error) {
      console.error('Failed to delete papers:', error);
      alert(`Failed to delete papers: ${error.message}`);
    }
  }

  async searchPapers(query) {
    if (!query.trim()) {
      await this.loadPapers();
      return;
    }

    console.log('Searching for:', query);
    const results = await window.electronAPI.searchPapers(query);
    console.log('Search results:', results);
    this.papers = results.map(r => r.paper);
    console.log('Papers after search:', this.papers);
    this.sortPapers();
    this.renderPaperList();
  }

  async updatePaperStatus(paperId, status) {
    await window.electronAPI.updatePaper(paperId, { read_status: status });

    // Update in local list
    const paper = this.papers.find(p => p.id === paperId);
    if (paper) paper.read_status = status;
    if (this.selectedPaper?.id === paperId) {
      this.selectedPaper.read_status = status;
      document.getElementById('read-status-select').value = status;
    }

    this.renderPaperList();

    // Update counts
    const info = await window.electronAPI.getLibraryInfo(this.libraryPath);
    if (info) this.updateLibraryDisplay(info);
  }

  async updatePaperRating(paperId, rating) {
    await window.electronAPI.updatePaper(paperId, { rating: rating });

    // Update in local list
    const paper = this.papers.find(p => p.id === paperId);
    if (paper) paper.rating = rating;
    if (this.selectedPaper?.id === paperId) {
      this.selectedPaper.rating = rating;
      document.getElementById('paper-rating-select').value = rating;
    }

    this.renderPaperList();
  }

  async fetchMetadata() {
    if (!this.selectedPaper || !this.hasAdsToken) return;

    // If paper already has a bibcode, try syncing first
    if (this.selectedPaper.bibcode) {
      this.addConsoleMessage(`Syncing ${this.selectedPaper.bibcode} with ADS...`, 'info');
      try {
        const result = await window.electronAPI.adsSyncPapers([this.selectedPaper.id]);
        if (result.success && result.updated > 0) {
          this.addConsoleMessage(`Synced successfully`, 'success');
          // Reload the paper data
          await this.loadPapers();
          const updated = this.papers.find(p => p.id === this.selectedPaper.id);
          if (updated) {
            this.selectedPaper = updated;
            this.showPaperDetails(updated);
          }
          return; // Success - no need to show dialog
        }
      } catch (e) {
        this.addConsoleMessage(`Sync failed: ${e.message}`, 'warn');
      }
      // Sync failed, fall through to show dialog
    }

    this.showAdsLookupModal();
  }

  // ===== ADS Lookup Modal =====

  async showAdsLookupModal() {
    if (!this.selectedPaper) return;

    const modal = document.getElementById('ads-lookup-modal');
    const titleEl = document.getElementById('ads-lookup-paper-title');
    const queryInput = document.getElementById('ads-lookup-query');
    const statusEl = document.getElementById('ads-lookup-status');
    const statusText = document.getElementById('ads-lookup-status-text');
    const resultsEl = document.getElementById('ads-lookup-results');

    // Reset state
    this.adsLookupSelectedDoc = null;
    titleEl.textContent = this.selectedPaper.title || 'Untitled';
    resultsEl.innerHTML = '<div class="ads-empty-state"><p>Extracting metadata...</p></div>';

    this.addConsoleMessage('Opening ADS lookup...', 'info');

    modal.classList.remove('hidden');

    // Check if paper has DOI - use it directly
    if (this.selectedPaper.doi) {
      let doi = this.selectedPaper.doi;
      doi = doi.replace(/^https?:\/\/doi\.org\//i, '');
      doi = doi.replace(/^doi:/i, '');
      queryInput.value = `doi:"${doi}"`;
      statusEl.classList.remove('hidden');
      statusText.textContent = 'Paper has DOI. Click Search to find in ADS.';
      this.addConsoleMessage(`Using DOI for search: ${doi}`, 'info');
      resultsEl.innerHTML = '<div class="ads-empty-state"><p>Click Search to find matching papers in ADS</p></div>';
      return;
    }

    // Extract metadata using LLM
    statusEl.classList.remove('hidden');
    statusText.textContent = 'Extracting metadata with AI...';
    this.addConsoleMessage('Extracting metadata with AI...', 'info');

    try {
      const result = await window.electronAPI.llmExtractMetadata(this.selectedPaper.id);
      console.log('LLM extraction result:', result);

      if (result.success && result.metadata) {
        const meta = result.metadata;
        console.log('Extracted metadata:', meta);

        // Build search query
        let query = '';
        if (meta.firstAuthor) query += `author:"^${meta.firstAuthor}" `;
        if (meta.year) query += `year:${meta.year} `;
        if (meta.title) {
          const titleWords = meta.title
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3)
            .slice(0, 6)
            .join(' ');
          if (titleWords) query += `title:(${titleWords})`;
        }

        query = query.trim();
        console.log('Built query:', query);

        // If query is empty, fall back to paper's existing data
        if (!query) {
          const paper = this.selectedPaper;
          if (paper.title) {
            const titleWords = paper.title
              .replace(/[^\w\s]/g, ' ')
              .split(/\s+/)
              .filter(w => w.length > 3)
              .slice(0, 6)
              .join(' ');
            if (titleWords) query = `title:(${titleWords})`;
          }
          if (paper.year) query = `year:${paper.year} ` + query;
          if (paper.authors?.[0]) {
            const firstAuthor = paper.authors[0].split(',')[0].trim();
            query = `author:"^${firstAuthor}" ` + query;
          }
          query = query.trim();
          statusText.textContent = 'Using paper metadata. Adjust query if needed.';
        } else {
          statusText.textContent = `Metadata extracted via ${result.source}. Adjust query if needed.`;
        }

        queryInput.value = query;
      } else {
        // Fall back to paper's existing data
        this.buildAdsQueryFromPaper(queryInput);
        statusText.textContent = 'Could not extract metadata. Using paper info.';
      }
    } catch (err) {
      console.error('Metadata extraction error:', err);
      this.buildAdsQueryFromPaper(queryInput);
      statusText.textContent = 'Extraction failed. Using paper info.';
    }

    resultsEl.innerHTML = '<div class="ads-empty-state"><p>Click Search to find matching papers in ADS</p></div>';
  }

  buildAdsQueryFromPaper(queryInput) {
    const paper = this.selectedPaper;
    if (!paper) {
      queryInput.value = '';
      return;
    }

    // If paper has DOI, use it directly (clean URL prefix if present)
    if (paper.doi) {
      let doi = paper.doi;
      // Remove URL prefixes like https://doi.org/
      doi = doi.replace(/^https?:\/\/doi\.org\//i, '');
      doi = doi.replace(/^doi:/i, '');
      queryInput.value = `doi:"${doi}"`;
      this.addConsoleMessage(`Using DOI for search: ${doi}`, 'info');
      return;
    }

    let query = '';
    if (paper.authors?.[0]) {
      const firstAuthor = paper.authors[0].split(',')[0].trim();
      query += `author:"^${firstAuthor}" `;
    }
    if (paper.year) {
      query += `year:${paper.year} `;
    }
    if (paper.title) {
      const titleWords = paper.title
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 6)
        .join(' ');
      if (titleWords) query += `title:(${titleWords})`;
    }

    queryInput.value = query.trim();
    this.addConsoleMessage(`Built search query from paper metadata`, 'info');
  }

  hideAdsLookupModal() {
    document.getElementById('ads-lookup-modal').classList.add('hidden');
    this.adsLookupSelectedDoc = null;
  }

  // ===== ADS Sync =====

  async startAdsSync() {
    // Check if ADS token is configured
    const token = await window.electronAPI.getAdsToken();
    if (!token) {
      alert('Please configure your ADS API token first.');
      return;
    }

    // Get selected paper IDs - use multi-select if available, otherwise current paper
    let paperIds = [];
    if (this.selectedPapers.size > 0) {
      paperIds = Array.from(this.selectedPapers);
    } else if (this.selectedPaper) {
      paperIds = [this.selectedPaper.id];
    }

    if (paperIds.length === 0) {
      alert('No papers selected. Please select one or more papers to sync.');
      return;
    }

    // Show progress modal
    const modal = document.getElementById('ads-sync-modal');
    modal.classList.remove('hidden');

    const statusEl = document.getElementById('sync-status');
    const progressEl = document.getElementById('sync-progress-fill');
    const paperEl = document.getElementById('sync-current-paper');
    const timerEl = document.getElementById('sync-timer');

    const paperCount = paperIds.length;
    statusEl.textContent = `Starting sync of ${paperCount} paper${paperCount > 1 ? 's' : ''}...`;
    progressEl.style.width = '0%';
    paperEl.textContent = '';

    // Reset button states - show cancel, hide close
    document.getElementById('sync-cancel-btn').classList.remove('hidden');
    document.getElementById('sync-cancel-btn').disabled = false;
    document.getElementById('sync-cancel-btn').textContent = 'Cancel';
    document.getElementById('sync-close-btn').classList.add('hidden');

    // Start timer
    const startTime = Date.now();
    timerEl.textContent = '0:00';
    const formatTime = (ms) => {
      const seconds = Math.floor(ms / 1000);
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    const timerInterval = setInterval(() => {
      timerEl.textContent = formatTime(Date.now() - startTime);
    }, 1000);

    // Add spinning animation to button
    const syncBtn = document.getElementById('ads-sync-btn');
    syncBtn.classList.add('syncing');
    syncBtn.disabled = true;

    // Set up progress listener
    const cancelBtn = document.getElementById('sync-cancel-btn');
    const closeBtn = document.getElementById('sync-close-btn');
    window.electronAPI.onAdsSyncProgress((data) => {
      console.log('Sync progress event:', data);
      if (data.done) {
        // Stop timer
        clearInterval(timerInterval);
        const elapsed = formatTime(Date.now() - startTime);
        timerEl.textContent = data.cancelled ? `Cancelled after ${elapsed}` : `Completed in ${elapsed}`;

        // Sync complete or cancelled
        const r = data.results;
        if (data.cancelled) {
          statusEl.textContent = `⚠ Sync cancelled. Updated ${r.updated}, skipped ${r.skipped}, failed ${r.failed}`;
          progressEl.style.backgroundColor = '#f0ad4e';
        } else {
          statusEl.textContent = `✓ Sync complete! Updated ${r.updated}, skipped ${r.skipped}, failed ${r.failed}`;
          progressEl.style.backgroundColor = '#28a745';
        }
        progressEl.style.width = '100%';
        paperEl.textContent = '';

        syncBtn.classList.remove('syncing');
        syncBtn.disabled = false;

        // Show close button, hide cancel button
        cancelBtn.classList.add('hidden');
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel';
        closeBtn.classList.remove('hidden');

        // Reload papers and refresh view
        const selectedPaperId = this.selectedPaper?.id;
        (async () => {
          try {
            await this.loadPapers();
            if (selectedPaperId) {
              // Re-fetch the updated paper and refresh view
              const paper = await window.electronAPI.getPaper(selectedPaperId);
              if (paper) {
                this.selectedPaper = paper;
                // Update in papers array too
                const index = this.papers.findIndex(p => p.id === paper.id);
                if (index >= 0) this.papers[index] = paper;
                // Force re-select to update all panes
                await this.selectPaper(paper.id);
              }
            }
          } catch (err) {
            console.error('Error refreshing after sync:', err);
          }
        })();

        // Auto-close after 2 seconds (3 seconds if cancelled to show the message)
        setTimeout(() => {
          console.log('Auto-closing sync modal');
          this.hideAdsSyncModal();
          progressEl.style.backgroundColor = '';
        }, data.cancelled ? 3000 : 2000);
      } else {
        // Progress update
        const percent = Math.round((data.current / data.total) * 100);
        statusEl.textContent = `Syncing ${data.current} of ${data.total} papers...`;
        progressEl.style.width = `${percent}%`;
        paperEl.textContent = data.paper || '';
      }
    });

    // Start the sync with selected paper IDs
    try {
      await window.electronAPI.adsSyncPapers(paperIds);
    } catch (error) {
      clearInterval(timerInterval);
      statusEl.textContent = `Sync failed: ${error.message}`;
      // Show close button on error
      cancelBtn.classList.add('hidden');
      closeBtn.classList.remove('hidden');
      syncBtn.classList.remove('syncing');
      syncBtn.disabled = false;
      // Clean up listener on error
      window.electronAPI.removeAdsSyncListeners();
    }
    // Note: listener cleanup on success happens in the setTimeout callback after auto-close
  }

  hideAdsSyncModal() {
    document.getElementById('ads-sync-modal').classList.add('hidden');
    // Clean up listener when modal is closed (manually or auto)
    window.electronAPI.removeAdsSyncListeners();
    // Reset button states
    document.getElementById('sync-cancel-btn')?.classList.remove('hidden');
    document.getElementById('sync-close-btn')?.classList.add('hidden');
  }

  async cancelAdsSync() {
    const cancelBtn = document.getElementById('sync-cancel-btn');
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling...';
    await window.electronAPI.adsCancelSync();
    // The progress handler will handle the UI updates when done event arrives
  }

  async searchAdsLookup() {
    const query = document.getElementById('ads-lookup-query').value.trim();
    if (!query) return;

    const resultsEl = document.getElementById('ads-lookup-results');
    const statusEl = document.getElementById('ads-lookup-status');
    const statusText = document.getElementById('ads-lookup-status-text');

    statusEl.classList.remove('hidden');
    statusText.textContent = 'Searching ADS...';
    resultsEl.innerHTML = '';

    try {
      const result = await window.electronAPI.adsSearch(query, { rows: 10 });
      console.log('ADS lookup search result:', result);

      if (result.success && result.data?.papers?.length > 0) {
        statusText.textContent = `Found ${result.data.numFound} papers`;
        this.renderAdsLookupResults(result.data.papers);
      } else if (result.error) {
        statusText.textContent = 'Search failed: ' + result.error;
        resultsEl.innerHTML = '<div class="ads-empty-state"><p>Search error</p></div>';
      } else {
        statusText.textContent = 'No papers found. Try adjusting your search.';
        resultsEl.innerHTML = '<div class="ads-empty-state"><p>No results found</p></div>';
      }
    } catch (err) {
      console.error('ADS lookup error:', err);
      statusText.textContent = 'Search failed: ' + err.message;
    }
  }

  renderAdsLookupResults(papers) {
    const resultsEl = document.getElementById('ads-lookup-results');

    resultsEl.innerHTML = papers.map((paper, i) => `
      <div class="ads-result-item" data-index="${i}">
        <div class="ads-result-info">
          <div class="ads-result-title">${this.escapeHtml(paper.title || 'Untitled')}</div>
          <div class="ads-result-meta">
            <span>${paper.authors?.[0] || 'Unknown'}</span>
            <span>${paper.year || ''}</span>
            <span>${paper.bibcode || ''}</span>
          </div>
          ${paper.abstract ? `<div class="ads-result-abstract">${this.escapeHtml(paper.abstract.substring(0, 200))}...</div>` : ''}
        </div>
        <button class="ads-lookup-import-btn" data-index="${i}" title="Apply this metadata">+</button>
      </div>
    `).join('');

    // Store papers for selection
    this.adsLookupPapers = papers;

    // Add click handlers for import buttons
    resultsEl.querySelectorAll('.ads-lookup-import-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const index = parseInt(btn.dataset.index);
        this.adsLookupSelectedDoc = this.adsLookupPapers[index];
        btn.textContent = '...';
        btn.disabled = true;
        await this.applyAdsLookupMetadata();
      });
    });
  }

  async applyAdsLookupMetadata() {
    if (!this.selectedPaper || !this.adsLookupSelectedDoc) return;

    try {
      // Use the raw ADS doc if available, otherwise reconstruct it
      const doc = this.adsLookupSelectedDoc._raw || {
        bibcode: this.adsLookupSelectedDoc.bibcode,
        title: [this.adsLookupSelectedDoc.title],
        author: this.adsLookupSelectedDoc.authors,
        year: this.adsLookupSelectedDoc.year,
        doi: this.adsLookupSelectedDoc.doi ? [this.adsLookupSelectedDoc.doi] : undefined,
        abstract: this.adsLookupSelectedDoc.abstract,
        pub: this.adsLookupSelectedDoc.journal,
        keyword: this.adsLookupSelectedDoc.keywords,
        identifier: this.adsLookupSelectedDoc.arxiv_id ? [`arXiv:${this.adsLookupSelectedDoc.arxiv_id}`] : []
      };

      // Do a full import from ADS (creates new entry with PDF if available)
      const result = await window.electronAPI.importSingleFromAds(doc);

      if (result.success) {
        const pdfMsg = result.hasPdf ? ' with PDF' : '';
        this.addConsoleMessage(`Imported from ADS${pdfMsg}`, 'success');

        // Reload paper list and select the newly imported paper
        await this.loadPapers();
        if (result.paperId) {
          await this.selectPaper(result.paperId);
          await this.refreshCurrentTabView();
        }

        // Auto-close modal
        this.hideAdsLookupModal();
      } else {
        alert('Failed to import from ADS: ' + result.error);
      }
    } catch (error) {
      alert('Failed to import from ADS: ' + error.message);
    }
  }

  async copyCite() {
    if (this.selectedPapers.size === 0) return;

    // Get paper IDs in selection order
    const paperIds = Array.from(this.selectedPapers);

    const result = await window.electronAPI.copyCite(paperIds, 'cite');
    if (result.success) {
      const btn = document.getElementById('copy-cite-btn');
      const originalText = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => btn.textContent = originalText, 1500);
    }
  }

  copyBibtex() {
    const textarea = document.getElementById('bibtex-content');
    navigator.clipboard.writeText(textarea.value);

    const btn = document.getElementById('copy-bibtex-btn');
    const originalText = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.textContent = originalText, 1500);
  }

  async exportBibtexToFile() {
    const textarea = document.getElementById('bibtex-content');
    const content = textarea.value;

    if (!content || content.startsWith('%')) {
      return; // No content to export
    }

    const btn = document.getElementById('export-bibtex-btn');
    const originalText = btn.textContent;

    const result = await window.electronAPI.saveBibtexFile(content);

    if (result.success) {
      btn.textContent = '✓ Saved!';
      setTimeout(() => btn.textContent = originalText, 1500);
    }
  }

  openInADS() {
    if (!this.selectedPaper?.bibcode) return;
    window.electronAPI.openExternal(`https://ui.adsabs.harvard.edu/abs/${this.selectedPaper.bibcode}`);
  }

  openSelectedPaperInADS() {
    this.hidePaperContextMenu();
    // If multiple selected, open the first one; otherwise use rightClickedPaper or selectedPaper
    const paper = this.rightClickedPaper || this.selectedPaper;
    if (!paper?.bibcode) return;
    window.electronAPI.openExternal(`https://ui.adsabs.harvard.edu/abs/${paper.bibcode}`);
  }

  async openPublisherPDF() {
    this.hidePaperContextMenu();
    const paper = this.rightClickedPaper || this.selectedPaper;
    if (!paper?.bibcode) {
      alert('No paper selected or paper has no bibcode');
      return;
    }

    // Get the proxy URL from settings
    let proxyUrl = await window.electronAPI.getLibraryProxy();

    // Construct the publisher PDF URL via ADS link gateway
    // This will redirect to the publisher and proxy will handle auth
    let url = `https://ui.adsabs.harvard.edu/link_gateway/${paper.bibcode}/PUB_PDF`;

    if (proxyUrl) {
      // Normalize proxy URL format for EZProxy
      proxyUrl = proxyUrl.trim();
      if (!proxyUrl.includes('?url=') && !proxyUrl.endsWith('=')) {
        if (proxyUrl.includes('?')) {
          proxyUrl += '&url=';
        } else {
          proxyUrl += '?url=';
        }
      }
      // EZProxy expects unencoded URLs
      url = proxyUrl + url;
    }

    window.electronAPI.openExternal(url);
  }

  // PDF Source Dropdown
  async showPdfSourceDropdown(btn, paperId, bibcode) {
    // Select this paper so the PDF viewer shows the right paper
    this.selectPaper(paperId);

    // Hide any existing dropdown
    this.hidePdfSourceDropdown();

    // Show loading state
    btn.textContent = '⏳';

    try {
      // Fetch available sources
      const result = await window.electronAPI.adsGetEsources(bibcode);

      if (!result.success) {
        btn.textContent = '📄';
        alert(`Failed to get PDF sources: ${result.error}`);
        return;
      }

      const sources = result.data;

      // Fetch annotation counts by source for this paper
      const annotationCounts = await window.electronAPI.getAnnotationCountsBySource(paperId);

      // Check which PDFs are already downloaded
      const downloadedPdfs = await window.electronAPI.getDownloadedPdfSources(paperId);

      // Get user's preferred PDF source priority
      const priority = await window.electronAPI.getPdfPriority();

      btn.textContent = '📄';

      // Map source types to display info
      const sourceInfo = {
        'EPRINT_PDF': { key: 'arxiv', type: 'arxiv', label: '📑 arXiv', available: sources.arxiv },
        'PUB_PDF': { key: 'publisher', type: 'publisher', label: '📰 Publisher', available: sources.publisher },
        'ADS_PDF': { key: 'ads', type: 'ads', label: '📜 ADS Scan', available: sources.ads }
      };

      // Collect available sources in priority order
      const availableSources = [];
      for (const sourceType of priority) {
        const info = sourceInfo[sourceType];
        if (info && info.available) {
          const count = annotationCounts[sourceType] || 0;
          const downloaded = downloadedPdfs.includes(sourceType);
          availableSources.push({ type: info.type, label: info.label, noteCount: count, downloaded });
        }
      }

      // If no sources available
      if (availableSources.length === 0) {
        alert('No PDF sources available for this paper');
        return;
      }

      // If only one source, download/show it directly
      if (availableSources.length === 1) {
        await this.downloadFromSource(paperId, availableSources[0].type, null);
        return;
      }

      // Multiple sources - show dropdown menu
      const dropdown = document.createElement('div');
      dropdown.className = 'pdf-source-dropdown';
      dropdown.dataset.paperId = paperId;

      dropdown.innerHTML = availableSources.map(s => {
        const notesBadge = s.noteCount > 0 ? `<span class="note-count-badge">${s.noteCount} 📝</span>` : '';
        const downloadedIcon = s.downloaded ? '✓ ' : '';
        const deleteBtn = s.downloaded ? `<span class="pdf-delete-btn" data-source="${s.type}" title="Delete this PDF">×</span>` : '';
        return `<div class="pdf-source-item${s.downloaded ? ' downloaded' : ''}" data-source="${s.type}">${downloadedIcon}${s.label}${notesBadge}${deleteBtn}</div>`;
      }).join('');

      // Position dropdown below button
      const btnRect = btn.getBoundingClientRect();
      dropdown.style.position = 'fixed';
      dropdown.style.left = `${btnRect.left}px`;
      dropdown.style.top = `${btnRect.bottom + 2}px`;

      document.body.appendChild(dropdown);

      // Add click handlers for source items
      dropdown.querySelectorAll('.pdf-source-item').forEach(item => {
        item.addEventListener('click', async (e) => {
          // Don't trigger if clicking delete button
          if (e.target.classList.contains('pdf-delete-btn')) return;
          e.stopPropagation();
          const sourceType = item.dataset.source;
          await this.downloadFromSource(paperId, sourceType, item);
        });
      });

      // Add click handlers for delete buttons
      dropdown.querySelectorAll('.pdf-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const sourceType = btn.dataset.source;
          const paper = this.papers.find(p => p.id === paperId);
          if (!paper) return;

          const sourceTypeMap = { 'arxiv': 'EPRINT_PDF', 'publisher': 'PUB_PDF', 'ads': 'ADS_PDF' };
          const pdfSourceType = sourceTypeMap[sourceType] || sourceType;

          if (confirm(`Delete the ${sourceType} PDF for this paper?`)) {
            const deleted = await window.electronAPI.deletePdf(paperId, pdfSourceType);
            if (deleted) {
              // Update item to show not downloaded
              const item = btn.closest('.pdf-source-item');
              item.classList.remove('downloaded');
              item.innerHTML = item.innerHTML.replace('✓ ', '').replace(/<span class="pdf-delete-btn"[^>]*>×<\/span>/, '');
              this.addConsoleMessage(`Deleted ${sourceType} PDF`, 'info');
            }
          }
        });
      });

      // Close dropdown when clicking outside
      setTimeout(() => {
        document.addEventListener('click', this.hidePdfSourceDropdownHandler = (e) => {
          if (!dropdown.contains(e.target) && e.target !== btn) {
            this.hidePdfSourceDropdown();
          }
        });
      }, 0);
    } catch (error) {
      btn.textContent = '📄';
      console.error('Error fetching PDF sources:', error);
    }
  }

  hidePdfSourceDropdown() {
    const dropdown = document.querySelector('.pdf-source-dropdown');
    if (dropdown) {
      dropdown.remove();
    }
    if (this.hidePdfSourceDropdownHandler) {
      document.removeEventListener('click', this.hidePdfSourceDropdownHandler);
      this.hidePdfSourceDropdownHandler = null;
    }
  }

  async downloadFromSource(paperId, sourceType, menuItem) {
    this.hidePdfSourceDropdown();
    console.log(`[downloadFromSource] Starting download: paperId=${paperId}, sourceType=${sourceType}`);

    const paper = this.papers.find(p => p.id === paperId);
    if (!paper) {
      console.log(`[downloadFromSource] Paper not found: ${paperId}`);
      return;
    }

    // Map source types to PDF source identifiers
    const sourceToType = {
      publisher: 'PUB_PDF',
      arxiv: 'EPRINT_PDF',
      ads: 'ADS_PDF',
      author: 'AUTHOR_PDF'
    };

    const requestedSourceType = sourceToType[sourceType];

    // Check if the REQUESTED source's PDF already exists
    // Filename format: bibcode_SOURCETYPE.pdf
    if (paper.bibcode) {
      const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
      const expectedPath = `papers/${baseFilename}_${requestedSourceType}.pdf`;

      console.log(`[downloadFromSource] Checking for PDF: ${expectedPath}`);

      const pdfPath = await window.electronAPI.getPdfPath(expectedPath);
      if (pdfPath) {
        console.log(`[downloadFromSource] ${sourceType} PDF found, loading: ${expectedPath}`);
        paper.pdf_path = expectedPath;
        if (this.selectedPaper && this.selectedPaper.id === paperId) {
          this.selectedPaper.pdf_path = expectedPath;
          this.currentPdfSource = requestedSourceType;
          await this.loadPDF(this.selectedPaper);
        }
        await window.electronAPI.updatePaper(paperId, { pdf_path: expectedPath });
        return;
      }

      console.log(`[downloadFromSource] ${sourceType} PDF not found, proceeding to download`);
    }

    // Publisher PDFs require authentication - open in auth window to download
    if (sourceType === 'publisher') {
      console.log(`[downloadFromSource] Publisher download path for bibcode: ${paper.bibcode}`);
      // Get the direct publisher PDF URL from esources
      const esourcesResult = await window.electronAPI.adsGetEsources(paper.bibcode);
      let publisherUrl = null;

      console.log(`[downloadFromSource] esourcesResult:`, esourcesResult);

      if (esourcesResult.success && esourcesResult.data.publisher) {
        publisherUrl = esourcesResult.data.publisher.url;
        console.log(`[downloadFromSource] Got publisher URL from esources: ${publisherUrl}`);
      }

      // Fall back to ADS link gateway if no direct URL
      if (!publisherUrl) {
        publisherUrl = `https://ui.adsabs.harvard.edu/link_gateway/${paper.bibcode}/PUB_PDF`;
        console.log(`[downloadFromSource] Using fallback ADS gateway URL: ${publisherUrl}`);
      }

      const proxyUrl = await window.electronAPI.getLibraryProxy();
      console.log('[downloadFromSource] Calling downloadPublisherPdf:', { proxyUrl, publisherUrl, bibcode: paper.bibcode });

      // Show loading indicator
      const paperItem = document.querySelector(`.paper-item[data-id="${paperId}"]`);
      const btn = paperItem?.querySelector('.pdf-source-btn');
      if (btn) {
        btn.textContent = '⏳';
        btn.disabled = true;
      }

      try {
        // Open auth window and download
        const result = await window.electronAPI.downloadPublisherPdf(paperId, publisherUrl, proxyUrl);

        if (result.success) {
          // Update local paper data
          paper.pdf_path = result.pdf_path;

          // Reload the PDF if this paper is currently displayed
          if (this.selectedPaper && this.selectedPaper.id === paperId) {
            this.selectedPaper.pdf_path = result.pdf_path;
            this.currentPdfSource = 'PUB_PDF';
            await this.loadPDF(this.selectedPaper);
          }

          if (btn) {
            btn.textContent = '✓';
            setTimeout(() => {
              btn.textContent = '📄';
              btn.disabled = false;
            }, 1500);
          }
        } else {
          alert(`Download failed: ${result.error}`);
          if (btn) {
            btn.textContent = '📄';
            btn.disabled = false;
          }
        }
      } catch (error) {
        console.error('Publisher PDF download error:', error);
        alert(`Download error: ${error.message}`);
        if (btn) {
          btn.textContent = '📄';
          btn.disabled = false;
        }
      }
      return;
    }

    // Map source types to PDF source identifiers
    const sourceMap = { arxiv: 'EPRINT_PDF', ads: 'ADS_PDF', author: 'AUTHOR_PDF' };

    // For arXiv and ADS PDFs, download directly
    const paperItem = document.querySelector(`.paper-item[data-id="${paperId}"]`);
    const btn = paperItem?.querySelector('.pdf-source-btn');
    if (btn) {
      btn.textContent = '⏳';
      btn.disabled = true;
    }

    try {
      const result = await window.electronAPI.downloadPdfFromSource(paperId, sourceType);

      if (result.success) {
        // Update local paper data
        paper.pdf_path = result.pdf_path;

        // Reload the PDF if this paper is currently displayed
        if (this.selectedPaper && this.selectedPaper.id === paperId) {
          this.selectedPaper.pdf_path = result.pdf_path;
          this.currentPdfSource = sourceMap[sourceType] || null;
          await this.loadPDF(this.selectedPaper);
        }

        // Show success
        if (btn) {
          btn.textContent = '✓';
          setTimeout(() => {
            btn.textContent = '📄';
            btn.disabled = false;
          }, 1500);
        }
      } else {
        alert(`Download failed: ${result.error}`);
        if (btn) {
          btn.textContent = '📄';
          btn.disabled = false;
        }
      }
    } catch (error) {
      console.error('Download error:', error);
      alert(`Download error: ${error.message}`);
      if (btn) {
        btn.textContent = '📄';
        btn.disabled = false;
      }
    }
  }

  async syncSelectedPapers() {
    this.hidePaperContextMenu();
    // Get the papers to sync from right-click context or selection
    let paperIds = [];
    if (this.selectedPapers.size > 0) {
      paperIds = Array.from(this.selectedPapers);
    } else if (this.rightClickedPaper) {
      paperIds = [this.rightClickedPaper.id];
    } else if (this.selectedPaper) {
      paperIds = [this.selectedPaper.id];
    }

    if (paperIds.length === 0) {
      alert('No papers selected');
      return;
    }

    // Use the existing startAdsSync method
    this.startAdsSync(paperIds);
  }

  selectNextPaper() {
    if (!this.papers.length) return;

    const currentIndex = this.selectedPaper
      ? this.papers.findIndex(p => p.id === this.selectedPaper.id)
      : -1;

    const nextIndex = Math.min(currentIndex + 1, this.papers.length - 1);
    this.selectPaper(this.papers[nextIndex].id);
  }

  selectPreviousPaper() {
    if (!this.papers.length) return;

    const currentIndex = this.selectedPaper
      ? this.papers.findIndex(p => p.id === this.selectedPaper.id)
      : this.papers.length;

    const prevIndex = Math.max(currentIndex - 1, 0);
    this.selectPaper(this.papers[prevIndex].id);
  }

  // Settings section toggle
  toggleSettings() {
    const header = document.getElementById('settings-header');
    const items = document.getElementById('settings-items');
    header.classList.toggle('collapsed');
    items.classList.toggle('collapsed');
  }

  // ADS Token Modal
  async checkAdsToken() {
    const token = await window.electronAPI.getAdsToken();
    this.hasAdsToken = !!token;

    const status = document.getElementById('ads-status');
    status.classList.toggle('connected', this.hasAdsToken);
  }

  async checkProxyStatus() {
    const proxyUrl = await window.electronAPI.getLibraryProxy();
    const status = document.getElementById('proxy-status');
    status.classList.toggle('connected', !!proxyUrl);
  }

  async showAdsTokenModal() {
    document.getElementById('ads-token-modal').classList.remove('hidden');
    document.getElementById('ads-token-input').focus();

    // Load current ADS token
    const token = await window.electronAPI.getAdsToken();
    document.getElementById('ads-token-input').value = token || '';
  }

  hideAdsTokenModal() {
    document.getElementById('ads-token-modal').classList.add('hidden');
    document.getElementById('ads-token-input').value = '';
    document.getElementById('ads-modal-status').textContent = '';
  }

  async saveAdsToken() {
    const token = document.getElementById('ads-token-input').value.trim();
    const statusEl = document.getElementById('ads-modal-status');

    if (!token) {
      statusEl.className = 'modal-status error';
      statusEl.textContent = 'Please enter a token';
      return;
    }

    statusEl.className = 'modal-status';
    statusEl.textContent = 'Validating...';

    const result = await window.electronAPI.setAdsToken(token);

    if (result.success) {
      this.hasAdsToken = true;
      document.getElementById('ads-status').classList.add('connected');
      statusEl.className = 'modal-status success';
      statusEl.textContent = 'Token saved successfully!';
      setTimeout(() => this.hideAdsTokenModal(), 1000);
    } else {
      statusEl.className = 'modal-status error';
      statusEl.textContent = `Invalid token: ${result.error}`;
    }
  }

  // Library Proxy Modal
  async showLibraryProxyModal() {
    document.getElementById('library-proxy-modal').classList.remove('hidden');
    document.getElementById('library-proxy-input').focus();

    const proxyUrl = await window.electronAPI.getLibraryProxy();
    document.getElementById('library-proxy-input').value = proxyUrl || '';
  }

  hideLibraryProxyModal() {
    document.getElementById('library-proxy-modal').classList.add('hidden');
    document.getElementById('library-proxy-input').value = '';
    document.getElementById('proxy-modal-status').textContent = '';
  }

  async saveLibraryProxy() {
    const proxyUrl = document.getElementById('library-proxy-input').value.trim();
    const statusEl = document.getElementById('proxy-modal-status');

    statusEl.className = 'modal-status';
    statusEl.textContent = 'Saving...';

    await window.electronAPI.setLibraryProxy(proxyUrl);

    document.getElementById('proxy-status').classList.toggle('connected', !!proxyUrl);
    statusEl.className = 'modal-status success';
    statusEl.textContent = proxyUrl ? 'Proxy saved!' : 'Proxy cleared!';
    setTimeout(() => this.hideLibraryProxyModal(), 1000);
  }

  // Preferences Modal
  async showPreferencesModal() {
    document.getElementById('preferences-modal').classList.remove('hidden');

    // Load current PDF priority
    const priority = await window.electronAPI.getPdfPriority();
    this.updatePriorityListUI(priority);

    // Setup drag-and-drop
    this.setupPriorityListDragDrop();
  }

  hidePreferencesModal() {
    document.getElementById('preferences-modal').classList.add('hidden');
  }

  updatePriorityListUI(priorityOrder) {
    const list = document.getElementById('pdf-priority-list');
    const items = Array.from(list.querySelectorAll('li'));

    // Sort items according to priority order
    priorityOrder.forEach((sourceType, index) => {
      const item = items.find(li => li.dataset.source === sourceType);
      if (item) {
        list.appendChild(item);
      }
    });
  }

  setupPriorityListDragDrop() {
    const list = document.getElementById('pdf-priority-list');
    const items = list.querySelectorAll('li');
    let draggedItem = null;

    items.forEach(item => {
      item.addEventListener('dragstart', (e) => {
        draggedItem = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        draggedItem = null;
        items.forEach(i => i.classList.remove('drag-over'));
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (item !== draggedItem) {
          item.classList.add('drag-over');
        }
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        if (draggedItem && item !== draggedItem) {
          const allItems = Array.from(list.querySelectorAll('li'));
          const draggedIdx = allItems.indexOf(draggedItem);
          const targetIdx = allItems.indexOf(item);

          if (draggedIdx < targetIdx) {
            item.after(draggedItem);
          } else {
            item.before(draggedItem);
          }
        }
      });
    });
  }

  async savePreferences() {
    const list = document.getElementById('pdf-priority-list');
    const items = Array.from(list.querySelectorAll('li'));
    const priority = items.map(item => item.dataset.source);

    const result = await window.electronAPI.setPdfPriority(priority);
    if (result.success) {
      this.hidePreferencesModal();
    }
  }

  // Collection Modal
  showCollectionModal() {
    document.getElementById('collection-modal').classList.remove('hidden');
    document.getElementById('collection-name-input').focus();
  }

  hideCollectionModal() {
    document.getElementById('collection-modal').classList.add('hidden');
    document.getElementById('collection-name-input').value = '';
  }

  async createCollection() {
    const name = document.getElementById('collection-name-input').value.trim();
    if (!name) return;

    await window.electronAPI.createCollection(name);
    await this.loadCollections();
    this.hideCollectionModal();
  }

  async deleteCollection(collectionId) {
    const collection = this.collections.find(c => c.id === collectionId);
    if (!collection) return;

    // Confirm deletion
    const confirmed = confirm(`Delete collection "${collection.name}"?\n\nThis will not delete the papers, only the collection.`);
    if (!confirmed) return;

    await window.electronAPI.deleteCollection(collectionId);

    // If we were viewing this collection, switch to all papers
    if (this.currentCollection === collectionId) {
      this.currentCollection = null;
      this.setView('all');
    }

    await this.loadCollections();
  }

  // ADS Search Modal
  showAdsSearchModal() {
    if (!this.hasAdsToken) {
      this.showAdsTokenModal();
      return;
    }
    document.getElementById('ads-search-modal').classList.remove('hidden');
    document.getElementById('ads-query-input').focus();
  }

  hideAdsSearchModal() {
    document.getElementById('ads-search-modal').classList.add('hidden');
    document.getElementById('ads-query-input').value = '';
    this.adsResults = [];
    this.adsSelected.clear();
    this.renderAdsResults();
    document.getElementById('ads-results-header').classList.add('hidden');
    document.getElementById('ads-progress').classList.add('hidden');
  }

  async executeAdsSearch() {
    const query = document.getElementById('ads-query-input').value.trim();
    if (!query) return;

    const searchBtn = document.getElementById('ads-search-execute-btn');
    searchBtn.textContent = 'Searching...';
    searchBtn.disabled = true;

    try {
      const result = await window.electronAPI.adsImportSearch(query, { rows: 1000 });

      if (result.success) {
        this.adsResults = result.data.papers;
        this.adsSelected.clear();
        document.getElementById('ads-results-count').textContent =
          `${result.data.numFound} papers found${result.data.numFound > 1000 ? ' (showing first 1000)' : ''}`;
        document.getElementById('ads-results-header').classList.remove('hidden');
        this.renderAdsResults();
      } else {
        this.showAdsError(result.error);
      }
    } catch (error) {
      this.showAdsError(error.message);
    } finally {
      searchBtn.textContent = 'Search';
      searchBtn.disabled = false;
    }
  }

  renderAdsResults() {
    const listEl = document.getElementById('ads-results-list');

    if (this.adsResults.length === 0) {
      listEl.innerHTML = `
        <div class="ads-empty-state">
          <p>Enter a search query to find papers in NASA ADS</p>
        </div>
      `;
      this.updateAdsSelectedCount();
      return;
    }

    listEl.innerHTML = this.adsResults.map((paper, index) => {
      const authorsList = paper.authors || [];
      const authorsDisplay = this.formatAuthorsForList(authorsList);
      const hasArxiv = !!paper.arxiv_id;
      const isInLibrary = paper.inLibrary;
      const isSelected = this.adsSelected.has(index);
      const abstractPreview = paper.abstract
        ? paper.abstract.substring(0, 200) + (paper.abstract.length > 200 ? '...' : '')
        : null;

      return `
        <div class="ads-result-item${isSelected ? ' selected' : ''}${isInLibrary ? ' in-library' : ''}" data-index="${index}">
          <input type="checkbox" class="ads-result-checkbox"
            ${isSelected ? 'checked' : ''} ${isInLibrary ? 'disabled' : ''}>
          <div class="ads-result-content">
            <div class="ads-result-title">${this.escapeHtml(paper.title)}</div>
            <div class="ads-result-authors">${this.escapeHtml(authorsDisplay)}</div>
            <div class="ads-result-meta">
              <span>${paper.year || ''}</span>
              ${paper.journal ? `<span class="ads-result-journal">${this.escapeHtml(paper.journal)}</span>` : ''}
              ${paper.bibcode ? `<span>${paper.bibcode}</span>` : ''}
            </div>
            ${abstractPreview ? `<div class="ads-result-abstract">${this.escapeHtml(abstractPreview)}</div>` : ''}
          </div>
          ${isInLibrary ? '<span class="ads-result-status in-library">In Library</span>' : ''}
          ${!isInLibrary && !hasArxiv ? '<span class="ads-result-status no-pdf">No arXiv</span>' : ''}
        </div>
      `;
    }).join('');

    // Add click handlers
    listEl.querySelectorAll('.ads-result-item').forEach(item => {
      const index = parseInt(item.dataset.index);
      const paper = this.adsResults[index];

      if (!paper.inLibrary) {
        item.addEventListener('click', (e) => {
          if (e.target.type !== 'checkbox') {
            this.toggleAdsSelection(index);
          }
        });

        const checkbox = item.querySelector('.ads-result-checkbox');
        checkbox.addEventListener('change', () => {
          this.toggleAdsSelection(index);
        });
      }
    });

    this.updateAdsSelectedCount();
  }

  toggleAdsSelection(index) {
    if (this.adsSelected.has(index)) {
      this.adsSelected.delete(index);
    } else {
      this.adsSelected.add(index);
    }
    this.renderAdsResults();
  }

  adsSelectAll() {
    this.adsResults.forEach((paper, index) => {
      if (!paper.inLibrary) {
        this.adsSelected.add(index);
      }
    });
    this.renderAdsResults();
  }

  adsSelectNone() {
    this.adsSelected.clear();
    this.renderAdsResults();
  }

  updateAdsSelectedCount() {
    const count = this.adsSelected.size;
    document.getElementById('ads-selected-count').textContent = `${count} selected`;
    document.getElementById('ads-import-btn').disabled = count === 0;
  }

  async importAdsSelected() {
    if (this.adsSelected.size === 0) return;

    const selectedPapers = Array.from(this.adsSelected).map(index => this.adsResults[index]);

    // Show progress
    document.getElementById('ads-progress').classList.remove('hidden');
    document.getElementById('ads-progress-fill').style.width = '0%';
    document.getElementById('ads-progress-text').textContent = 'Starting import...';
    document.getElementById('ads-import-btn').disabled = true;

    try {
      await window.electronAPI.adsImportPapers(selectedPapers);
      // Completion handled by onImportComplete callback
    } catch (error) {
      this.showAdsError(error.message);
      document.getElementById('ads-progress').classList.add('hidden');
      document.getElementById('ads-import-btn').disabled = false;
    }
  }

  updateImportProgress(data) {
    const percent = (data.current / data.total) * 100;
    document.getElementById('ads-progress-fill').style.width = `${percent}%`;
    document.getElementById('ads-progress-text').textContent =
      `Importing ${data.current} of ${data.total}: ${data.paper?.substring(0, 50) || ''}...`;
  }

  async handleImportComplete(results) {
    const imported = results.imported?.length || 0;
    const skipped = results.skipped?.length || 0;
    const failed = results.failed?.length || 0;

    document.getElementById('ads-progress-fill').style.width = '100%';
    document.getElementById('ads-progress-text').textContent =
      `Done! Imported: ${imported}, Skipped: ${skipped}, Failed: ${failed}`;

    // Reload papers list
    await this.loadPapers();
    const info = await window.electronAPI.getLibraryInfo(this.libraryPath);
    if (info) this.updateLibraryDisplay(info);

    // Close modal after a delay
    setTimeout(() => {
      this.hideAdsSearchModal();
    }, 2000);
  }

  showAdsError(message) {
    const listEl = document.getElementById('ads-results-list');
    listEl.innerHTML = `
      <div class="ads-empty-state">
        <p style="color: var(--error)">Error: ${this.escapeHtml(message)}</p>
      </div>
    `;
  }

  // ===== LLM/AI Methods =====

  async checkLlmConnection() {
    this.updateLlmStatus('loading', 'Checking Ollama...');

    try {
      this.llmConfig = await window.electronAPI.getLlmConfig();
      const result = await window.electronAPI.checkLlmConnection();

      if (result.connected) {
        this.llmConnected = true;
        this.updateLlmStatus('connected', `Connected to Ollama (${this.llmConfig.model})`);
        // Start auto-indexing in background
        this.autoIndexPapers();
      } else {
        this.llmConnected = false;
        this.updateLlmStatus('disconnected', result.error || 'Ollama not connected');
      }
    } catch (error) {
      this.llmConnected = false;
      this.updateLlmStatus('disconnected', error.message);
    }
  }

  async autoIndexPapers() {
    if (this.isAutoIndexing) return; // Prevent multiple runs

    try {
      const result = await window.electronAPI.llmGetUnindexedPapers();
      if (!result.success || result.paperIds.length === 0) return;

      this.isAutoIndexing = true;
      const paperIds = result.paperIds;
      const total = paperIds.length;

      // Show indexing status in sidebar
      const indexingStatus = document.getElementById('indexing-status');
      const indexingText = document.getElementById('indexing-text');
      indexingStatus?.classList.remove('hidden');

      for (let i = 0; i < paperIds.length; i++) {
        if (!this.llmConnected) break; // Stop if disconnected

        // Update progress in sidebar
        if (indexingText) {
          indexingText.textContent = `Indexing: ${i + 1}/${total}`;
        }

        try {
          await window.electronAPI.llmGenerateEmbeddings(paperIds[i]);
          // Update paper list to show indexed status
          this.updatePaperIndexedStatus(paperIds[i], true);
        } catch (err) {
          console.error(`Failed to index paper ${paperIds[i]}:`, err);
        }
      }

      // Hide indexing status
      indexingStatus?.classList.add('hidden');
    } catch (error) {
      console.error('Auto-indexing error:', error);
    } finally {
      this.isAutoIndexing = false;
    }
  }

  updatePaperIndexedStatus(paperId, indexed) {
    const paperItem = document.querySelector(`.paper-item[data-id="${paperId}"]`);
    if (paperItem) {
      let indicator = paperItem.querySelector('.indexed-indicator');
      if (indexed && !indicator) {
        indicator = document.createElement('span');
        indicator.className = 'indexed-indicator';
        indicator.title = 'Indexed for AI search';
        indicator.textContent = '⚡';
        paperItem.querySelector('.paper-item-meta')?.appendChild(indicator);
      } else if (!indexed && indicator) {
        indicator.remove();
      }
    }
  }

  updateLlmStatus(status, text) {
    // Sidebar status
    const sidebarStatus = document.getElementById('llm-status');
    if (sidebarStatus) {
      sidebarStatus.classList.toggle('connected', status === 'connected');
    }

    // AI panel status bar
    const indicator = document.getElementById('ai-status-indicator');
    const statusText = document.getElementById('ai-status-text');

    if (indicator) {
      indicator.className = 'ai-status-indicator ' + status;
    }
    if (statusText) {
      statusText.textContent = text;
    }
  }

  async showLlmModal() {
    const modal = document.getElementById('llm-modal');
    modal.classList.remove('hidden');

    // Load current config
    this.llmConfig = await window.electronAPI.getLlmConfig();
    document.getElementById('llm-endpoint-input').value = this.llmConfig.endpoint || 'http://localhost:11434';

    // Load available models
    await this.loadLlmModels();

    // Test connection
    await this.testLlmConnection();
  }

  hideLlmModal() {
    document.getElementById('llm-modal').classList.add('hidden');
  }

  async loadLlmModels() {
    const modelSelect = document.getElementById('llm-model-select');
    const embeddingSelect = document.getElementById('llm-embedding-select');

    modelSelect.innerHTML = '<option value="">Loading models...</option>';
    embeddingSelect.innerHTML = '<option value="">Loading models...</option>';

    try {
      const models = await window.electronAPI.listLlmModels();

      if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">No models found</option>';
        embeddingSelect.innerHTML = '<option value="">No models found</option>';
        return;
      }

      // Populate model dropdown
      modelSelect.innerHTML = models.map(m =>
        `<option value="${m.name}" ${m.name === this.llmConfig.model ? 'selected' : ''}>${m.name}</option>`
      ).join('');

      // Populate embedding model dropdown
      embeddingSelect.innerHTML = models.map(m =>
        `<option value="${m.name}" ${m.name === this.llmConfig.embeddingModel ? 'selected' : ''}>${m.name}</option>`
      ).join('');
    } catch (error) {
      modelSelect.innerHTML = `<option value="">Error: ${error.message}</option>`;
      embeddingSelect.innerHTML = `<option value="">Error: ${error.message}</option>`;
    }
  }

  async saveLlmConfig() {
    const config = {
      endpoint: document.getElementById('llm-endpoint-input').value.trim(),
      model: document.getElementById('llm-model-select').value,
      embeddingModel: document.getElementById('llm-embedding-select').value
    };

    await window.electronAPI.setLlmConfig(config);
    this.llmConfig = config;
    await this.checkLlmConnection();
    this.hideLlmModal();
  }

  async testLlmConnection() {
    const statusDot = document.getElementById('llm-modal-status-dot');
    const statusText = document.getElementById('llm-modal-status-text');

    statusDot.className = 'llm-status-dot checking';
    statusText.textContent = 'Testing connection...';

    // Temporarily update endpoint for test
    const endpoint = document.getElementById('llm-endpoint-input').value.trim();

    try {
      // Save temporarily to test
      await window.electronAPI.setLlmConfig({ ...this.llmConfig, endpoint });
      const result = await window.electronAPI.checkLlmConnection();

      if (result.connected) {
        statusDot.className = 'llm-status-dot connected';
        statusText.textContent = `Connected! ${result.models?.length || 0} models available`;
        await this.loadLlmModels();
      } else {
        statusDot.className = 'llm-status-dot disconnected';
        statusText.textContent = result.error || 'Connection failed';
      }
    } catch (error) {
      statusDot.className = 'llm-status-dot disconnected';
      statusText.textContent = error.message;
    }
  }

  async generateSummary() {
    if (!this.selectedPaper) return;

    if (!this.llmConnected) {
      this.showLlmModal();
      return;
    }

    const contentEl = document.getElementById('ai-summary-content');
    const keyPointsEl = document.getElementById('ai-key-points');

    // Show loading state
    contentEl.innerHTML = '<div class="ai-summary-text ai-streaming">Generating summary...</div>';
    contentEl.classList.add('loading');
    keyPointsEl.classList.add('hidden');

    try {
      const result = await window.electronAPI.llmSummarize(this.selectedPaper.id);

      if (result.success) {
        this.displaySummary(result.data);
      } else {
        contentEl.innerHTML = `<div class="ai-placeholder"><p style="color: var(--error)">Error: ${result.error}</p></div>`;
      }
    } catch (error) {
      contentEl.innerHTML = `<div class="ai-placeholder"><p style="color: var(--error)">Error: ${error.message}</p></div>`;
    }

    contentEl.classList.remove('loading');
  }

  async regenerateSummary() {
    if (!this.selectedPaper) return;

    // Delete cached summary first
    await window.electronAPI.llmDeleteSummary(this.selectedPaper.id);
    this.currentPaperSummary = null;

    // Generate new one
    await this.generateSummary();
  }

  displaySummary(data) {
    this.currentPaperSummary = data;

    const contentEl = document.getElementById('ai-summary-content');
    const keyPointsEl = document.getElementById('ai-key-points');
    const keyPointsList = document.getElementById('ai-key-points-list');

    contentEl.innerHTML = `<div class="ai-summary-text">${this.escapeHtml(data.summary || '')}</div>`;

    if (data.key_points?.length || data.keyPoints?.length) {
      const points = data.key_points || data.keyPoints;
      keyPointsList.innerHTML = points.map(p => `<li>${this.escapeHtml(p)}</li>`).join('');
      keyPointsEl.classList.remove('hidden');
    } else {
      keyPointsEl.classList.add('hidden');
    }
  }

  async askQuestion() {
    if (!this.selectedPaper) return;

    const input = document.getElementById('ai-question-input');
    const question = input.value.trim();
    if (!question) return;

    if (!this.llmConnected) {
      this.showLlmModal();
      return;
    }

    input.value = '';
    input.disabled = true;
    document.getElementById('ai-ask-btn').disabled = true;

    // Reset Q&A accumulator and add question to history
    this.qaStreamText = '';
    this.addQAToHistory(question, null, true);

    try {
      const result = await window.electronAPI.llmAsk(this.selectedPaper.id, question);

      if (result.success) {
        // Update the streaming answer with final
        this.updateLatestAnswer(result.data.answer);
      } else {
        this.updateLatestAnswer(`Error: ${result.error}`, true);
      }
    } catch (error) {
      this.updateLatestAnswer(`Error: ${error.message}`, true);
    }

    input.disabled = false;
    document.getElementById('ai-ask-btn').disabled = false;
    input.focus();
  }

  async loadQAHistory() {
    if (!this.selectedPaper) return;

    const history = await window.electronAPI.llmGetQAHistory(this.selectedPaper.id);
    const historyEl = document.getElementById('ai-qa-history');

    if (!history || history.length === 0) {
      historyEl.innerHTML = `
        <div class="ai-qa-placeholder">
          <p>Ask questions about this paper and get AI-powered answers.</p>
          <div class="ai-suggested-questions">
            <button class="suggested-question" data-question="Give a simplified explanation of the entire paper.">Simplified explanation</button>
            <button class="suggested-question" data-question="What are the main findings and conclusions?">Main findings</button>
            <button class="suggested-question" data-question="What methods were used in this research?">Methods used</button>
            <button class="suggested-question" data-question="What are the limitations of this study?">Limitations</button>
            <button class="suggested-question" data-question="How does this paper relate to other work in the field?">Related work</button>
          </div>
        </div>
      `;
      return;
    }

    historyEl.innerHTML = history.map(qa => `
      <div class="ai-qa-item">
        <div class="ai-qa-question">
          <span class="ai-label">You:</span>
          <span class="ai-text">${this.escapeHtml(qa.question)}</span>
        </div>
        <div class="ai-qa-answer">
          <span class="ai-label">AI:</span>
          <span class="ai-text">${this.escapeHtml(qa.answer)}</span>
        </div>
      </div>
    `).join('');

    // Scroll to bottom
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  addQAToHistory(question, answer = null, streaming = false) {
    const historyEl = document.getElementById('ai-qa-history');

    // Remove placeholder if present
    const placeholder = historyEl.querySelector('.ai-qa-placeholder');
    if (placeholder) placeholder.remove();

    const qaDiv = document.createElement('div');
    qaDiv.className = 'ai-qa-item';
    qaDiv.innerHTML = `
      <div class="ai-qa-question">
        <span class="ai-label">You:</span>
        <span class="ai-text">${this.escapeHtml(question)}</span>
      </div>
      <div class="ai-qa-answer">
        <span class="ai-label">AI:</span>
        <span class="ai-text${streaming ? ' ai-streaming' : ''}">${answer ? this.escapeHtml(answer) : ''}</span>
      </div>
    `;

    historyEl.appendChild(qaDiv);
    this.aiStreamingElement = qaDiv.querySelector('.ai-qa-answer .ai-text');
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  updateLatestAnswer(answer, isError = false) {
    if (this.aiStreamingElement) {
      this.aiStreamingElement.classList.remove('ai-streaming');
      this.aiStreamingElement.textContent = answer;
      if (isError) {
        this.aiStreamingElement.style.color = 'var(--error)';
      }
      this.aiStreamingElement = null;
    }
  }

  async clearQAHistory() {
    if (!this.selectedPaper) return;

    await window.electronAPI.llmClearQAHistory(this.selectedPaper.id);
    document.getElementById('ai-qa-history').innerHTML = `
      <div class="ai-qa-placeholder">
        <p>Ask questions about this paper and get AI-powered answers.</p>
        <div class="ai-suggested-questions">
          <button class="suggested-question" data-question="Give a simplified explanation of the entire paper.">Simplified explanation</button>
          <button class="suggested-question" data-question="What are the main findings and conclusions?">Main findings</button>
          <button class="suggested-question" data-question="What methods were used in this research?">Methods used</button>
          <button class="suggested-question" data-question="What are the limitations of this study?">Limitations</button>
          <button class="suggested-question" data-question="How does this paper relate to other work in the field?">Related work</button>
        </div>
      </div>
    `;
  }

  handleLlmStream(data) {
    if (data.type === 'qa') {
      // Accumulate Q&A answer text
      if (data.chunk) {
        this.qaStreamText += data.chunk;
        if (this.aiStreamingElement) {
          this.aiStreamingElement.textContent = this.qaStreamText;
        }
        const historyEl = document.getElementById('ai-qa-history');
        historyEl.scrollTop = historyEl.scrollHeight;
      }

      // Render markdown when done
      if (data.done && this.aiStreamingElement) {
        const rawText = this.qaStreamText;
        try {
          if (typeof marked !== 'undefined' && rawText) {
            const html = marked.parse(rawText);
            this.aiStreamingElement.innerHTML = html;
            this.aiStreamingElement.classList.add('ai-answer-rendered');
            // Render LaTeX
            if (typeof renderMathInElement === 'function') {
              renderMathInElement(this.aiStreamingElement, {
                delimiters: [
                  {left: '$$', right: '$$', display: true},
                  {left: '$', right: '$', display: false},
                  {left: '\\[', right: '\\]', display: true},
                  {left: '\\(', right: '\\)', display: false}
                ]
              });
            }
          }
        } catch (e) {
          console.error('Q&A markdown render error:', e);
        }
        this.aiStreamingElement.classList.remove('ai-streaming');
        this.aiStreamingElement = null;
      }
    } else if (data.type === 'summarize') {
      const contentEl = document.getElementById('ai-summary-content');
      const summaryText = contentEl.querySelector('.ai-summary-text');
      if (summaryText) {
        // Remove "Generating..." and append actual content
        if (summaryText.textContent === 'Generating summary...') {
          summaryText.textContent = '';
        }
        summaryText.textContent += data.chunk;
      }
    } else if (data.type === 'explain') {
      const contentEl = document.getElementById('ai-explanation-content');
      if (contentEl) {
        // Remove loading state on first chunk and reset accumulator
        if (contentEl.querySelector('.ai-loading')) {
          this.explainStreamText = '';
          contentEl.innerHTML = '<span class="ai-streaming"></span>';
        }

        // Accumulate text in class property (not dependent on DOM)
        if (data.chunk) {
          this.explainStreamText += data.chunk;
          const streamEl = contentEl.querySelector('.ai-streaming');
          if (streamEl) {
            streamEl.textContent = this.explainStreamText;
          }
        }

        if (data.done) {
          // Render markdown and LaTeX when complete
          const rawText = this.explainStreamText;
          try {
            if (typeof marked !== 'undefined' && rawText) {
              const html = marked.parse(rawText);
              contentEl.innerHTML = `<div class="ai-explanation-rendered">${html}</div>`;
              // Render LaTeX equations
              if (typeof renderMathInElement === 'function') {
                renderMathInElement(contentEl, {
                  delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '$', right: '$', display: false},
                    {left: '\\[', right: '\\]', display: true},
                    {left: '\\(', right: '\\)', display: false}
                  ]
                });
              }
            } else {
              // Fallback: at least show with line breaks
              contentEl.innerHTML = `<div class="ai-explanation-rendered">${rawText.replace(/\n/g, '<br>')}</div>`;
            }
          } catch (e) {
            console.error('Markdown render error:', e);
            contentEl.innerHTML = `<div class="ai-explanation-rendered">${rawText.replace(/\n/g, '<br>')}</div>`;
          }
        }
      }
    }
  }

  // Text selection context menu for AI explain
  selectedText = '';
  selectedTextPosition = { x: 0, y: 0 };
  explainStreamText = '';  // Accumulate explanation text for markdown rendering
  qaStreamText = '';  // Accumulate Q&A answer text for markdown rendering

  // Track mousedown for detecting clicks vs selections
  pdfMouseDownPos = null;
  pdfAnchorPosition = null;

  handlePdfMouseDown(e) {
    // Store mousedown position to detect click vs drag
    this.pdfMouseDownPos = { x: e.clientX, y: e.clientY };
  }

  handlePdfMouseUp(e) {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // Check if this was a click (minimal movement) vs a selection drag
    const isClick = this.pdfMouseDownPos &&
      Math.abs(e.clientX - this.pdfMouseDownPos.x) < 5 &&
      Math.abs(e.clientY - this.pdfMouseDownPos.y) < 5;

    if (text.length > 10) {
      // Text selection - show selection context menu
      this.selectedText = text;
      this.selectedTextPosition = { x: e.clientX, y: e.clientY };
      this.selectedTextPage = this.getPageFromSelection();
      this.selectedTextRects = this.getSelectionRects(this.selectedTextPage);
      this.showTextContextMenu(e.clientX, e.clientY);
      this.removeAnchorMarker();
    } else if (isClick && !e.target.closest('.pdf-highlight') && !e.target.closest('.pdf-anchor-marker')) {
      // Click without selection - place anchor for notes
      this.placeAnchorAtClick(e);
    }

    this.pdfMouseDownPos = null;
  }

  placeAnchorAtClick(e) {
    // Find which page was clicked
    const pageWrapper = e.target.closest('.pdf-page-wrapper');
    if (!pageWrapper) return;

    const pageNum = parseInt(pageWrapper.dataset.page);
    const rect = pageWrapper.getBoundingClientRect();

    // Calculate relative position within the page (0-1 range)
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;

    // Store anchor position
    this.pdfAnchorPosition = {
      page: pageNum,
      x: relX,
      y: relY,
      screenX: e.clientX,
      screenY: e.clientY
    };

    // Show visual anchor marker
    this.showAnchorMarker(pageWrapper, relX, relY);

    // Show anchor context menu
    this.showAnchorContextMenu(e.clientX, e.clientY);
  }

  showAnchorMarker(pageWrapper, relX, relY) {
    // Remove any existing anchor marker
    this.removeAnchorMarker();

    // Create anchor marker element
    const marker = document.createElement('div');
    marker.className = 'pdf-anchor-marker';
    marker.style.left = `${relX * 100}%`;
    marker.style.top = `${relY * 100}%`;
    marker.innerHTML = '<span class="anchor-icon">📍</span>';

    pageWrapper.appendChild(marker);
  }

  removeAnchorMarker() {
    document.querySelectorAll('.pdf-anchor-marker').forEach(m => m.remove());
    this.pdfAnchorPosition = null;
  }

  showAnchorContextMenu(x, y) {
    // Hide text context menu if visible
    this.hideTextContextMenu();

    const menu = document.getElementById('anchor-context-menu');
    if (!menu) return;

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');

    // Auto-hide on click elsewhere
    const hideHandler = (e) => {
      if (!menu.contains(e.target) && !e.target.closest('.pdf-anchor-marker')) {
        menu.classList.add('hidden');
        this.removeAnchorMarker();
        document.removeEventListener('click', hideHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', hideHandler), 0);
  }

  hideAnchorContextMenu() {
    const menu = document.getElementById('anchor-context-menu');
    if (menu) menu.classList.add('hidden');
  }

  async createNoteAtAnchor() {
    if (!this.selectedPaper || !this.pdfAnchorPosition) return;

    this.hideAnchorContextMenu();

    const { page, x, y } = this.pdfAnchorPosition;

    try {
      const result = await window.electronAPI.createAnnotation(this.selectedPaper.id, {
        page_number: page,
        selection_text: null,
        selection_rects: [{ x, y, width: 0, height: 0, isAnchor: true }],
        note_content: '',
        color: '#ffeb3b',
        pdf_source: this.currentPdfSource
      });

      if (result.success) {
        await this.loadAnnotations(this.selectedPaper.id);
        this.renderHighlightsOnPdf();

        // Switch to Notes tab and start editing
        this.switchTab('notes');
        requestAnimationFrame(() => {
          this.editAnnotation(result.annotation.id);
        });
      }
    } catch (error) {
      console.error('Error creating anchor note:', error);
    }

    this.removeAnchorMarker();
  }

  // Keep old method name for backward compatibility
  handleTextSelection(e) {
    this.handlePdfMouseUp(e);
  }

  showTextContextMenu(x, y) {
    const menu = document.getElementById('text-context-menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove('hidden');

    // Auto-hide on click elsewhere
    const hideHandler = (e) => {
      if (!menu.contains(e.target)) {
        menu.classList.add('hidden');
        document.removeEventListener('click', hideHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', hideHandler), 0);
  }

  hideTextContextMenu() {
    document.getElementById('text-context-menu').classList.add('hidden');
  }

  async explainSelectedText() {
    if (!this.selectedText) return;

    this.hideTextContextMenu();

    if (!this.llmConnected) {
      this.showLlmModal();
      return;
    }

    // Show explanation popup
    this.showExplanationPopup(this.selectedTextPosition.x, this.selectedTextPosition.y);

    try {
      const result = await window.electronAPI.llmExplain(
        this.selectedText,
        this.selectedPaper?.id
      );

      if (!result.success) {
        document.getElementById('ai-explanation-content').innerHTML =
          `<div class="ai-loading" style="color: var(--error)">Error: ${result.error}</div>`;
      }
      // Streaming handled by handleLlmStream
    } catch (error) {
      document.getElementById('ai-explanation-content').innerHTML =
        `<div class="ai-loading" style="color: var(--error)">Error: ${error.message}</div>`;
    }
  }

  copySelectedText() {
    if (this.selectedText) {
      navigator.clipboard.writeText(this.selectedText);
    }
    this.hideTextContextMenu();
  }

  showExplanationPopup(x, y) {
    const popup = document.getElementById('ai-explanation-popup');
    popup.style.left = `${Math.min(x, window.innerWidth - 420)}px`;
    popup.style.top = `${Math.min(y + 20, window.innerHeight - 320)}px`;
    popup.classList.remove('hidden');

    document.getElementById('ai-explanation-content').innerHTML =
      '<div class="ai-loading">Generating explanation...</div>';
  }

  hideExplanationPopup() {
    document.getElementById('ai-explanation-popup').classList.add('hidden');
  }

  async loadAIPanelData() {
    if (!this.selectedPaper) return;

    // Load cached summary if exists (don't auto-generate)
    try {
      const result = await window.electronAPI.llmSummarize(this.selectedPaper.id, { checkCacheOnly: true });

      if (result.success && result.data) {
        // Display the cached summary
        this.displaySummary(result.data);
      } else {
        // No cached summary exists, show placeholder
        this.showSummaryPlaceholder();
      }
    } catch (error) {
      this.showSummaryPlaceholder();
    }

    // Load Q&A history
    await this.loadQAHistory();
  }

  showSummaryPlaceholder() {
    const contentEl = document.getElementById('ai-summary-content');
    const keyPointsEl = document.getElementById('ai-key-points');

    contentEl.innerHTML = `
      <div class="ai-placeholder">
        <p>Click "Generate Summary" to create an AI-powered summary of this paper.</p>
        <button class="primary-button" id="ai-generate-summary-btn-inner">Generate Summary</button>
      </div>
    `;
    keyPointsEl.classList.add('hidden');
    this.currentPaperSummary = null;

    // Re-attach event listener
    document.getElementById('ai-generate-summary-btn-inner')?.addEventListener('click', () => this.generateSummary());
  }

  // Semantic Search Methods
  async indexCurrentPaper() {
    if (!this.selectedPaper) return;

    if (!this.llmConnected) {
      this.showLlmModal();
      return;
    }

    const btn = document.getElementById('ai-index-paper-btn');
    const originalText = btn.textContent;
    btn.textContent = 'Indexing...';
    btn.disabled = true;

    try {
      const result = await window.electronAPI.llmGenerateEmbeddings(this.selectedPaper.id);

      if (result.success) {
        if (result.cached) {
          btn.textContent = 'Already Indexed';
        } else {
          btn.textContent = `Indexed (${result.chunksProcessed} chunks)`;
        }
      } else {
        btn.textContent = 'Index Failed';
        console.error('Indexing failed:', result.error);
      }
    } catch (error) {
      btn.textContent = 'Index Failed';
      console.error('Indexing error:', error);
    }

    // Reset button after delay
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2000);
  }

  async semanticSearch() {
    const input = document.getElementById('ai-search-input');
    const query = input.value.trim();
    if (!query) return;

    if (!this.llmConnected) {
      this.showLlmModal();
      return;
    }

    const resultsEl = document.getElementById('ai-search-results');
    resultsEl.innerHTML = '<div class="ai-search-placeholder"><p>Searching...</p></div>';

    try {
      const result = await window.electronAPI.llmSemanticSearch(query, 10);

      if (result.success) {
        if (result.data.length === 0) {
          resultsEl.innerHTML = `
            <div class="ai-search-placeholder">
              <p>${result.message || 'No matching papers found. Try indexing more papers.'}</p>
            </div>
          `;
        } else {
          this.displaySemanticSearchResults(result.data);
        }
      } else {
        resultsEl.innerHTML = `
          <div class="ai-search-placeholder">
            <p style="color: var(--error)">Error: ${result.error}</p>
          </div>
        `;
      }
    } catch (error) {
      resultsEl.innerHTML = `
        <div class="ai-search-placeholder">
          <p style="color: var(--error)">Error: ${error.message}</p>
        </div>
      `;
    }
  }

  displaySemanticSearchResults(results) {
    const resultsEl = document.getElementById('ai-search-results');

    resultsEl.innerHTML = results.map(r => {
      const paper = r.paper;
      const score = Math.round(r.score * 100);
      const authors = paper.authors?.[0]?.split(',')[0] || 'Unknown';

      return `
        <div class="ai-search-result" data-paper-id="${paper.id}">
          <div class="ai-search-result-title">${this.escapeHtml(paper.title || 'Untitled')}</div>
          <div class="ai-search-result-meta">
            <span>${authors} ${paper.year || ''}</span>
            <span class="ai-search-result-score">${score}% match</span>
          </div>
          ${r.matchedChunk ? `<div class="ai-search-result-chunk">${this.escapeHtml(r.matchedChunk)}</div>` : ''}
        </div>
      `;
    }).join('');

    // Add click handlers to navigate to papers
    resultsEl.querySelectorAll('.ai-search-result').forEach(item => {
      item.addEventListener('click', () => {
        const paperId = parseInt(item.dataset.paperId);
        this.selectPaper(paperId);
        // Switch to PDF tab
        this.switchTab('pdf');
      });
    });
  }

  // ===== Annotations =====

  async loadAnnotations(paperId) {
    this.annotations = await window.electronAPI.getAnnotations(paperId);

    // Show/hide annotations panel based on whether PDF tab is active
    const annotationsPanel = document.getElementById('annotations-panel');
    const annotationsResize = document.getElementById('annotations-resize');

    if (this.annotations.length > 0 || this.selectedPaper?.pdf_path) {
      annotationsPanel.classList.remove('hidden');
      annotationsResize.classList.remove('hidden');
    } else {
      annotationsPanel.classList.add('hidden');
      annotationsResize.classList.add('hidden');
    }

    // Update count
    const countEl = document.getElementById('annotations-count');
    countEl.textContent = this.annotations.length > 0 ? `(${this.annotations.length})` : '';

    this.renderAnnotationsList();
  }

  renderAnnotationsList() {
    const listEl = document.getElementById('annotations-list');

    if (this.annotations.length === 0) {
      listEl.innerHTML = `
        <div class="annotations-placeholder">
          <p>Select text in the PDF and click "Add Note" to create an annotation.</p>
        </div>
      `;
      return;
    }

    // Group annotations by page
    const byPage = {};
    this.annotations.forEach(a => {
      const page = a.page_number || 1;
      if (!byPage[page]) byPage[page] = [];
      byPage[page].push(a);
    });

    let html = '';
    Object.keys(byPage).sort((a, b) => a - b).forEach(pageNum => {
      const pageAnnotations = byPage[pageNum];
      pageAnnotations.forEach(a => {
        const colorClass = this.getColorClass(a.color);
        const timestamp = a.updated_at || a.created_at;
        const timeStr = timestamp ? this.formatTimestamp(timestamp) : '';
        const hasNote = a.note_content && a.note_content.trim();

        html += `
          <div class="annotation-item" data-id="${a.id}" data-page="${pageNum}">
            <span class="annotation-page-badge">Page ${pageNum}</span>
            ${a.selection_text ? `<div class="annotation-quote" style="border-color: ${a.color}">${this.escapeHtml(a.selection_text)}</div>` : ''}
            <div class="annotation-content">
              <div class="annotation-text ${hasNote ? '' : 'empty'}" data-id="${a.id}">
                ${hasNote ? this.escapeHtml(a.note_content) : 'Click to add a note...'}
              </div>
            </div>
            <div class="annotation-footer">
              <span class="annotation-timestamp">${timeStr}</span>
              <div class="annotation-actions">
                <button class="annotation-btn edit" data-id="${a.id}">Edit</button>
                <button class="annotation-btn delete" data-id="${a.id}">Delete</button>
              </div>
            </div>
          </div>
        `;
      });
    });

    listEl.innerHTML = html;

    // Render LaTeX in annotations
    this.renderAnnotationsLatex();

    // Add event listeners - clicking on annotation starts editing
    listEl.querySelectorAll('.annotation-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (!e.target.closest('.annotation-btn')) {
          const id = parseInt(item.dataset.id);
          this.scrollToAnnotationHighlight(id);
          this.editAnnotation(id);
        }
      });
    });

    listEl.querySelectorAll('.annotation-btn.delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteAnnotation(parseInt(btn.dataset.id));
      });
    });
  }

  renderAnnotationsLatex() {
    if (typeof renderMathInElement === 'function') {
      const listEl = document.getElementById('annotations-list');
      renderMathInElement(listEl, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false
      });
    }
  }

  getColorClass(color) {
    const colorMap = {
      '#ffeb3b': 'yellow',
      '#4ade80': 'green',
      '#60a5fa': 'blue',
      '#f472b6': 'pink',
      '#fb923c': 'orange'
    };
    return colorMap[color] || 'yellow';
  }

  formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: 'short' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  }

  async createGeneralNote() {
    if (!this.selectedPaper) return;

    // Create a note without selection
    const result = await window.electronAPI.createAnnotation(this.selectedPaper.id, {
      page_number: this.getCurrentVisiblePage(),
      selection_text: null,
      selection_rects: [],
      note_content: '',
      color: '#ffeb3b',
      pdf_source: this.currentPdfSource
    });

    if (result.success) {
      await this.loadAnnotations(this.selectedPaper.id);
      // Start editing the new note after DOM updates
      requestAnimationFrame(() => {
        this.editAnnotation(result.annotation.id);
      });
    }
  }

  async createNoteFromSelection() {
    console.log('createNoteFromSelection called');
    if (!this.selectedPaper) {
      console.log('No selected paper');
      this.hideTextContextMenu();
      return;
    }

    // Use the stored selection text (captured when menu was shown)
    const text = this.selectedText;
    console.log('Selected text:', text);

    if (!text) {
      console.log('No text stored, hiding menu');
      this.hideTextContextMenu();
      return;
    }

    // Use stored page and rects (captured when menu was shown, before selection cleared)
    const pageNum = this.selectedTextPage || 1;
    const rects = this.selectedTextRects || [];
    console.log('Page:', pageNum, 'Rects:', rects);

    this.hideTextContextMenu();

    try {
      const result = await window.electronAPI.createAnnotation(this.selectedPaper.id, {
        page_number: pageNum,
        selection_text: text,
        selection_rects: rects,
        note_content: '',
        color: '#ffeb3b',
        pdf_source: this.currentPdfSource
      });
      console.log('Create annotation result:', result);

      if (result.success) {
        await this.loadAnnotations(this.selectedPaper.id);
        this.renderHighlightsOnPdf();

        // Switch to Notes tab so the annotation is visible
        this.switchTab('notes');

        // Start editing the new note after DOM updates
        requestAnimationFrame(() => {
          this.editAnnotation(result.annotation.id);
        });
      } else {
        console.error('Failed to create annotation:', result.error);
      }
    } catch (error) {
      console.error('Error creating annotation:', error);
    }
  }

  getPageFromSelection() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return 1;

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const pageEl = container.nodeType === 1
      ? container.closest('.pdf-page-wrapper')
      : container.parentElement?.closest('.pdf-page-wrapper');

    if (pageEl) {
      return parseInt(pageEl.dataset.page) || 1;
    }
    return this.getCurrentVisiblePage();
  }

  getSelectionRects(pageNum) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return [];

    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();

    // Find the PDF page wrapper
    const pageWrapper = document.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`);
    if (!pageWrapper) return [];

    const pageRect = pageWrapper.getBoundingClientRect();
    const pageWidth = pageRect.width;
    const pageHeight = pageRect.height;

    // Convert to relative coordinates (0-1 range)
    return Array.from(rects).map(r => ({
      x: (r.left - pageRect.left) / pageWidth,
      y: (r.top - pageRect.top) / pageHeight,
      width: r.width / pageWidth,
      height: r.height / pageHeight
    })).filter(r => r.width > 0 && r.height > 0);
  }

  async editAnnotation(id) {
    const annotation = this.annotations.find(a => a.id === id);
    if (!annotation) return;

    const textEl = document.querySelector(`.annotation-text[data-id="${id}"]`);
    if (!textEl) return;

    const contentDiv = textEl.closest('.annotation-content');

    // Replace with textarea
    const currentText = annotation.note_content || '';
    contentDiv.innerHTML = `
      <textarea class="annotation-input" data-id="${id}" placeholder="Write your note here... (supports LaTeX: $formula$)">${this.escapeHtml(currentText)}</textarea>
      <div class="annotation-edit-actions" style="margin-top: 6px; display: flex; gap: 4px;">
        <button class="annotation-btn save" data-id="${id}">Save</button>
        <button class="annotation-btn cancel" data-id="${id}">Cancel</button>
      </div>
    `;

    const textarea = contentDiv.querySelector('.annotation-input');

    // Scroll the annotation into view first
    const annotationItem = contentDiv.closest('.annotation-item');
    if (annotationItem) {
      annotationItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Focus with a slight delay to ensure scroll completes
    setTimeout(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    }, 100);

    // Save handler
    contentDiv.querySelector('.annotation-btn.save').addEventListener('click', async () => {
      const newText = textarea.value.trim();
      await window.electronAPI.updateAnnotation(id, { note_content: newText });
      await this.loadAnnotations(this.selectedPaper.id);
    });

    // Cancel handler
    contentDiv.querySelector('.annotation-btn.cancel').addEventListener('click', () => {
      this.renderAnnotationsList();
    });

    // Save on Enter (with Shift for newlines)
    textarea.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const newText = textarea.value.trim();
        await window.electronAPI.updateAnnotation(id, { note_content: newText });
        await this.loadAnnotations(this.selectedPaper.id);
      } else if (e.key === 'Escape') {
        this.renderAnnotationsList();
      }
    });
  }

  async deleteAnnotation(id) {
    if (!confirm('Delete this annotation?')) return;

    await window.electronAPI.deleteAnnotation(id);
    await this.loadAnnotations(this.selectedPaper.id);
    this.renderHighlightsOnPdf();
  }

  scrollToAnnotationHighlight(id) {
    const annotation = this.annotations.find(a => a.id === id);
    if (!annotation) return;

    // Highlight the annotation item in sidebar
    document.querySelectorAll('.annotation-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.annotation-item[data-id="${id}"]`)?.classList.add('active');

    // Scroll to the page and highlight
    const pageWrapper = document.querySelector(`.pdf-page-wrapper[data-page="${annotation.page_number}"]`);
    if (pageWrapper) {
      pageWrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Highlight the PDF highlight element or anchor note
    document.querySelectorAll('.pdf-highlight, .pdf-anchor-note').forEach(el => el.classList.remove('active'));
    document.querySelectorAll(`.pdf-highlight[data-annotation="${id}"], .pdf-anchor-note[data-annotation="${id}"]`).forEach(el => el.classList.add('active'));
  }

  renderHighlightsOnPdf() {
    // Remove existing highlights and anchor notes
    document.querySelectorAll('.pdf-highlight-layer').forEach(el => el.remove());
    document.querySelectorAll('.pdf-anchor-note').forEach(el => el.remove());

    // Group annotations by page
    const byPage = {};
    this.annotations.forEach(a => {
      const page = a.page_number || 1;
      if (!byPage[page]) byPage[page] = [];
      byPage[page].push(a);
    });

    // Add highlights and anchor notes to each page
    Object.keys(byPage).forEach(pageNum => {
      const pageWrapper = document.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`);
      if (!pageWrapper) return;

      const layer = document.createElement('div');
      layer.className = 'pdf-highlight-layer';

      byPage[pageNum].forEach(annotation => {
        const colorClass = this.getColorClass(annotation.color);

        // Check if this is an anchor note (no selection text, single rect with isAnchor or zero dimensions)
        const isAnchorNote = !annotation.selection_text &&
          annotation.selection_rects?.length === 1 &&
          (annotation.selection_rects[0].isAnchor ||
           (annotation.selection_rects[0].width === 0 && annotation.selection_rects[0].height === 0));

        if (isAnchorNote && annotation.selection_rects?.length) {
          // Render as anchor marker (circular dot)
          const rect = annotation.selection_rects[0];
          const anchor = document.createElement('div');
          anchor.className = 'pdf-anchor-note';
          anchor.dataset.annotation = annotation.id;
          anchor.style.left = `${rect.x * 100}%`;
          anchor.style.top = `${rect.y * 100}%`;
          anchor.title = annotation.note_content?.substring(0, 50) || 'Note';

          anchor.addEventListener('click', () => {
            this.scrollToAnnotationInSidebar(annotation.id);
          });

          pageWrapper.appendChild(anchor);
        } else if (annotation.selection_rects?.length) {
          // Render as highlight rectangles
          annotation.selection_rects.forEach(rect => {
            const highlight = document.createElement('div');
            highlight.className = `pdf-highlight ${colorClass}`;
            highlight.dataset.annotation = annotation.id;
            highlight.style.left = `${rect.x * 100}%`;
            highlight.style.top = `${rect.y * 100}%`;
            highlight.style.width = `${rect.width * 100}%`;
            highlight.style.height = `${rect.height * 100}%`;

            highlight.addEventListener('click', () => {
              this.scrollToAnnotationInSidebar(annotation.id);
            });

            layer.appendChild(highlight);
          });
        }
      });

      pageWrapper.appendChild(layer);
    });
  }

  scrollToAnnotationInSidebar(id) {
    // Highlight in sidebar
    document.querySelectorAll('.annotation-item').forEach(el => el.classList.remove('active'));
    const item = document.querySelector(`.annotation-item[data-id="${id}"]`);
    if (item) {
      item.classList.add('active');
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Highlight on PDF
    document.querySelectorAll('.pdf-highlight').forEach(el => el.classList.remove('active'));
    document.querySelectorAll(`.pdf-highlight[data-annotation="${id}"]`).forEach(el => el.classList.add('active'));
  }

  getRatingEmoji(rating) {
    const ratingMap = {
      1: '<span class="rating-indicator" title="Seminal">🌟</span>',
      2: '<span class="rating-indicator" title="Important">⭐</span>',
      3: '<span class="rating-indicator" title="Average">📄</span>',
      4: '<span class="rating-indicator" title="Meh">💤</span>'
    };
    return ratingMap[rating] || '';
  }

  // Format authors list for display: first 3 + last author if more than 4
  formatAuthorsForList(authors) {
    if (!authors || authors.length === 0) return 'Unknown';

    // Handle both array and comma-separated string
    const authorsList = Array.isArray(authors) ? authors : authors.split(',').map(a => a.trim());

    // Get last name only from author string (format: "Last, First" or just "Last")
    const getLastName = (author) => {
      if (!author) return '';
      return author.split(',')[0].trim();
    };

    if (authorsList.length <= 4) {
      return authorsList.map(getLastName).join(', ');
    } else {
      // More than 4 authors: first 3 + "..." + last
      const first3 = authorsList.slice(0, 3).map(getLastName).join(', ');
      const last = getLastName(authorsList[authorsList.length - 1]);
      return `${first3}, ..., ${last}`;
    }
  }

  formatAuthors(authors, forList = false) {
    if (!authors || authors.length === 0) return 'Unknown';

    if (forList) {
      return this.formatAuthorsForList(authors);
    } else {
      // For detail view: show all authors
      return authors.map(a => a || '').join('; ');
    }
  }

  // Console panel methods
  setupConsoleResize() {
    const panel = document.getElementById('console-panel');
    const handle = document.getElementById('console-resize-handle');
    if (!panel || !handle) return;

    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    handle.addEventListener('mousedown', (e) => {
      if (panel.classList.contains('collapsed')) return;
      isResizing = true;
      startY = e.clientY;
      startHeight = panel.offsetHeight;
      handle.classList.add('resizing');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const delta = startY - e.clientY;
      const newHeight = Math.min(400, Math.max(80, startHeight + delta));
      panel.style.height = `${newHeight}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        handle.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  toggleConsole() {
    const panel = document.getElementById('console-panel');
    panel?.classList.toggle('collapsed');
    // Reset height when expanding
    if (!panel?.classList.contains('collapsed')) {
      panel.style.height = '';
    }
  }

  consoleLog(message, type = 'info') {
    const logEl = document.getElementById('console-log');
    if (!logEl) return;

    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<span class="log-time">${time}</span><span class="log-${type}">${this.escapeHtml(message)}</span>`;

    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;

    // Keep only last 100 entries
    while (logEl.children.length > 100) {
      logEl.removeChild(logEl.firstChild);
    }
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  window.app = new ADSReader();
});
