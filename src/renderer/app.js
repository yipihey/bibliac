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
    this.isMobileView = window.matchMedia('(max-width: 768px)').matches;
    this.currentMobileView = 'papers';
    this.currentTab = 'pdf'; // Current active tab
    this.previousTab = 'pdf'; // Previous tab (for returning after library selection)
    this.isSelectionMode = false; // iOS multi-select mode

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
    // Sort preferences will be loaded async in init()
    this.sortField = 'added';
    this.sortOrder = 'desc';

    // Annotations state
    this.annotations = [];
    this.currentAnnotation = null;
    this.pendingSelectionText = null;
    this.pendingSelectionRects = null;
    this.pendingSelectionPage = null;

    // Smart ADS Searches state
    this.smartSearches = [];           // All saved searches
    this.currentSmartSearch = null;    // ID of currently selected search (null = local library)
    this.editingSearchId = null;       // ID of search being edited (null = creating new)

    this.init();
  }

  async init() {
    console.log('[ADSReader] init() starting...');

    // Wait for platform initialization FIRST (sets up window.electronAPI on iOS)
    // Add timeout to prevent hanging
    if (window._platformReady) {
      try {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Platform init timeout after 15s')), 15000)
        );
        await Promise.race([window._platformReady, timeout]);
        console.log('[ADSReader] Platform ready');
      } catch (error) {
        console.error('[ADSReader] Platform initialization failed:', error);
        // Don't return - try to continue anyway
        console.warn('[ADSReader] Continuing despite platform init failure...');
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

    // Listen for mobile view changes
    window.matchMedia('(max-width: 768px)').addEventListener('change', (e) => {
      this.isMobileView = e.matches;
      if (this.isMobileView) {
        this.initMobileNavigation();
      } else {
        // Clean up mobile classes when leaving mobile mode
        document.body.classList.remove('mobile-view-active');
        document.body.classList.remove('showing-detail');
        document.body.classList.remove('showing-papers');
        document.body.classList.remove('mobile-search-active');
        document.querySelectorAll('[data-mobile-view]').forEach(el => {
          el.classList.remove('mobile-active');
        });
      }
    });

    // Ensure electronAPI is available
    if (!window.electronAPI) {
      console.error('[ADSReader] No electronAPI available');
      alert('App initialization failed. No API available.');
      return;
    }

    // Set up event listeners AFTER platform is ready (so window.electronAPI exists)
    this.setupEventListeners();
    console.log('[ADSReader] Event listeners set up');

    // Set up the download queue panel
    this.setupDownloadQueue();

    this.libraryPath = await window.electronAPI.getLibraryPath();

    // Load saved PDF zoom level
    const savedZoom = await window.electronAPI.getPdfZoom();
    if (savedZoom) {
      this.pdfScale = savedZoom;
    }

    // Load saved sort preferences
    if (window.electronAPI.getSortPreferences) {
      const sortPrefs = await window.electronAPI.getSortPreferences();
      if (sortPrefs) {
        this.sortField = sortPrefs.field || 'added';
        this.sortOrder = sortPrefs.order || 'desc';
      }
    }

    // Load saved PDF page positions
    this.pdfPagePositions = await window.electronAPI.getPdfPositions() || {};

    // Load last viewed PDF sources per paper
    this.lastPdfSources = await window.electronAPI.getLastPdfSources() || {};

    // Check if migration is needed for existing users
    await this.checkMigration();

    // Try to auto-load the last used library
    let libraryLoaded = false;

    if (!this.libraryPath) {
      // No library path set - check if we have a last used library ID
      this.updateLoadingText('Checking for libraries...');
      const lastLibraryId = await window.electronAPI.getCurrentLibraryId?.();
      if (lastLibraryId) {
        console.log('[ADSReader] Found last library ID:', lastLibraryId);
        const libraries = await window.electronAPI.getAllLibraries();
        const lastLib = libraries.find(l => l.id === lastLibraryId);
        if (lastLib) {
          console.log('[ADSReader] Auto-loading last library:', lastLib.name);
          this.updateLoadingText(`Loading ${lastLib.name}...`);
          try {
            await this.switchLibrary(lastLibraryId);
            libraryLoaded = true;
          } catch (e) {
            console.warn('[ADSReader] Failed to auto-load last library:', e);
          }
        }
      }
    }

    if (!libraryLoaded && this.libraryPath) {
      this.updateLoadingText('Loading library...');
      const info = await window.electronAPI.getLibraryInfo(this.libraryPath);
      if (info) {
        this.updateLoadingText(`Loading ${info.name || 'library'}...`);
        this.showMainScreen(info);
        await this.loadPapers();
        await this.loadCollections();
        await this.loadSmartSearches();
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
        libraryLoaded = true;
      }
    }

    if (!libraryLoaded) {
      this.showSetupScreen();
    }

    // setupEventListeners is now called early in init()
    this.setupLibraryPicker();
    this.restoreShortcutsState();
    document.title = 'ADS Reader';

    // Initialize top bar navigation (always - unified layout)
    this.initMobileNavigation();

    // Initialize mobile-specific features if in mobile view
    if (this.isMobileView) {
      this.initMobilePdfGestures();
      this.initMobilePdfControls();
      this.setupMobileTextSelection();
    }
  }

  restoreShortcutsState() {
    const isExpanded = localStorage.getItem('shortcutsExpanded') === 'true';
    if (isExpanded) {
      document.getElementById('shortcuts-summary')?.classList.add('expanded');
      document.getElementById('shortcuts-grid')?.classList.remove('hidden');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MOBILE NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════════

  initMobileNavigation() {
    // Add mobile-view-active class to body
    document.body.classList.add('mobile-view-active');

    // Hamburger button
    document.getElementById('hamburger-btn')?.addEventListener('click', () => {
      this.openMobileDrawer();
    });

    // Mobile search button - toggle search visibility
    document.getElementById('mobile-search-btn')?.addEventListener('click', () => {
      this.toggleMobileSearch();
    });

    // Floating back button - return to papers list
    document.getElementById('floating-back-btn')?.addEventListener('click', () => {
      this.showMobileView('papers');
    });

    // Mobile toolbar buttons - wire to same actions as desktop
    document.getElementById('mobile-import-btn')?.addEventListener('click', () => {
      this.importFiles();
    });
    // Logo tap triggers ADS search on iOS
    document.getElementById('mobile-title')?.addEventListener('click', () => {
      this.showAdsSearchModal();
    });
    document.getElementById('mobile-sort-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMobileSortMenu();
    });

    // Mobile download dropdown - dynamically populated from ADS sources
    document.getElementById('mobile-download-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const menu = document.getElementById('mobile-download-menu');
      if (menu) {
        const wasHidden = menu.classList.contains('hidden');
        menu.classList.toggle('hidden');
        if (wasHidden) {
          // Populate with available sources when opening
          const papers = this.getSelectedOrCurrentPapers();
          await this.populateDownloadMenu(menu, papers);
        }
      }
    });

    // Close download menu when clicking elsewhere
    document.addEventListener('click', () => {
      document.getElementById('mobile-download-menu')?.classList.add('hidden');
    });

    // iOS Selection mode buttons
    document.getElementById('mobile-select-btn')?.addEventListener('click', () => {
      this.enterSelectionMode();
    });
    document.getElementById('selection-cancel-btn')?.addEventListener('click', () => {
      this.exitSelectionMode();
    });
    document.getElementById('selection-actions-btn')?.addEventListener('click', () => {
      this.showSelectionActionSheet();
    });

    // iOS Action sheet buttons
    document.getElementById('action-sheet-overlay')?.addEventListener('click', () => {
      this.hideSelectionActionSheet();
      this.hideCollectionsActionSheet();
    });
    document.getElementById('as-cancel-btn')?.addEventListener('click', () => {
      this.hideSelectionActionSheet();
    });
    document.getElementById('as-delete-btn')?.addEventListener('click', () => {
      this.hideSelectionActionSheet();
      this.removeSelectedPapers();
      this.exitSelectionMode();
    });
    document.getElementById('as-sync-btn')?.addEventListener('click', () => {
      this.hideSelectionActionSheet();
      this.syncSelectedPapers();
      this.exitSelectionMode();
    });
    document.getElementById('as-bibtex-btn')?.addEventListener('click', () => {
      this.hideSelectionActionSheet();
      this.exportSelectedBibtex();
      this.exitSelectionMode();
    });
    document.getElementById('as-book-btn')?.addEventListener('click', () => {
      this.hideSelectionActionSheet();
      this.showExportBookModal();
      // Don't exit - modal handles it
    });
    document.getElementById('as-add-to-collection-btn')?.addEventListener('click', () => {
      this.hideSelectionActionSheet();
      this.showCollectionsActionSheet();
    });
    document.getElementById('as-add-to-library-btn')?.addEventListener('click', () => {
      this.hideSelectionActionSheet();
      this.addSelectedPapersToLibrary();
      this.exitSelectionMode();
    });
    document.getElementById('as-remove-from-collection-btn')?.addEventListener('click', () => {
      this.hideSelectionActionSheet();
      this.removeFromCurrentCollection();
      this.exitSelectionMode();
    });
    document.getElementById('collections-cancel-btn')?.addEventListener('click', () => {
      this.hideCollectionsActionSheet();
    });

    // Drawer overlay click to close
    document.getElementById('mobile-drawer-overlay')?.addEventListener('click', () => {
      this.closeMobileDrawer();
    });

    // Drawer close button
    document.getElementById('drawer-close-btn')?.addEventListener('click', () => {
      this.closeMobileDrawer();
    });

    // Drawer view buttons (same as desktop sidebar)
    document.querySelectorAll('.drawer-nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setView(btn.dataset.view);
        // Update active state in drawer
        document.querySelectorAll('.drawer-nav-item[data-view]').forEach(b => {
          b.classList.toggle('active', b === btn);
        });
        this.closeMobileDrawer();
      });
    });

    // Drawer settings buttons
    document.getElementById('drawer-settings-btn')?.addEventListener('click', () => {
      this.closeMobileDrawer();
      this.showPreferencesModal();
    });

    document.getElementById('drawer-ads-token-btn')?.addEventListener('click', () => {
      this.closeMobileDrawer();
      this.showAdsTokenModal();
    });

    document.getElementById('drawer-proxy-btn')?.addEventListener('click', () => {
      this.closeMobileDrawer();
      this.showLibraryProxyModal();
    });

    document.getElementById('drawer-llm-btn')?.addEventListener('click', () => {
      this.closeMobileDrawer();
      this.showLlmModal();
    });

    // Drawer add collection button
    document.getElementById('drawer-add-collection-btn')?.addEventListener('click', () => {
      this.closeMobileDrawer();
      this.showCollectionModal();
    });

    // Drawer console toggle
    document.getElementById('drawer-console-toggle')?.addEventListener('click', (e) => {
      e.currentTarget.classList.toggle('expanded');
      document.getElementById('drawer-console')?.classList.toggle('hidden');
    });

    // Drawer shortcuts toggle
    document.getElementById('drawer-shortcuts-toggle')?.addEventListener('click', (e) => {
      e.currentTarget.classList.toggle('expanded');
      document.getElementById('drawer-shortcuts')?.classList.toggle('hidden');
    });

    // Drawer new library buttons
    document.getElementById('drawer-new-icloud-lib')?.addEventListener('click', () => {
      this.closeMobileDrawer();
      this.createNewLibrary('icloud');
    });

    document.getElementById('drawer-new-local-lib')?.addEventListener('click', () => {
      this.closeMobileDrawer();
      this.createNewLibrary('local');
    });

    // Initialize with Papers view
    this.showMobileView('papers');
  }

  openMobileDrawer() {
    document.getElementById('mobile-drawer')?.classList.add('open');
    document.getElementById('mobile-drawer-overlay')?.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  closeMobileDrawer() {
    document.getElementById('mobile-drawer')?.classList.remove('open');
    document.getElementById('mobile-drawer-overlay')?.classList.remove('visible');
    document.body.style.overflow = '';
  }

  toggleMobileDrawer() {
    const drawer = document.getElementById('mobile-drawer');
    if (drawer?.classList.contains('open')) {
      this.closeMobileDrawer();
    } else {
      this.openMobileDrawer();
    }
  }

  toggleMobileSearch() {
    const isActive = document.body.classList.toggle('mobile-search-active');
    if (isActive) {
      // Focus the search input when opened
      const searchInput = document.getElementById('search-input');
      searchInput?.focus();
    }
  }

  toggleMobileSortMenu() {
    const menu = document.getElementById('mobile-sort-menu');
    if (menu) {
      menu.classList.toggle('hidden');
    }
  }

  closeMobileSortMenu() {
    const menu = document.getElementById('mobile-sort-menu');
    if (menu) {
      menu.classList.add('hidden');
    }
  }

  // Shared sort option handler - used by both mobile and desktop dropdowns
  handleSortOptionClick(field) {
    if (field === this.sortField) {
      // Same field - toggle direction
      this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
      // New field - default to descending for date/year/citations, ascending for text
      this.sortField = field;
      this.sortOrder = ['added', 'year', 'citations'].includes(field) ? 'desc' : 'asc';
    }

    // Save preferences
    if (window.electronAPI.setSortPreferences) {
      window.electronAPI.setSortPreferences(this.sortField, this.sortOrder);
    }

    // Update all sort UIs and re-render
    this.updateAllSortUI();
    this.sortPapers();
    this.renderPaperList();
    this.scrollToSelectedPaper();
  }

  // Update sort UI in toolbar
  updateAllSortUI() {
    this.updateMobileSortButton();
  }

  setupMobileSortMenu() {
    const menu = document.getElementById('mobile-sort-menu');
    const options = document.querySelectorAll('.mobile-sort-option');

    if (!menu) return;

    options.forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleSortOptionClick(opt.dataset.sort);
        this.closeMobileSortMenu();
      });
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      const container = document.querySelector('.mobile-sort-dropdown');
      if (container && !container.contains(e.target)) {
        this.closeMobileSortMenu();
      }
    });
  }

  // Filter Select Methods
  renderFilterCollections() {
    const optgroup = document.getElementById('filter-collections-group');
    if (!optgroup) return;

    if (!this.collections || this.collections.length === 0) {
      optgroup.innerHTML = '';
      return;
    }

    optgroup.innerHTML = this.collections.map(col =>
      `<option value="col:${col.id}">${col.is_smart ? '🔍 ' : '📁 '}${this.escapeHtml(col.name)}</option>`
    ).join('');
  }

  updateFilterSelect() {
    const select = document.getElementById('filter-select');
    if (!select) return;

    if (this.currentCollection) {
      select.value = `col:${this.currentCollection}`;
    } else {
      select.value = this.currentView || 'all';
    }
  }

  setupFilterSelect() {
    const select = document.getElementById('filter-select');
    if (!select) return;

    select.addEventListener('change', (e) => {
      const value = e.target.value;
      if (value.startsWith('col:')) {
        const collectionId = parseInt(value.substring(4));
        this.selectCollection(collectionId);
      } else {
        this.setView(value);
      }
    });
  }

  // Alias for compatibility
  updateFilterLabel() {
    this.updateFilterSelect();
  }

  updateMobileSortButton() {
    const labels = { added: 'Date', year: 'Year', title: 'Title', author: 'Author', citations: 'Cites', rating: 'Rating' };
    const labelEl = document.querySelector('.mobile-sort-label');
    const dirEl = document.querySelector('.mobile-sort-dir');
    if (labelEl) labelEl.textContent = labels[this.sortField] || this.sortField;
    if (dirEl) dirEl.textContent = this.sortOrder === 'asc' ? '↑' : '↓';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MOBILE LIBRARY PICKER
  // ═══════════════════════════════════════════════════════════════════════════

  async showMobileLibraryPicker() {
    const overlay = document.getElementById('mobile-library-overlay');
    const listContainer = document.getElementById('mobile-library-list');
    if (!overlay || !listContainer) return;

    // Get current library ID
    const currentLibraryId = await window.electronAPI.getCurrentLibraryId?.() || null;

    // Get all libraries
    try {
      const libraries = await window.electronAPI.getAllLibraries();

      // Build list HTML with inline onclick handlers for iOS compatibility
      let html = '';
      for (const lib of libraries) {
        const isActive = lib.id === currentLibraryId;
        const icon = lib.location === 'icloud' ? '☁️' : '💻';
        const paperCount = lib.paperCount || 0;
        const paperLabel = paperCount === 1 ? '1 paper' : `${paperCount} papers`;
        const checkmark = isActive ? '<span class="library-checkmark">✓</span>' : '';
        const escapedName = this.escapeHtml(lib.name).replace(/'/g, "\\'");

        html += `
          <button class="mobile-library-item ${isActive ? 'active' : ''}" data-id="${lib.id}" onclick="window.app.handleMobileLibrarySelect('${lib.id}', '${escapedName}')">
            <span class="library-icon">${icon}</span>
            <div class="library-info">
              <div class="library-name">${this.escapeHtml(lib.name)}</div>
              <div class="library-meta">${paperLabel}</div>
            </div>
            ${checkmark}
            <span class="library-delete-btn" onclick="event.stopPropagation(); window.app.handleMobileLibraryDeleteBtn('${lib.id}', '${escapedName}')">🗑</span>
          </button>
        `;
      }

      if (libraries.length === 0) {
        html = '<div class="mobile-library-empty">No libraries yet</div>';
      }

      listContainer.innerHTML = html;
      console.log('[MobileLibraryPicker] Using inline onclick handlers for', listContainer.querySelectorAll('.mobile-library-item').length, 'items');

    } catch (error) {
      console.error('Failed to load libraries:', error);
      listContainer.innerHTML = '<div class="mobile-library-empty">Failed to load libraries</div>';
    }

    // Set up close button
    document.getElementById('mobile-library-close')?.addEventListener('click', () => {
      this.hideMobileLibraryPicker();
    });

    // Set up new library button
    document.getElementById('mobile-library-new-btn')?.addEventListener('click', async () => {
      await this.createIOSLibrary();
      this.showMobileLibraryPicker(); // Refresh list
    });

    // Show overlay
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  hideMobileLibraryPicker() {
    const overlay = document.getElementById('mobile-library-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      document.body.style.overflow = '';
    }
  }

  // Handler methods for mobile library picker inline onclick (iOS compatibility)
  async handleMobileLibrarySelect(libId, libName) {
    console.log('[handleMobileLibrarySelect] Called with:', libId, libName);
    try {
      await this.switchToLibrary(libId);
      this.hideMobileLibraryPicker();
      console.log('[handleMobileLibrarySelect] Switch completed successfully');
    } catch (error) {
      console.error('[handleMobileLibrarySelect] Error:', error);
      alert('Failed to switch library: ' + error.message);
    }
  }

  async handleMobileLibraryDeleteBtn(libId, libName) {
    console.log('[handleMobileLibraryDeleteBtn] Called with:', libId, libName);
    await this.confirmDeleteIOSLibrary(libId, libName);
    // Refresh the list after deletion
    this.showMobileLibraryPicker();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MOBILE PDF VIEWER
  // ═══════════════════════════════════════════════════════════════════════════

  initMobilePdfGestures() {
    const container = document.getElementById('pdf-container');
    if (!container) return;

    let initialDistance = 0;
    let initialScale = 1;
    let isPinching = false;
    let currentVisualScale = 1;
    let pinchCenter = { x: 0, y: 0 };

    const getPinchCenter = (touches) => {
      return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2
      };
    };

    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        isPinching = true;
        initialDistance = this.getTouchDistance(e.touches);
        initialScale = this.pdfScale || 1;
        currentVisualScale = 1;
        pinchCenter = getPinchCenter(e.touches);
      }
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && isPinching) {
        e.preventDefault();
        const currentDistance = this.getTouchDistance(e.touches);
        const scaleChange = currentDistance / initialDistance;
        currentVisualScale = scaleChange;
        const center = getPinchCenter(e.touches);

        // Use CSS transform for instant visual feedback (no re-render)
        // Transform from the pinch center point
        const pdfPages = container.querySelectorAll('.pdf-page-wrapper');
        pdfPages.forEach(page => {
          const rect = page.getBoundingClientRect();
          const originX = ((center.x - rect.left) / rect.width) * 100;
          const originY = ((center.y - rect.top) / rect.height) * 100;
          page.style.transformOrigin = `${originX}% ${originY}%`;
          page.style.transform = `scale(${scaleChange})`;
        });
      }
    }, { passive: false });

    container.addEventListener('touchend', () => {
      if (isPinching) {
        isPinching = false;

        // Calculate final scale
        const newScale = Math.max(0.5, Math.min(3, initialScale * currentVisualScale));

        // Reset CSS transforms
        const pdfPages = container.querySelectorAll('.pdf-page-wrapper');
        pdfPages.forEach(page => {
          page.style.transform = '';
          page.style.transformOrigin = '';
        });

        // Only re-render if scale actually changed significantly
        if (Math.abs(newScale - (this.pdfScale || 1)) > 0.05) {
          this.setPdfScale(newScale);
        }
      }
    }, { passive: true });
  }

  getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  setPdfScale(scale) {
    const container = document.getElementById('pdf-container');

    // Capture current page position before re-rendering
    const targetPage = this.getCurrentVisiblePage();
    let pageOffset = 0;

    if (container) {
      const currentWrapper = container.querySelector(`.pdf-page-wrapper[data-page="${targetPage}"]`);
      if (currentWrapper) {
        const wrapperRect = currentWrapper.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        // How far into the page is the viewport top?
        const offsetIntoPage = containerRect.top - wrapperRect.top;
        pageOffset = offsetIntoPage / currentWrapper.offsetHeight;
        // Clamp to valid range
        pageOffset = Math.max(0, Math.min(1, pageOffset));
      }
    }

    this.pdfScale = Math.max(0.5, Math.min(3, scale));
    this.renderAllPages(targetPage, pageOffset);
    this.updateMobilePdfControls();

    // Save zoom level
    window.electronAPI?.setPdfZoom?.(this.pdfScale);
  }

  initMobilePdfControls() {
    document.getElementById('pdf-prev-page')?.addEventListener('click', () => {
      this.goToPdfPage(this.getCurrentVisiblePage() - 1);
    });

    document.getElementById('pdf-next-page')?.addEventListener('click', () => {
      this.goToPdfPage(this.getCurrentVisiblePage() + 1);
    });

    document.getElementById('pdf-page-input')?.addEventListener('change', (e) => {
      this.goToPdfPage(parseInt(e.target.value));
    });

    document.getElementById('pdf-zoom-in')?.addEventListener('click', () => {
      this.setPdfScale((this.pdfScale || 1) + 0.25);
    });

    document.getElementById('pdf-zoom-out')?.addEventListener('click', () => {
      this.setPdfScale((this.pdfScale || 1) - 0.25);
    });

    document.getElementById('pdf-fit-width')?.addEventListener('click', () => {
      this.fitPdfToWidth();
    });

    // Fullscreen button
    document.getElementById('pdf-fullscreen-btn')?.addEventListener('click', () => {
      this.enterPdfFullscreen();
    });

    // Fullscreen close button
    document.getElementById('pdf-fullscreen-close')?.addEventListener('click', () => {
      this.exitPdfFullscreen();
    });

    // Double-tap to enter fullscreen on PDF container
    this.setupPdfDoubleTap();

    // Update controls when scrolling through pages
    document.getElementById('pdf-container')?.addEventListener('scroll', () => {
      this.updateMobilePdfControls();
      // Show close button briefly on scroll in fullscreen mode
      if (this.isPdfFullscreen) {
        this.showFullscreenCloseButton();
      }
    });
  }

  setupPdfDoubleTap() {
    const container = document.getElementById('pdf-container');
    if (!container) return;

    let lastTapTime = 0;
    const doubleTapDelay = 300; // ms

    container.addEventListener('touchend', (e) => {
      // Only handle single-finger taps, not pinch gestures
      if (e.touches.length > 0) return;

      const currentTime = Date.now();
      const tapLength = currentTime - lastTapTime;

      if (tapLength < doubleTapDelay && tapLength > 0) {
        // Double-tap detected
        e.preventDefault();
        if (this.isPdfFullscreen) {
          this.exitPdfFullscreen();
        } else {
          this.enterPdfFullscreen();
        }
        lastTapTime = 0;
      } else {
        lastTapTime = currentTime;
      }
    });
  }

  enterPdfFullscreen() {
    if (this.isPdfFullscreen) return;
    this.isPdfFullscreen = true;

    document.body.classList.add('pdf-fullscreen');

    // Show close button
    const closeBtn = document.getElementById('pdf-fullscreen-close');
    if (closeBtn) {
      closeBtn.classList.remove('hidden');
      this.showFullscreenCloseButton();
    }

    // Hide status bar on iOS if possible
    if (window.StatusBar?.hide) {
      window.StatusBar.hide();
    }

    console.log('[ADSReader] Entered PDF fullscreen mode');
  }

  exitPdfFullscreen() {
    if (!this.isPdfFullscreen) return;
    this.isPdfFullscreen = false;

    document.body.classList.remove('pdf-fullscreen');

    // Hide close button
    const closeBtn = document.getElementById('pdf-fullscreen-close');
    if (closeBtn) {
      closeBtn.classList.add('hidden');
      closeBtn.classList.remove('visible');
    }

    // Clear any pending auto-hide timer
    if (this._fullscreenCloseTimer) {
      clearTimeout(this._fullscreenCloseTimer);
      this._fullscreenCloseTimer = null;
    }

    // Show status bar on iOS if possible
    if (window.StatusBar?.show) {
      window.StatusBar.show();
    }

    console.log('[ADSReader] Exited PDF fullscreen mode');
  }

  showFullscreenCloseButton() {
    const closeBtn = document.getElementById('pdf-fullscreen-close');
    if (!closeBtn || !this.isPdfFullscreen) return;

    // Show button
    closeBtn.classList.add('visible');

    // Clear previous timer
    if (this._fullscreenCloseTimer) {
      clearTimeout(this._fullscreenCloseTimer);
    }

    // Auto-hide after 3 seconds
    this._fullscreenCloseTimer = setTimeout(() => {
      if (this.isPdfFullscreen) {
        closeBtn.classList.remove('visible');
      }
    }, 3000);
  }

  goToPdfPage(pageNum) {
    if (!this.pdfDoc) return;
    const page = Math.max(1, Math.min(pageNum, this.pdfDoc.numPages));
    const wrapper = document.querySelector(`.pdf-page-wrapper[data-page="${page}"]`);
    if (wrapper) {
      wrapper.scrollIntoView({ behavior: 'smooth' });
    }
    this.updateMobilePdfControls();
  }

  getCurrentVisiblePage() {
    const container = document.getElementById('pdf-container');
    if (!container) return 1;

    const wrappers = container.querySelectorAll('.pdf-page-wrapper');
    const containerRect = container.getBoundingClientRect();
    const containerCenter = containerRect.top + containerRect.height / 2;

    for (const wrapper of wrappers) {
      const rect = wrapper.getBoundingClientRect();
      if (rect.top <= containerCenter && rect.bottom >= containerCenter) {
        return parseInt(wrapper.dataset.page) || 1;
      }
    }
    return 1;
  }

  fitPdfToWidth() {
    const container = document.getElementById('pdf-container');
    const page = document.querySelector('.pdf-page canvas');
    if (!page || !container) return;

    const containerWidth = container.clientWidth - 24;
    const pageWidth = page.width / (this.pdfScale || 1);
    this.setPdfScale(containerWidth / pageWidth);
  }

  updateMobilePdfControls() {
    const currentPage = this.getCurrentVisiblePage();
    const pageInput = document.getElementById('pdf-page-input');
    const totalPages = document.getElementById('pdf-total-pages');
    const zoomDisplay = document.getElementById('pdf-zoom-display');

    if (pageInput) pageInput.value = currentPage;
    if (totalPages) totalPages.textContent = this.pdfDoc?.numPages || 1;
    if (zoomDisplay) zoomDisplay.textContent = `${Math.round((this.pdfScale || 1) * 100)}%`;
  }

  setupMobileTextSelection() {
    document.addEventListener('selectionchange', () => {
      if (!this.isMobileView) return;
      this.handleMobileTextSelection();
    });
  }

  handleMobileTextSelection() {
    const selection = window.getSelection();
    const text = selection?.toString().trim();

    // Hide button if no selection
    const existingBtn = document.getElementById('mobile-highlight-btn');
    if (!text || text.length < 5) {
      if (existingBtn) existingBtn.style.display = 'none';
      return;
    }

    // Show floating highlight button
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    let btn = existingBtn;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'mobile-highlight-btn';
      btn.className = 'mobile-highlight-btn';
      btn.textContent = 'Highlight';
      btn.addEventListener('click', () => {
        this.createHighlightFromSelection();
        btn.style.display = 'none';
      });
      document.body.appendChild(btn);
    }

    btn.style.display = 'block';
    btn.style.top = `${rect.top + window.scrollY - 50}px`;
    btn.style.left = `${rect.left + rect.width / 2 - 40}px`;
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
          const paperCount = lib.paperCount || 0;
          const paperLabel = paperCount === 1 ? '1 paper' : `${paperCount} papers`;
          html += `
            <div class="library-item ${isActive ? 'active' : ''}" data-id="${lib.id}">
              <span class="lib-icon">☁️</span>
              <span class="lib-name">${this.escapeHtml(lib.name)} (${paperLabel})</span>
              <button class="lib-delete-btn" data-id="${lib.id}" title="Delete library">✕</button>
            </div>
          `;
        }
      }

      if (localLibs.length > 0) {
        html += '<div class="library-section-label">Local</div>';
        for (const lib of localLibs) {
          const isActive = lib.id === currentId;
          const paperCount = lib.paperCount || 0;
          const paperLabel = paperCount === 1 ? '1 paper' : `${paperCount} papers`;
          html += `
            <div class="library-item ${isActive ? 'active' : ''}" data-id="${lib.id}">
              <span class="lib-icon">💻</span>
              <span class="lib-name">${this.escapeHtml(lib.name)} (${paperLabel})</span>
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
    let name;
    try {
      console.log('[createNewLibrary] Showing prompt...');
      name = await this.showPrompt(`Enter name for new ${location} library:`, 'My Library');
      console.log('[createNewLibrary] User entered name:', name);
    } catch (promptError) {
      console.error('[createNewLibrary] Prompt error:', promptError);
      alert('Error showing prompt: ' + promptError.message);
      return;
    }

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
    console.log('[switchToLibrary] Starting for library:', libraryId);
    try {
      console.log('[switchToLibrary] Calling API.switchLibrary...');
      const result = await window.electronAPI.switchLibrary(libraryId);
      console.log('[switchToLibrary] API result:', result);

      if (result.success) {
        this.libraryPath = result.path;
        this.consoleLog(`Switched to library at ${result.path}`, 'success');

        // Show main screen if we were on setup screen
        const setupScreen = document.getElementById('setup-screen');
        if (setupScreen && !setupScreen.classList.contains('hidden')) {
          console.log('[switchToLibrary] Showing main screen...');
          this.showMainScreen({ path: result.path });
        }

        // Reset smart search state when switching libraries
        this.currentSmartSearch = null;
        this.exitSmartSearchView();

        // Reload papers, collections, and smart searches
        console.log('[switchToLibrary] Loading papers...');
        await this.loadPapers();
        console.log('[switchToLibrary] Loading collections...');
        await this.loadCollections();
        console.log('[switchToLibrary] Loading smart searches...');
        await this.loadSmartSearches();
        console.log('[switchToLibrary] Updating library picker...');
        await this.updateLibraryPickerDisplay();

        // Clear selection
        this.clearPaperDisplay();
        console.log('[switchToLibrary] Complete');
      } else {
        console.error('[switchToLibrary] Failed:', result.error);
        this.consoleLog(`Failed to switch library: ${result.error}`, 'error');
        alert(`Failed to switch library: ${result.error}`);
      }
    } catch (error) {
      console.error('[switchToLibrary] Exception:', error);
      this.consoleLog(`Error switching library: ${error.message}`, 'error');
      throw error; // Re-throw so caller can handle
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

  // Sanitize abstract text - allow safe HTML tags (sub, sup) and decode entities
  sanitizeAbstract(str) {
    if (!str) return '';

    // First, escape everything for safety
    let safe = this.escapeHtml(str);

    // Now selectively restore safe tags (case-insensitive)
    // Restore <sub> and </sub>
    safe = safe.replace(/&lt;sub&gt;/gi, '<sub>');
    safe = safe.replace(/&lt;\/sub&gt;/gi, '</sub>');

    // Restore <sup> and </sup>
    safe = safe.replace(/&lt;sup&gt;/gi, '<sup>');
    safe = safe.replace(/&lt;\/sup&gt;/gi, '</sup>');

    // Restore <em> and </em> for emphasis
    safe = safe.replace(/&lt;em&gt;/gi, '<em>');
    safe = safe.replace(/&lt;\/em&gt;/gi, '</em>');

    // Restore <i> and </i> for italics
    safe = safe.replace(/&lt;i&gt;/gi, '<i>');
    safe = safe.replace(/&lt;\/i&gt;/gi, '</i>');

    // Restore <b> and </b> for bold
    safe = safe.replace(/&lt;b&gt;/gi, '<b>');
    safe = safe.replace(/&lt;\/b&gt;/gi, '</b>');

    return safe;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FILES PANEL METHODS (unified file management)
  // ═══════════════════════════════════════════════════════════════════════════

  async renderFilesPanel(paper) {
    const filesPanel = document.getElementById('files-panel');
    const filesList = document.getElementById('files-list');
    const filesAvailable = document.getElementById('files-available');

    if (!filesPanel || !paper) return;

    // Rescan for unregistered files on disk (fixes missing files issue)
    if (window.electronAPI?.paperFiles?.rescan) {
      try {
        await window.electronAPI.paperFiles.rescan(paper.id);
      } catch (e) {
        // Ignore rescan errors - not critical
      }
    }

    // Try to use new paperFiles API if available, fall back to legacy APIs
    let files = [];
    let availableSources = [];

    // Use new API if available (from Agent 3's implementation)
    if (window.electronAPI?.paperFiles?.list) {
      try {
        files = await window.electronAPI.paperFiles.list(paper.id);
      } catch (e) {
        console.warn('[renderFilesPanel] paperFiles.list failed, using legacy APIs:', e);
        files = [];
      }
    }

    // If new API not available or returned empty, build from legacy APIs
    if (files.length === 0) {
      const downloadedSources = await window.electronAPI.getDownloadedPdfSources(paper.id);
      const attachments = await window.electronAPI.getAttachments(paper.id);

      // Convert downloaded sources to file items
      for (const source of downloadedSources) {
        files.push({
          id: `source-${source}`,
          file_role: 'pdf',
          source_type: source,
          original_name: this.getSourceLabel(source),
          is_primary: source === downloadedSources[0], // First is primary
          file_size: null
        });
      }

      // Convert attachments to file items
      for (const att of attachments) {
        files.push({
          id: `att-${att.id}`,
          file_role: att.file_type === 'pdf' ? 'pdf' : 'attachment',
          source_type: 'attachment',
          original_name: att.original_name || att.filename,
          filename: att.filename,
          is_primary: false,
          file_size: att.file_size
        });
      }
    }

    // Render existing files
    if (files.length > 0) {
      filesList.innerHTML = files.map(file => this.renderFileItem(file, paper.id)).join('');
      this.setupFileItemListeners(paper.id);
    } else {
      filesList.innerHTML = '<div class="files-empty">No files attached</div>';
    }

    // Render available downloads
    await this.renderAvailableSources(paper, filesAvailable, files);
  }

  getSourceLabel(sourceType) {
    const labels = {
      'EPRINT_PDF': 'arXiv',
      'PUB_PDF': 'Publisher',
      'ADS_PDF': 'ADS Scan',
      'LEGACY': 'PDF',
      'ATTACHED': 'Attached',
      'arxiv': 'arXiv',
      'publisher': 'Publisher',
      'ads_scan': 'ADS Scan'
    };
    return labels[sourceType] || sourceType;
  }

  renderFileItem(file, paperId) {
    const icon = file.file_role === 'pdf' ? '📄' : '📎';
    const size = file.file_size ? this.formatFileSize(file.file_size) : '';
    const isPrimary = file.is_primary;
    const sourceLabel = this.getSourceLabel(file.source_type);
    const meta = [sourceLabel, size].filter(Boolean).join(' · ');

    // Make file items draggable for external drag-and-drop
    return `
      <div class="file-item${isPrimary ? ' primary' : ''}" data-file-id="${file.id}" data-paper-id="${paperId}"
           draggable="true" title="Drag to share this file">
        <span class="file-icon">${icon}</span>
        <div class="file-info">
          <div class="file-name">${this.escapeHtml(file.original_name || file.filename || 'Unknown')}</div>
          <div class="file-meta">${meta}</div>
        </div>
        <div class="file-actions">
          ${file.file_role === 'pdf' ? `
            <button class="file-primary-btn ${isPrimary ? 'active' : ''}"
                    data-file-id="${file.id}" title="Set as primary PDF">★</button>
          ` : ''}
          <button class="file-open-btn" data-file-id="${file.id}" title="Open in viewer">↗</button>
          <button class="file-delete-btn" data-file-id="${file.id}" title="Delete file">×</button>
        </div>
      </div>
    `;
  }

  async renderAvailableSources(paper, container, existingFiles) {
    if (!container || !paper.bibcode) {
      container.innerHTML = '';
      return;
    }

    // Get ADS sources for this paper
    let sources = { arxiv: false, publisher: false, ads: false };
    try {
      if (window.electronAPI.adsPdfSources) {
        sources = await window.electronAPI.adsPdfSources(paper.bibcode);
      }
    } catch (e) {
      console.warn('[renderAvailableSources] Failed to get ADS sources:', e);
    }

    // Determine which sources are already downloaded
    const existingSourceTypes = existingFiles
      .filter(f => f.file_role === 'pdf')
      .map(f => f.source_type);

    const availableSources = [];

    if (sources.arxiv && !existingSourceTypes.includes('EPRINT_PDF')) {
      availableSources.push({ type: 'EPRINT_PDF', label: 'arXiv' });
    }
    if (sources.publisher && !existingSourceTypes.includes('PUB_PDF')) {
      availableSources.push({ type: 'PUB_PDF', label: 'Publisher' });
    }
    if (sources.ads && !existingSourceTypes.includes('ADS_PDF')) {
      availableSources.push({ type: 'ADS_PDF', label: 'ADS Scan' });
    }

    if (availableSources.length > 0) {
      container.innerHTML = `
        <div class="files-available-header">Available for download</div>
        ${availableSources.map(s => `
          <div class="available-source" data-source="${s.type}">
            <span>⬇ ${s.label}</span>
            <button class="download-btn" data-source="${s.type}">Download</button>
          </div>
        `).join('')}
      `;

      // Add click handlers for download buttons
      container.querySelectorAll('.download-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const sourceType = btn.dataset.source;
          await this.downloadPdfSource(paper.id, sourceType);
        });
      });
    } else {
      container.innerHTML = '';
    }
  }

  setupFileItemListeners(paperId) {
    const filesList = document.getElementById('files-list');
    if (!filesList) return;

    // Primary button handlers
    filesList.querySelectorAll('.file-primary-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fileId = btn.dataset.fileId;
        await this.setPrimaryPdf(paperId, fileId);
      });
    });

    // Open button handlers
    filesList.querySelectorAll('.file-open-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fileId = btn.dataset.fileId;
        await this.openFileFromPanel(paperId, fileId);
      });
    });

    // Delete button handlers
    filesList.querySelectorAll('.file-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fileId = btn.dataset.fileId;
        await this.deleteFileFromPanel(paperId, fileId);
      });
    });

    // Click handler to open files with system default app
    filesList.querySelectorAll('.file-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        // Don't trigger if clicking on action buttons
        if (e.target.closest('.file-actions')) return;

        const fileId = item.dataset.fileId;
        const filePath = await this.getFilePathForItem(paperId, fileId);
        if (filePath) {
          await window.electronAPI.openPath?.(filePath);
        }
      });

      // Drag handler for dragging files to Finder, Mail, etc.
      item.addEventListener('dragstart', async (e) => {
        const fileId = item.dataset.fileId;
        const filePath = await this.getFilePathForItem(paperId, fileId);
        if (filePath && window.electronAPI?.startFileDrag) {
          e.preventDefault();
          window.electronAPI.startFileDrag(filePath);
        }
      });
    });
  }

  // Helper to get file path for a file item
  async getFilePathForItem(paperId, fileId) {
    if (fileId.startsWith('source-')) {
      const sourceType = fileId.replace('source-', '');
      const paths = await window.electronAPI.getPaperPdfPaths?.(paperId);
      return paths?.[sourceType];
    } else if (fileId.startsWith('att-')) {
      const attId = fileId.replace('att-', '');
      const attachments = await window.electronAPI.getAttachments(paperId);
      const att = attachments.find(a => a.id.toString() === attId);
      if (att?.filename) {
        const libraryPath = await window.electronAPI.getLibraryPath();
        return `${libraryPath}/attachments/${att.filename}`;
      }
    }
    return null;
  }

  async setPrimaryPdf(paperId, fileId) {
    // Use new API if available
    if (window.electronAPI?.paperFiles?.setPrimary) {
      try {
        await window.electronAPI.paperFiles.setPrimary(paperId, fileId);
        // Refresh the panel
        const paper = this.papers.find(p => p.id === paperId);
        if (paper) await this.renderFilesPanel(paper);
        this.consoleLog('Primary PDF updated', 'success');
      } catch (e) {
        console.error('[setPrimaryPdf] Failed:', e);
        this.consoleLog('Failed to set primary PDF', 'error');
      }
    } else {
      // No legacy equivalent - just log
      console.warn('[setPrimaryPdf] paperFiles.setPrimary API not available');
    }
  }

  async openFileFromPanel(paperId, fileId) {
    const paper = this.papers.find(p => p.id === paperId);
    if (!paper) return;

    // If fileId starts with 'source-', it's a PDF source
    if (fileId.startsWith('source-')) {
      const sourceType = fileId.replace('source-', '');
      await this.downloadFromSource(paperId, sourceType, null);
    } else if (fileId.startsWith('att-')) {
      // It's an attachment
      const attId = fileId.replace('att-', '');
      const attachments = await window.electronAPI.getAttachments(paperId);
      const att = attachments.find(a => a.id.toString() === attId);
      if (att && att.file_type === 'pdf') {
        paper.pdf_path = `papers/${att.filename}`;
        this.selectedPaper = paper;
        this.switchTab('pdf');
        await this.loadPDF(paper);
      }
    } else if (window.electronAPI?.paperFiles?.open) {
      // Use new API
      try {
        await window.electronAPI.paperFiles.open(paperId, fileId);
      } catch (e) {
        console.error('[openFileFromPanel] Failed:', e);
      }
    }
  }

  async deleteFileFromPanel(paperId, fileId) {
    if (!confirm('Delete this file?')) return;

    // If fileId starts with 'source-', delete the PDF source
    if (fileId.startsWith('source-')) {
      const sourceType = fileId.replace('source-', '');
      const deleted = await window.electronAPI.deletePdfSource(paperId, sourceType);
      if (deleted) {
        this.consoleLog(`Deleted ${this.getSourceLabel(sourceType)} PDF`, 'info');
        const paper = this.papers.find(p => p.id === paperId);
        if (paper) await this.renderFilesPanel(paper);
      }
    } else if (fileId.startsWith('att-')) {
      // Delete attachment
      const attId = parseInt(fileId.replace('att-', ''));
      const result = await window.electronAPI.deleteAttachment(attId);
      if (result.success) {
        this.consoleLog('Deleted attachment', 'info');
        const paper = this.papers.find(p => p.id === paperId);
        if (paper) await this.renderFilesPanel(paper);
      }
    } else if (window.electronAPI?.paperFiles?.remove) {
      // Use new API
      try {
        const result = await window.electronAPI.paperFiles.remove(fileId);
        if (result.success) {
          const paper = this.papers.find(p => p.id === paperId);
          if (paper) await this.renderFilesPanel(paper);
          this.consoleLog('File deleted', 'info');
        } else {
          this.consoleLog(`Failed to delete file: ${result.error}`, 'error');
        }
      } catch (e) {
        console.error('[deleteFileFromPanel] Failed:', e);
        this.consoleLog('Failed to delete file', 'error');
      }
    }
  }

  async downloadPdfSource(paperId, sourceType) {
    // Normalize source type: buttons use uppercase (EPRINT_PDF), but download uses lowercase (arxiv)
    const typeToLegacy = {
      'EPRINT_PDF': 'arxiv',
      'PUB_PDF': 'publisher',
      'ADS_PDF': 'ads'
    };
    const normalizedType = typeToLegacy[sourceType] || sourceType;

    console.log('[downloadPdfSource] paperId:', paperId, 'sourceType:', sourceType, 'normalized:', normalizedType);
    console.log('[downloadPdfSource] downloadQueue available:', !!window.electronAPI?.downloadQueue?.enqueue);

    // Use the download queue if available, otherwise direct download
    if (window.electronAPI?.downloadQueue?.enqueue) {
      try {
        console.log('[downloadPdfSource] Calling downloadQueue.enqueue...');
        const result = await window.electronAPI.downloadQueue.enqueue(paperId, normalizedType);
        console.log('[downloadPdfSource] enqueue result:', result);
        if (result.success) {
          this.showDownloadQueue();
          this.consoleLog?.(`Queued ${this.getSourceLabel(sourceType)} download`, 'info');
        } else {
          console.error('[downloadPdfSource] Queue returned error:', result.error);
          await this.downloadFromSource(paperId, normalizedType, null);
        }
      } catch (e) {
        console.error('[downloadPdfSource] Queue failed, trying direct download:', e);
        await this.downloadFromSource(paperId, normalizedType, null);
      }
    } else {
      console.log('[downloadPdfSource] No queue, using direct download');
      // Direct download using legacy method
      await this.downloadFromSource(paperId, normalizedType, null);
    }
  }

  async downloadPdfsForSelected(sourceType) {
    // Get selected papers (or current paper if none selected)
    let paperIds = this.selectedPapers.size > 0
      ? Array.from(this.selectedPapers)
      : (this.selectedPaper ? [this.selectedPaper.id] : []);

    if (paperIds.length === 0) {
      this.showNotification('No papers selected', 'warn');
      return;
    }

    // Filter to papers with bibcodes (required for ADS download)
    const papersWithBibcodes = paperIds.filter(id => {
      const paper = this.papers.find(p => p.id === id);
      return paper?.bibcode;
    });

    if (papersWithBibcodes.length === 0) {
      this.showNotification('Selected papers have no ADS bibcodes', 'warn');
      return;
    }

    const sourceLabel = this.getSourceLabel(sourceType);
    this.consoleLog(`Downloading ${sourceLabel} PDFs for ${papersWithBibcodes.length} paper(s)...`, 'info');

    // Queue downloads for all selected papers
    for (const paperId of papersWithBibcodes) {
      await this.downloadPdfSource(paperId, sourceType);
    }
  }

  // Get selected papers (multi-select) or current paper
  getSelectedOrCurrentPapers() {
    if (this.selectedPapers.size > 0) {
      return Array.from(this.selectedPapers)
        .map(id => this.papers.find(p => p.id === id))
        .filter(Boolean);
    }
    return this.selectedPaper ? [this.selectedPaper] : [];
  }

  // Populate download dropdown with available ADS sources
  async populateDownloadMenu(menuElement, papers) {
    menuElement.innerHTML = '<div class="download-loading">Loading...</div>';

    const sourceLabels = {
      'EPRINT_PDF': { icon: '📑', label: 'arXiv' },
      'PUB_PDF': { icon: '📰', label: 'Publisher' },
      'ADS_PDF': { icon: '📜', label: 'ADS Scan' },
      'ATTACHED': { icon: '📎', label: 'Attached' },
      'LEGACY': { icon: '📄', label: 'PDF' }
    };

    // For single paper, show both downloaded and available sources
    if (papers.length === 1) {
      const paper = papers[0];
      const downloadedSources = await window.electronAPI.getDownloadedPdfSources(paper.id);
      const pdfAttachments = await window.electronAPI.getPdfAttachments(paper.id) || [];

      // Get available sources from ADS
      const availableSources = new Set();
      if (paper.bibcode) {
        try {
          const result = await window.electronAPI.adsGetEsources(paper.bibcode);
          if (result.success && result.data) {
            if (result.data.arxiv) availableSources.add('EPRINT_PDF');
            if (result.data.publisher) availableSources.add('PUB_PDF');
            if (result.data.ads) availableSources.add('ADS_PDF');
          }
        } catch (e) {
          console.warn('[populateDownloadMenu] Failed to get esources:', e);
        }
      }

      let html = '';

      // Show downloaded sources first with checkmarks
      for (const source of downloadedSources) {
        const info = sourceLabels[source] || { icon: '📄', label: source };
        html += `<div class="download-option downloaded" data-source="${source}" data-action="view">✓ ${info.icon} ${info.label}</div>`;
        availableSources.delete(source); // Remove from available since already downloaded
      }

      // Show attachments with checkmarks
      for (const att of pdfAttachments) {
        html += `<div class="download-option downloaded" data-attachment="${att.filename}" data-action="view">✓ 📎 ${att.display_name || att.filename}</div>`;
      }

      // Show available sources for download (not yet downloaded)
      for (const source of ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF']) {
        if (availableSources.has(source)) {
          const { icon, label } = sourceLabels[source];
          html += `<div class="download-option" data-source="${source}" data-action="download">${icon} ${label}</div>`;
        }
      }

      if (!html) {
        menuElement.innerHTML = '<div class="download-option disabled">No sources available</div>';
        return;
      }
      menuElement.innerHTML = html;

      // Attach click handlers
      menuElement.querySelectorAll('.download-option:not(.disabled)').forEach(option => {
        option.addEventListener('click', async () => {
          const action = option.dataset.action;
          const source = option.dataset.source;
          const attachment = option.dataset.attachment;

          if (action === 'view') {
            if (attachment) {
              // View attachment
              paper.pdf_path = `papers/${attachment}`;
            } else if (source) {
              // View downloaded source
              const baseFilename = paper.bibcode ? paper.bibcode.replace(/\//g, '_') : `paper_${paper.id}`;
              paper.pdf_path = source === 'LEGACY' ? `papers/${baseFilename}.pdf` : `papers/${baseFilename}_${source}.pdf`;
            }
            await this.loadPDF(paper);
          } else if (action === 'download' && source) {
            await this.downloadPdfsForSelected(source);
          }
          menuElement.classList.add('hidden');
        });
      });
    } else {
      // Multiple papers - just show download options
      const allSources = new Set();

      for (const paper of papers) {
        if (!paper.bibcode) continue;
        try {
          const result = await window.electronAPI.adsGetEsources(paper.bibcode);
          if (result.success && result.data) {
            if (result.data.arxiv) allSources.add('EPRINT_PDF');
            if (result.data.publisher) allSources.add('PUB_PDF');
            if (result.data.ads) allSources.add('ADS_PDF');
          }
        } catch (e) {
          console.warn('[populateDownloadMenu] Failed to get esources:', e);
        }
      }

      if (allSources.size === 0) {
        menuElement.innerHTML = '<div class="download-option disabled">No sources available</div>';
        return;
      }

      let html = '';
      for (const source of ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF']) {
        if (allSources.has(source)) {
          const { icon, label } = sourceLabels[source];
          html += `<div class="download-option" data-source="${source}">${icon} ${label}</div>`;
        }
      }
      menuElement.innerHTML = html;

      // Attach click handlers
      menuElement.querySelectorAll('.download-option').forEach(option => {
        option.addEventListener('click', () => {
          this.downloadPdfsForSelected(option.dataset.source);
          menuElement.classList.add('hidden');
        });
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOWNLOAD QUEUE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  setupDownloadQueue() {
    // Set up IPC listeners for download queue events if API is available
    if (window.electronAPI?.downloadQueue) {
      if (window.electronAPI.downloadQueue.onProgress) {
        window.electronAPI.downloadQueue.onProgress(data => this.updateQueueItem(data));
      }
      if (window.electronAPI.downloadQueue.onComplete) {
        window.electronAPI.downloadQueue.onComplete(data => this.handleDownloadComplete(data));
      }
      if (window.electronAPI.downloadQueue.onError) {
        window.electronAPI.downloadQueue.onError(data => this.handleDownloadError(data));
      }
    }

    // Set up queue panel button handlers
    document.getElementById('queue-close-btn')?.addEventListener('click', () => {
      this.hideDownloadQueue();
    });

    document.getElementById('queue-pause-btn')?.addEventListener('click', async () => {
      if (window.electronAPI?.downloadQueue?.pauseAll) {
        await window.electronAPI.downloadQueue.pauseAll();
      }
    });
  }

  showDownloadQueue() {
    const panel = document.getElementById('download-queue-panel');
    if (panel) {
      panel.classList.remove('hidden');
      this.refreshQueueList();
    }
  }

  hideDownloadQueue() {
    document.getElementById('download-queue-panel')?.classList.add('hidden');
  }

  async refreshQueueList() {
    const queueList = document.getElementById('queue-list');
    const queueSummary = document.getElementById('queue-summary');
    if (!queueList) return;

    // Get queue state from API if available
    if (window.electronAPI?.downloadQueue?.status) {
      try {
        const state = await window.electronAPI.downloadQueue.status();
        const items = state.items || [];

        if (items.length === 0) {
          queueList.innerHTML = '<div class="queue-empty">No downloads in queue</div>';
          queueSummary.textContent = '';
          return;
        }

        queueList.innerHTML = items.map(item => this.renderQueueItem(item)).join('');

        // Update summary
        const active = items.filter(i => i.status === 'downloading').length;
        const pending = items.filter(i => i.status === 'pending').length;
        queueSummary.textContent = `${active} active, ${pending} pending`;

        // Set up cancel button handlers
        queueList.querySelectorAll('.queue-item-cancel').forEach(btn => {
          btn.addEventListener('click', async () => {
            const paperId = btn.dataset.paperId;
            if (window.electronAPI?.downloadQueue?.cancel) {
              await window.electronAPI.downloadQueue.cancel(paperId);
              this.refreshQueueList();
            }
          });
        });
      } catch (e) {
        console.warn('[refreshQueueList] Failed:', e);
        queueList.innerHTML = '<div class="queue-empty">Queue unavailable</div>';
      }
    } else {
      queueList.innerHTML = '<div class="queue-empty">Download queue not available</div>';
    }
  }

  renderQueueItem(item) {
    const statusClass = item.status === 'downloading' ? 'downloading' :
                        item.status === 'error' ? 'error' :
                        item.status === 'complete' ? 'complete' : '';
    const progress = item.percent || 0;
    const statusText = item.status === 'downloading' ? `Downloading... ${progress}%` :
                       item.status === 'pending' ? 'Pending' :
                       item.status === 'error' ? 'Failed' :
                       item.status === 'complete' ? 'Complete' : item.status;

    return `
      <div class="queue-item" data-paper-id="${item.paperId}">
        <span class="queue-item-icon">📄</span>
        <div class="queue-item-info">
          <div class="queue-item-title">${this.escapeHtml(item.title || 'Downloading...')}</div>
          <div class="queue-item-status ${statusClass}">${statusText}</div>
          ${item.status === 'downloading' ? `
            <div class="queue-progress">
              <div class="queue-progress-bar" style="width: ${progress}%"></div>
            </div>
          ` : ''}
        </div>
        <button class="queue-item-cancel" data-paper-id="${item.paperId}" title="Cancel">×</button>
      </div>
    `;
  }

  updateQueueItem(data) {
    const queueList = document.getElementById('queue-list');
    if (!queueList) return;

    const item = queueList.querySelector(`[data-paper-id="${data.paperId}"]`);
    if (item) {
      const bar = item.querySelector('.queue-progress-bar');
      const status = item.querySelector('.queue-item-status');
      if (bar) bar.style.width = `${data.percent || 0}%`;
      if (status) status.textContent = `Downloading... ${data.percent || 0}%`;
    }

    // Show queue panel if not visible
    this.showDownloadQueue();
  }

  async handleDownloadComplete(data) {
    console.log('[handleDownloadComplete] data:', data);
    this.consoleLog(`Downloaded: ${data.sourceType || 'PDF'}`, 'success');
    await this.refreshQueueList();

    // Check if queue is empty and hide the panel after a short delay
    if (window.electronAPI?.downloadQueue?.status) {
      try {
        const state = await window.electronAPI.downloadQueue.status();
        // getStatus returns: { queued, active, paused, activeIds }
        const hasActiveOrPending = (state.queued || 0) + (state.active || 0) > 0;
        if (!hasActiveOrPending) {
          // All downloads complete - hide panel after brief delay so user sees success
          setTimeout(() => this.hideDownloadQueue(), 1500);
        }
      } catch (e) {
        // Ignore errors
      }
    }

    // Update paper's pdf_path and refresh UI if viewing this paper
    if (this.selectedPaper?.id === data.paperId) {
      // Set pdf_path from the download result (path is relative like "papers/BIBCODE_EPRINT_PDF.pdf")
      if (data.path) {
        this.selectedPaper.pdf_path = data.path;
        // Also update in papers array
        const paper = this.papers.find(p => p.id === data.paperId);
        if (paper) {
          paper.pdf_path = data.path;
        }
      }
      await this.renderFilesPanel(this.selectedPaper);
      // Also reload PDF if on PDF tab
      const currentTab = document.querySelector('.tab-btn.active')?.dataset.tab;
      if (currentTab === 'pdf') {
        await this.loadPDF(this.selectedPaper);
      }
    }
  }

  handleDownloadError(data) {
    const paper = this.papers.find(p => p.id === data.paperId);
    const paperInfo = paper ? (paper.bibcode || paper.title?.substring(0, 30)) : `ID ${data.paperId}`;
    const sourceInfo = data.sourceType ? ` [${data.sourceType}]` : '';
    const retryInfo = data.willRetry ? ` (will retry, attempt ${data.attempt})` : ' (giving up)';
    const errorMsg = data.error?.message || data.error || 'Unknown error';

    this.consoleLog(`Download failed: ${paperInfo}${sourceInfo} - ${errorMsg}${retryInfo}`, 'error');
    this.refreshQueueList();
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
    // Use event delegation for iOS compatibility (elements may not exist at init time)
    document.addEventListener('click', (e) => {
      const target = e.target;

      // Handle nav-items via delegation
      const navItem = target.closest('.nav-item[data-view]');
      if (navItem) {
        this.setView(navItem.dataset.view);
        return;
      }

      // Handle collection nav-items
      const collectionItem = target.closest('.nav-item[data-collection]');
      if (collectionItem) {
        this.selectCollection(parseInt(collectionItem.dataset.collection));
        return;
      }

      // Handle buttons and nav-items by ID via delegation
      const clickableEl = target.closest('button, .nav-item[id]');
      const elementId = clickableEl?.id || target.id;
      if (elementId) {
        switch (elementId) {
          case 'import-btn':
          case 'add-paper-btn':
            this.importFiles();
            break;
          case 'remove-paper-btn':
            this.removeSelectedPapers();
            break;
          case 'change-library-btn':
          case 'select-folder-btn':
            this.selectLibraryFolder();
            break;
          case 'preferences-btn':
            this.showPreferencesModal();
            break;
          case 'sync-btn':
            this.syncAllPapers();
            break;
          case 'create-icloud-library-btn':
            this.createNewLibrary('icloud');
            break;
          case 'console-header':
            this.toggleConsole();
            break;
          // Settings nav-items - inline for desktop, modal for iOS
          case 'ads-settings-btn':
            console.log('[Debug] ads-settings-btn clicked via delegation');
            if (this.isIOS) {
              this.showAdsTokenModal();
            } else {
              this.toggleInlineSettings('ads');
            }
            break;
          case 'library-proxy-btn':
            if (this.isIOS) {
              this.showLibraryProxyModal();
            } else {
              this.toggleInlineSettings('proxy');
            }
            break;
          case 'llm-settings-btn':
            this.showLlmModal();
            break;
          case 'ads-token-save-inline':
            this.saveAdsTokenInline();
            break;
          case 'proxy-save-inline':
            this.saveProxyInline();
            break;
          // Modal buttons (iOS compatibility)
          case 'ads-save-btn':
            this.saveAdsToken();
            break;
          case 'ads-cancel-btn':
            this.hideAdsTokenModal();
            break;
          case 'proxy-save-btn':
            this.saveLibraryProxy();
            break;
          case 'proxy-cancel-btn':
            this.hideLibraryProxyModal();
            break;
          case 'llm-save-btn':
            this.saveLlmConfig();
            break;
          case 'llm-cancel-btn':
            this.hideLlmModal();
            break;
          case 'llm-test-btn':
            this.testLlmConnection();
            break;
          // Cloud provider test buttons (iOS compatibility)
          case 'anthropic-test-btn':
            this.testProvider('anthropic');
            break;
          case 'gemini-test-btn':
            this.testProvider('gemini');
            break;
          case 'perplexity-test-btn':
            this.testProvider('perplexity');
            break;
          case 'ollama-test-btn':
            this.testProvider('ollama');
            break;
          case 'reset-summary-prompt-btn':
            this.resetSummaryPrompt();
            break;
          // ADS Import modal buttons (iOS compatibility)
          case 'ads-search-btn':
            this.showAdsSearchModal();
            break;
          case 'ads-search-execute-btn':
            this.executeAdsSearch();
            break;
          case 'ads-import-btn':
            this.importAdsSelected();
            break;
          case 'ads-close-btn':
          case 'ads-modal-close-btn':
            this.hideAdsSearchModal();
            break;
          case 'ads-select-all-btn':
            this.selectAllAdsResults();
            break;
          case 'ads-deselect-all-btn':
            this.deselectAllAdsResults();
            break;
          // ADS Lookup modal buttons (iOS compatibility)
          case 'ads-lookup-search-btn':
            this.searchAdsLookup();
            break;
          case 'ads-lookup-close-btn':
          case 'ads-lookup-cancel-btn':
            this.hideAdsLookupModal();
            break;
          case 'ads-lookup-apply-btn':
            this.applyAdsLookupMetadata();
            break;
          // Feedback modal
          case 'send-feedback-btn':
            this.showFeedbackModal();
            break;
          case 'feedback-close-btn':
          case 'feedback-cancel-btn':
            this.hideFeedbackModal();
            break;
          case 'feedback-submit-btn':
            this.submitFeedback();
            break;
          // Smart ADS Search buttons
          case 'drawer-add-search-btn':
            this.showSmartSearchModal();
            break;
          case 'search-refresh-btn':
            this.refreshSmartSearch();
            break;
          case 'search-edit-btn':
            if (this.currentSmartSearch) {
              this.showSmartSearchModal(this.currentSmartSearch);
            }
            break;
          case 'smart-search-close-btn':
            this.exitSmartSearchView();
            this.setView('all');
            break;
          case 'smart-search-cancel-btn':
            this.hideSmartSearchModal();
            break;
          case 'smart-search-save-btn':
            this.saveSmartSearch();
            break;
        }
      }

      // Handle toggle-password buttons (iOS compatibility)
      const togglePwdBtn = target.closest('.toggle-password');
      if (togglePwdBtn && togglePwdBtn.dataset.target) {
        this.togglePasswordVisibility(togglePwdBtn.dataset.target);
      }

      // Handle tab buttons
      const tabBtn = target.closest('.tab-btn');
      if (tabBtn && tabBtn.dataset.tab) {
        this.switchTab(tabBtn.dataset.tab);
      }

      // Handle provider tabs in AI settings modal (iOS compatibility)
      const providerTab = target.closest('.provider-tab');
      if (providerTab && providerTab.dataset.provider) {
        this.switchProviderTab(providerTab.dataset.provider);
      }

      // Handle ADS shortcut buttons (iOS compatibility)
      const shortcutBtn = target.closest('.ads-shortcut-btn');
      if (shortcutBtn && shortcutBtn.dataset.insert) {
        const insertText = shortcutBtn.dataset.insert;
        // Determine which input to use based on which modal is open
        const adsModal = document.getElementById('ads-search-modal');
        const lookupModal = document.getElementById('ads-lookup-modal');
        const smartSearchModal = document.getElementById('smart-search-modal');

        let input;
        if (adsModal && !adsModal.classList.contains('hidden')) {
          input = document.getElementById('ads-query-input');
        } else if (lookupModal && !lookupModal.classList.contains('hidden')) {
          input = document.getElementById('ads-lookup-query');
        } else if (smartSearchModal && !smartSearchModal.classList.contains('hidden')) {
          input = document.getElementById('smart-search-query');
        }

        if (input) {
          const start = input.selectionStart || input.value.length;
          const end = input.selectionEnd || input.value.length;
          input.value = input.value.substring(0, start) + insertText + input.value.substring(end);
          input.focus();
          input.selectionStart = input.selectionEnd = start + insertText.length;
        }
      }

      // ===== Library Tab Event Handlers =====

      // Library item click - switch library (but not if clicking delete button)
      const libraryItem = target.closest('.library-item');
      if (libraryItem && !target.closest('.library-delete-btn')) {
        const libraryId = libraryItem.dataset.libraryId;
        if (libraryId) {
          this.switchToLibrary(libraryId).then(() => {
            this.switchTab(this.previousTab || 'pdf');
          });
        }
        return;
      }

      // Library delete button click
      if (target.closest('.library-delete-btn')) {
        const libraryItem = target.closest('.library-item');
        const libraryId = libraryItem?.dataset.libraryId;
        if (libraryId) {
          this.confirmDeleteLibrary(libraryId).then(() => {
            this.renderLibrariesTab();
          });
        }
        return;
      }

      // Collection item click in Library tab - filter and switch back (but not if clicking delete button)
      const collectionItemInTab = target.closest('#tab-collections-list .collection-item');
      if (collectionItemInTab && !target.closest('.collection-delete-btn')) {
        const collectionId = collectionItemInTab.dataset.collectionId;
        // collectionId is empty string for "All Papers", or a number for collections
        const id = collectionId ? parseInt(collectionId) : null;
        this.selectCollection(id).then(() => {
          this.renderCollectionsTab(); // Update active state
          this.switchTab(this.previousTab || 'pdf');
        });
        return;
      }

      // Collection delete button click in Library tab
      if (target.closest('#tab-collections-list .collection-delete-btn')) {
        const collectionItem = target.closest('.collection-item');
        const collectionId = collectionItem?.dataset.collectionId;
        if (collectionId) {
          this.deleteCollection(parseInt(collectionId)).then(() => {
            this.renderCollectionsTab();
          });
        }
        return;
      }

      // New iCloud library button
      if (target.id === 'new-icloud-lib-btn' || target.closest('#new-icloud-lib-btn')) {
        this.createNewLibrary('icloud').then(() => {
          this.renderLibrariesTab();
        });
        return;
      }

      // New local library button
      if (target.id === 'new-local-lib-btn' || target.closest('#new-local-lib-btn')) {
        this.createNewLibrary('local').then(() => {
          this.renderLibrariesTab();
        });
        return;
      }

      // New collection button
      if (target.id === 'new-collection-btn' || target.closest('#new-collection-btn')) {
        this.showCollectionModal();
        return;
      }

      // Export library button
      if (target.id === 'export-lib-btn' || target.closest('#export-lib-btn')) {
        this.showExportModal();
        return;
      }

      // Import library button
      if (target.id === 'import-lib-btn' || target.closest('#import-lib-btn')) {
        this.showImportModal();
        return;
      }
    });

    // Console starts expanded by default

    // Console panel resize
    this.setupConsoleResize();

    // Listen for console messages from main process
    window.electronAPI.onConsoleLog((data) => {
      this.consoleLog(data.message, data.type || 'info', data.details || null);
    });

    // Listen for feedback modal request from menu
    if (window.electronAPI.onShowFeedbackModal) {
      window.electronAPI.onShowFeedbackModal(() => {
        this.showFeedbackModal();
      });
    }

    // Search input (needs direct listener for 'input' event, not handled by click delegation)
    const searchInput = document.getElementById('search-input');
    let searchTimeout;
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => this.searchPapers(e.target.value), 300);
      });
    }

    // Paper actions
    document.getElementById('paper-rating-select')?.addEventListener('change', (e) => {
      if (this.selectedPaper) {
        this.updatePaperRating(this.selectedPaper.id, parseInt(e.target.value));
      }
    });

    // Mobile rating select (in tab bar)
    document.getElementById('mobile-rating-select')?.addEventListener('change', (e) => {
      if (this.selectedPaper) {
        const rating = parseInt(e.target.value);
        this.updatePaperRating(this.selectedPaper.id, rating);
        // Sync with desktop rating select
        document.getElementById('paper-rating-select').value = rating;
      }
    });

    document.getElementById('fetch-metadata-btn')?.addEventListener('click', () => this.fetchMetadata());
    document.getElementById('copy-cite-btn')?.addEventListener('click', () => this.copyCite());
    document.getElementById('open-ads-btn')?.addEventListener('click', () => this.openInADS());
    document.getElementById('attach-file-btn')?.addEventListener('click', () => this.attachFiles());
    // Files Panel attach button (in BibTeX tab)
    document.getElementById('files-attach-btn')?.addEventListener('click', () => this.attachFiles());
    document.getElementById('copy-bibtex-btn')?.addEventListener('click', () => this.copyBibtex());
    document.getElementById('export-bibtex-btn')?.addEventListener('click', () => this.exportBibtexToFile());
    document.getElementById('edit-bibtex-btn')?.addEventListener('click', () => this.enterBibtexEditMode());
    document.getElementById('save-bibtex-btn')?.addEventListener('click', () => this.saveBibtex());
    document.getElementById('cancel-bibtex-btn')?.addEventListener('click', () => this.exitBibtexEditMode(true));

    // Shortcuts toggle
    document.getElementById('shortcuts-toggle')?.addEventListener('click', () => this.toggleShortcuts());

    // PDF controls
    document.getElementById('zoom-in-btn')?.addEventListener('click', () => this.zoomPDF(0.1));
    document.getElementById('zoom-out-btn')?.addEventListener('click', () => this.zoomPDF(-0.1));
    document.getElementById('rotate-btn')?.addEventListener('click', () => this.rotatePage());

    // Pinch-to-zoom support for trackpads - optimized with CSS transforms
    const pdfContainer = document.getElementById('pdf-container');
    if (pdfContainer) {
      let trackpadPinchScale = 1;
      let trackpadPinchTimer = null;
      let initialPdfScale = this.pdfScale || 1;
      let zoomCenterX = 0;  // Cursor X relative to container
      let zoomCenterY = 0;  // Cursor Y relative to container (not including scroll)
      let docPointX = 0;    // Document X position under cursor at start
      let docPointY = 0;    // Document Y position under cursor at start (including scroll)

      pdfContainer.addEventListener('wheel', (e) => {
        // Detect pinch gesture (ctrlKey is set for trackpad pinch)
        if (e.ctrlKey) {
          e.preventDefault();

          const containerRect = pdfContainer.getBoundingClientRect();

          // If starting a new pinch gesture, capture initial state
          if (!trackpadPinchTimer) {
            initialPdfScale = this.pdfScale || 1;
            trackpadPinchScale = 1;
            // Store cursor position in container (viewport) coordinates
            zoomCenterX = e.clientX - containerRect.left;
            zoomCenterY = e.clientY - containerRect.top;
            // Store document position under cursor (includes scroll)
            docPointX = zoomCenterX;
            docPointY = zoomCenterY + pdfContainer.scrollTop;
          }

          // Update visual scale (reduced sensitivity for smoother zooming)
          const delta = e.deltaY > 0 ? -0.015 : 0.015;
          trackpadPinchScale = Math.max(0.5 / initialPdfScale, Math.min(3 / initialPdfScale, trackpadPinchScale + delta));

          // Apply CSS transform centered on the cursor position
          // Use transform-origin at cursor point relative to each page
          const pdfPages = pdfContainer.querySelectorAll('.pdf-page-wrapper');
          pdfPages.forEach(page => {
            // Use center transform and adjust scroll instead
            page.style.transformOrigin = 'center top';
            page.style.transform = `scale(${trackpadPinchScale})`;
          });

          // Adjust scroll to keep cursor point fixed during visual transform
          const scaledDocY = docPointY * trackpadPinchScale;
          pdfContainer.scrollTop = scaledDocY - zoomCenterY;

          // Debounce the actual re-render
          if (trackpadPinchTimer) {
            clearTimeout(trackpadPinchTimer);
          }
          trackpadPinchTimer = setTimeout(async () => {
            // Calculate the document position at cursor point (at original scale)
            const pdfPages = pdfContainer.querySelectorAll('.pdf-page-wrapper');

            // Reset CSS transforms
            pdfPages.forEach(page => {
              page.style.transform = '';
              page.style.transformOrigin = '';
            });

            // Apply actual zoom if changed significantly
            const newScale = Math.max(0.5, Math.min(3, initialPdfScale * trackpadPinchScale));
            if (Math.abs(newScale - (this.pdfScale || 1)) > 0.02) {
              const scaleRatio = newScale / initialPdfScale;
              this.pdfScale = newScale;

              // Render pages first
              await this.renderAllPages();

              // After re-render, scroll so the same document point is under cursor
              // Document position scales with the zoom ratio
              const newDocY = docPointY * scaleRatio;
              pdfContainer.scrollTop = newDocY - zoomCenterY;

              window.electronAPI.setPdfZoom(this.pdfScale);
              document.getElementById('zoom-level').textContent = `${Math.round(this.pdfScale * 100)}%`;
            }

            trackpadPinchTimer = null;
            trackpadPinchScale = 1;
          }, 150); // Wait 150ms after last wheel event
        }
      }, { passive: false });
    }

    // Settings section toggle
    document.getElementById('settings-header')?.addEventListener('click', () => this.toggleSettings());

    // ADS settings - Inline expandable
    document.getElementById('ads-settings-btn')?.addEventListener('click', () => this.toggleInlineSettings('ads'));
    document.getElementById('ads-token-save-inline')?.addEventListener('click', () => this.saveAdsTokenInline());
    document.getElementById('ads-token-help-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      window.electronAPI.openExternal('https://ui.adsabs.harvard.edu/user/settings/token');
    });
    // Keep modal handlers for backward compatibility
    document.getElementById('ads-cancel-btn')?.addEventListener('click', () => this.hideAdsTokenModal());
    document.getElementById('ads-save-btn')?.addEventListener('click', () => this.saveAdsToken());

    // Library Proxy settings - Inline expandable
    document.getElementById('library-proxy-btn')?.addEventListener('click', () => this.toggleInlineSettings('proxy'));
    document.getElementById('proxy-save-inline')?.addEventListener('click', () => this.saveProxyInline());
    // Keep modal handlers for backward compatibility
    document.getElementById('proxy-cancel-btn')?.addEventListener('click', () => this.hideLibraryProxyModal());
    document.getElementById('proxy-save-btn')?.addEventListener('click', () => this.saveLibraryProxy());

    // Preferences modal removed - using defaults
    document.getElementById('ads-token-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      window.electronAPI.openExternal('https://ui.adsabs.harvard.edu/user/settings/token');
    });

    // Collections
    document.getElementById('add-collection-btn')?.addEventListener('click', () => this.showCollectionModal());
    document.getElementById('collection-cancel-btn')?.addEventListener('click', () => this.hideCollectionModal());
    document.getElementById('collection-save-btn')?.addEventListener('click', () => this.createCollection());

    // Preferences modal
    document.getElementById('preferences-cancel-btn')?.addEventListener('click', () => this.hidePreferencesModal());
    document.getElementById('preferences-save-btn')?.addEventListener('click', () => this.savePreferences());

    // Smart collection type toggle
    document.querySelectorAll('input[name="collection-type"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const smartOptions = document.getElementById('smart-collection-options');
        if (e.target.value === 'smart') {
          smartOptions?.classList.remove('hidden');
        } else {
          smartOptions?.classList.add('hidden');
        }
      });
    });

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
      const handleShortcut = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const searchInput = document.getElementById('search-input');
        const insertText = btn.dataset.insert;
        const currentValue = searchInput.value || '';

        // On iOS, selectionStart may not be reliable - just append to end of current value
        // Add a space before if there's existing content that doesn't end with a space
        let newValue = currentValue;
        if (currentValue.length > 0 && !currentValue.endsWith(' ')) {
          newValue += ' ';
        }
        newValue += insertText;

        searchInput.value = newValue;
        searchInput.focus();

        // Try to position cursor at the end
        try {
          const newPos = newValue.length;
          searchInput.setSelectionRange(newPos, newPos);
        } catch (e) {
          // Ignore if setSelectionRange fails on some browsers
        }
      };

      // Use both click and touchend for better iOS support
      btn.addEventListener('click', handleShortcut);
      btn.addEventListener('touchend', handleShortcut);
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

    // ADS Sync button (in tab bar)
    document.getElementById('sync-tab-btn')?.addEventListener('click', () => this.startAdsSync());
    document.getElementById('sync-close-btn')?.addEventListener('click', () => this.hideAdsSyncModal());
    document.getElementById('ads-sync-close-btn')?.addEventListener('click', () => this.hideAdsSyncModal());
    document.getElementById('sync-cancel-btn')?.addEventListener('click', () => this.cancelAdsSync());

    // Mobile action buttons (in tab bar)
    document.getElementById('download-tab-btn')?.addEventListener('click', async () => {
      const papers = this.getSelectedOrCurrentPapers();
      if (papers.length === 0) {
        this.showNotification('Select a paper first', 'warn');
        return;
      }
      this.showDownloadActionSheet(papers);
    });
    document.getElementById('attach-tab-btn')?.addEventListener('click', () => this.attachFiles());
    document.getElementById('cite-tab-btn')?.addEventListener('click', () => this.copyCite());
    document.getElementById('ads-tab-btn')?.addEventListener('click', () => this.openInADS());

    // Download PDF button and dropdown - dynamically populated from ADS sources
    const downloadBtn = document.getElementById('download-pdf-btn');
    const downloadMenu = document.getElementById('download-pdf-menu');
    if (downloadBtn && downloadMenu) {
      downloadBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const wasHidden = downloadMenu.classList.contains('hidden');
        downloadMenu.classList.toggle('hidden');
        if (wasHidden) {
          // Populate with available sources when opening
          const papers = this.getSelectedOrCurrentPapers();
          await this.populateDownloadMenu(downloadMenu, papers);
        }
      });

      // Close dropdown when clicking outside
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.download-pdf-dropdown')) {
          downloadMenu.classList.add('hidden');
        }
      });
    }

    // ADS shortcut buttons are handled by the delegated click handler (lines ~1270-1292)
    // for iOS compatibility - no duplicate listeners needed here

    // ADS import progress listeners
    window.electronAPI.onImportProgress((data) => this.updateImportProgress(data));
    window.electronAPI.onImportComplete((data) => this.handleImportComplete(data));

    // Refs/Cites selection controls
    document.getElementById('refs-select-all')?.addEventListener('click', () => this.selectAllRefs());
    document.getElementById('cites-select-all')?.addEventListener('click', () => this.selectAllCites());

    // Refs/Cites limit controls
    // References - always fetch all (no limit dialog)
    document.getElementById('refs-load-all')?.addEventListener('click', () => this.fetchRefsFromADS());
    document.getElementById('cites-load-more')?.addEventListener('click', () => this.fetchCitesFromADS());
    document.getElementById('cites-load-all')?.addEventListener('click', () => this.fetchCitesFromADS(2000));

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
    document.getElementById('ctx-download-pdfs')?.addEventListener('click', () => this.batchDownloadPdfs());
    document.getElementById('ctx-export-book')?.addEventListener('click', () => {
      this.hideContextMenu();
      this.showExportBookModal();
    });
    document.getElementById('ctx-add-to-library')?.addEventListener('click', () => {
      this.hideContextMenu();
      this.addSelectedPapersToLibrary();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => this.handleKeydown(e));

    // Paste bibcode to search ADS
    document.addEventListener('paste', (e) => this.handlePaste(e));

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

    // Provider tabs in AI settings modal
    document.querySelectorAll('.provider-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchProviderTab(tab.dataset.provider));
    });

    // Provider test buttons
    document.getElementById('ollama-test-btn')?.addEventListener('click', () => this.testProvider('ollama'));
    document.getElementById('anthropic-test-btn')?.addEventListener('click', () => this.testProvider('anthropic'));
    document.getElementById('gemini-test-btn')?.addEventListener('click', () => this.testProvider('gemini'));
    document.getElementById('perplexity-test-btn')?.addEventListener('click', () => this.testProvider('perplexity'));

    // Toggle password visibility
    document.querySelectorAll('.toggle-password').forEach(btn => {
      btn.addEventListener('click', () => this.togglePasswordVisibility(btn.dataset.target));
    });

    // Reset summary prompt button
    document.getElementById('reset-summary-prompt-btn')?.addEventListener('click', () => this.resetSummaryPrompt());

    // External links in settings
    document.querySelectorAll('.external-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        window.electronAPI.openExternal(link.dataset.url);
      });
    });

    // Copy buttons
    document.getElementById('ai-copy-summary-btn')?.addEventListener('click', () => this.copySummaryToClipboard());
    document.getElementById('ai-copy-qa-btn')?.addEventListener('click', () => this.copyLastAnswerToClipboard());

    // Semantic Search info popup
    document.getElementById('semantic-search-info-btn')?.addEventListener('click', () => this.showSemanticSearchInfo());
    document.getElementById('semantic-search-info-close')?.addEventListener('click', () => this.hideSemanticSearchInfo());

    // LLM stream listener
    window.electronAPI.onLlmStream((data) => this.handleLlmStream(data));

    // Text selection and anchor placement for AI explain and notes
    pdfContainer?.addEventListener('mousedown', (e) => this.handlePdfMouseDown(e));
    pdfContainer?.addEventListener('mouseup', (e) => this.handlePdfMouseUp(e));
    document.getElementById('ctx-explain-text')?.addEventListener('click', () => this.explainSelectedText());
    document.getElementById('ctx-copy-text')?.addEventListener('click', () => this.copySelectedText());
    document.getElementById('ai-explanation-close')?.addEventListener('click', () => this.hideExplanationPopup());
    document.getElementById('ai-explanation-add-note')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.addExplanationAsNote();
    });

    // Make AI explanation popup draggable
    this.setupExplanationPopupDrag();

    // Semantic search
    document.getElementById('ai-index-paper-btn')?.addEventListener('click', () => this.indexCurrentPaper());
    document.getElementById('ai-search-btn')?.addEventListener('click', () => this.semanticSearch());
    document.getElementById('ai-search-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.semanticSearch();
    });

    // Annotations
    document.getElementById('add-note-btn')?.addEventListener('click', () => this.createGeneralNote());
    document.getElementById('ctx-add-note')?.addEventListener('click', () => this.createNoteFromSelection());
    document.getElementById('export-annotations-btn')?.addEventListener('click', () => this.exportAnnotations());

    // Panel collapse toggles
    document.getElementById('sidebar-collapse-btn')?.addEventListener('click', () => this.toggleSidebar());
    document.getElementById('sidebar-collapsed-toggle')?.addEventListener('click', () => this.toggleSidebar());
    document.getElementById('notes-collapse-btn')?.addEventListener('click', () => this.toggleNotesPanel());
    document.getElementById('notes-collapsed-toggle')?.addEventListener('click', () => this.toggleNotesPanel());

    // Focus Notes Mode (desktop only)
    document.getElementById('focus-notes-btn')?.addEventListener('click', () => this.enterFocusNotesMode());
    document.getElementById('focus-exit-btn')?.addEventListener('click', () => this.exitFocusNotesMode());
    // Removed: focus-add-note-btn event listener (button removed from UI)

    // Resize handles
    this.setupResizeHandlers();

    // Export/Import Library Modals
    document.getElementById('export-close-btn')?.addEventListener('click', () => this.hideExportModal());
    document.getElementById('export-cancel-btn')?.addEventListener('click', () => this.hideExportModal());
    document.getElementById('export-save-btn')?.addEventListener('click', () => this.handleExport());
    document.getElementById('export-share-btn')?.addEventListener('click', () => this.handleExportAndShare());
    document.getElementById('import-close-btn')?.addEventListener('click', () => this.hideImportModal());
    document.getElementById('import-cancel-btn')?.addEventListener('click', () => this.hideImportModal());
    document.getElementById('import-select-btn')?.addEventListener('click', () => this.selectImportFile());
    document.getElementById('import-confirm-btn')?.addEventListener('click', () => this.handleImport());

    // Export Book modal
    document.getElementById('export-book-close-btn')?.addEventListener('click', () => this.hideExportBookModal());
    document.getElementById('export-book-cancel-btn')?.addEventListener('click', () => this.hideExportBookModal());
    document.getElementById('export-book-save-btn')?.addEventListener('click', () => this.handleExportBook(false));
    document.getElementById('export-book-share-btn')?.addEventListener('click', () => this.handleExportBook(true));

    // Export/import progress listeners
    window.electronAPI.onExportProgress?.((data) => this.updateExportProgress(data));
    window.electronAPI.onLibraryImportProgress?.((data) => this.updateLibraryImportProgress(data));

    // Menu-triggered export/import modals
    window.electronAPI.onShowExportModal?.(() => this.showExportModal());
    window.electronAPI.onShowImportModal?.(() => this.showImportModal());
    window.electronAPI.onShowExportBookModal?.(() => this.showExportBookModal());

    // Window-wide BibTeX file drop handler
    document.body.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    document.body.addEventListener('drop', async (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      const bibFile = files.find(f => f.name.endsWith('.bib'));
      if (bibFile) {
        e.preventDefault();
        e.stopPropagation();
        const filePath = window.electronAPI.getPathForFile(bibFile);
        if (filePath) {
          this.showNotification(`Importing ${bibFile.name}...`, 'info');
          try {
            const result = await window.electronAPI.importBibtexFromPath(filePath);
            if (result.success) {
              this.showNotification(`Imported ${result.imported} papers, ${result.skipped} skipped`, 'success');
              await this.loadPapers();
            } else {
              this.showNotification(`Import failed: ${result.error}`, 'error');
            }
          } catch (error) {
            this.showNotification(`Import failed: ${error.message}`, 'error');
          }
        }
      }
    });
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

    // Setup sort dropdown in toolbar
    this.setupMobileSortMenu();

    // Setup filter select in toolbar
    this.setupFilterSelect();
    this.updateFilterSelect();

    // Setup AI section resize handles
    this.setupAISectionResize();
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
          // Parse first author to get lastname, firstname
          const parseAuthor = (authors) => {
            const author = authors?.[0] || '';
            // ADS format is usually "Lastname, Firstname"
            if (author.includes(',')) {
              const parts = author.split(',');
              return {
                lastname: (parts[0] || '').trim().toLowerCase(),
                firstname: (parts[1] || '').trim().toLowerCase()
              };
            }
            // Fallback: "Firstname Lastname" - last word is lastname
            const words = author.trim().split(/\s+/);
            if (words.length > 1) {
              return {
                lastname: words[words.length - 1].toLowerCase(),
                firstname: words.slice(0, -1).join(' ').toLowerCase()
              };
            }
            return { lastname: author.toLowerCase(), firstname: '' };
          };
          const authorA = parseAuthor(a.authors);
          const authorB = parseAuthor(b.authors);
          // Compare lastname first
          if (authorA.lastname !== authorB.lastname) {
            valA = authorA.lastname;
            valB = authorB.lastname;
          } else if (authorA.firstname !== authorB.firstname) {
            // Same lastname, compare firstname
            valA = authorA.firstname;
            valB = authorB.firstname;
          } else {
            // Same author, sort by year
            valA = parseInt(a.year) || 0;
            valB = parseInt(b.year) || 0;
          }
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

    // Handle Cmd+Option shortcuts first
    if ((e.metaKey || e.ctrlKey) && e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'i':
          // Cmd+Option+I opens DevTools (handled by Electron, just for documentation)
          return;
      }
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
      case '0':
        if (this.selectedPaper) {
          this.updatePaperRating(this.selectedPaper.id, 0); // Clear rating
        }
        break;
      case 'm':
        e.preventDefault();
        this.toggleMobileDrawer();
        break;
      case 'n':
      case 'N':
        e.preventDefault();
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
          // Cmd+Shift+N: Toggle Focus Notes Mode
          if (this.isFocusNotesMode) {
            this.exitFocusNotesMode();
          } else {
            this.enterFocusNotesMode();
          }
        } else {
          this.toggleNotesPanel();
        }
        break;
      case 'a':
        if (e.metaKey || e.ctrlKey) {
          // Cmd+A: Select all papers
          e.preventDefault();
          this.selectAllPapers();
        } else if (this.currentSmartSearch && this.selectedPapers.size > 0) {
          // 'a' adds selected papers to library (from smart search)
          this.addSelectedPapersToLibrary();
        }
        break;
      case 'w':
        // 'w' opens in ADS (web)
        if (this.selectedPaper) {
          this.openInADS();
        }
        break;
      case 'f':
        // 'f' toggles focus mode for PDF reading
        if (this.selectedPaper) {
          if (this.isFocusNotesMode) {
            this.exitFocusNotesMode();
          } else {
            this.enterFocusNotesMode();
          }
        }
        break;
      case '+':
      case '=':
        this.zoomPDF(0.1);
        break;
      case '-':
        this.zoomPDF(-0.1);
        break;
      case 'r':
        if (!e.metaKey && !e.ctrlKey) {
          this.rotatePage();
        }
        break;
      case 's':
        if (this.selectedPapers.size > 0) {
          this.syncSelectedPapers();
        }
        break;
      case 'p':
        // Switch to PDF tab
        if (this.selectedPaper?.pdf_path) {
          this.switchTab('pdf');
        }
        break;
      case 'P':
        // Open PDF with system viewer (Shift+P)
        this.openPdfWithSystemViewer();
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
      case 'Escape':
        // Exit focus notes mode or PDF fullscreen
        if (this.isFocusNotesMode) {
          this.exitFocusNotesMode();
        } else if (this.isPdfFullscreen) {
          this.exitPdfFullscreen();
        }
        break;
    }
  }

  // Handle paste event to detect bibcodes
  handlePaste(e) {
    // Only handle paste when not in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }

    const text = e.clipboardData?.getData('text')?.trim();
    if (!text) return;

    // Check if it looks like a bibcode or list of bibcodes
    const bibcodes = this.extractBibcodes(text);
    if (bibcodes.length > 0) {
      e.preventDefault();
      this.searchBibcodes(bibcodes);
    }
  }

  // Extract bibcodes from text
  extractBibcodes(text) {
    // Bibcode pattern: year (4 digits) + journal code + volume/page + author initial
    // Examples: 2024ApJ...123..456A, 2020MNRAS.500.1234B, 2011A&A...527A.126P
    const bibcodePattern = /\b(\d{4}[A-Za-z&.]{2,9}\.{0,3}\d{0,5}[A-Za-z]?\.{0,2}\d+[A-Za-z]?\.?\.?\d*[A-Za-z.]*)\b/g;
    const matches = text.match(bibcodePattern) || [];
    // Filter to ensure they look like real bibcodes (at least 13 chars, contain dots)
    const filtered = matches.filter(m => m.length >= 13 && m.includes('.'));
    return [...new Set(filtered)]; // Remove duplicates
  }

  // Search ADS for bibcodes
  async searchBibcodes(bibcodes) {
    // Check for ADS token
    const token = await window.electronAPI.getAdsToken();
    if (!token) {
      this.showNotification('Please configure your ADS API token first', 'error');
      return;
    }

    // Show ADS search modal with bibcode query
    this.showAdsSearchModal();

    // Build query: bibcode:"X" OR bibcode:"Y"
    const query = bibcodes.map(b => `bibcode:"${b}"`).join(' OR ');
    document.getElementById('ads-query-input').value = query;

    // Execute the search automatically
    await this.executeAdsSearch();
  }

  showSetupScreen() {
    document.getElementById('loading-screen')?.classList.add('hidden');
    document.getElementById('setup-screen').classList.remove('hidden');
    document.getElementById('main-screen').classList.add('hidden');

    // Hide splash screen now that UI is ready
    this.hideSplashScreen();

    console.log('[ADSReader] showSetupScreen called, isIOS:', this.isIOS);

    // Check for existing libraries and show picker if any exist
    setTimeout(async () => {
      try {
        const libraries = await window.electronAPI.getAllLibraries();
        console.log('[ADSReader] Found libraries:', libraries.length);

        if (libraries.length > 0) {
          // Show library picker with existing libraries
          if (this.isIOS) {
            this.selectOrCreateIOSLibrary();
          } else {
            this.showDesktopLibraryPicker(libraries);
          }
        } else if (this.isIOS) {
          // No libraries - show create screen for iOS
          this.selectOrCreateIOSLibrary();
        }
        // For desktop with no libraries, the default setup screen buttons are fine
      } catch (e) {
        console.log('[ADSReader] Error checking libraries:', e);
        if (this.isIOS) {
          this.selectOrCreateIOSLibrary();
        }
      }
    }, 100);
  }

  showDesktopLibraryPicker(libraries) {
    const setupContainer = document.querySelector('.setup-container');
    if (!setupContainer) return;

    let html = `
      <div class="setup-icon">📚</div>
      <h1>Choose Library</h1>
      <p class="setup-subtitle">Select an existing library or create a new one</p>

      <div class="ios-library-list" style="margin-top: 24px;">
    `;

    for (const lib of libraries) {
      const icon = lib.location === 'icloud' ? '☁️' : '💻';
      const locationLabel = lib.location === 'icloud' ? 'iCloud' : 'Local';
      const paperCount = lib.paperCount || 0;
      const paperLabel = paperCount === 1 ? '1 paper' : `${paperCount} papers`;
      html += `
        <div class="ios-library-item" data-id="${lib.id}" style="display: flex; align-items: center; padding: 12px; margin: 8px 0; background: var(--bg-secondary); border-radius: 8px; cursor: pointer;">
          <span style="font-size: 24px; margin-right: 12px;">${icon}</span>
          <div style="flex: 1;">
            <div style="font-weight: 500;">${this.escapeHtml(lib.name)} <span style="font-weight: normal; color: var(--text-secondary);">(${paperLabel})</span></div>
            <div style="font-size: 12px; color: var(--text-secondary);">${locationLabel}</div>
          </div>
        </div>
      `;
    }

    html += `
      </div>
      <div style="margin-top: 24px; display: flex; gap: 12px; justify-content: center;">
        <button id="desktop-create-icloud-btn" class="primary-button">
          Create iCloud Library
        </button>
        <button id="desktop-create-local-btn" class="secondary-button">
          Create Local Library
        </button>
      </div>
    `;

    setupContainer.innerHTML = html;

    // Add click handlers for existing libraries
    setupContainer.querySelectorAll('.ios-library-item').forEach(item => {
      item.addEventListener('click', () => this.switchToLibrary(item.dataset.id));
    });

    // Add click handlers for create buttons
    document.getElementById('desktop-create-icloud-btn')?.addEventListener('click', () => {
      this.createDesktopLibrary('icloud');
    });
    document.getElementById('desktop-create-local-btn')?.addEventListener('click', () => {
      this.createDesktopLibrary('local');
    });
  }

  async createDesktopLibrary(location) {
    const name = prompt('Enter library name:', 'My Library');
    if (!name) return;

    try {
      const result = await window.electronAPI.createLibrary({ name, location });
      if (result.success) {
        await this.switchToLibrary(result.id);
        this.showMainScreen({ path: result.path, name });
      } else {
        alert(`Failed to create library: ${result.error}`);
      }
    } catch (error) {
      alert(`Error creating library: ${error.message}`);
    }
  }

  showMainScreen(info) {
    document.getElementById('loading-screen')?.classList.add('hidden');
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');
    this.updateLibraryDisplay(info);

    // Hide splash screen now that UI is ready
    this.hideSplashScreen();
  }

  // Update loading screen text
  updateLoadingText(text) {
    const loadingText = document.querySelector('.loading-text');
    if (loadingText) {
      loadingText.textContent = text;
    }
  }

  // Hide the native splash screen (Capacitor)
  hideSplashScreen() {
    if (this._splashHidden) return; // Only hide once
    this._splashHidden = true;

    if (window.Capacitor) {
      import('@capacitor/splash-screen').then(({ SplashScreen }) => {
        SplashScreen.hide();
        console.log('[ADSReader] Splash screen hidden');
      }).catch(err => {
        console.log('[ADSReader] SplashScreen not available:', err.message);
      });
    }
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
        // Show main screen after library creation
        this.showMainScreen({ path: result.path, name });
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
    console.log('[showIOSLibraryPicker] Called with', libraries.length, 'libraries');
    // Update setup screen to show library selection
    const setupContainer = document.querySelector('.setup-container');
    if (!setupContainer) {
      console.error('[showIOSLibraryPicker] No setup container found');
      return;
    }

    let html = `
      <div class="setup-icon">📚</div>
      <h1>Choose Library</h1>
      <p class="setup-subtitle">Select an existing library or create a new one</p>

      <div class="ios-library-list">
    `;

    for (const lib of libraries) {
      const icon = lib.location === 'icloud' ? '☁️' : '💻';
      html += `
        <button class="ios-library-item" data-id="${lib.id}" onclick="window.app.handleLibraryClick('${lib.id}', '${this.escapeHtml(lib.name).replace(/'/g, "\\'")}')">
          <span class="lib-icon">${icon}</span>
          <div class="lib-info">
            <span class="lib-name">${this.escapeHtml(lib.name)}</span>
            <span class="lib-location">${lib.location === 'icloud' ? 'iCloud' : 'Local'}</span>
          </div>
          <span class="ios-library-delete-btn" data-id="${lib.id}" data-name="${this.escapeHtml(lib.name)}" onclick="event.stopPropagation(); window.app.handleLibraryDelete('${lib.id}', '${this.escapeHtml(lib.name).replace(/'/g, "\\'")}')">
            🗑️
          </span>
        </button>
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

    // Note: Library items use inline onclick handlers for iOS compatibility
    // Only set up the Create button handler
    document.getElementById('ios-new-library-btn')?.addEventListener('click', () => {
      console.log('[showIOSLibraryPicker] Create new library clicked');
      this.createIOSLibrary();
    });

    console.log('[showIOSLibraryPicker] Setup complete, using inline onclick handlers');
  }

  // Handler methods for inline onclick (iOS compatibility)
  async handleLibraryClick(libId, libName) {
    console.log('[handleLibraryClick] Called with:', libId, libName);
    try {
      await this.switchToLibrary(libId);
      console.log('[handleLibraryClick] switchToLibrary completed successfully');
    } catch (error) {
      console.error('[handleLibraryClick] Error:', error);
      alert('Failed to switch library: ' + error.message);
    }
  }

  async handleLibraryDelete(libId, libName) {
    console.log('[handleLibraryDelete] Called with:', libId, libName);
    await this.confirmDeleteIOSLibrary(libId, libName);
  }

  async confirmDeleteIOSLibrary(libraryId, libraryName) {
    // Show confirmation dialog
    const confirmed = confirm(
      `Delete library "${libraryName}"?\n\n` +
      `This will permanently delete the library and all its papers, PDFs, and annotations.\n\n` +
      `This action cannot be undone.`
    );

    if (!confirmed) return;

    // Double-confirm for safety
    const doubleConfirm = confirm(
      `Are you sure? Type "delete" in the next prompt to confirm deletion of "${libraryName}".`
    );

    if (!doubleConfirm) return;

    const typed = prompt('Type "delete" to confirm:');
    if (typed?.toLowerCase() !== 'delete') {
      alert('Deletion cancelled.');
      return;
    }

    try {
      const result = await window.electronAPI.deleteLibrary({
        libraryId,
        deleteFiles: true
      });

      if (result.success) {
        alert(`Library "${libraryName}" has been deleted.`);
        // Refresh the library picker
        await this.selectOrCreateIOSLibrary();
      } else {
        alert(`Failed to delete library: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to delete library:', error);
      alert(`Error deleting library: ${error.message}`);
    }
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
    this.renderFilterCollections();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SMART ADS SEARCHES
  // ═══════════════════════════════════════════════════════════════════════════

  async loadSmartSearches() {
    if (!window.electronAPI?.smartSearchList) return;
    this.smartSearches = await window.electronAPI.smartSearchList();
    this.renderSmartSearchesList();
  }

  renderSmartSearchesList() {
    const listEl = document.getElementById('drawer-searches-list');
    if (!listEl) return;

    if (this.smartSearches.length === 0) {
      listEl.innerHTML = '<div class="drawer-placeholder">No saved searches</div>';
      return;
    }

    listEl.innerHTML = this.smartSearches.map(search => `
      <div class="drawer-search-item${this.currentSmartSearch === search.id ? ' active' : ''}"
           data-search-id="${search.id}">
        <span class="search-icon">🔍</span>
        <span class="search-name">${this.escapeHtml(search.name)}</span>
        <span class="search-count">${search.result_count || '—'}</span>
        <button class="search-delete-btn" data-delete-search="${search.id}" title="Delete search">✕</button>
      </div>
    `).join('');

    // Attach click handlers
    listEl.querySelectorAll('.drawer-search-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // Don't select if clicking delete button
        if (e.target.classList.contains('search-delete-btn')) return;
        this.selectSmartSearch(parseInt(item.dataset.searchId));
        this.closeDrawer();
      });
    });

    // Delete handlers
    listEl.querySelectorAll('.search-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const searchId = parseInt(btn.dataset.deleteSearch);
        const search = this.smartSearches.find(s => s.id === searchId);
        if (search && confirm(`Delete search "${search.name}"?`)) {
          await this.deleteSmartSearch(searchId);
        }
      });
    });
  }

  async selectSmartSearch(searchId) {
    const search = this.smartSearches.find(s => s.id === searchId);
    if (!search) return;

    // Update state
    this.currentSmartSearch = searchId;
    this.currentView = null;
    this.currentCollection = null;

    // Clear selections
    this.selectedPapers.clear();
    this.selectedPaper = null;

    // Update UI
    this.updateNavActiveStates();
    this.renderSmartSearchesList();

    // Show search toolbar
    const toolbar = document.getElementById('smart-search-toolbar');
    if (toolbar) {
      toolbar.classList.remove('hidden');
      document.getElementById('search-toolbar-name').textContent = search.name;
      this.updateSearchToolbarMeta(search);
    }

    // Load cached results
    const result = await window.electronAPI.smartSearchGet(searchId);
    if (result && result.results) {
      // Convert results to paper-like objects for unified rendering
      this.papers = result.results.map(r => ({
        ...r,
        id: r.bibcode, // Use bibcode as ID for ADS papers
        isAdsSearch: true
      }));
      this.sortPapers();
      this.renderPaperList();
    } else {
      // No cached results - show empty state
      this.papers = [];
      this.renderSmartSearchEmptyState(search);
    }
  }

  updateSearchToolbarMeta(search) {
    const metaEl = document.getElementById('search-toolbar-meta');
    if (!metaEl) return;

    let meta = `${search.result_count || 0} results`;
    if (search.last_refresh_date) {
      const refreshDate = new Date(search.last_refresh_date);
      const now = new Date();
      const diffMs = now - refreshDate;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 60) {
        meta += ` • Updated ${diffMins}m ago`;
      } else if (diffHours < 24) {
        meta += ` • Updated ${diffHours}h ago`;
      } else {
        meta += ` • Updated ${diffDays}d ago`;
      }
    }
    metaEl.textContent = meta;
  }

  renderSmartSearchEmptyState(search) {
    const listEl = document.getElementById('paper-list');
    listEl.innerHTML = `
      <div class="smart-search-empty">
        <div class="empty-icon">🔍</div>
        <h3>${search.result_count > 0 ? 'No cached results' : 'Search not yet executed'}</h3>
        <p>Click the refresh button to load results from ADS</p>
        <button class="primary-button" id="refresh-search-empty-btn">Refresh Now</button>
      </div>
    `;
    document.getElementById('refresh-search-empty-btn')?.addEventListener('click', () => {
      this.refreshSmartSearch(search.id);
    });
  }

  async refreshSmartSearch(searchId = null) {
    const id = searchId || this.currentSmartSearch;
    if (!id) return;

    const search = this.smartSearches.find(s => s.id === id);
    if (!search) return;

    // Show loading
    const refreshBtn = document.getElementById('search-refresh-btn');
    refreshBtn?.classList.add('loading');

    try {
      const result = await window.electronAPI.smartSearchRefresh(id);

      if (result.success) {
        // Reload searches list
        await this.loadSmartSearches();

        // If we're viewing this search, reload results
        if (this.currentSmartSearch === id) {
          await this.selectSmartSearch(id);
        }

        this.showNotification(`Refreshed: ${result.resultCount} results`, 'success');
      } else {
        this.showNotification(`Refresh failed: ${result.error}`, 'error');
      }
    } finally {
      refreshBtn?.classList.remove('loading');
    }
  }

  async deleteSmartSearch(searchId) {
    const result = await window.electronAPI.smartSearchDelete(searchId);
    if (result.success) {
      await this.loadSmartSearches();
      // If we were viewing this search, go back to All Papers
      if (this.currentSmartSearch === searchId) {
        this.exitSmartSearchView();
        this.setView('all');
      }
    }
  }

  exitSmartSearchView() {
    this.currentSmartSearch = null;

    // Hide search toolbar
    const toolbar = document.getElementById('smart-search-toolbar');
    toolbar?.classList.add('hidden');

    // Update nav
    this.renderSmartSearchesList();
  }

  showSmartSearchModal(searchId = null) {
    this.editingSearchId = searchId;
    const modal = document.getElementById('smart-search-modal');
    const titleEl = document.getElementById('smart-search-modal-title');
    const nameInput = document.getElementById('smart-search-name');
    const queryInput = document.getElementById('smart-search-query');

    if (searchId) {
      const search = this.smartSearches.find(s => s.id === searchId);
      if (search) {
        titleEl.textContent = 'Edit ADS Search';
        nameInput.value = search.name;
        queryInput.value = search.query;
      }
    } else {
      titleEl.textContent = 'New ADS Search';
      nameInput.value = '';
      queryInput.value = '';
    }

    modal.classList.remove('hidden');
    nameInput.focus();
  }

  hideSmartSearchModal() {
    const modal = document.getElementById('smart-search-modal');
    modal.classList.add('hidden');
    this.editingSearchId = null;
  }

  async saveSmartSearch() {
    const nameInput = document.getElementById('smart-search-name');
    const queryInput = document.getElementById('smart-search-query');

    const name = nameInput.value.trim();
    const query = queryInput.value.trim();

    if (!name || !query) {
      this.showNotification('Please enter both name and query', 'error');
      return;
    }

    try {
      if (this.editingSearchId) {
        // Update existing
        await window.electronAPI.smartSearchUpdate(this.editingSearchId, { name, query });
      } else {
        // Create new
        const result = await window.electronAPI.smartSearchCreate(name, query);
        if (result.success) {
          // Auto-refresh to get results
          await window.electronAPI.smartSearchRefresh(result.id);
          // Select the new search
          await this.loadSmartSearches();
          await this.selectSmartSearch(result.id);
        }
      }

      this.hideSmartSearchModal();
      await this.loadSmartSearches();
    } catch (error) {
      this.showNotification(`Error: ${error.message}`, 'error');
    }
  }

  async addPaperToLibraryFromSearch(paper) {
    if (!paper.bibcode) {
      this.showNotification('Cannot add paper without bibcode', 'error');
      return;
    }

    if (paper.inLibrary) {
      this.showNotification('Paper already in library', 'info');
      return;
    }

    const result = await window.electronAPI.smartSearchAddToLibrary(paper.bibcode);

    if (result.success) {
      // Mark as in library
      paper.inLibrary = true;
      paper.libraryPaperId = result.paperId;
      this.renderPaperList();
      this.showNotification(`Added "${paper.title?.substring(0, 50)}..." to library`, 'success');
    } else {
      this.showNotification(`Failed to add: ${result.error}`, 'error');
    }
  }

  /**
   * Add all selected papers from smart search to library
   * Used by context menu "Add to Library" and iOS action sheet
   */
  async addSelectedPapersToLibrary() {
    if (!this.currentSmartSearch) return;

    const papersToAdd = [];
    for (const id of this.selectedPapers) {
      const paper = this.papers.find(p => p.id === id);
      if (paper && !paper.inLibrary) {
        papersToAdd.push(paper);
      }
    }

    if (papersToAdd.length === 0) {
      this.showNotification('All selected papers already in library', 'info');
      return;
    }

    let added = 0;
    for (const paper of papersToAdd) {
      const result = await window.electronAPI.smartSearchAddToLibrary(paper.bibcode);
      if (result.success) {
        paper.inLibrary = true;
        paper.libraryPaperId = result.paperId;
        added++;
      }
    }

    this.renderPaperList();
    const msg = added === 1 ? 'Added 1 paper to library' : `Added ${added} papers to library`;
    this.showNotification(msg, 'success');
  }

  updateNavActiveStates() {
    // Update view items
    document.querySelectorAll('.drawer-nav-item[data-view]').forEach(item => {
      item.classList.toggle('active', this.currentView === item.dataset.view && !this.currentSmartSearch);
    });

    // Update collection items
    document.querySelectorAll('.collection-item').forEach(item => {
      item.classList.toggle('active', parseInt(item.dataset.collection) === this.currentCollection && !this.currentSmartSearch);
    });

    // Update smart search items
    document.querySelectorAll('.drawer-search-item').forEach(item => {
      item.classList.toggle('active', parseInt(item.dataset.searchId) === this.currentSmartSearch);
    });
  }

  // Virtual scrolling configuration
  PAPER_ITEM_HEIGHT = 58; // Fixed height per paper item in pixels
  VIRTUAL_BUFFER = 5; // Extra items to render above/below visible area

  renderPaperList() {
    const listEl = document.getElementById('paper-list');
    console.log('renderPaperList called, papers:', this.papers.length);

    if (this.papers.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📚</div>
          <h3>No papers yet</h3>
          <p>Import PDFs or BibTeX to get started</p>
          <button class="primary-button" id="import-first-btn">Import Files</button>
        </div>
      `;
      document.getElementById('import-first-btn')?.addEventListener('click', () => this.importFiles());
      return;
    }

    // Use virtual scrolling for large lists (>100 papers)
    if (this.papers.length > 100) {
      this.renderVirtualPaperList();
    } else {
      this.renderFullPaperList();
    }
  }

  renderFullPaperList() {
    const listEl = document.getElementById('paper-list');
    const inCollection = !!this.currentCollection;
    const isAdsSearchView = !!this.currentSmartSearch;

    // Determine action based on context
    let actionIcon, actionTitle, actionClass;
    if (isAdsSearchView) {
      actionIcon = '+';
      actionTitle = 'Add to library';
      actionClass = 'add';
    } else if (inCollection) {
      actionIcon = '✕';
      actionTitle = 'Remove from collection';
      actionClass = 'remove';
    } else {
      actionIcon = '🗑';
      actionTitle = 'Delete paper';
      actionClass = 'delete';
    }

    listEl.innerHTML = this.papers.map((paper, index) => {
      const pos = this.pdfPagePositions[paper.id];
      const hasProgress = pos && pos.totalPages > 0 && pos.page > 1;
      const progressPct = hasProgress ? Math.round((pos.page / pos.totalPages) * 100) : 0;

      // ADS search paper specific badges
      const inLibraryBadge = (isAdsSearchView && paper.inLibrary) ?
        '<span class="in-library-badge" title="Already in your library">In Library</span>' : '';

      // For ADS papers, hide the swipe action if already in library
      // Only render swipe action on iOS - it's not needed on macOS
      const showSwipeAction = this.isIOS && (!isAdsSearchView || !paper.inLibrary);
      const swipeActionHtml = showSwipeAction ? `
        <div class="paper-swipe-action ${actionClass}" title="${actionTitle}">
          <span class="swipe-action-icon">${actionIcon}</span>
        </div>
      ` : '';

      return `
      <div class="paper-swipe-container${paper.inLibrary ? ' in-library' : ''}" data-id="${paper.id}" data-index="${index}" data-bibcode="${paper.bibcode || ''}">
        ${swipeActionHtml}
        <div class="paper-item${this.selectedPapers.has(paper.id) ? ' selected' : ''}${paper.inLibrary ? ' dimmed' : ''}" data-id="${paper.id}" data-index="${index}" draggable="${!isAdsSearchView}">
          <div class="paper-item-title">
            <span class="paper-item-status ${paper.read_status || 'unread'}"></span>
            ${this.escapeHtml(paper.title || 'Untitled')}
            ${inLibraryBadge}
          </div>
          <div class="paper-item-meta">
            <span class="paper-item-authors">${this.formatAuthors(paper.authors, true)}</span>
            <span>${paper.year || ''}</span>
            ${paper.citation_count > 0 ? `<span class="citation-count" title="${paper.citation_count} citations">🔗${paper.citation_count}</span>` : ''}
            ${this.getRatingEmoji(paper.rating)}
            ${hasProgress ? `<span class="reading-progress" title="Page ${pos.page}/${pos.totalPages} (${progressPct}%)">📖${progressPct}%</span>` : ''}
            ${paper.is_indexed ? '<span class="indexed-indicator" title="Indexed for AI search">⚡</span>' : ''}
          </div>
        </div>
      </div>
    `}).join('');

    this.attachPaperListHandlers(listEl);
  }

  renderVirtualPaperList() {
    const listEl = document.getElementById('paper-list');
    const totalHeight = this.papers.length * this.PAPER_ITEM_HEIGHT;

    // Create virtual scroll container
    listEl.innerHTML = `<div class="virtual-scroll-container" style="height: ${totalHeight}px; position: relative;"></div>`;
    const container = listEl.querySelector('.virtual-scroll-container');

    // Store reference for scroll updates
    this._virtualContainer = container;
    this._virtualListEl = listEl;

    // Initial render
    this.updateVirtualPaperList();

    // Setup scroll listener (throttled)
    if (!this._virtualScrollHandler) {
      let scrollTicking = false;
      this._virtualScrollHandler = () => {
        if (!scrollTicking) {
          requestAnimationFrame(() => {
            this.updateVirtualPaperList();
            scrollTicking = false;
          });
          scrollTicking = true;
        }
      };
      listEl.addEventListener('scroll', this._virtualScrollHandler);
    }
  }

  updateVirtualPaperList() {
    const listEl = this._virtualListEl || document.getElementById('paper-list');
    const container = this._virtualContainer || listEl.querySelector('.virtual-scroll-container');
    if (!container || !listEl) return;

    const scrollTop = listEl.scrollTop;
    const viewportHeight = listEl.clientHeight;
    const inCollection = !!this.currentCollection;
    const isAdsSearchView = !!this.currentSmartSearch;

    // Determine action based on context
    let actionIcon, actionTitle, actionClass;
    if (isAdsSearchView) {
      actionIcon = '+';
      actionTitle = 'Add to library';
      actionClass = 'add';
    } else if (inCollection) {
      actionIcon = '✕';
      actionTitle = 'Remove from collection';
      actionClass = 'remove';
    } else {
      actionIcon = '🗑';
      actionTitle = 'Delete paper';
      actionClass = 'delete';
    }

    // Calculate visible range
    const startIndex = Math.max(0, Math.floor(scrollTop / this.PAPER_ITEM_HEIGHT) - this.VIRTUAL_BUFFER);
    const endIndex = Math.min(
      this.papers.length - 1,
      Math.ceil((scrollTop + viewportHeight) / this.PAPER_ITEM_HEIGHT) + this.VIRTUAL_BUFFER
    );

    // Generate HTML for visible items only
    let html = '';
    for (let i = startIndex; i <= endIndex; i++) {
      const paper = this.papers[i];
      const top = i * this.PAPER_ITEM_HEIGHT;
      const pos = this.pdfPagePositions[paper.id];
      const hasProgress = pos && pos.totalPages > 0 && pos.page > 1;
      const progressPct = hasProgress ? Math.round((pos.page / pos.totalPages) * 100) : 0;

      // ADS search paper specific badges
      const inLibraryBadge = (isAdsSearchView && paper.inLibrary) ?
        '<span class="in-library-badge" title="Already in your library">In Library</span>' : '';

      // For ADS papers, hide the swipe action if already in library
      // Only render swipe action on iOS - it's not needed on macOS
      const showSwipeAction = this.isIOS && (!isAdsSearchView || !paper.inLibrary);
      const swipeActionHtml = showSwipeAction ? `
        <div class="paper-swipe-action ${actionClass}" title="${actionTitle}">
          <span class="swipe-action-icon">${actionIcon}</span>
        </div>
      ` : '';

      html += `
        <div class="paper-swipe-container${paper.inLibrary ? ' in-library' : ''}" data-id="${paper.id}" data-index="${i}" data-bibcode="${paper.bibcode || ''}"
             style="position: absolute; top: ${top}px; left: 0; right: 0; height: ${this.PAPER_ITEM_HEIGHT}px;">
          ${swipeActionHtml}
          <div class="paper-item${this.selectedPapers.has(paper.id) ? ' selected' : ''}${paper.inLibrary ? ' dimmed' : ''}"
               data-id="${paper.id}" data-index="${i}" draggable="${!isAdsSearchView}">
            <div class="paper-item-title">
              <span class="paper-item-status ${paper.read_status || 'unread'}"></span>
              ${this.escapeHtml(paper.title || 'Untitled')}
              ${inLibraryBadge}
            </div>
            <div class="paper-item-meta">
              <span class="paper-item-authors">${this.formatAuthors(paper.authors, true)}</span>
              <span>${paper.year || ''}</span>
              ${paper.citation_count > 0 ? `<span class="citation-count" title="${paper.citation_count} citations">🔗${paper.citation_count}</span>` : ''}
              ${this.getRatingEmoji(paper.rating)}
              ${hasProgress ? `<span class="reading-progress" title="Page ${pos.page}/${pos.totalPages} (${progressPct}%)">📖${progressPct}%</span>` : ''}
              ${paper.is_indexed ? '<span class="indexed-indicator" title="Indexed for AI search">⚡</span>' : ''}
            </div>
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
    this.attachPaperListHandlers(container);
  }

  attachPaperListHandlers(container) {
    // Add click handlers with multi-select support
    container.querySelectorAll('.paper-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // For ADS search papers, ID is a bibcode string; for local papers, it's a number
        const rawId = item.dataset.id;
        const id = this.currentSmartSearch ? rawId : parseInt(rawId);
        const index = parseInt(item.dataset.index);
        this.handlePaperClick(id, index, e);
      });

      // Drag support
      item.addEventListener('dragstart', (e) => {
        const id = parseInt(item.dataset.id);
        if (!this.selectedPapers.has(id)) {
          this.selectedPapers.clear();
          this.selectedPapers.add(id);
          this.updatePaperListSelection();
          this.updateSelectionUI();
        }
        e.dataTransfer.setData('text/plain', 'papers');
        e.dataTransfer.effectAllowed = 'move';
        item.classList.add('dragging');
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
      });

      // Drop support for attaching PDFs
      item.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          item.classList.add('drop-target');
        }
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drop-target');
      });

      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        item.classList.remove('drop-target');
        const files = Array.from(e.dataTransfer.files);
        const pdfFiles = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
        if (pdfFiles.length > 0) {
          const paperId = parseInt(item.dataset.id);
          const pdfPath = window.electronAPI.getPathForFile(pdfFiles[0]);
          await this.attachDroppedPdf(paperId, pdfPath);
        }
      });
    });

    // Swipe-to-delete handlers for iOS
    if (this.isIOS) {
      container.querySelectorAll('.paper-swipe-container').forEach(swipeContainer => {
        let startX = 0;
        let currentX = 0;
        let isSwiping = false;
        const threshold = 60; // Minimum swipe distance to trigger action
        const paperItem = swipeContainer.querySelector('.paper-item');

        swipeContainer.addEventListener('touchstart', (e) => {
          // Don't swipe in selection mode
          if (document.body.classList.contains('selection-mode')) return;

          startX = e.touches[0].clientX;
          isSwiping = false;
          swipeContainer.classList.remove('swiped');
        }, { passive: true });

        swipeContainer.addEventListener('touchmove', (e) => {
          if (document.body.classList.contains('selection-mode')) return;

          currentX = e.touches[0].clientX;
          const deltaX = currentX - startX;

          // Only swipe left (negative deltaX)
          if (deltaX < -10) {
            isSwiping = true;
            swipeContainer.classList.add('swiping');
            const translateX = Math.max(-80, deltaX);
            paperItem.style.transform = `translateX(${translateX}px)`;
            e.preventDefault();
          }
        }, { passive: false });

        swipeContainer.addEventListener('touchend', () => {
          if (document.body.classList.contains('selection-mode')) return;

          swipeContainer.classList.remove('swiping');
          const deltaX = currentX - startX;

          if (isSwiping && deltaX < -threshold) {
            // Snap to open state
            swipeContainer.classList.add('swiped');
            paperItem.style.transform = '';
          } else {
            // Snap back closed
            swipeContainer.classList.remove('swiped');
            paperItem.style.transform = '';
          }

          isSwiping = false;
          startX = 0;
          currentX = 0;
        }, { passive: true });

        // Handle tap on action area - use touchend for iOS
        const actionArea = swipeContainer.querySelector('.paper-swipe-action');
        const handleActionTap = async (e) => {
          e.stopPropagation();
          e.preventDefault();

          // Skip disabled actions (e.g., paper already in library)
          if (actionArea.classList.contains('disabled')) return;

          const rawId = swipeContainer.dataset.id;

          if (this.currentSmartSearch) {
            // Add to library from ADS search
            const paper = this.papers.find(p => p.id === rawId);
            if (paper && !paper.inLibrary) {
              await this.addPaperToLibraryFromSearch(paper);
              // Close the swipe
              swipeContainer.classList.remove('swiped');
              if (paperItem) paperItem.style.transform = '';
            }
          } else if (this.currentCollection) {
            // Remove from collection
            const paperId = parseInt(rawId);
            await window.electronAPI.removePaperFromCollection(paperId, this.currentCollection);
            await this.loadPapersInCollection(this.currentCollection);
            this.consoleLog('Paper removed from collection', 'success');
          } else {
            // Delete paper - use custom confirmation for iOS
            const paperId = parseInt(rawId);
            this.showDeleteConfirmation(paperId, swipeContainer, paperItem);
          }
        };
        actionArea?.addEventListener('touchend', handleActionTap);
        actionArea?.addEventListener('click', handleActionTap);
      });

      // Close any open swipes when tapping elsewhere
      container.addEventListener('touchstart', (e) => {
        if (!e.target.closest('.paper-swipe-action')) {
          container.querySelectorAll('.paper-swipe-container.swiped').forEach(s => {
            s.classList.remove('swiped');
            const item = s.querySelector('.paper-item');
            if (item) item.style.transform = '';
          });
        }
      }, { passive: true });
    }

    // Add Info button handlers
    container.querySelectorAll('.info-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const paperId = parseInt(btn.dataset.paperId);
        await this.navigateToPaperInfo(paperId);
      });
    });

    // Add PDF button handlers
    container.querySelectorAll('.pdf-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const paperId = parseInt(btn.dataset.paperId);
        const bibcode = btn.dataset.bibcode;

        // Check if unavailable
        if (btn.classList.contains('pdf-btn-unavailable')) {
          this.consoleLog('No PDF sources available for this paper', 'info');
          return;
        }

        await this.showPdfSourceDropdown(btn, paperId, bibcode);
      });
    });

    // Legacy: keep old pdf-source-btn handler for backward compatibility
    container.querySelectorAll('.pdf-source-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const paperId = parseInt(btn.dataset.paperId);
        const bibcode = btn.dataset.bibcode;
        await this.showPdfSourceDropdown(btn, paperId, bibcode);
      });
    });
  }

  handlePaperClick(id, index, event) {
    // iOS selection mode: toggle selection instead of opening paper
    if (this.isSelectionMode && this.isIOS) {
      if (this.selectedPapers.has(id)) {
        this.selectedPapers.delete(id);
      } else {
        this.selectedPapers.add(id);
      }
      this.updatePaperListSelection();
      this.updateSelectionCount();
      return; // Don't open the paper
    }

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
      // For ADS search papers, ID is a bibcode string; for local papers, it's a number
      const rawId = item.dataset.id;
      const id = this.currentSmartSearch ? rawId : parseInt(rawId);
      item.classList.toggle('selected', this.selectedPapers.has(id));
    });
  }

  updateSelectionUI() {
    const count = this.selectedPapers.size;
    const removeBtn = document.getElementById('remove-paper-btn');
    if (removeBtn) {
      removeBtn.disabled = count === 0;
      removeBtn.textContent = count > 1 ? `−` : '−';
      removeBtn.title = count > 1 ? `Remove ${count} Papers (Backspace)` : 'Remove Paper (Backspace)';
    }

    // Update attach button - disabled when multiple papers selected
    const attachBtn = document.getElementById('attach-file-btn');
    if (attachBtn) {
      attachBtn.disabled = count !== 1;
      attachBtn.classList.toggle('disabled', count !== 1);
    }

    this.updateBottomBarButtonStates();
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

  // iOS Multi-Select Mode
  enterSelectionMode() {
    if (!this.isIOS) return;

    this.isSelectionMode = true;
    document.body.classList.add('selection-mode');

    // Show selection UI, hide normal top bar
    document.getElementById('mobile-top-bar')?.classList.add('hidden');
    document.getElementById('mobile-selection-bar')?.classList.remove('hidden');

    // Clear previous selection
    this.selectedPapers.clear();
    this.updatePaperListSelection();
    this.updateSelectionCount();
  }

  exitSelectionMode() {
    this.isSelectionMode = false;
    document.body.classList.remove('selection-mode');

    // Hide selection UI, show normal top bar
    document.getElementById('mobile-top-bar')?.classList.remove('hidden');
    document.getElementById('mobile-selection-bar')?.classList.add('hidden');
    this.hideSelectionActionSheet();

    // Clear selection
    this.selectedPapers.clear();
    this.updatePaperListSelection();
  }

  updateSelectionCount() {
    const count = this.selectedPapers.size;
    const countEl = document.getElementById('selection-count');
    if (countEl) {
      countEl.textContent = count === 0 ? 'Select Items' : `${count} selected`;
    }
  }

  showSelectionActionSheet() {
    if (this.selectedPapers.size === 0) {
      this.showNotification('No papers selected', 'warn');
      return;
    }
    // Show/hide "Remove from Collection" based on whether we're viewing a collection
    const removeBtn = document.getElementById('as-remove-from-collection-btn');
    if (removeBtn) {
      if (this.currentCollection) {
        removeBtn.classList.remove('hidden');
      } else {
        removeBtn.classList.add('hidden');
      }
    }

    // Show/hide ADS-specific buttons
    const addToLibraryBtn = document.getElementById('as-add-to-library-btn');
    const deleteBtn = document.getElementById('as-delete-btn');
    const syncBtn = document.getElementById('as-sync-btn');

    if (this.currentSmartSearch) {
      addToLibraryBtn?.classList.remove('hidden');
      deleteBtn?.classList.add('hidden');
      syncBtn?.classList.add('hidden');
    } else {
      addToLibraryBtn?.classList.add('hidden');
      deleteBtn?.classList.remove('hidden');
      syncBtn?.classList.remove('hidden');
    }

    document.getElementById('action-sheet-overlay')?.classList.remove('hidden');
    document.getElementById('selection-action-sheet')?.classList.remove('hidden');
  }

  hideSelectionActionSheet() {
    document.getElementById('action-sheet-overlay')?.classList.add('hidden');
    document.getElementById('selection-action-sheet')?.classList.add('hidden');
  }

  showCollectionsActionSheet() {
    const content = document.getElementById('collections-sheet-content');
    if (!content) return;

    if (this.collections.length === 0) {
      content.innerHTML = '<div class="action-sheet-btn" style="color: var(--text-muted);">No collections</div>';
    } else {
      content.innerHTML = this.collections.map(c =>
        `<button class="action-sheet-btn" data-collection-id="${c.id}">${this.escapeHtml(c.name)}</button>`
      ).join('');

      // Add click handlers
      content.querySelectorAll('.action-sheet-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const collectionId = parseInt(btn.dataset.collectionId);
          this.hideCollectionsActionSheet();
          this.addSelectedToCollection(collectionId);
          this.exitSelectionMode();
        });
      });
    }

    // Keep overlay visible for this sheet
    document.getElementById('action-sheet-overlay')?.classList.remove('hidden');
    document.getElementById('collections-action-sheet')?.classList.remove('hidden');
  }

  hideCollectionsActionSheet() {
    document.getElementById('collections-action-sheet')?.classList.add('hidden');
    document.getElementById('action-sheet-overlay')?.classList.add('hidden');
  }

  async showDownloadActionSheet(papers) {
    const overlay = document.getElementById('action-sheet-overlay');

    // Create download action sheet dynamically
    let sheet = document.getElementById('download-action-sheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'download-action-sheet';
      sheet.className = 'action-sheet';
      document.body.appendChild(sheet);
    }

    sheet.innerHTML = '<div class="action-sheet-content"><div class="action-sheet-title">Loading sources...</div></div><button class="action-sheet-cancel" id="download-sheet-cancel">Cancel</button>';

    overlay?.classList.remove('hidden');
    sheet.classList.remove('hidden');

    // Cancel button
    document.getElementById('download-sheet-cancel')?.addEventListener('click', () => {
      sheet.classList.add('hidden');
      overlay?.classList.add('hidden');
    });

    // Populate with sources
    const sourceLabels = {
      'EPRINT_PDF': { icon: '📑', label: 'arXiv' },
      'PUB_PDF': { icon: '📰', label: 'Publisher' },
      'ADS_PDF': { icon: '📜', label: 'ADS Scan' },
      'ATTACHED': { icon: '📎', label: 'Attached' },
      'LEGACY': { icon: '📄', label: 'PDF' }
    };

    let html = '';

    try {
      if (papers.length === 1) {
        const paper = papers[0];
        let downloadedSources = [];
        let pdfAttachments = [];

        // Get downloaded sources
        try {
          downloadedSources = await window.electronAPI.getDownloadedPdfSources(paper.id) || [];
        } catch (e) {
          // Ignore errors - will just not show downloaded sources
        }

        // Get attachments
        try {
          pdfAttachments = await window.electronAPI.getPdfAttachments(paper.id) || [];
        } catch (e) {
          // Ignore errors - attachments may not be available on iOS
        }

        // Get available sources from ADS
        const availableSources = new Set();
        if (paper.bibcode) {
          try {
            const result = await window.electronAPI.adsGetEsources(paper.bibcode);
            if (result && result.success && result.data) {
              if (result.data.arxiv) availableSources.add('EPRINT_PDF');
              if (result.data.publisher) availableSources.add('PUB_PDF');
              if (result.data.ads) availableSources.add('ADS_PDF');
            }
          } catch (e) {
            // Ignore errors - will just not show ADS sources
          }
        }

        // Downloaded sources with checkmarks
        for (const source of downloadedSources) {
          const info = sourceLabels[source] || { icon: '📄', label: source };
          html += `<button class="action-sheet-btn downloaded-source" data-source="${source}" data-action="view">✓ ${info.icon} ${info.label}</button>`;
          availableSources.delete(source);
        }

        // Attachments
        for (const att of pdfAttachments) {
          html += `<button class="action-sheet-btn downloaded-source" data-attachment="${att.filename}" data-action="view">✓ 📎 ${att.display_name || att.filename}</button>`;
        }

        // Available for download
        for (const source of ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF']) {
          if (availableSources.has(source)) {
            const { icon, label } = sourceLabels[source];
            html += `<button class="action-sheet-btn" data-source="${source}" data-action="download">${icon} Download ${label}</button>`;
          }
        }

        if (!html) {
          html = '<div class="action-sheet-btn" style="color: var(--text-muted);">No sources available</div>';
        }
      } else {
        // Multiple papers - just download options
        html = `
          <button class="action-sheet-btn" data-source="EPRINT_PDF" data-action="download">📑 Download arXiv</button>
          <button class="action-sheet-btn" data-source="PUB_PDF" data-action="download">📰 Download Publisher</button>
          <button class="action-sheet-btn" data-source="ADS_PDF" data-action="download">📜 Download ADS Scan</button>
        `;
      }
    } catch (e) {
      html = '<div class="action-sheet-btn" style="color: var(--text-muted);">Error loading sources</div>';
    }

    const content = sheet.querySelector('.action-sheet-content');
    content.innerHTML = `<div class="action-sheet-title">${papers.length === 1 ? 'PDF Sources' : 'Download PDFs'}</div>${html}`;

    // Add click handlers
    content.querySelectorAll('.action-sheet-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const source = btn.dataset.source;
        const attachment = btn.dataset.attachment;

        sheet.classList.add('hidden');
        overlay?.classList.add('hidden');

        if (action === 'view' && papers.length === 1) {
          const paper = papers[0];
          if (attachment) {
            paper.pdf_path = `papers/${attachment}`;
          } else if (source) {
            const baseFilename = paper.bibcode ? paper.bibcode.replace(/\//g, '_') : `paper_${paper.id}`;
            paper.pdf_path = source === 'LEGACY' ? `papers/${baseFilename}.pdf` : `papers/${baseFilename}_${source}.pdf`;
          }
          await this.loadPDF(paper);
        } else if (action === 'download' && source) {
          await this.downloadPdfsForSelected(source);
        }
      });
    });
  }

  showDeleteConfirmation(paperId, swipeContainer, paperItem) {
    // Create a temporary action sheet for delete confirmation
    const overlay = document.getElementById('action-sheet-overlay');
    const paper = this.papers.find(p => p.id === paperId);
    const title = paper ? (paper.title || 'Untitled').substring(0, 50) + (paper.title?.length > 50 ? '...' : '') : 'this paper';

    // Create confirmation sheet dynamically
    let sheet = document.getElementById('delete-confirm-sheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'delete-confirm-sheet';
      sheet.className = 'action-sheet';
      document.body.appendChild(sheet);
    }

    sheet.innerHTML = `
      <div class="action-sheet-content">
        <div class="action-sheet-title">Delete "${title}"?</div>
        <button class="action-sheet-btn action-sheet-danger" id="confirm-delete-btn">Delete Paper</button>
      </div>
      <button class="action-sheet-cancel" id="cancel-delete-btn">Cancel</button>
    `;

    // Show sheet
    overlay?.classList.remove('hidden');
    sheet.classList.remove('hidden');

    // Handle delete
    document.getElementById('confirm-delete-btn')?.addEventListener('click', async () => {
      sheet.classList.add('hidden');
      overlay?.classList.add('hidden');
      await this.deletePapers([paperId]);
    });

    // Handle cancel
    document.getElementById('cancel-delete-btn')?.addEventListener('click', () => {
      sheet.classList.add('hidden');
      overlay?.classList.add('hidden');
      // Reset swipe state
      swipeContainer?.classList.remove('swiped');
      if (paperItem) paperItem.style.transform = '';
    });
  }

  async exportSelectedBibtex() {
    if (this.selectedPapers.size === 0) {
      this.showNotification('No papers selected', 'warn');
      return;
    }

    const papers = this.papers.filter(p => this.selectedPapers.has(p.id));
    const bibtexEntries = papers
      .filter(p => p.bibtex)
      .map(p => p.bibtex)
      .join('\n\n');

    if (!bibtexEntries) {
      this.showNotification('No BibTeX entries available', 'warn');
      return;
    }

    // Copy to clipboard
    try {
      await navigator.clipboard.writeText(bibtexEntries);
      this.showNotification(`Copied ${papers.length} BibTeX entries`, 'success');
    } catch (e) {
      this.showNotification('Failed to copy to clipboard', 'error');
    }
  }

  clearPaperDisplay() {
    this.selectedPaper = null;
    document.getElementById('viewer-wrapper').classList.add('hidden');
    document.getElementById('detail-placeholder').classList.remove('hidden');
    document.body.classList.remove('has-selected-paper');
    document.title = 'ADS Reader';
    this.updateBottomBarButtonStates();
  }

  // Context menu methods
  showContextMenu(e) {
    const paperItem = e.target.closest('.paper-item');
    if (!paperItem) return;

    e.preventDefault();

    // For smart search, ID is bibcode (string); for library, it's numeric
    const rawId = paperItem.dataset.id;
    const id = this.currentSmartSearch ? rawId : parseInt(rawId);

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

    // Update export book text based on selection count
    const exportBookItem = document.getElementById('ctx-export-book');
    if (exportBookItem) {
      exportBookItem.textContent = this.selectedPapers.size > 1
        ? `Export ${this.selectedPapers.size} Papers as Book`
        : 'Export as Book';
    }

    // Show/hide ADS-specific items
    const addToLibraryItem = document.getElementById('ctx-add-to-library');
    if (this.currentSmartSearch) {
      addToLibraryItem?.classList.remove('hidden');
      // Update text based on selection count
      addToLibraryItem.textContent = this.selectedPapers.size > 1
        ? `Add ${this.selectedPapers.size} Papers to Library`
        : 'Add to Library';
      // Hide non-applicable items for ADS papers
      deleteItem.style.display = 'none';
      document.getElementById('ctx-sync-paper')?.style.setProperty('display', 'none');
      document.getElementById('ctx-download-pdfs')?.style.setProperty('display', 'none');
      document.getElementById('ctx-open-publisher')?.style.setProperty('display', 'none');
    } else {
      addToLibraryItem?.classList.add('hidden');
      deleteItem.style.display = 'block';
      document.getElementById('ctx-sync-paper')?.style.setProperty('display', 'block');
      document.getElementById('ctx-download-pdfs')?.style.setProperty('display', 'block');
      document.getElementById('ctx-open-publisher')?.style.setProperty('display', 'block');
    }

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

    // For smart search papers, first add to library
    if (this.currentSmartSearch) {
      for (const bibcode of this.selectedPapers) {
        const paper = this.papers.find(p => p.id === bibcode);
        if (!paper) continue;

        // Add to library first if not already
        if (!paper.inLibrary) {
          const result = await window.electronAPI.smartSearchAddToLibrary(paper.bibcode);
          if (result.success) {
            paper.inLibrary = true;
            paper.libraryPaperId = result.paperId;
          } else {
            this.showNotification(`Failed to add: ${result.error}`, 'error');
            continue;
          }
        }

        // Now add to collection using library paper ID
        await window.electronAPI.addPaperToCollection(paper.libraryPaperId, collectionId);
      }
      this.renderPaperList(); // Refresh to show "In Library" badges
    } else {
      // Existing logic for library papers
      for (const paperId of this.selectedPapers) {
        await window.electronAPI.addPaperToCollection(paperId, collectionId);
      }
    }

    // Refresh collections to update counts
    await this.loadCollections();

    // Show feedback
    const count = this.selectedPapers.size;
    const msg = count === 1 ? 'Paper added to' : `${count} papers added to`;
    this.showNotification(`${msg} "${collection.name}"`, 'success');
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
      <div class="nav-item${this.currentCollection === col.id ? ' active' : ''}${col.is_smart ? ' smart' : ''}" data-collection="${col.id}">
        <button class="collection-delete-btn" data-delete-collection="${col.id}" title="Delete collection">−</button>
        <span class="nav-icon">${col.is_smart ? '🔍' : '📁'}</span>
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

  // Render libraries list in the Library tab
  async renderLibrariesTab() {
    const container = document.getElementById('libraries-list');
    if (!container) return;

    try {
      const libraries = await window.electronAPI.getAllLibraries();
      const currentId = await window.electronAPI.getCurrentLibraryId();

      if (libraries.length === 0) {
        container.innerHTML = '<div class="library-placeholder">No libraries found</div>';
        return;
      }

      container.innerHTML = libraries.map(lib => `
        <div class="library-item${lib.id === currentId ? ' active' : ''}" data-library-id="${lib.id}">
          <span class="library-icon">${lib.location === 'icloud' ? '☁️' : '💻'}</span>
          <div class="library-info">
            <div class="library-name">${this.escapeHtml(lib.name)}</div>
            <div class="library-meta">${lib.paperCount} papers</div>
          </div>
          <button class="library-delete-btn" title="Delete library">×</button>
        </div>
      `).join('');
    } catch (error) {
      console.error('Error rendering libraries tab:', error);
      container.innerHTML = '<div class="library-placeholder">Error loading libraries</div>';
    }
  }

  // Render collections list in the Library tab
  renderCollectionsTab() {
    const container = document.getElementById('tab-collections-list');
    if (!container) return;

    // Add "All Papers" option first
    let html = `
      <div class="collection-item${!this.currentCollection ? ' active' : ''}" data-collection-id="">
        <span class="collection-icon">📚</span>
        <span class="collection-name">All Papers</span>
        <span class="collection-count">${this.papers.length}</span>
      </div>
    `;

    // Add user collections
    html += this.collections.map(col => `
      <div class="collection-item${this.currentCollection === col.id ? ' active' : ''}" data-collection-id="${col.id}">
        <span class="collection-icon">${col.is_smart ? '🔍' : '📁'}</span>
        <span class="collection-name">${this.escapeHtml(col.name)}</span>
        <span class="collection-count">${col.paper_count || 0}</span>
        <button class="collection-delete-btn" title="Delete collection">×</button>
      </div>
    `).join('');

    container.innerHTML = html;
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
    // Stay in list view on mobile - user can use tab bar to navigate
  }

  // Navigate to paper info (refs/cites/bibtex)
  async navigateToPaperInfo(paperId) {
    // Select the paper first
    await this.selectPaper(paperId);

    // Go directly to the info/bibtex tab on both mobile and desktop
    this.switchTab('bibtex');
  }

  // Show paper info sheet for mobile (BibTeX, Refs, Cites options)
  showPaperInfoSheet(paperId) {
    const paper = this.papers.find(p => p.id === paperId);
    if (!paper) return;

    // Remove any existing info sheet
    const existingOverlay = document.getElementById('info-sheet-overlay');
    const existingSheet = document.getElementById('info-sheet');
    existingOverlay?.remove();
    existingSheet?.remove();

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'info-sheet-overlay';
    overlay.id = 'info-sheet-overlay';

    // Create sheet
    const sheet = document.createElement('div');
    sheet.className = 'info-sheet';
    sheet.id = 'info-sheet';
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-title">Paper Info</div>
      <div class="sheet-options">
        <div class="sheet-option" data-tab="bibtex">
          <div class="sheet-option-content">
            <span class="sheet-option-icon">📋</span>
            <span class="sheet-option-label">Info</span>
          </div>
        </div>
        <div class="sheet-option" data-tab="refs">
          <div class="sheet-option-content">
            <span class="sheet-option-icon">📚</span>
            <span class="sheet-option-label">References</span>
          </div>
          <span class="sheet-option-count" id="info-sheet-refs-count"></span>
        </div>
        <div class="sheet-option" data-tab="cites">
          <div class="sheet-option-content">
            <span class="sheet-option-icon">🔗</span>
            <span class="sheet-option-label">Citations</span>
          </div>
          <span class="sheet-option-count" id="info-sheet-cites-count"></span>
        </div>
        <button class="sheet-cancel">Cancel</button>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(sheet);

    // Animate in
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      sheet.classList.add('visible');
    });

    // Load refs/cites counts
    this.loadInfoSheetCounts(paperId);

    // Event handlers
    const hideSheet = () => {
      overlay.classList.remove('visible');
      sheet.classList.remove('visible');
      setTimeout(() => {
        overlay.remove();
        sheet.remove();
      }, 300);
    };

    overlay.addEventListener('click', hideSheet);
    sheet.querySelector('.sheet-cancel').addEventListener('click', hideSheet);

    sheet.querySelectorAll('.sheet-option[data-tab]').forEach(option => {
      option.addEventListener('click', () => {
        const tab = option.dataset.tab;
        hideSheet();
        // Switch to the detail view which has the tabs
        this.showMobileView('detail');
        setTimeout(() => this.switchTab(tab), 100);
      });
    });

    // Swipe to dismiss
    let startY = 0;
    sheet.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
    });
    sheet.addEventListener('touchmove', (e) => {
      const diff = e.touches[0].clientY - startY;
      if (diff > 50) {
        hideSheet();
      }
    });
  }

  // Load refs/cites counts for info sheet
  async loadInfoSheetCounts(paperId) {
    try {
      const refs = await window.electronAPI.getReferences(paperId);
      const cites = await window.electronAPI.getCitations(paperId);

      const refsCount = document.getElementById('info-sheet-refs-count');
      const citesCount = document.getElementById('info-sheet-cites-count');

      if (refsCount && refs?.length > 0) {
        refsCount.textContent = refs.length;
      }
      if (citesCount && cites?.length > 0) {
        citesCount.textContent = cites.length;
      }
    } catch (e) {
      // Ignore errors
    }
  }

  async displayPaper(id) {
    // Save current scroll position before switching papers
    // Only save if we're on the PDF tab - otherwise the container may have stale wrappers
    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (this.selectedPaper && this.pdfDoc && activeTab === 'pdf') {
      const container = document.getElementById('pdf-container');
      const currentPage = this.getCurrentVisiblePage();
      const currentWrapper = container.querySelector(`.pdf-page-wrapper[data-page="${currentPage}"]`);

      let pageOffset = 0;
      if (currentWrapper) {
        // Calculate offset within the current page (0 = top, 1 = bottom)
        const offsetIntoPage = container.scrollTop - currentWrapper.offsetTop;
        pageOffset = offsetIntoPage / currentWrapper.offsetHeight;
      }

      const position = {
        page: currentPage,
        offset: pageOffset,
        totalPages: this.pdfDoc?.numPages || 0
      };
      this.pdfPagePositions[this.selectedPaper.id] = position;
      // Persist to storage
      window.electronAPI.setPdfPosition(this.selectedPaper.id, position);
    }

    const paper = this.papers.find(p => p.id === id);

    // For local papers, fallback to database lookup; for ADS papers, just use the array
    const resolvedPaper = paper || (!this.currentSmartSearch ? await window.electronAPI.getPaper(id) : null);
    if (!resolvedPaper) return;

    this.selectedPaper = resolvedPaper;

    // Save last selected paper for session persistence (only for local papers)
    if (!this.currentSmartSearch) {
      window.electronAPI.setLastSelectedPaper(id);
    }

    // Show viewer wrapper
    document.getElementById('detail-placeholder').classList.add('hidden');
    document.getElementById('viewer-wrapper').classList.remove('hidden');

    // Add class for mobile action grid visibility
    document.body.classList.add('has-selected-paper');

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

    document.getElementById('paper-rating-select').value = paper.rating || 0;
    const mobileRating = document.getElementById('mobile-rating-select');
    if (mobileRating) mobileRating.value = paper.rating || 0;

    // Update bottom bar button states to reflect current paper state
    this.updateBottomBarButtonStates();

    // Update abstract with paper metadata header
    const abstractEl = document.getElementById('abstract-content');
    const authorsText = this.formatAuthors(paper.authors, false);
    const yearText = paper.year ? `(${paper.year})` : '';

    // Build meta items - show journal AND arXiv if both exist
    let metaItems = [];
    if (paper.journal) metaItems.push(`<span class="abstract-journal">${this.escapeHtml(paper.journal)}</span>`);
    if (paper.arxiv_id) metaItems.push(`<span class="abstract-arxiv">arXiv:${this.escapeHtml(paper.arxiv_id)}</span>`);
    if (yearText) metaItems.push(`<span class="abstract-year">${yearText}</span>`);

    let headerHtml = `
      <div class="abstract-header">
        <h2 class="abstract-title">${this.escapeHtml(paper.title || 'Untitled')}</h2>
        <div class="abstract-authors">${this.escapeHtml(authorsText)}</div>
        <div class="abstract-meta">${metaItems.join('')}</div>
      </div>
    `;

    if (paper.abstract) {
      abstractEl.innerHTML = headerHtml + `<p class="abstract-text">${this.sanitizeAbstract(paper.abstract)}</p>`;
    } else {
      abstractEl.innerHTML = headerHtml + '<p class="no-content">No abstract available. Click "Sync" to retrieve metadata from ADS.</p>';
    }

    // For ADS search papers, add "Download & View PDF" button under abstract
    if (this.currentSmartSearch && resolvedPaper.bibcode) {
      const pdfBtnHtml = `
        <div class="abstract-pdf-action">
          <button class="primary-button abstract-view-pdf-btn" id="abstract-view-pdf-btn">
            Download & View PDF
          </button>
        </div>
      `;
      abstractEl.insertAdjacentHTML('beforeend', pdfBtnHtml);

      // Add click handler
      document.getElementById('abstract-view-pdf-btn')?.addEventListener('click', () => {
        this.downloadAndViewTempPDF(resolvedPaper);
      });
    }

    // Update keywords
    const keywordsEl = document.getElementById('keywords-list');
    if (paper.keywords?.length) {
      keywordsEl.innerHTML = paper.keywords.map(k => `<span class="keyword-tag">${this.escapeHtml(k)}</span>`).join('');
      document.getElementById('keywords-section').classList.remove('hidden');
    } else {
      document.getElementById('keywords-section').classList.add('hidden');
    }

    // Update BibTeX tab with full information
    await this.displayBibtex(resolvedPaper);

    // Load references and citations (only for local papers)
    if (!this.currentSmartSearch && typeof resolvedPaper.id === 'number') {
      await this.loadReferences(resolvedPaper.id);
      await this.loadCitations(resolvedPaper.id);
      await this.loadAnnotations(resolvedPaper.id);
    } else {
      // Clear refs/cites for ADS search papers (they don't have local data)
      this.currentRefs = [];
      this.currentCites = [];
      this.annotations = [];
      this.renderReferencesList([]);
      this.renderCitationsList([]);
    }

    // Check current tab - stay on info tabs if already there
    const currentTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    const infoTabs = ['abstract', 'refs', 'cites', 'bibtex'];

    // For ADS search papers, handle temp PDF viewing
    if (this.currentSmartSearch) {
      // Check if temp PDF is already cached
      const hasTempPdf = await window.electronAPI.tempPdfHas(resolvedPaper.bibcode);

      if (hasTempPdf && currentTab === 'pdf') {
        // Load from cache
        await this.loadTempPDF(resolvedPaper);
      } else if (!infoTabs.includes(currentTab)) {
        // No cached PDF and not on info tab - switch to abstract
        this.switchTab('abstract');
      }
      return;
    }

    // Check if paper has any PDF available (downloaded sources + attachments + pdf_path)
    const downloadedSources = await window.electronAPI.getDownloadedPdfSources(resolvedPaper.id);
    const attachments = await window.electronAPI.getAttachments(resolvedPaper.id);
    const pdfAttachments = attachments.filter(a => a.file_type === 'pdf');
    const hasAnyPdf = downloadedSources.length > 0 || pdfAttachments.length > 0 || !!resolvedPaper.pdf_path;

    // Save original pdf_path from database (for legacy PDFs)
    const originalPdfPath = resolvedPaper.pdf_path;

    // If paper has PDFs, determine which one to load based on last viewed
    if (hasAnyPdf) {
      const lastSource = this.lastPdfSources[resolvedPaper.id];
      let pdfPathSet = false;

      if (lastSource) {
        // Check if last source is an attachment
        if (lastSource.startsWith('ATTACHMENT:')) {
          const filename = lastSource.substring('ATTACHMENT:'.length);
          const attachment = pdfAttachments.find(a => a.filename === filename);
          if (attachment) {
            resolvedPaper.pdf_path = `papers/${filename}`;
            pdfPathSet = true;
          }
        } else if (lastSource === 'LEGACY' && downloadedSources.includes('LEGACY')) {
          // Legacy PDF - use original path from database
          resolvedPaper.pdf_path = originalPdfPath;
          pdfPathSet = true;
        } else {
          // It's a source type (EPRINT_PDF, PUB_PDF, ADS_PDF)
          if (downloadedSources.includes(lastSource) && resolvedPaper.bibcode) {
            const baseFilename = resolvedPaper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
            resolvedPaper.pdf_path = `papers/${baseFilename}_${lastSource}.pdf`;
            pdfPathSet = true;
          }
        }
      }

      // If no last source or last source not available, use first available
      if (!pdfPathSet) {
        if (downloadedSources.length > 0) {
          if (downloadedSources[0] === 'LEGACY') {
            // Legacy PDF - use the pdf_path stored in database
            resolvedPaper.pdf_path = originalPdfPath;
          } else if (resolvedPaper.bibcode) {
            const baseFilename = resolvedPaper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
            resolvedPaper.pdf_path = `papers/${baseFilename}_${downloadedSources[0]}.pdf`;
          }
        } else if (pdfAttachments.length > 0) {
          resolvedPaper.pdf_path = `papers/${pdfAttachments[0].filename}`;
        } else if (originalPdfPath) {
          // Fallback to original pdf_path if it exists
          resolvedPaper.pdf_path = originalPdfPath;
        }
      }
    }

    // On mobile, don't auto-switch tabs - user uses tab bar to navigate
    if (this.isMobileView) {
      // Just load the PDF in background if available
      if (hasAnyPdf) {
        await this.loadPDF(resolvedPaper);
      }
    } else if (infoTabs.includes(currentTab)) {
      // Stay on current tab and refresh if multi-select
      if (this.selectedPapers.size > 1) {
        this.switchTab(currentTab); // This will trigger multi-display
      }
      // Still load PDF in background for when user switches
      if (hasAnyPdf) {
        await this.loadPDF(resolvedPaper);
      }
    } else if (!hasAnyPdf) {
      // No PDF available, switch to BibTeX tab instead
      this.switchTab('bibtex');
    } else {
      // Switch to PDF tab
      this.switchTab('pdf');
      await this.loadPDF(resolvedPaper);
    }
  }

  async openPdfWithSystemViewer() {
    if (!this.selectedPaper?.pdf_path) {
      this.showNotification('No PDF available', 'error');
      return;
    }

    // Extract filename from pdf_path (e.g., "papers/filename.pdf" -> "filename.pdf")
    const pdfPath = this.selectedPaper.pdf_path;
    const filename = pdfPath.replace(/^papers\//, '');

    try {
      const result = await window.electronAPI.openAttachment(filename);
      if (!result.success) {
        this.showNotification(result.error || 'Failed to open PDF', 'error');
      }
    } catch (error) {
      this.showNotification(`Error opening PDF: ${error.message}`, 'error');
    }
  }

  async showNoPdfMessage(container, paper, fileMissing = false) {
    // Check if this paper has available PDF sources from ADS
    let availableSources = [];

    if (paper.bibcode && window.electronAPI?.adsGetEsources) {
      try {
        const esourcesResult = await window.electronAPI.adsGetEsources(paper.bibcode);
        if (esourcesResult.success && esourcesResult.data) {
          const sources = esourcesResult.data;
          if (sources.arxiv) {
            availableSources.push({ type: 'EPRINT_PDF', label: 'arXiv', icon: '📑' });
          }
          if (sources.publisher) {
            availableSources.push({ type: 'PUB_PDF', label: 'Publisher', icon: '📰' });
          }
          if (sources.ads) {
            availableSources.push({ type: 'ADS_PDF', label: 'ADS Scan', icon: '📜' });
          }
        }
      } catch (e) {
        console.warn('[showNoPdfMessage] Failed to get esources:', e);
      }
    }

    const message = fileMissing
      ? 'PDF file not found'
      : 'No associated PDF yet';

    let html = `
      <div class="pdf-no-content">
        <div class="pdf-no-content-icon">📄</div>
        <div class="pdf-no-content-message">${message}</div>
    `;

    if (availableSources.length > 0) {
      html += `
        <div class="pdf-no-content-sources">
          <p>Download from:</p>
          <div class="pdf-source-buttons">
            ${availableSources.map(s => `
              <button class="pdf-source-btn" data-source="${s.type}">
                ${s.icon} ${s.label}
              </button>
            `).join('')}
          </div>
        </div>
      `;
    } else if (!paper.bibcode) {
      html += `
        <div class="pdf-no-content-hint">
          <p>Drag and drop a PDF file here to attach it to this paper.</p>
        </div>
      `;
    } else {
      html += `
        <div class="pdf-no-content-hint">
          <p>Sync with ADS to check for available PDFs, or drag and drop a PDF file here.</p>
        </div>
      `;
    }

    html += '</div>';
    container.innerHTML = html;

    // Add click handlers for download buttons
    container.querySelectorAll('.pdf-source-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sourceType = btn.dataset.source;
        btn.disabled = true;
        btn.textContent = 'Downloading...';
        await this.downloadPdfSource(paper.id, sourceType);
      });
    });
  }

  async loadPDF(paper) {
    const container = document.getElementById('pdf-container');

    // On iOS with native viewer preference, use native PDF viewer instead of PDF.js
    if (this.isIOS && !this.isMobileView && paper.pdf_path) {
      // Show a button to open in native viewer
      container.innerHTML = `
        <div class="pdf-loading ios-pdf-prompt">
          <button class="btn btn-primary open-pdf-native-btn">Open PDF</button>
          <p class="ios-pdf-hint">Tap to open in PDF viewer</p>
        </div>
      `;

      // Add click handler for the button
      const btn = container.querySelector('.open-pdf-native-btn');
      btn.addEventListener('click', async () => {
        btn.textContent = 'Opening...';
        btn.disabled = true;
        try {
          const result = await window.electronAPI.openPdfNative(paper.pdf_path);
          if (!result.success) {
            this.showNotification(result.error || 'Failed to open PDF', 'error');
          }
        } catch (error) {
          this.showNotification(`Error: ${error.message}`, 'error');
        }
        btn.textContent = 'Open PDF';
        btn.disabled = false;
      });

      document.getElementById('total-pages').textContent = '-';
      document.getElementById('current-page').textContent = '-';
      return;
    }

    // Cleanup previous PDF document
    if (this.pdfDoc) {
      this.pdfDoc.destroy();
      this.pdfDoc = null;
    }

    // Reset page rotations for new document and load saved rotations
    this.pageRotations = {};
    if (paper.id) {
      try {
        const savedRotations = await window.electronAPI.getPageRotations?.(paper.id, this.currentPdfSource);
        if (savedRotations) {
          this.pageRotations = savedRotations;
        }
      } catch (e) {
        console.warn('Failed to load page rotations:', e);
      }
    }

    if (!paper.pdf_path) {
      // Show helpful message with download options if available
      await this.showNoPdfMessage(container, paper);
      document.getElementById('total-pages').textContent = '0';
      document.getElementById('current-page').textContent = '0';
      if (this.isMobileView) {
        document.body.classList.remove('viewing-pdf');
      }
      return;
    }

    // Show loading state
    container.innerHTML = '<div class="pdf-loading">Loading PDF...</div>';

    try {
      let loadingTask;

      // On iOS, use data loading (file:// and blob URLs don't work in WKWebView)
      if (this.isIOS) {
        const pdfData = await window.electronAPI.getPdfAsBlob(paper.pdf_path);
        if (!pdfData) {
          // PDF file not found - show same message as desktop with download options
          await this.showNoPdfMessage(container, paper, true);
          return;
        }
        // Note: viewing-pdf class is handled by switchToTab(), not here
        // This allows PDF to load in background without showing back button
        loadingTask = pdfjsLib.getDocument({
          data: pdfData,
          cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
          cMapPacked: true
        });
        this.pdfDoc = await loadingTask.promise;
      } else {
        // Desktop/Electron: use file:// URL
        const pdfPath = await window.electronAPI.getPdfPath(paper.pdf_path);
        if (!pdfPath) {
          // PDF path exists in DB but file not found - show download options
          await this.showNoPdfMessage(container, paper, true);
          return;
        }

        // Load new PDF with cache busting to ensure fresh load
        loadingTask = pdfjsLib.getDocument({
          url: `file://${pdfPath}`,
          cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
          cMapPacked: true
        });
        this.pdfDoc = await loadingTask.promise;
      }

      document.getElementById('total-pages').textContent = this.pdfDoc.numPages;

      // Get saved position if available, but validate it
      const savedPos = this.pdfPagePositions[paper.id];
      let targetPage = savedPos?.page || 1;
      let pageOffset = savedPos?.offset || 0;

      // Validate saved position - if page is out of range, start at page 1
      if (targetPage < 1 || targetPage > this.pdfDoc.numPages) {
        targetPage = 1;
        pageOffset = 0;
        // Clear invalid saved position
        delete this.pdfPagePositions[paper.id];
      }

      document.getElementById('current-page').textContent = targetPage;

      // Render with priority on the saved page
      await this.renderAllPages(targetPage, pageOffset);

      // Update mobile PDF controls after loading
      if (this.isMobileView) {
        this.updateMobilePdfControls();
      }
    } catch (error) {
      console.error('PDF load error:', error);
      container.innerHTML = `<div class="pdf-loading">Failed to load PDF: ${error.message}</div>`;
      if (this.isMobileView) {
        document.body.classList.remove('viewing-pdf');
      }
    }
  }

  /**
   * Load a temporary PDF from the in-memory cache (for ADS search papers)
   * @param {Object} paper - Paper object with bibcode
   */
  async loadTempPDF(paper) {
    const container = document.getElementById('pdf-container');
    container.innerHTML = '<div class="pdf-loading">Loading PDF from cache...</div>';

    // Cleanup previous PDF
    if (this.pdfDoc) {
      this.pdfDoc.destroy();
      this.pdfDoc = null;
    }

    // Reset rotations for temp PDFs
    this.pageRotations = {};

    try {
      // Get from cache
      const result = await window.electronAPI.tempPdfGet(paper.bibcode);

      if (!result.success) {
        container.innerHTML = '<div class="pdf-loading">PDF not in cache. Click "View PDF" to download.</div>';
        return;
      }

      // Load with PDF.js from Uint8Array
      const loadingTask = pdfjsLib.getDocument({ data: result.data });
      this.pdfDoc = await loadingTask.promise;
      this.currentPdfSource = `TEMP:${result.source}`;

      document.getElementById('total-pages').textContent = this.pdfDoc.numPages;
      document.getElementById('current-page').textContent = '1';

      // Render all pages
      await this.renderAllPages(1, 0);

      // Update mobile PDF controls if needed
      if (this.isMobileView) {
        this.updateMobilePdfControls();
        document.body.classList.add('viewing-pdf');
      }

    } catch (error) {
      console.error('Temp PDF load error:', error);
      container.innerHTML = `<div class="pdf-loading">Failed to load PDF: ${error.message}</div>`;
    }
  }

  /**
   * Download and view a temporary PDF for an ADS search paper
   * @param {Object} paper - Paper object from ADS search results
   */
  async downloadAndViewTempPDF(paper) {
    if (!paper || !paper.bibcode) {
      this.showNotification('Cannot download PDF without bibcode', 'error');
      return;
    }

    const container = document.getElementById('pdf-container');
    container.innerHTML = '<div class="pdf-loading">Downloading PDF...</div>';

    // Switch to PDF tab
    this.switchTab('pdf');

    // Set up progress listener
    window.electronAPI.onTempPdfProgress((data) => {
      if (data.bibcode === paper.bibcode) {
        const percent = data.total > 0 ? Math.round((data.received / data.total) * 100) : 0;
        const mb = (data.received / 1024 / 1024).toFixed(1);
        container.innerHTML = `<div class="pdf-loading">Downloading PDF... ${percent}% (${mb} MB)</div>`;
      }
    });

    try {
      const result = await window.electronAPI.tempPdfDownload(paper);

      // Remove progress listener
      window.electronAPI.removeTempPdfProgressListener();

      if (!result.success) {
        container.innerHTML = `<div class="pdf-loading">Download failed: ${result.error}</div>`;
        this.showNotification(`PDF download failed: ${result.error}`, 'error');
        return;
      }

      // Load with PDF.js
      container.innerHTML = '<div class="pdf-loading">Loading PDF...</div>';

      // Cleanup previous PDF
      if (this.pdfDoc) {
        this.pdfDoc.destroy();
        this.pdfDoc = null;
      }

      const loadingTask = pdfjsLib.getDocument({ data: result.data });
      this.pdfDoc = await loadingTask.promise;
      this.currentPdfSource = `TEMP:${result.source}`;
      this.pageRotations = {};

      document.getElementById('total-pages').textContent = this.pdfDoc.numPages;
      document.getElementById('current-page').textContent = '1';

      await this.renderAllPages(1, 0);

      if (this.isMobileView) {
        this.updateMobilePdfControls();
        document.body.classList.add('viewing-pdf');
      }

      this.showNotification(`PDF loaded (${result.cached ? 'cached' : result.source})`, 'success');

    } catch (error) {
      console.error('Temp PDF download error:', error);
      window.electronAPI.removeTempPdfProgressListener();
      container.innerHTML = `<div class="pdf-loading">Error: ${error.message}</div>`;
      this.showNotification(`PDF error: ${error.message}`, 'error');
    }
  }

  /**
   * Show temp PDF prompt or load from cache
   * @param {Object} paper - Paper from ADS search results
   */
  async showTempPdfPromptOrLoad(paper) {
    const container = document.getElementById('pdf-container');

    // Check if already cached
    const hasCached = await window.electronAPI.tempPdfHas(paper.bibcode);

    if (hasCached) {
      // Load from cache
      await this.loadTempPDF(paper);
    } else {
      // Show download prompt
      const hasArxiv = !!paper.arxiv_id;
      const hasDoi = !!paper.doi;
      const sources = [];
      if (hasArxiv) sources.push('arXiv');
      if (hasDoi) sources.push('Publisher');
      if (paper.bibcode) sources.push('ADS');

      container.innerHTML = `
        <div class="temp-pdf-prompt">
          <div class="temp-pdf-icon">📄</div>
          <h3>View PDF</h3>
          <p>This paper is from ADS search results. PDF will be downloaded temporarily.</p>
          ${sources.length > 0 ? `<p class="temp-pdf-sources">Available: ${sources.join(', ')}</p>` : ''}
          <button class="primary-button temp-pdf-download-btn" id="temp-pdf-download-btn">
            Download & View PDF
          </button>
          <p class="temp-pdf-note">PDF will not be saved to your library until you click "Add to Library"</p>
        </div>
      `;

      // Add click handler
      document.getElementById('temp-pdf-download-btn')?.addEventListener('click', () => {
        this.downloadAndViewTempPDF(paper);
      });
    }
  }

  async renderAllPages(scrollToPage = null, scrollPageOffset = 0) {
    // Generate unique render ID to detect if a newer render has started
    const renderId = Symbol('render');
    this.currentRenderId = renderId;

    const container = document.getElementById('pdf-container');
    container.innerHTML = '';

    // Use device pixel ratio for sharper rendering on high-DPI displays
    // Multiply by 1.2 for extra sharpness on desktop
    const dpr = (window.devicePixelRatio || 1) * 1.2;

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

  async rotatePage() {
    if (!this.pdfDoc) return;

    const currentPage = this.getCurrentVisiblePage();
    this.pageRotations[currentPage] = ((this.pageRotations[currentPage] || 0) + 90) % 360;
    this.renderSinglePage(currentPage);

    // Persist the rotation
    if (this.selectedPaper?.id) {
      try {
        await window.electronAPI.setPageRotation?.(
          this.selectedPaper.id,
          currentPage,
          this.pageRotations[currentPage],
          this.currentPdfSource
        );
      } catch (e) {
        console.warn('Failed to save page rotation:', e);
      }
    }
  }

  async renderSinglePage(pageNum) {
    const page = await this.pdfDoc.getPage(pageNum);
    const rotation = this.pageRotations[pageNum] || 0;
    const viewport = page.getViewport({ scale: this.pdfScale, rotation });

    const canvas = document.querySelector(`.pdf-page[data-page="${pageNum}"]`);
    if (!canvas) return;

    // Use device pixel ratio for sharper rendering
    // Multiply by 1.2 for extra sharpness on desktop
    const dpr = (window.devicePixelRatio || 1) * 1.2;

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

  async displayBibtex(paper) {
    // Update BibTeX content
    document.getElementById('bibtex-content').value = paper.bibtex || '';

    // Show BibTeX source if available
    const sourceInfo = document.getElementById('bibtex-source-info');
    if (paper.import_source) {
      sourceInfo.textContent = `Imported from: ${paper.import_source}`;
      sourceInfo.classList.remove('hidden');
    } else {
      sourceInfo.classList.add('hidden');
    }

    // Render the new unified Files Panel
    await this.renderFilesPanel(paper);

    // Legacy display file information (hidden, but keeping for backwards compatibility)
    const filesListEl = document.getElementById('bibtex-files-list');
    const downloadedSources = await window.electronAPI.getDownloadedPdfSources(paper.id);
    const attachments = await window.electronAPI.getAttachments(paper.id);

    const fileItems = [];

    // Add PDFs
    for (const source of downloadedSources) {
      const sourceLabels = {
        'EPRINT_PDF': 'arXiv',
        'PUB_PDF': 'Publisher',
        'ADS_PDF': 'ADS Scan',
        'LEGACY': 'PDF',
        'ATTACHED': 'Attached'
      };
      const label = sourceLabels[source] || source;
      fileItems.push(`<span class="bibtex-file-item"><span class="file-icon">📄</span>${label}<span class="file-type">PDF</span></span>`);
    }

    // Add attachments
    for (const att of attachments) {
      const icon = att.file_type === 'pdf' ? '📄' : '📎';
      fileItems.push(`<span class="bibtex-file-item"><span class="file-icon">${icon}</span>${this.escapeHtml(att.filename)}<span class="file-type">${att.file_type}</span></span>`);
    }

    if (fileItems.length > 0) {
      filesListEl.innerHTML = fileItems.join('');
    } else {
      filesListEl.innerHTML = '<span class="no-files">No files attached</span>';
    }

    // Display record information
    const recordInfoEl = document.getElementById('bibtex-record-info');
    const recordItems = [];

    if (paper.bibcode) {
      recordItems.push(`<span class="record-label">Bibcode:</span><span class="record-value"><a href="https://ui.adsabs.harvard.edu/abs/${paper.bibcode}" target="_blank">${this.escapeHtml(paper.bibcode)}</a></span>`);
    }
    if (paper.doi) {
      recordItems.push(`<span class="record-label">DOI:</span><span class="record-value"><a href="https://doi.org/${paper.doi}" target="_blank">${this.escapeHtml(paper.doi)}</a></span>`);
    }
    if (paper.arxiv_id) {
      recordItems.push(`<span class="record-label">arXiv:</span><span class="record-value"><a href="https://arxiv.org/abs/${paper.arxiv_id}" target="_blank">${this.escapeHtml(paper.arxiv_id)}</a></span>`);
    }
    if (paper.journal) {
      recordItems.push(`<span class="record-label">Journal:</span><span class="record-value">${this.escapeHtml(paper.journal)}</span>`);
    }
    if (paper.volume) {
      recordItems.push(`<span class="record-label">Volume:</span><span class="record-value">${this.escapeHtml(paper.volume)}</span>`);
    }
    if (paper.pages) {
      recordItems.push(`<span class="record-label">Pages:</span><span class="record-value">${this.escapeHtml(paper.pages)}</span>`);
    }
    if (paper.year) {
      recordItems.push(`<span class="record-label">Year:</span><span class="record-value">${paper.year}</span>`);
    }
    if (paper.citation_count !== null && paper.citation_count !== undefined) {
      recordItems.push(`<span class="record-label">Citations:</span><span class="record-value">${paper.citation_count}</span>`);
    }
    if (paper.added_date) {
      const addedDate = new Date(paper.added_date).toLocaleDateString();
      recordItems.push(`<span class="record-label">Added:</span><span class="record-value">${addedDate}</span>`);
    }

    recordInfoEl.innerHTML = recordItems.join('');
  }

  async loadReferences(paperId) {
    const refs = await window.electronAPI.getReferences(paperId);
    const refsEl = document.getElementById('refs-list');
    const toolbar = document.getElementById('refs-toolbar');

    this.currentRefs = refs;
    this.selectedRefs.clear();
    this.lastRefClickedIndex = -1;

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
      const isSelected = this.selectedRefs.has(index);
      return `
        <div class="ref-item${inLibrary ? ' in-library' : ''}${isSelected ? ' selected' : ''}" data-index="${index}" data-bibcode="${ref.ref_bibcode}">
          <div class="ref-content">
            <div class="ref-title">${this.escapeHtml(ref.ref_title || 'Untitled')}</div>
            <div class="ref-meta">${this.formatAuthorsForList(ref.ref_authors)} · ${ref.ref_year || ''}${inLibrary ? '<span class="in-library-badge">In Library</span>' : ''}</div>
          </div>
          <div class="ref-actions">
            <a class="ref-ads-link" href="#" data-bibcode="${ref.ref_bibcode}" title="Open in ADS">↗</a>
            ${!inLibrary ? `<button class="ref-import-btn" data-bibcode="${ref.ref_bibcode}" title="Add to library">+</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    refsEl.querySelectorAll('.ref-item').forEach(item => {
      const adsLink = item.querySelector('.ref-ads-link');
      const importBtn = item.querySelector('.ref-import-btn');
      const index = parseInt(item.dataset.index);
      const inLibrary = item.classList.contains('in-library');

      item.addEventListener('click', (e) => {
        if (e.target === adsLink || e.target === importBtn) return;
        if (inLibrary) return; // Can't select items already in library
        this.handleRefClick(index, e);
      });

      adsLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const bibcode = item.dataset.bibcode;
        if (bibcode) {
          window.electronAPI.openExternal(`https://ui.adsabs.harvard.edu/abs/${bibcode}`);
        }
      });

      importBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const bibcode = item.dataset.bibcode;
        if (bibcode) {
          this.importSingleBibcode(bibcode, 'ref');
        }
      });
    });
  }

  // Handle ref item click with Cmd/Shift support
  handleRefClick(index, event) {
    const isMeta = event.metaKey || event.ctrlKey;
    const isShift = event.shiftKey;
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));

    if (isShift && this.lastRefClickedIndex >= 0) {
      // Range select
      const start = Math.min(this.lastRefClickedIndex, index);
      const end = Math.max(this.lastRefClickedIndex, index);
      if (!isMeta) this.selectedRefs.clear();
      for (let i = start; i <= end; i++) {
        const ref = this.currentRefs[i];
        if (ref && !libraryBibcodes.has(ref.ref_bibcode)) {
          this.selectedRefs.add(i);
        }
      }
    } else if (isMeta) {
      // Toggle select
      if (this.selectedRefs.has(index)) {
        this.selectedRefs.delete(index);
      } else {
        this.selectedRefs.add(index);
      }
    } else {
      // Single select
      this.selectedRefs.clear();
      this.selectedRefs.add(index);
    }

    this.lastRefClickedIndex = index;
    this.updateRefListSelection();
  }

  // Update visual selection state for refs
  updateRefListSelection() {
    document.querySelectorAll('.ref-item').forEach(item => {
      const index = parseInt(item.dataset.index);
      item.classList.toggle('selected', this.selectedRefs.has(index));
    });
  }

  async loadCitations(paperId) {
    const cites = await window.electronAPI.getCitations(paperId);
    const citesEl = document.getElementById('cites-list');
    const toolbar = document.getElementById('cites-toolbar');

    this.currentCites = cites;
    this.selectedCites.clear();
    this.lastCiteClickedIndex = -1;

    if (cites.length === 0) {
      citesEl.innerHTML = '<p class="no-content">No citations loaded. Click "Sync" to retrieve from ADS.</p>';
      toolbar.classList.add('hidden');
      return;
    }

    // Check which cites are already in library
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));

    toolbar.classList.remove('hidden');
    document.getElementById('cites-count').textContent = `${cites.length} citations`;

    // Hide limit controls if we already have all citations (less than default limit)
    const citesLimitControls = document.querySelector('.cites-limit-controls');
    if (citesLimitControls) {
      citesLimitControls.style.display = cites.length < 50 ? 'none' : '';
    }

    citesEl.innerHTML = cites.map((cite, index) => {
      const inLibrary = libraryBibcodes.has(cite.citing_bibcode);
      const isSelected = this.selectedCites.has(index);
      return `
        <div class="cite-item${inLibrary ? ' in-library' : ''}${isSelected ? ' selected' : ''}" data-index="${index}" data-bibcode="${cite.citing_bibcode}">
          <div class="cite-content">
            <div class="cite-title">${this.escapeHtml(cite.citing_title || 'Untitled')}</div>
            <div class="cite-meta">${this.formatAuthorsForList(cite.citing_authors)} · ${cite.citing_year || ''}${inLibrary ? '<span class="in-library-badge">In Library</span>' : ''}</div>
          </div>
          <div class="cite-actions">
            <a class="cite-ads-link" href="#" data-bibcode="${cite.citing_bibcode}" title="Open in ADS">↗</a>
            ${!inLibrary ? `<button class="cite-import-btn" data-bibcode="${cite.citing_bibcode}" title="Add to library">+</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    citesEl.querySelectorAll('.cite-item').forEach(item => {
      const adsLink = item.querySelector('.cite-ads-link');
      const importBtn = item.querySelector('.cite-import-btn');
      const index = parseInt(item.dataset.index);
      const inLibrary = item.classList.contains('in-library');

      item.addEventListener('click', (e) => {
        if (e.target === adsLink || e.target === importBtn) return;
        if (inLibrary) return; // Can't select items already in library
        this.handleCiteClick(index, e);
      });

      adsLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const bibcode = item.dataset.bibcode;
        if (bibcode) {
          window.electronAPI.openExternal(`https://ui.adsabs.harvard.edu/abs/${bibcode}`);
        }
      });

      importBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const bibcode = item.dataset.bibcode;
        if (bibcode) {
          this.importSingleBibcode(bibcode, 'cite');
        }
      });
    });
  }

  // Handle cite item click with Cmd/Shift support
  handleCiteClick(index, event) {
    const isMeta = event.metaKey || event.ctrlKey;
    const isShift = event.shiftKey;
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));

    if (isShift && this.lastCiteClickedIndex >= 0) {
      // Range select
      const start = Math.min(this.lastCiteClickedIndex, index);
      const end = Math.max(this.lastCiteClickedIndex, index);
      if (!isMeta) this.selectedCites.clear();
      for (let i = start; i <= end; i++) {
        const cite = this.currentCites[i];
        if (cite && !libraryBibcodes.has(cite.citing_bibcode)) {
          this.selectedCites.add(i);
        }
      }
    } else if (isMeta) {
      // Toggle select
      if (this.selectedCites.has(index)) {
        this.selectedCites.delete(index);
      } else {
        this.selectedCites.add(index);
      }
    } else {
      // Single select
      this.selectedCites.clear();
      this.selectedCites.add(index);
    }

    this.lastCiteClickedIndex = index;
    this.updateCiteListSelection();
  }

  // Update visual selection state for cites
  updateCiteListSelection() {
    document.querySelectorAll('.cite-item').forEach(item => {
      const index = parseInt(item.dataset.index);
      item.classList.toggle('selected', this.selectedCites.has(index));
    });
  }

  /**
   * Fetch all references from ADS (no limit)
   */
  async fetchRefsFromADS() {
    if (!this.selectedPaper?.bibcode) {
      this.showNotification('Paper has no bibcode - cannot fetch from ADS', 'error');
      return;
    }

    const loadAllBtn = document.getElementById('refs-load-all');

    // Disable button during fetch
    if (loadAllBtn) {
      loadAllBtn.disabled = true;
      loadAllBtn.textContent = 'Loading...';
    }

    try {
      // Fetch all references (no limit)
      const result = await window.electronAPI.adsGetReferences(this.selectedPaper.bibcode, { limit: 2000 });
      if (result.success && result.data) {
        // Store refs in database
        await window.electronAPI.addReferences(this.selectedPaper.id, result.data.map(r => ({
          bibcode: r.bibcode,
          title: r.title?.[0] || r.title,
          authors: Array.isArray(r.author) ? r.author.join(', ') : r.author,
          year: r.year
        })));
        // Reload from database
        await this.loadReferences(this.selectedPaper.id);
        this.showNotification(`Loaded ${result.data.length} references`, 'success');
      } else {
        this.showNotification(result.error || 'Failed to fetch references', 'error');
      }
    } catch (err) {
      this.showNotification(`Error fetching references: ${err.message}`, 'error');
    } finally {
      if (loadAllBtn) {
        loadAllBtn.disabled = false;
        loadAllBtn.textContent = 'Load All';
      }
    }
  }

  /**
   * Fetch citations from ADS with custom limit
   * @param {number} [limit] - Number of cites to fetch (uses input value if not provided)
   */
  async fetchCitesFromADS(limit = null) {
    if (!this.selectedPaper?.bibcode) {
      this.showNotification('Paper has no bibcode - cannot fetch from ADS', 'error');
      return;
    }

    const limitInput = document.getElementById('cites-limit-input');
    const actualLimit = limit || parseInt(limitInput.value) || 50;
    const loadBtn = document.getElementById('cites-load-more');
    const loadAllBtn = document.getElementById('cites-load-all');

    // Disable buttons during fetch
    loadBtn.disabled = true;
    loadAllBtn.disabled = true;
    loadBtn.textContent = 'Loading...';

    try {
      const result = await window.electronAPI.adsGetCitations(this.selectedPaper.bibcode, { limit: actualLimit });
      if (result.success && result.data) {
        // Store cites in database
        await window.electronAPI.addCitations(this.selectedPaper.id, result.data.map(c => ({
          bibcode: c.bibcode,
          title: c.title?.[0] || c.title,
          authors: Array.isArray(c.author) ? c.author.join(', ') : c.author,
          year: c.year
        })));
        // Reload from database
        await this.loadCitations(this.selectedPaper.id);
        this.showNotification(`Loaded ${result.data.length} citations`, 'success');
      } else {
        this.showNotification(result.error || 'Failed to fetch citations', 'error');
      }
    } catch (err) {
      this.showNotification(`Error fetching citations: ${err.message}`, 'error');
    } finally {
      loadBtn.disabled = false;
      loadAllBtn.disabled = false;
      loadBtn.textContent = 'Load';
    }
  }

  // Refs selection methods
  selectAllRefs() {
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));
    this.selectedRefs.clear();
    this.currentRefs.forEach((ref, index) => {
      if (!libraryBibcodes.has(ref.ref_bibcode)) {
        this.selectedRefs.add(index);
      }
    });
    this.updateRefListSelection();
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
  selectAllCites() {
    const libraryBibcodes = new Set(this.papers.map(p => p.bibcode).filter(Boolean));
    this.selectedCites.clear();
    this.currentCites.forEach((cite, index) => {
      if (!libraryBibcodes.has(cite.citing_bibcode)) {
        this.selectedCites.add(index);
      }
    });
    this.updateCiteListSelection();
  }

  async importSelectedCites() {
    if (this.selectedCites.size === 0) return;

    const papers = Array.from(this.selectedCites).map(index => {
      const cite = this.currentCites[index];
      return { bibcode: cite.citing_bibcode };
    });

    await this.importPapersFromBibcodes(papers, 'cites');
  }

  /**
   * Import a single bibcode from refs or cites list
   * @param {string} bibcode - The bibcode to import
   * @param {string} source - 'ref' or 'cite' for notification message
   */
  async importSingleBibcode(bibcode, source) {
    const papers = [{ bibcode }];
    await this.importPapersFromBibcodes(papers, source === 'ref' ? 'refs' : 'cites');
  }

  /**
   * Attach a dropped PDF file to a paper
   * @param {number} paperId - The paper ID to attach the PDF to
   * @param {string} pdfPath - Path to the PDF file
   */
  async attachDroppedPdf(paperId, pdfPath) {
    try {
      const paper = this.papers.find(p => p.id === paperId);
      if (!paper) {
        this.showNotification('Paper not found', 'error');
        return;
      }

      // Call IPC to copy PDF to library and update database
      const result = await window.electronAPI.attachPdfToPaper(paperId, pdfPath);
      if (result.success) {
        // Update local paper object
        paper.pdf_path = result.pdfPath;
        paper.pdf_source = 'ATTACHED';

        // Set as last viewed source so it shows by default
        this.lastPdfSources[paperId] = 'ATTACHED';
        window.electronAPI.setLastPdfSource(paperId, 'ATTACHED');

        // Re-render to show PDF button
        this.renderPaperList();
        // If this paper is selected, refresh detail view and switch to PDF tab
        if (this.selectedPaper?.id === paperId) {
          this.selectedPaper = paper;
          // Refresh the Files Panel immediately so it shows the new file
          await this.renderFilesPanel(paper);
          this.switchTab('pdf');
          await this.displayPaper(paperId);
        }
        this.showNotification(`PDF attached to "${paper.title?.substring(0, 30)}..."`, 'success');
      } else {
        this.showNotification(result.error || 'Failed to attach PDF', 'error');
      }
    } catch (err) {
      this.showNotification(`Error attaching PDF: ${err.message}`, 'error');
    }
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
    // Handle Papers tab on mobile - switch to papers view
    if (tabName === 'papers') {
      this.showMobileView('papers');
      return;
    }

    // Track previous tab for returning after library/collection selection
    // But don't track 'library' as previous tab (so we always return to a content tab)
    if (tabName !== 'library' && this.currentTab && this.currentTab !== 'library') {
      this.previousTab = this.currentTab;
    }
    this.currentTab = tabName;

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('hidden', pane.id !== `tab-${tabName}`);
      pane.classList.toggle('active', pane.id === `tab-${tabName}`);
    });

    // On mobile, switch to detail view for content tabs
    if (this.isMobileView) {
      if (['pdf', 'abstract', 'refs', 'cites', 'bibtex', 'ai', 'library'].includes(tabName)) {
        this.showMobileView('detail');
      }
    }

    // Toggle viewing-pdf class for PDF-specific UI (floating back button, hide top bar)
    document.body.classList.toggle('viewing-pdf', tabName === 'pdf' && this.isMobileView);

    // Load library tab content when switching to it
    if (tabName === 'library') {
      this.renderLibrariesTab();
      this.renderCollectionsTab();
    }

    // Load AI panel data when switching to AI tab
    if (tabName === 'ai' && this.selectedPaper) {
      this.loadAIPanelData();
    }

    // When switching to PDF tab, ensure we load the correct paper's PDF
    if (tabName === 'pdf' && this.selectedPaper) {
      if (this.currentSmartSearch) {
        // ADS search paper - check for cached temp PDF or show download prompt
        this.showTempPdfPromptOrLoad(this.selectedPaper);
      } else {
        this.loadPDF(this.selectedPaper);
      }
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

  // Switch between full-screen views on mobile
  showMobileView(view) {
    if (!this.isMobileView) return;

    // Special case: Libraries shows an overlay, not a view
    if (view === 'libraries') {
      this.showMobileLibraryPicker();
      return;
    }

    this.currentMobileView = view;

    // Hide all mobile views
    document.querySelectorAll('[data-mobile-view]').forEach(el => {
      el.classList.remove('mobile-active');
    });

    // Show selected view
    const viewEl = document.querySelector(`[data-mobile-view="${view}"]`);
    if (viewEl) {
      viewEl.classList.add('mobile-active');
    }

    // Update body class for CSS
    document.body.classList.toggle('showing-detail', view === 'detail');
    document.body.classList.toggle('showing-papers', view === 'papers');

    // Update top bar state for back button visibility
    document.getElementById('mobile-top-bar')?.classList.toggle('showing-detail', view === 'detail');

    // Update Papers tab active state
    document.querySelectorAll('.tab-btn').forEach(btn => {
      if (btn.dataset.tab === 'papers') {
        btn.classList.toggle('active', view === 'papers');
      }
    });

    // Logo is static now - no need to update title text

    // Remove viewing-pdf when going back to papers
    if (view === 'papers') {
      document.body.classList.remove('viewing-pdf');
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
        await this.displayBibtex(paper);
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
          <p class="paper-abstract">${paper.abstract ? this.sanitizeAbstract(paper.abstract) : '<em>No abstract available</em>'}</p>
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

    // Hide limit controls if we already have all citations (less than default limit)
    const citesLimitControls = document.querySelector('.cites-limit-controls');
    if (citesLimitControls) {
      citesLimitControls.style.display = allCites.length < 50 ? 'none' : '';
    }

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

    // Exit smart search mode when selecting a built-in view
    if (this.currentSmartSearch) {
      this.exitSmartSearchView();
    }

    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.classList.toggle('active', item.dataset.view === view);
    });
    document.querySelectorAll('.nav-item[data-collection]').forEach(item => {
      item.classList.remove('active');
    });

    this.updateFilterLabel();
    this.loadPapers();
  }

  async selectCollection(collectionId) {
    this.currentCollection = collectionId;
    this.currentView = null;

    // Exit smart search mode when selecting a collection
    if (this.currentSmartSearch) {
      this.exitSmartSearchView();
    }

    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.classList.remove('active');
    });
    document.querySelectorAll('.nav-item[data-collection]').forEach(item => {
      item.classList.toggle('active', parseInt(item.dataset.collection) === collectionId);
    });

    this.updateFilterLabel();
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

  async importFiles() {
    // Unified import for PDFs and BibTeX files
    const result = await window.electronAPI.importFiles();

    if (result.canceled) return;

    const pdfs = result.results?.pdfs || [];
    const bibtex = result.results?.bibtex || { imported: 0, skipped: 0 };

    // Reload papers if anything was imported
    if (pdfs.length > 0 || bibtex.imported > 0) {
      await this.loadPapers();
      const info = await window.electronAPI.getLibraryInfo(this.libraryPath);
      if (info) this.updateLibraryDisplay(info);
    }

    // Select first successfully imported PDF paper
    const firstSuccess = pdfs.find(r => r.success);
    if (firstSuccess) {
      this.selectPaper(firstSuccess.id);
    }

    // Log BibTeX import results
    if (bibtex.imported > 0 || bibtex.skipped > 0) {
      const message = `Imported ${bibtex.imported} papers from BibTeX` +
        (bibtex.skipped > 0 ? `, skipped ${bibtex.skipped} duplicates` : '');
      console.log('BibTeX import:', message);
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
      document.body.classList.remove('has-selected-paper');
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
      const mobileRating = document.getElementById('mobile-rating-select');
      if (mobileRating) mobileRating.value = rating;
    }

    this.renderPaperList();
  }

  // ===== Mobile Action Grid Methods =====

  showRatingPicker(paperId) {
    // Create a simple rating picker overlay
    const paper = this.papers.find(p => p.id === paperId);
    if (!paper) return;

    // Remove any existing picker
    document.getElementById('mobile-rating-picker')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'mobile-rating-picker';
    overlay.className = 'mobile-picker-overlay';
    overlay.innerHTML = `
      <div class="mobile-picker-modal">
        <div class="mobile-picker-header">
          <h3>Rate Paper</h3>
          <button class="mobile-picker-close">&times;</button>
        </div>
        <div class="mobile-picker-options">
          <button class="mobile-picker-option ${paper.rating === 1 ? 'selected' : ''}" data-rating="1">
            <span class="picker-icon">&#127775;</span>
            <span class="picker-label">Seminal</span>
          </button>
          <button class="mobile-picker-option ${paper.rating === 2 ? 'selected' : ''}" data-rating="2">
            <span class="picker-icon">&#11088;</span>
            <span class="picker-label">Important</span>
          </button>
          <button class="mobile-picker-option ${paper.rating === 3 ? 'selected' : ''}" data-rating="3">
            <span class="picker-icon">&#128196;</span>
            <span class="picker-label">Useful</span>
          </button>
          <button class="mobile-picker-option ${!paper.rating ? 'selected' : ''}" data-rating="0">
            <span class="picker-icon">&#10060;</span>
            <span class="picker-label">Clear Rating</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Handle option selection
    overlay.querySelectorAll('.mobile-picker-option').forEach(btn => {
      btn.addEventListener('click', async () => {
        const rating = parseInt(btn.dataset.rating);
        await this.updatePaperRating(paperId, rating);
        overlay.remove();
      });
    });

    // Handle close
    overlay.querySelector('.mobile-picker-close').addEventListener('click', () => {
      overlay.remove();
    });

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  async cycleReadStatus(paperId) {
    const paper = this.papers.find(p => p.id === paperId);
    if (!paper) return;

    // Cycle through: unread -> reading -> read -> unread
    const statusOrder = ['unread', 'reading', 'read'];
    const currentIndex = statusOrder.indexOf(paper.read_status || 'unread');
    const nextIndex = (currentIndex + 1) % statusOrder.length;
    const newStatus = statusOrder[nextIndex];

    await this.updatePaperStatus(paperId, newStatus);

    // Show brief notification
    const statusLabels = { unread: 'Unread', reading: 'Reading', read: 'Read' };
    this.showNotification(`Status: ${statusLabels[newStatus]}`, 'info');
  }

  async sharePaper() {
    if (!this.selectedPaper) return;

    const paper = this.selectedPaper;
    const title = paper.title || 'Untitled Paper';
    const authors = paper.authors || '';
    const year = paper.year || '';
    const bibcode = paper.bibcode || '';

    // Build share text
    let shareText = title;
    if (authors) shareText += `\n${authors}`;
    if (year) shareText += ` (${year})`;
    if (bibcode) {
      shareText += `\nhttps://ui.adsabs.harvard.edu/abs/${bibcode}`;
    }

    // Try native share API (available on iOS/mobile)
    if (navigator.share) {
      try {
        await navigator.share({
          title: title,
          text: shareText,
          url: bibcode ? `https://ui.adsabs.harvard.edu/abs/${bibcode}` : undefined
        });
      } catch (err) {
        if (err.name !== 'AbortError') {
          // User didn't cancel, so fallback to clipboard
          await navigator.clipboard.writeText(shareText);
          this.showNotification('Copied to clipboard', 'success');
        }
      }
    } else {
      // Fallback: copy to clipboard
      await navigator.clipboard.writeText(shareText);
      this.showNotification('Copied to clipboard', 'success');
    }
  }

  updateBottomBarButtonStates() {
    const hasSelection = this.selectedPaper !== null;
    const hasSingleSelection = this.selectedPapers.size === 1;
    const hasBibcode = hasSelection && this.selectedPaper?.bibcode;

    // Rating dropdown - enabled when paper selected
    const ratingSelect = document.getElementById('paper-rating-select');
    if (ratingSelect) ratingSelect.disabled = !hasSelection;

    // Attach button - only enabled for single selection
    const attachBtn = document.getElementById('attach-file-btn');
    if (attachBtn) attachBtn.disabled = !hasSingleSelection;

    // Cite button - enabled when any paper selected
    const citeBtn = document.getElementById('copy-cite-btn');
    if (citeBtn) citeBtn.disabled = !hasSelection;

    // Link button - enabled when paper has bibcode
    const linkBtn = document.getElementById('open-ads-btn');
    if (linkBtn) linkBtn.disabled = !hasBibcode;
  }

  async fetchMetadata() {
    if (!this.selectedPaper || !this.hasAdsToken) return;

    // If paper already has a bibcode, try syncing first
    if (this.selectedPaper.bibcode) {
      this.consoleLog(`Syncing ${this.selectedPaper.bibcode} with ADS...`, 'info');
      try {
        const result = await window.electronAPI.adsSyncPapers([this.selectedPaper.id]);
        if (result.success && result.updated > 0) {
          this.consoleLog(`Synced successfully`, 'success');
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
        this.consoleLog(`Sync failed: ${e.message}`, 'warn');
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

    this.consoleLog('Opening ADS lookup...', 'info');

    modal.classList.remove('hidden');

    // Check if paper has DOI - use it directly
    if (this.selectedPaper.doi) {
      let doi = this.selectedPaper.doi;
      doi = doi.replace(/^https?:\/\/doi\.org\//i, '');
      doi = doi.replace(/^doi:/i, '');
      queryInput.value = `doi:"${doi}"`;
      statusEl.classList.remove('hidden');
      statusText.textContent = 'Paper has DOI. Click Search to find in ADS.';
      this.consoleLog(`Using DOI for search: ${doi}`, 'info');
      resultsEl.innerHTML = '<div class="ads-empty-state"><p>Click Search to find matching papers in ADS</p></div>';
      return;
    }

    // Extract metadata using LLM
    statusEl.classList.remove('hidden');
    statusText.textContent = 'Extracting metadata with AI...';
    this.consoleLog('Extracting metadata with AI...', 'info');

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
      this.consoleLog(`Using DOI for search: ${doi}`, 'info');
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
    this.consoleLog(`Built search query from paper metadata`, 'info');
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

    // Check if on refs/cites tab with selections - import those instead
    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (activeTab === 'refs' && this.selectedRefs.size > 0) {
      await this.importSelectedRefs();
      return;
    }
    if (activeTab === 'cites' && this.selectedCites.size > 0) {
      await this.importSelectedCites();
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
    const syncBtn = document.getElementById('sync-tab-btn');
    syncBtn?.classList.add('syncing');
    if (syncBtn) syncBtn.disabled = true;

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

        syncBtn?.classList.remove('syncing');
        if (syncBtn) syncBtn.disabled = false;

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

                // On desktop, check if PDF is now available and switch to PDF tab
                // On mobile, stay in list view - user navigates via tab bar
                if (this.isMobileView) {
                  this.showMobileView('papers');
                } else {
                  const downloadedSources = await window.electronAPI.getDownloadedPdfSources(paper.id);
                  const attachments = await window.electronAPI.getAttachments(paper.id);
                  const pdfAttachments = attachments.filter(a => a.file_type === 'pdf');
                  const hasAnyPdf = downloadedSources.length > 0 || pdfAttachments.length > 0 || !!paper.pdf_path;

                  if (hasAnyPdf) {
                    const currentTab = document.querySelector('.tab-btn.active')?.dataset.tab;
                    if (currentTab !== 'pdf') {
                      this.switchTab('pdf');
                      await this.loadPDF(paper);
                    }
                  }
                }
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
        this.consoleLog(`Imported from ADS${pdfMsg}`, 'success');

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

  enterBibtexEditMode() {
    const textarea = document.getElementById('bibtex-content');
    const editBtn = document.getElementById('edit-bibtex-btn');
    const saveBtn = document.getElementById('save-bibtex-btn');
    const cancelBtn = document.getElementById('cancel-bibtex-btn');

    // Store original value for cancel
    this.originalBibtex = textarea.value;

    // Enable editing
    textarea.removeAttribute('readonly');
    textarea.classList.add('editing');

    // Toggle buttons
    editBtn.classList.add('hidden');
    saveBtn.classList.remove('hidden');
    cancelBtn.classList.remove('hidden');

    // Focus textarea
    textarea.focus();
  }

  exitBibtexEditMode(restoreOriginal = false) {
    const textarea = document.getElementById('bibtex-content');
    const editBtn = document.getElementById('edit-bibtex-btn');
    const saveBtn = document.getElementById('save-bibtex-btn');
    const cancelBtn = document.getElementById('cancel-bibtex-btn');

    // Restore original value if canceling
    if (restoreOriginal && this.originalBibtex !== undefined) {
      textarea.value = this.originalBibtex;
    }

    // Disable editing
    textarea.setAttribute('readonly', '');
    textarea.classList.remove('editing');

    // Toggle buttons
    editBtn.classList.remove('hidden');
    saveBtn.classList.add('hidden');
    cancelBtn.classList.add('hidden');

    // Clear stored original
    this.originalBibtex = undefined;
  }

  toggleShortcuts() {
    const summary = document.getElementById('shortcuts-summary');
    const grid = document.getElementById('shortcuts-grid');

    const isExpanded = summary.classList.toggle('expanded');
    grid.classList.toggle('hidden', !isExpanded);

    // Persist state
    localStorage.setItem('shortcutsExpanded', isExpanded);
  }

  async saveBibtex() {
    if (!this.selectedPaper) return;

    const textarea = document.getElementById('bibtex-content');
    const bibtex = textarea.value.trim();

    if (!bibtex) return;

    const btn = document.getElementById('save-bibtex-btn');
    const originalText = btn.textContent;
    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
      const result = await window.electronAPI.saveBibtex(this.selectedPaper.id, bibtex);

      if (result.success) {
        // Update local paper object with new metadata
        Object.assign(this.selectedPaper, result.paper);

        // Update the papers array
        const index = this.papers.findIndex(p => p.id === this.selectedPaper.id);
        if (index !== -1) {
          this.papers[index] = result.paper;
        }

        // Refresh paper list to show updated title/authors
        this.renderPaperList();

        // Update the detail view
        document.getElementById('paper-title').textContent = result.paper.title || 'Untitled';
        document.getElementById('paper-authors').textContent = result.paper.authors?.slice(0, 3).join(', ') || '';
        document.getElementById('paper-year').textContent = result.paper.year || '';
        document.getElementById('paper-journal').textContent = result.paper.journal || '';

        // Update abstract if present
        const abstractEl = document.getElementById('abstract-content');
        if (result.paper.abstract) {
          abstractEl.innerHTML = `<p>${this.sanitizeAbstract(result.paper.abstract)}</p>`;
        }

        btn.textContent = '✓ Saved!';
        btn.disabled = false;

        // Exit edit mode after brief success message
        setTimeout(() => {
          this.exitBibtexEditMode();
        }, 800);
      } else {
        btn.textContent = 'Error';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.disabled = false;
        }, 1500);
        console.error('Failed to save BibTeX:', result.error);
      }
    } catch (error) {
      console.error('Error saving BibTeX:', error);
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }

  openInADS() {
    if (!this.selectedPaper?.bibcode) return;
    window.electronAPI.openExternal(`https://ui.adsabs.harvard.edu/abs/${this.selectedPaper.bibcode}`);
  }

  async attachFiles() {
    // Only allow attaching to single paper selection
    if (this.selectedPapers.size > 1) {
      this.consoleLog('Cannot attach files to multiple papers at once', 'warn');
      return;
    }

    if (!this.selectedPaper) {
      this.consoleLog('No paper selected', 'warn');
      return;
    }

    const result = await window.electronAPI.attachFiles(
      this.selectedPaper.id,
      this.selectedPaper.bibcode
    );

    if (result.success && result.attachments?.length > 0) {
      this.consoleLog(`Attached ${result.attachments.length} file(s)`, 'success');
    }
  }

  updateAttachButtonState() {
    const btn = document.getElementById('attach-file-btn');
    if (!btn) return;

    const disabled = this.selectedPapers.size !== 1;
    btn.disabled = disabled;
    btn.classList.toggle('disabled', disabled);
  }

  openSelectedPaperInADS() {
    this.hideContextMenu();
    // If multiple selected, open the first one; otherwise use rightClickedPaper or selectedPaper
    const paper = this.rightClickedPaper || this.selectedPaper;
    if (!paper?.bibcode) return;
    window.electronAPI.openExternal(`https://ui.adsabs.harvard.edu/abs/${paper.bibcode}`);
  }

  async openPublisherPDF() {
    this.hideContextMenu();
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
  // NOTE: This legacy dropdown is still used by paper list PDF source buttons.
  // The new unified Files Panel (renderFilesPanel) handles file management in the BibTeX tab.
  // Consider migrating paper list to use the new Files Panel pattern in a future update.
  async showPdfSourceDropdown(btn, paperId, bibcode) {
    // Select this paper so the PDF viewer shows the right paper
    this.selectPaper(paperId);

    // Hide any existing dropdown
    this.hidePdfSourceDropdown();

    // Show loading state
    btn.textContent = '⏳';

    try {
      // Fetch attachments first (always available even without bibcode)
      const attachments = await window.electronAPI.getAttachments(paperId);

      // Try to fetch ADS sources (only if we have a bibcode)
      let sources = { arxiv: false, publisher: false, ads: false };
      if (bibcode) {
        const result = await window.electronAPI.adsGetEsources(bibcode);
        if (result.success) {
          sources = result.data;
        }
      }

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
      // Include sources that are either available from ADS OR already downloaded
      const availableSources = [];
      for (const sourceType of priority) {
        const info = sourceInfo[sourceType];
        if (!info) continue;

        const downloaded = downloadedPdfs.includes(sourceType);
        const available = info.available || downloaded; // Show if available OR already downloaded

        if (available) {
          const count = annotationCounts[sourceType] || 0;
          availableSources.push({ type: info.type, label: info.label, noteCount: count, downloaded });
        }
      }

      // Add ATTACHED PDF if it exists (drag-drop attached PDFs)
      if (downloadedPdfs.includes('ATTACHED')) {
        const count = annotationCounts['ATTACHED'] || 0;
        availableSources.push({ type: 'ATTACHED', label: '📎 Attached', noteCount: count, downloaded: true });
      }

      // If no sources available AND no attachments
      if (availableSources.length === 0 && attachments.length === 0) {
        alert('No PDF sources available for this paper');
        return;
      }

      // If only one source and no attachments, download/show it directly
      if (availableSources.length === 1 && attachments.length === 0) {
        await this.downloadFromSource(paperId, availableSources[0].type, null);
        return;
      }

      // If no ADS sources but has exactly one PDF attachment, open it directly
      if (availableSources.length === 0 && attachments.length === 1 && attachments[0].file_type === 'pdf') {
        const paper = this.papers.find(p => p.id === paperId);
        if (paper) {
          const filename = attachments[0].filename;
          paper.pdf_path = `papers/${filename}`;
          this.selectedPaper = paper;
          this.switchTab('pdf');
          await this.loadPDF(paper);
          // Save as last viewed
          this.lastPdfSources[paperId] = `ATTACHMENT:${filename}`;
          window.electronAPI.setLastPdfSource(paperId, `ATTACHMENT:${filename}`);
        }
        return;
      }

      // Multiple sources - show bottom sheet on mobile, dropdown on desktop
      if (this.isMobileView) {
        this.showPdfSourceSheet(paperId, availableSources, attachments);
        return;
      }

      // Desktop: show dropdown menu
      const dropdown = document.createElement('div');
      dropdown.className = 'pdf-source-dropdown';
      dropdown.dataset.paperId = paperId;

      dropdown.innerHTML = availableSources.map(s => {
        const notesBadge = s.noteCount > 0 ? `<span class="note-count-badge">${s.noteCount} 📝</span>` : '';
        const statusIcon = s.downloaded ? '✓' : '⬇';
        const actionLabel = s.downloaded ? 'View' : 'Download';
        return `<div class="pdf-source-item${s.downloaded ? ' downloaded' : ''}" data-source="${s.type}">
          <span class="source-status">${statusIcon}</span>
          <span class="source-label">${s.label}</span>
          <span class="source-action">${actionLabel}</span>
          ${notesBadge}
        </div>`;
      }).join('');

      // Add attachments section (already fetched earlier)
      if (attachments.length > 0) {
        // Only show separator if there are also ADS sources
        if (availableSources.length > 0) {
          dropdown.innerHTML += '<div class="pdf-source-separator"></div>';
        }
        dropdown.innerHTML += attachments.map(att => {
          const icon = att.file_type === 'pdf' ? '📄' : '📎';
          return `<div class="pdf-source-item attachment-item" data-attachment-id="${att.id}" data-filename="${att.filename}" data-is-pdf="${att.file_type === 'pdf'}">
            <span class="source-status">${icon}</span>
            <span class="source-label">${att.original_name}</span>
            <span class="source-action">View</span>
          </div>`;
        }).join('');
      }

      // Position dropdown below button
      const btnRect = btn.getBoundingClientRect();
      dropdown.style.position = 'fixed';
      dropdown.style.left = `${btnRect.left}px`;
      dropdown.style.top = `${btnRect.bottom + 2}px`;

      document.body.appendChild(dropdown);

      // Add click handlers for PDF source items (not attachments)
      dropdown.querySelectorAll('.pdf-source-item:not(.attachment-item)').forEach(item => {
        item.addEventListener('click', async (e) => {
          // Don't trigger if clicking delete button
          if (e.target.classList.contains('pdf-delete-btn')) return;
          e.stopPropagation();
          const sourceType = item.dataset.source;
          await this.downloadFromSource(paperId, sourceType, item);
        });
      });

      // Add click handlers for attachment items
      dropdown.querySelectorAll('.attachment-item').forEach(item => {
        item.addEventListener('click', async (e) => {
          // Don't trigger if clicking delete button
          if (e.target.classList.contains('attachment-delete-btn')) return;
          e.stopPropagation();

          const filename = item.dataset.filename;
          const isPdf = item.dataset.isPdf === 'true';

          if (isPdf) {
            // Load PDF in viewer - update paper's pdf_path and load
            const paper = this.papers.find(p => p.id === paperId);
            if (paper) {
              paper.pdf_path = `papers/${filename}`;
              this.selectedPaper = paper;
              this.switchTab('pdf');
              await this.loadPDF(paper);
              // Save as last viewed (use filename as identifier for attachments)
              this.lastPdfSources[paperId] = `ATTACHMENT:${filename}`;
              window.electronAPI.setLastPdfSource(paperId, `ATTACHMENT:${filename}`);
            }
          } else {
            // Open with system default app
            await window.electronAPI.openAttachment(filename);
          }
          this.hidePdfSourceDropdown();
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

  // Mobile bottom sheet for PDF source selection
  showPdfSourceSheet(paperId, availableSources, attachments) {
    const overlay = document.getElementById('pdf-source-sheet-overlay');
    const sheet = document.getElementById('pdf-source-sheet');
    const optionsContainer = document.getElementById('sheet-options');

    if (!overlay || !sheet || !optionsContainer) return;

    // Store paperId for later use
    this.sheetPaperId = paperId;

    // Build options HTML
    let html = '';

    // PDF sources
    if (availableSources.length > 0) {
      html += '<div class="sheet-section-label">PDF Sources</div>';
      availableSources.forEach(s => {
        const notesBadge = s.noteCount > 0 ? `<span class="note-count-badge">${s.noteCount} notes</span>` : '';
        const statusIcon = s.downloaded ? '✓' : '⬇';
        const actionLabel = s.downloaded ? 'View' : 'Download';
        const icon = s.label.split(' ')[0]; // Get emoji from label
        const labelText = s.label.split(' ').slice(1).join(' '); // Get text without emoji

        html += `
          <div class="sheet-option${s.downloaded ? ' downloaded' : ''}" data-source="${s.type}">
            <div class="sheet-option-content">
              <span class="sheet-option-icon">${statusIcon} ${icon}</span>
              <span class="sheet-option-label">${labelText}</span>
            </div>
            <div class="sheet-option-meta">
              <span class="sheet-action-label">${actionLabel}</span>
              ${notesBadge}
            </div>
          </div>
        `;
      });
    }

    // Attachments
    if (attachments.length > 0) {
      if (availableSources.length > 0) {
        html += '<div class="sheet-separator"></div>';
      }
      html += '<div class="sheet-section-label">Attachments</div>';
      attachments.forEach(att => {
        const icon = att.file_type === 'pdf' ? '📄' : '📎';
        html += `
          <div class="sheet-option attachment-option" data-attachment-id="${att.id}" data-filename="${att.filename}" data-is-pdf="${att.file_type === 'pdf'}">
            <div class="sheet-option-content">
              <span class="sheet-option-icon">${icon}</span>
              <span class="sheet-option-label">${att.original_name}</span>
            </div>
            <div class="sheet-option-meta">
              <span class="sheet-action-label">View</span>
            </div>
          </div>
        `;
      });
    }

    // Cancel button
    html += '<button class="sheet-cancel" id="sheet-cancel-btn">Cancel</button>';

    optionsContainer.innerHTML = html;

    // Show sheet with animation
    overlay.classList.remove('hidden');
    sheet.classList.remove('hidden');

    // Trigger animation on next frame
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      sheet.classList.add('visible');
    });

    // Add event listeners
    this.setupSheetEventListeners(paperId);
  }

  setupSheetEventListeners(paperId) {
    const overlay = document.getElementById('pdf-source-sheet-overlay');
    const sheet = document.getElementById('pdf-source-sheet');
    const optionsContainer = document.getElementById('sheet-options');
    const cancelBtn = document.getElementById('sheet-cancel-btn');

    // Close on overlay tap
    overlay.addEventListener('click', () => this.hidePdfSourceSheet());

    // Close on cancel button
    cancelBtn?.addEventListener('click', () => this.hidePdfSourceSheet());

    // Handle swipe down to dismiss
    let startY = 0;
    let currentY = 0;

    sheet.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
    });

    sheet.addEventListener('touchmove', (e) => {
      currentY = e.touches[0].clientY;
      const deltaY = currentY - startY;
      if (deltaY > 0) {
        sheet.style.transform = `translateY(${deltaY}px)`;
      }
    });

    sheet.addEventListener('touchend', () => {
      const deltaY = currentY - startY;
      if (deltaY > 100) {
        this.hidePdfSourceSheet();
      } else {
        sheet.style.transform = '';
      }
      startY = 0;
      currentY = 0;
    });

    // Handle PDF source taps
    optionsContainer.querySelectorAll('.sheet-option:not(.attachment-option)').forEach(option => {
      option.addEventListener('click', async (e) => {
        // Don't trigger if clicking delete button
        if (e.target.classList.contains('sheet-delete-btn')) return;

        const sourceType = option.dataset.source;
        this.hidePdfSourceSheet();
        await this.downloadFromSource(paperId, sourceType, null);
      });
    });

    // Handle attachment taps
    optionsContainer.querySelectorAll('.attachment-option').forEach(option => {
      option.addEventListener('click', async (e) => {
        // Don't trigger if clicking delete button
        if (e.target.classList.contains('sheet-delete-btn')) return;

        const filename = option.dataset.filename;
        const isPdf = option.dataset.isPdf === 'true';

        this.hidePdfSourceSheet();

        if (isPdf) {
          const paper = this.papers.find(p => p.id === paperId);
          if (paper) {
            paper.pdf_path = `papers/${filename}`;
            this.selectedPaper = paper;
            this.switchTab('pdf');
            await this.loadPDF(paper);
            this.lastPdfSources[paperId] = `ATTACHMENT:${filename}`;
            window.electronAPI.setLastPdfSource(paperId, `ATTACHMENT:${filename}`);
          }
        } else {
          await window.electronAPI.openAttachment(filename);
        }
      });
    });

    // Handle delete buttons for PDF sources
    optionsContainer.querySelectorAll('.sheet-option:not(.attachment-option) .sheet-delete-btn').forEach(btn => {
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
            const option = btn.closest('.sheet-option');
            option.classList.remove('downloaded');
            option.querySelector('.sheet-option-label').textContent = option.querySelector('.sheet-option-label').textContent.replace('✓ ', '');
            btn.remove();
            this.consoleLog(`Deleted ${sourceType} PDF`, 'info');
          }
        }
      });
    });

    // Handle delete buttons for attachments
    optionsContainer.querySelectorAll('.attachment-option .sheet-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const attachmentId = parseInt(btn.dataset.attachmentId);
        const option = btn.closest('.sheet-option');
        const filename = option.dataset.filename;

        const result = await window.electronAPI.deleteAttachment(attachmentId);
        if (result.success) {
          option.remove();
          this.consoleLog(`Deleted attachment: ${filename}`, 'info');
        }
      });
    });
  }

  hidePdfSourceSheet() {
    const overlay = document.getElementById('pdf-source-sheet-overlay');
    const sheet = document.getElementById('pdf-source-sheet');

    if (!overlay || !sheet) return;

    // Animate out
    overlay.classList.remove('visible');
    sheet.classList.remove('visible');
    sheet.style.transform = '';

    // Hide after animation
    setTimeout(() => {
      overlay.classList.add('hidden');
      sheet.classList.add('hidden');
    }, 300);
  }

  async downloadFromSource(paperId, sourceType, menuItem) {
    this.hidePdfSourceDropdown();
    this.hidePdfSourceSheet();
    console.log(`[downloadFromSource] Starting download: paperId=${paperId}, sourceType=${sourceType}`);

    const paper = this.papers.find(p => p.id === paperId);
    if (!paper) {
      console.log(`[downloadFromSource] Paper not found: ${paperId}`);
      return;
    }

    // Handle ATTACHED type (drag-drop attached PDFs) - these already exist
    if (sourceType === 'ATTACHED' && paper.bibcode) {
      const baseFilename = paper.bibcode.replace(/[^a-zA-Z0-9._-]/g, '_');
      const expectedPath = `papers/${baseFilename}_ATTACHED.pdf`;
      console.log(`[downloadFromSource] Loading attached PDF: ${expectedPath}`);

      paper.pdf_path = expectedPath;
      if (this.selectedPaper && this.selectedPaper.id === paperId) {
        this.selectedPaper.pdf_path = expectedPath;
        this.currentPdfSource = 'ATTACHED';
        await this.loadPDF(this.selectedPaper);
      }
      // Save as last viewed source
      this.lastPdfSources[paperId] = 'ATTACHED';
      window.electronAPI.setLastPdfSource(paperId, 'ATTACHED');
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
        // Save as last viewed source
        this.lastPdfSources[paperId] = requestedSourceType;
        window.electronAPI.setLastPdfSource(paperId, requestedSourceType);
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

          // Save as last viewed source
          this.lastPdfSources[paperId] = 'PUB_PDF';
          window.electronAPI.setLastPdfSource(paperId, 'PUB_PDF');

          // Refresh files panel
          if (this.selectedPaper?.id === paperId) {
            await this.renderFilesPanel(this.selectedPaper);
          }

          // Auto-close download queue panel after successful download
          setTimeout(() => this.hideDownloadQueue(), 1500);

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

        // Save as last viewed source
        const savedSourceType = sourceMap[sourceType] || sourceType;
        this.lastPdfSources[paperId] = savedSourceType;
        window.electronAPI.setLastPdfSource(paperId, savedSourceType);

        // Refresh files panel
        if (this.selectedPaper?.id === paperId) {
          await this.renderFilesPanel(this.selectedPaper);
        }

        // Auto-close download queue panel after successful download
        setTimeout(() => this.hideDownloadQueue(), 1500);

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
    this.hideContextMenu();
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

  async batchDownloadPdfs() {
    this.hideContextMenu();

    // Get papers from selection
    let paperIds = [];
    if (this.selectedPapers.size > 0) {
      paperIds = Array.from(this.selectedPapers);
    } else if (this.rightClickedPaper) {
      paperIds = [this.rightClickedPaper.id];
    } else if (this.selectedPaper) {
      paperIds = [this.selectedPaper.id];
    }

    if (paperIds.length === 0) {
      this.showNotification('No papers selected', 'error');
      return;
    }

    // Filter to papers without PDFs
    const papersWithoutPdfs = paperIds.filter(id => {
      const paper = this.papers.find(p => p.id === id);
      return paper && !paper.pdf_path;
    });

    if (papersWithoutPdfs.length === 0) {
      this.showNotification('All selected papers already have PDFs', 'info');
      return;
    }

    this.consoleLog(`Starting batch PDF download for ${papersWithoutPdfs.length} papers...`, 'info');

    // Set up progress listener
    window.electronAPI.onBatchDownloadProgress((data) => {
      this.consoleLog(
        `[${data.current}/${data.total}] ${data.bibcode || 'Unknown'}: ${data.status}`,
        data.status === 'success' ? 'success' : data.status === 'skipped' ? 'info' : 'warn'
      );
    });

    try {
      const result = await window.electronAPI.batchDownloadPdfs(papersWithoutPdfs);

      if (result.success) {
        const { success, failed, skipped } = result.results;
        this.showNotification(
          `Downloaded ${success.length} PDFs, ${skipped.length} skipped, ${failed.length} failed`,
          failed.length > 0 ? 'warn' : 'success'
        );

        // Refresh paper list to show PDF icons
        await this.loadPapers();
        this.renderPaperList();

        // Refresh current paper display if it got a PDF
        if (this.selectedPaper && success.some(s => s.paperId === this.selectedPaper.id)) {
          const updatedPaper = await window.electronAPI.getPaper(this.selectedPaper.id);
          if (updatedPaper) {
            this.selectedPaper = updatedPaper;
            this.displayPaper(this.selectedPaper.id);
          }
        }
      } else {
        this.showNotification(result.error || 'Batch download failed', 'error');
      }
    } catch (error) {
      this.showNotification(`Batch download error: ${error.message}`, 'error');
    } finally {
      window.electronAPI.removeBatchDownloadListeners();
    }
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

  // Sidebar toggle
  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const sidebarResize = document.getElementById('sidebar-resize');
    const collapsedToggle = document.getElementById('sidebar-collapsed-toggle');

    const isHidden = sidebar.classList.toggle('hidden');
    sidebarResize.classList.toggle('hidden', isHidden);
    collapsedToggle.classList.toggle('hidden', !isHidden);
  }

  // Notes panel toggle
  toggleNotesPanel() {
    const notesPanel = document.getElementById('annotations-panel');
    const notesResize = document.getElementById('annotations-resize');
    const collapsedToggle = document.getElementById('notes-collapsed-toggle');

    const isHidden = notesPanel.classList.toggle('hidden');
    notesResize.classList.toggle('hidden', isHidden);
    collapsedToggle.classList.toggle('hidden', !isHidden);
  }

  // Focus Notes Mode - Split view with PDF left, Notes right
  async enterFocusNotesMode() {
    if (this.isFocusNotesMode) return;
    if (!this.selectedPaper) {
      this.showNotification('Select a paper first', 'warn');
      return;
    }

    // Ensure we're on the PDF tab and notes panel is visible
    this.switchTab('pdf');

    this.isFocusNotesMode = true;
    document.body.classList.add('focus-notes-mode');

    // Show the focus toolbar
    const toolbar = document.getElementById('focus-notes-toolbar');
    if (toolbar) {
      toolbar.classList.remove('hidden');
      // Update title with paper name
      const titleEl = document.getElementById('focus-notes-title');
      if (titleEl && this.selectedPaper) {
        titleEl.textContent = this.selectedPaper.title || 'Taking notes...';
      }
    }

    // Ensure notes panel is visible
    const notesPanel = document.getElementById('annotations-panel');
    if (notesPanel) {
      notesPanel.classList.remove('hidden');
    }

    // Set up resize handle for focus mode (creates the handle element)
    this.setupFocusModeResize();

    // Load saved split position and apply it
    let splitPosition = 50; // Default 50%
    if (window.electronAPI.getFocusSplitPosition) {
      const saved = await window.electronAPI.getFocusSplitPosition();
      if (saved) splitPosition = saved;
    }
    this.setFocusSplitPosition(splitPosition);

    // If no annotations exist, create an empty note and focus on it
    if (this.annotations.length === 0) {
      try {
        const result = await window.electronAPI.createAnnotation(this.selectedPaper.id, {
          page_number: 1,
          selection_text: null,
          selection_rects: null,
          note_content: '',
          color: '#ffeb3b',
          pdf_source: this.currentPdfSource
        });

        if (result.success && result.annotation) {
          await this.loadAnnotations(this.selectedPaper.id);
          this.renderHighlightsOnPdf();

          // Start editing the new note after DOM updates
          requestAnimationFrame(() => {
            this.editAnnotation(result.annotation.id);
          });
        }
      } catch (error) {
        console.error('Error creating initial note in focus mode:', error);
      }
    }

    console.log('[ADSReader] Entered Focus Notes mode');
  }

  setFocusSplitPosition(percent) {
    const tabContent = document.querySelector('.tab-content');
    const notesPanel = document.getElementById('annotations-panel');
    const resizeHandle = document.getElementById('focus-mode-resize');

    if (tabContent && notesPanel && this.isFocusNotesMode) {
      tabContent.style.flex = `0 0 ${percent}%`;
      tabContent.style.maxWidth = `${percent}%`;
      tabContent.style.minWidth = `${percent}%`;
      notesPanel.style.flex = `0 0 ${100 - percent}%`;
      notesPanel.style.maxWidth = `${100 - percent}%`;
      notesPanel.style.minWidth = `${100 - percent}%`;

      // Update resize handle position
      if (resizeHandle) {
        resizeHandle.style.left = `${percent}%`;
      }
    }
    this.focusSplitPosition = percent;
  }

  setupFocusModeResize() {
    // Create resize handle if it doesn't exist
    let resizeHandle = document.getElementById('focus-mode-resize');
    if (!resizeHandle) {
      resizeHandle = document.createElement('div');
      resizeHandle.id = 'focus-mode-resize';
      resizeHandle.className = 'focus-mode-resize-handle';

      // Insert between tab-content and annotations-panel
      const annotationsPanel = document.getElementById('annotations-panel');
      if (annotationsPanel && annotationsPanel.parentNode) {
        annotationsPanel.parentNode.insertBefore(resizeHandle, annotationsPanel);
      }
    }
    resizeHandle.classList.remove('hidden');

    let isResizing = false;
    let startX = 0;
    let startPercent = 50;

    const onMouseDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      isResizing = true;
      startX = e.clientX;
      startPercent = this.focusSplitPosition || 50;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    };

    const onMouseMove = (e) => {
      if (!isResizing) return;

      const container = document.querySelector('.viewer-content-row');
      if (!container) return;

      const containerWidth = container.offsetWidth;
      const deltaX = e.clientX - startX;
      const deltaPercent = (deltaX / containerWidth) * 100;
      let newPercent = startPercent + deltaPercent;

      // Clamp between 20% and 80%
      newPercent = Math.max(20, Math.min(80, newPercent));

      this.setFocusSplitPosition(newPercent);
    };

    const onMouseUp = () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        // Save the position
        if (window.electronAPI.setFocusSplitPosition) {
          window.electronAPI.setFocusSplitPosition(this.focusSplitPosition);
        }
      }
    };

    // Remove old listeners if any
    resizeHandle.removeEventListener('mousedown', resizeHandle._onMouseDown);
    document.removeEventListener('mousemove', resizeHandle._onMouseMove);
    document.removeEventListener('mouseup', resizeHandle._onMouseUp);

    // Store references for cleanup
    resizeHandle._onMouseDown = onMouseDown;
    resizeHandle._onMouseMove = onMouseMove;
    resizeHandle._onMouseUp = onMouseUp;

    resizeHandle.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  exitFocusNotesMode() {
    if (!this.isFocusNotesMode) return;
    this.isFocusNotesMode = false;

    document.body.classList.remove('focus-notes-mode');

    // Hide the focus toolbar
    const toolbar = document.getElementById('focus-notes-toolbar');
    if (toolbar) {
      toolbar.classList.add('hidden');
    }

    // Hide the resize handle
    const resizeHandle = document.getElementById('focus-mode-resize');
    if (resizeHandle) {
      resizeHandle.classList.add('hidden');
    }

    // Reset panel styles
    const tabContent = document.querySelector('.tab-content');
    const notesPanel = document.getElementById('annotations-panel');
    if (tabContent) {
      tabContent.style.flex = '';
      tabContent.style.maxWidth = '';
      tabContent.style.minWidth = '';
    }
    if (notesPanel) {
      notesPanel.style.flex = '';
      notesPanel.style.maxWidth = '';
      notesPanel.style.minWidth = '';
    }

    // Notes are auto-saved, but show confirmation
    this.showNotification('Notes saved', 'success');

    console.log('[ADSReader] Exited Focus Notes mode');
  }

  // ADS Token Modal
  async checkAdsToken() {
    const token = await window.electronAPI.getAdsToken();
    this.hasAdsToken = !!token;

    // Update sidebar status
    document.getElementById('ads-status')?.classList.toggle('connected', this.hasAdsToken);
    // Update drawer status
    document.getElementById('drawer-ads-status')?.classList.toggle('connected', this.hasAdsToken);
  }

  async checkProxyStatus() {
    const proxyUrl = await window.electronAPI.getLibraryProxy();
    // Update sidebar status
    document.getElementById('proxy-status')?.classList.toggle('connected', !!proxyUrl);
    // Update drawer status
    document.getElementById('drawer-proxy-status')?.classList.toggle('connected', !!proxyUrl);
  }

  async showAdsTokenModal() {
    console.log('[Debug] showAdsTokenModal called');
    const modal = document.getElementById('ads-token-modal');
    console.log('[Debug] ads-token-modal element:', modal);
    console.log('[Debug] modal classes before:', modal?.className);
    modal?.classList.remove('hidden');
    console.log('[Debug] modal classes after:', modal?.className);
    document.getElementById('ads-token-input')?.focus();

    // Load current ADS token
    try {
      const token = await window.electronAPI.getAdsToken();
      console.log('[Debug] Got ADS token:', token ? 'yes' : 'no');
      document.getElementById('ads-token-input').value = token || '';
    } catch (e) {
      console.error('[Debug] Error getting ADS token:', e);
    }
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
      document.getElementById('ads-status')?.classList.add('connected');
      document.getElementById('drawer-ads-status')?.classList.add('connected');
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

    document.getElementById('proxy-status')?.classList.toggle('connected', !!proxyUrl);
    document.getElementById('drawer-proxy-status')?.classList.toggle('connected', !!proxyUrl);
    statusEl.className = 'modal-status success';
    statusEl.textContent = proxyUrl ? 'Proxy saved!' : 'Proxy cleared!';
    setTimeout(() => this.hideLibraryProxyModal(), 1000);
  }

  // Inline Settings Toggle
  async toggleInlineSettings(type) {
    const groupId = type === 'ads' ? 'ads-settings-group' : 'proxy-settings-group';
    const contentId = type === 'ads' ? 'ads-settings-content' : 'proxy-settings-content';

    const group = document.getElementById(groupId);
    const content = document.getElementById(contentId);

    if (!group || !content) return;

    const isExpanded = group.classList.toggle('expanded');
    content.classList.toggle('hidden', !isExpanded);

    // Load current values when expanding
    if (isExpanded) {
      if (type === 'ads') {
        const token = await window.electronAPI.getAdsToken();
        document.getElementById('ads-token-inline').value = token || '';
        document.getElementById('ads-token-inline').focus();
      } else {
        const proxyUrl = await window.electronAPI.getLibraryProxy();
        document.getElementById('proxy-url-inline').value = proxyUrl || '';
        document.getElementById('proxy-url-inline').focus();
      }
    }
  }

  async saveAdsTokenInline() {
    const input = document.getElementById('ads-token-inline');
    const btn = document.getElementById('ads-token-save-inline');
    const token = input.value.trim();

    if (!token) {
      this.showNotification('Please enter a token', 'warn');
      return;
    }

    btn.textContent = 'Saving...';
    btn.disabled = true;

    const result = await window.electronAPI.setAdsToken(token);

    if (result.success) {
      this.hasAdsToken = true;
      document.getElementById('ads-status').classList.add('connected');
      btn.textContent = '✓ Saved';
      this.showNotification('ADS token saved', 'success');

      // Collapse after success
      setTimeout(() => {
        btn.textContent = 'Save';
        btn.disabled = false;
        this.toggleInlineSettings('ads');
      }, 1000);
    } else {
      btn.textContent = 'Save';
      btn.disabled = false;
      this.showNotification(`Invalid token: ${result.error}`, 'error');
    }
  }

  async saveProxyInline() {
    const input = document.getElementById('proxy-url-inline');
    const btn = document.getElementById('proxy-save-inline');
    const proxyUrl = input.value.trim();

    btn.textContent = 'Saving...';
    btn.disabled = true;

    await window.electronAPI.setLibraryProxy(proxyUrl);

    document.getElementById('proxy-status').classList.toggle('connected', !!proxyUrl);
    btn.textContent = '✓ Saved';
    this.showNotification(proxyUrl ? 'Proxy saved' : 'Proxy cleared', 'success');

    // Collapse after success
    setTimeout(() => {
      btn.textContent = 'Save';
      btn.disabled = false;
      this.toggleInlineSettings('proxy');
    }, 1000);
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
    // Reset smart collection options
    document.querySelector('input[name="collection-type"][value="regular"]').checked = true;
    document.getElementById('smart-collection-options')?.classList.add('hidden');
    document.getElementById('collection-query-input').value = '';
  }

  async createCollection() {
    const name = document.getElementById('collection-name-input').value.trim();
    if (!name) return;

    // Check if this is a smart collection
    const isSmartRadio = document.querySelector('input[name="collection-type"][value="smart"]');
    const isSmart = isSmartRadio?.checked || false;
    const query = isSmart ? document.getElementById('collection-query-input')?.value.trim() : null;

    // Smart collections require a query
    if (isSmart && !query) {
      this.showNotification('Smart collections require a search query', 'error');
      return;
    }

    await window.electronAPI.createCollection(name, null, isSmart, query);
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

    console.log('[ADS Search] Executing search with query:', query);

    try {
      const result = await window.electronAPI.adsImportSearch(query, { rows: 1000 });
      console.log('[ADS Search] Got result:', result.success, 'papers:', result.data?.papers?.length);

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
    this.updateLlmStatus('loading', 'Checking AI providers...');

    try {
      this.llmConfig = await window.electronAPI.getLlmConfig();
      const activeProvider = this.llmConfig.activeProvider || 'ollama';

      // Check Ollama connection
      const ollamaResult = await window.electronAPI.testProviderConnection('ollama');
      const ollamaConnected = ollamaResult.connected || false;

      // Check cloud providers (at least one configured counts as connected)
      let cloudConnected = false;
      let connectedProvider = null;

      for (const provider of ['anthropic', 'gemini', 'perplexity']) {
        const hasKey = await window.electronAPI.getApiKey(provider);
        if (hasKey) {
          cloudConnected = true;
          if (!connectedProvider) connectedProvider = provider;
        }
      }

      // Determine overall connection status
      if (ollamaConnected || cloudConnected) {
        this.llmConnected = true;

        // Build status message based on active provider
        const providerConfig = this.llmConfig[activeProvider] || {};
        const model = providerConfig.model || 'Unknown';
        const providerName = activeProvider.charAt(0).toUpperCase() + activeProvider.slice(1);
        const statusMsg = `${providerName}: ${model}`;

        this.updateLlmStatus('connected', statusMsg);

        // Start auto-indexing in background (only works with Ollama for embeddings)
        if (ollamaConnected) {
          this.autoIndexPapers();
        }
      } else {
        this.llmConnected = false;
        this.updateLlmStatus('disconnected', 'No AI providers configured');
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

    // Drawer status
    const drawerStatus = document.getElementById('drawer-llm-status');
    if (drawerStatus) {
      drawerStatus.classList.toggle('connected', status === 'connected');
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

    // Load current config first
    this.llmConfig = await window.electronAPI.getLlmConfig();

    // Determine which provider tab to show
    let activeProvider = this.llmConfig.activeProvider;
    if (!activeProvider) {
      // Default to anthropic on iOS, ollama on desktop
      activeProvider = this.isIOS ? 'anthropic' : 'ollama';
    }
    this.switchProviderTab(activeProvider);

    // Update active provider indicator
    this.updateActiveProviderDisplay();

    // Get config with backward compatibility
    const ollamaConfig = this.llmConfig.ollama || {
      endpoint: this.llmConfig.endpoint || 'http://127.0.0.1:11434',
      model: this.llmConfig.model || 'qwen3:30b',
      embeddingModel: this.llmConfig.embeddingModel || 'nomic-embed-text'
    };

    // Populate Ollama fields
    document.getElementById('llm-endpoint-input').value = ollamaConfig.endpoint || 'http://127.0.0.1:11434';

    // Populate cloud provider model selects
    if (this.llmConfig.anthropic?.model) {
      document.getElementById('anthropic-model-select').value = this.llmConfig.anthropic.model;
    }
    if (this.llmConfig.gemini?.model) {
      document.getElementById('gemini-model-select').value = this.llmConfig.gemini.model;
    }
    if (this.llmConfig.perplexity?.model) {
      document.getElementById('perplexity-model-select').value = this.llmConfig.perplexity.model;
    }

    // Load summary prompt
    const summaryPrompt = await window.electronAPI.getSummaryPrompt();
    document.getElementById('summary-prompt-textarea').value = summaryPrompt;

    // Show API key status for cloud providers
    for (const provider of ['anthropic', 'gemini', 'perplexity']) {
      const hasKey = await window.electronAPI.getApiKey(provider);
      const keyInput = document.getElementById(`${provider}-api-key`);
      if (keyInput) {
        keyInput.value = hasKey ? '***configured***' : '';
        keyInput.placeholder = hasKey ? 'Key configured (enter new to replace)' : 'Enter API key';
      }
    }

    // Load available models for Ollama
    await this.loadLlmModels();

    // Test all provider connections and update status
    await this.testAllProviders();
  }

  hideLlmModal() {
    document.getElementById('llm-modal').classList.add('hidden');
  }

  // ========================================
  // Feedback Modal Methods
  // ========================================

  showFeedbackModal() {
    const modal = document.getElementById('feedback-modal');
    if (!modal) return;

    // Reset form
    document.getElementById('feedback-subject').value = '';
    document.getElementById('feedback-description').value = '';
    document.querySelector('input[name="feedback-type"][value="bug"]').checked = true;
    document.getElementById('include-system-info').checked = true;

    // Update system info preview
    this.updateSystemInfoPreview();

    // Add listener for checkbox changes
    const checkbox = document.getElementById('include-system-info');
    checkbox.addEventListener('change', () => this.updateSystemInfoPreview());

    modal.classList.remove('hidden');
  }

  hideFeedbackModal() {
    const modal = document.getElementById('feedback-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
  }

  async updateSystemInfoPreview() {
    const preview = document.getElementById('system-info-preview');
    const checkbox = document.getElementById('include-system-info');

    if (!preview || !checkbox?.checked) {
      if (preview) preview.textContent = '';
      return;
    }

    const info = await this.collectSystemInfo();
    preview.textContent = `App Version: ${info.appVersion}
Platform: ${info.platform}
Papers: ${info.paperCount}
View: ${info.currentView}
Time: ${info.timestamp}`;
  }

  async collectSystemInfo() {
    let appVersion = '1.0.0-beta.1';
    try {
      if (window.electronAPI?.getAppVersion) {
        appVersion = await window.electronAPI.getAppVersion();
      }
    } catch (e) {
      // Use default version
    }

    return {
      appVersion,
      platform: this.isIOS ? 'iOS' : 'macOS',
      osVersion: navigator.userAgent,
      paperCount: this.papers?.length || 0,
      currentView: this.getCurrentViewName(),
      timestamp: new Date().toISOString(),
      recentErrors: this.consoleErrors || []
    };
  }

  getCurrentViewName() {
    if (this.currentTab) return `Tab: ${this.currentTab}`;
    if (this.currentView) return `View: ${this.currentView}`;
    if (this.selectedCollection) return `Collection: ${this.selectedCollection.name}`;
    return 'Main';
  }

  async submitFeedback() {
    const type = document.querySelector('input[name="feedback-type"]:checked')?.value || 'general';
    const subject = document.getElementById('feedback-subject')?.value?.trim();
    const description = document.getElementById('feedback-description')?.value?.trim();
    const includeSystemInfo = document.getElementById('include-system-info')?.checked;

    if (!subject) {
      this.showNotification('Please enter a subject', 'error');
      return;
    }

    if (!description) {
      this.showNotification('Please enter a description', 'error');
      return;
    }

    const systemInfo = includeSystemInfo ? await this.collectSystemInfo() : null;

    // Build email body
    let body = `Type: ${type.charAt(0).toUpperCase() + type.slice(1)}
Subject: ${subject}

Description:
${description}`;

    if (systemInfo) {
      body += `

---
System Information:
App Version: ${systemInfo.appVersion}
Platform: ${systemInfo.platform}
OS: ${systemInfo.osVersion}
Papers: ${systemInfo.paperCount}
View: ${systemInfo.currentView}
Time: ${systemInfo.timestamp}`;
    }

    // Create mailto URL - using a placeholder email for now
    const feedbackEmail = 'adsreader@tomabel.org';
    const emailSubject = `[${type}] ${subject}`;
    const mailtoUrl = `mailto:${feedbackEmail}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(body)}`;

    // Open email client
    try {
      if (this.isIOS) {
        window.location.href = mailtoUrl;
      } else if (window.electronAPI?.openExternal) {
        await window.electronAPI.openExternal(mailtoUrl);
      } else {
        window.open(mailtoUrl);
      }
      this.hideFeedbackModal();
      this.showNotification('Opening email client...', 'success');
    } catch (e) {
      this.showNotification('Failed to open email client', 'error');
      console.error('Feedback submission error:', e);
    }
  }

  // Update the active provider indicator display
  updateActiveProviderDisplay() {
    const display = document.getElementById('active-provider-display');
    if (!display || !this.llmConfig) return;

    const provider = this.llmConfig.activeProvider || 'ollama';
    const providerConfig = this.llmConfig[provider] || {};
    const model = providerConfig.model || 'Unknown';

    const providerNames = {
      ollama: 'Ollama',
      anthropic: 'Claude',
      gemini: 'Gemini',
      perplexity: 'Perplexity'
    };

    display.textContent = `${providerNames[provider] || provider} - ${model}`;
  }

  // Switch between provider tabs
  switchProviderTab(provider) {
    // Update tab states
    document.querySelectorAll('.provider-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.provider === provider);
    });

    // Update panel visibility
    document.querySelectorAll('.provider-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `panel-${provider}`);
    });

    // Update internal state (will be saved when user clicks Save)
    if (this.llmConfig) {
      this.llmConfig.activeProvider = provider;
      // Update indicator to show pending selection
      this.updateActiveProviderDisplay();
    }
  }

  // Toggle password visibility
  togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    const btn = document.querySelector(`[data-target="${inputId}"]`);
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      btn.textContent = 'Show';
    }
  }

  // Test all providers and update status indicators
  async testAllProviders() {
    // Test Ollama
    this.testProvider('ollama');

    // Check API key status for cloud providers
    const providers = ['anthropic', 'gemini', 'perplexity'];
    for (const provider of providers) {
      const hasKey = await window.electronAPI.getApiKey(provider);
      const tabStatus = document.getElementById(`${provider}-tab-status`);
      const statusDot = document.getElementById(`${provider}-status-dot`);
      const statusText = document.getElementById(`${provider}-status-text`);

      if (hasKey) {
        tabStatus.className = 'provider-status configured';
        statusDot.className = 'llm-status-dot connected';
        statusText.textContent = 'API key configured';
      } else {
        tabStatus.className = 'provider-status disconnected';
        statusDot.className = 'llm-status-dot disconnected';
        statusText.textContent = 'Not configured';
      }
    }
  }

  // Test a specific provider connection
  async testProvider(provider) {
    const statusDot = document.getElementById(`${provider}-status-dot`);
    const statusText = document.getElementById(`${provider}-status-text`);
    const tabStatus = document.getElementById(`${provider}-tab-status`);

    statusDot.className = 'llm-status-dot checking';
    statusText.textContent = 'Testing connection...';

    try {
      if (provider === 'ollama') {
        // Update endpoint temporarily for test
        const endpoint = document.getElementById('llm-endpoint-input').value.trim();
        const currentConfig = await window.electronAPI.getLlmConfig();
        const updatedConfig = {
          ...currentConfig,
          ollama: { ...currentConfig.ollama, endpoint }
        };
        await window.electronAPI.setLlmConfig(updatedConfig);
      }

      const result = await window.electronAPI.testProviderConnection(provider);

      if (result.connected || result.success) {
        statusDot.className = 'llm-status-dot connected';
        tabStatus.className = 'provider-status connected';
        if (provider === 'ollama') {
          statusText.textContent = `Connected! ${result.models?.length || 'Models'} available`;
          await this.loadLlmModels();
        } else {
          statusText.textContent = 'Connected';
        }
      } else {
        statusDot.className = 'llm-status-dot disconnected';
        tabStatus.className = 'provider-status error';
        statusText.textContent = result.error || 'Connection failed';
      }
    } catch (error) {
      statusDot.className = 'llm-status-dot disconnected';
      tabStatus.className = 'provider-status error';
      statusText.textContent = error.message;
    }
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

      // Get current selection from config
      const ollamaConfig = this.llmConfig.ollama || {};
      const selectedModel = ollamaConfig.model || this.llmConfig.model;
      const selectedEmbedding = ollamaConfig.embeddingModel || this.llmConfig.embeddingModel;

      // Populate model dropdown
      modelSelect.innerHTML = models.map(m =>
        `<option value="${m.name}" ${m.name === selectedModel ? 'selected' : ''}>${m.name}</option>`
      ).join('');

      // Populate embedding model dropdown
      embeddingSelect.innerHTML = models.map(m =>
        `<option value="${m.name}" ${m.name === selectedEmbedding ? 'selected' : ''}>${m.name}</option>`
      ).join('');
    } catch (error) {
      modelSelect.innerHTML = `<option value="">Error: ${error.message}</option>`;
      embeddingSelect.innerHTML = `<option value="">Error: ${error.message}</option>`;
    }
  }

  async saveLlmConfig() {
    // Get active provider from the currently selected tab
    const activeTab = document.querySelector('.provider-tab.active');
    const activeProvider = activeTab?.dataset.provider || 'ollama';

    // Build new config - activeProvider is the single source of truth
    const newConfig = {
      activeProvider,
      ollama: {
        endpoint: document.getElementById('llm-endpoint-input').value.trim(),
        model: document.getElementById('llm-model-select').value,
        embeddingModel: document.getElementById('llm-embedding-select').value
      },
      anthropic: {
        model: document.getElementById('anthropic-model-select').value
      },
      gemini: {
        model: document.getElementById('gemini-model-select').value
      },
      perplexity: {
        model: document.getElementById('perplexity-model-select').value
      },
      summaryPrompt: this.llmConfig?.summaryPrompt || null
    };

    // Save API keys for cloud providers
    const anthropicKey = document.getElementById('anthropic-api-key').value.trim();
    const geminiKey = document.getElementById('gemini-api-key').value.trim();
    const perplexityKey = document.getElementById('perplexity-api-key').value.trim();

    if (anthropicKey && anthropicKey !== '***configured***') {
      await window.electronAPI.setApiKey('anthropic', anthropicKey);
    }
    if (geminiKey && geminiKey !== '***configured***') {
      await window.electronAPI.setApiKey('gemini', geminiKey);
    }
    if (perplexityKey && perplexityKey !== '***configured***') {
      await window.electronAPI.setApiKey('perplexity', perplexityKey);
    }

    // Save summary prompt if changed
    const summaryPrompt = document.getElementById('summary-prompt-textarea').value.trim();
    if (summaryPrompt) {
      await window.electronAPI.setSummaryPrompt(summaryPrompt);
    }

    await window.electronAPI.setLlmConfig(newConfig);
    this.llmConfig = newConfig;

    await this.checkLlmConnection();
    this.hideLlmModal();
  }

  async resetSummaryPrompt() {
    const result = await window.electronAPI.resetSummaryPrompt();
    if (result.defaultPrompt) {
      document.getElementById('summary-prompt-textarea').value = result.defaultPrompt;
    }
  }

  async testLlmConnection() {
    // Legacy method - now calls testProvider for Ollama
    await this.testProvider('ollama');
  }

  // Copy buttons
  async copySummaryToClipboard() {
    const summaryText = document.querySelector('#ai-summary-content .ai-summary-text');
    const keyPoints = document.getElementById('ai-key-points-list');

    let textToCopy = '';
    if (summaryText) {
      textToCopy = summaryText.textContent;
    }

    if (keyPoints && !keyPoints.parentElement.classList.contains('hidden')) {
      const points = Array.from(keyPoints.querySelectorAll('li')).map(li => `- ${li.textContent}`).join('\n');
      if (points) {
        textToCopy += '\n\nKey Points:\n' + points;
      }
    }

    if (textToCopy) {
      await navigator.clipboard.writeText(textToCopy);
      this.showCopyFeedback('ai-copy-summary-btn');
    }
  }

  async copyLastAnswerToClipboard() {
    const answers = document.querySelectorAll('#ai-qa-history .ai-qa-answer .ai-text');
    if (answers.length > 0) {
      const lastAnswer = answers[answers.length - 1];
      await navigator.clipboard.writeText(lastAnswer.textContent);
      this.showCopyFeedback('ai-copy-qa-btn');
    }
  }

  showCopyFeedback(btnId) {
    const btn = document.getElementById(btnId);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  }

  // Semantic Search Info Popup
  showSemanticSearchInfo() {
    document.getElementById('semantic-search-info-popup').classList.remove('hidden');
  }

  hideSemanticSearchInfo() {
    document.getElementById('semantic-search-info-popup').classList.add('hidden');
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

    // Show model name if available
    const modelName = data.model || this.getCurrentModelName();
    const modelNote = modelName ? `<div class="ai-model-note">Generated by ${modelName}</div>` : '';

    contentEl.innerHTML = `<div class="ai-summary-text">${this.escapeHtml(data.summary || '')}</div>${modelNote}`;

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

    // Show visual anchor marker with Add Note button
    this.showAnchorMarker(pageWrapper, relX, relY);
  }

  showAnchorMarker(pageWrapper, relX, relY) {
    // Remove any existing anchor marker element (but don't clear position - we just set it)
    document.querySelectorAll('.pdf-anchor-marker').forEach(m => m.remove());

    // Create anchor marker element with Add Note button
    const marker = document.createElement('div');
    marker.className = 'pdf-anchor-marker';
    marker.style.left = `${relX * 100}%`;
    marker.style.top = `${relY * 100}%`;

    const icon = document.createElement('span');
    icon.className = 'anchor-icon';
    icon.textContent = '📍';

    const addBtn = document.createElement('button');
    addBtn.className = 'anchor-add-btn';
    addBtn.textContent = '+ Note';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.createNoteAtAnchor();
    });

    marker.appendChild(icon);
    marker.appendChild(addBtn);
    pageWrapper.appendChild(marker);

    // Auto-hide on click elsewhere (but not on the marker itself)
    const hideHandler = (e) => {
      if (!marker.contains(e.target)) {
        this.removeAnchorMarker();
        document.removeEventListener('mousedown', hideHandler);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', hideHandler), 0);
  }

  removeAnchorMarker() {
    document.querySelectorAll('.pdf-anchor-marker').forEach(m => m.remove());
    this.pdfAnchorPosition = null;
  }

  async createNoteAtAnchor() {
    if (!this.selectedPaper || !this.pdfAnchorPosition) return;

    // Store position before removing marker (which clears it)
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

      if (result.success && result.annotation) {
        await this.loadAnnotations(this.selectedPaper.id);
        this.renderHighlightsOnPdf();

        // Ensure we're on PDF tab (annotations panel is part of PDF view)
        this.switchTab('pdf');

        // Make sure annotations panel is visible
        const annotationsPanel = document.getElementById('annotations-panel');
        const annotationsResize = document.getElementById('annotations-resize');
        annotationsPanel.classList.remove('hidden');
        annotationsResize.classList.remove('hidden');

        // Start editing the new note after DOM updates
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

    // Update header with model name
    const modelName = this.getCurrentModelName();
    const headerSpan = popup.querySelector('.ai-explanation-header span');
    if (headerSpan) {
      headerSpan.textContent = modelName ? `AI Explanation (${modelName})` : 'AI Explanation';
    }

    document.getElementById('ai-explanation-content').innerHTML =
      '<div class="ai-loading">Generating explanation...</div>';
  }

  getCurrentModelName() {
    const modelId = localStorage.getItem('selectedAiModel') || this.llmConfig?.selectedModel;
    if (!modelId) return null;

    // Model IDs are formatted as "provider:modelName" (e.g., "anthropic:claude-3-sonnet")
    const parts = modelId.split(':');
    if (parts.length >= 2) {
      return parts.slice(1).join(':'); // Return model name part
    }
    return modelId;
  }

  hideExplanationPopup() {
    document.getElementById('ai-explanation-popup').classList.add('hidden');
  }

  setupExplanationPopupDrag() {
    const popup = document.getElementById('ai-explanation-popup');
    const header = popup?.querySelector('.ai-explanation-header');
    if (!header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      // Don't start drag if clicking the close button
      if (e.target.classList.contains('popup-close-btn')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = popup.offsetLeft;
      startTop = popup.offsetTop;

      // Prevent text selection while dragging
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      // Calculate new position with bounds checking
      let newLeft = startLeft + deltaX;
      let newTop = startTop + deltaY;

      // Keep popup within viewport
      const maxLeft = window.innerWidth - popup.offsetWidth;
      const maxTop = window.innerHeight - popup.offsetHeight;

      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));

      popup.style.left = `${newLeft}px`;
      popup.style.top = `${newTop}px`;
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  async addExplanationAsNote() {
    if (!this.selectedPaper) {
      this.showNotification('No paper selected', 'error');
      return;
    }

    // Get the explanation content
    const contentEl = document.getElementById('ai-explanation-content');
    const renderedEl = contentEl.querySelector('.ai-explanation-rendered');

    if (!renderedEl) {
      this.showNotification('No explanation to add', 'error');
      return;
    }

    // Get the raw text from the accumulated explanation
    // We'll use the text content but preserve some formatting
    const explanationText = renderedEl.innerText || renderedEl.textContent;

    // Build the note content with the selected text as context
    let noteContent = '';
    if (this.selectedText) {
      noteContent = `**Selected text:**\n> ${this.selectedText}\n\n**AI Explanation:**\n${explanationText}`;
    } else {
      noteContent = `**AI Explanation:**\n${explanationText}`;
    }

    // Create the annotation
    const result = await window.electronAPI.createAnnotation(this.selectedPaper.id, {
      page_number: this.getCurrentVisiblePage(),
      selection_text: this.selectedText || null,
      selection_rects: [],
      note_content: noteContent,
      color: '#e1bee7', // Light purple for AI-generated notes
      pdf_source: this.currentPdfSource
    });

    if (result.success && result.annotation) {
      // Hide the explanation popup
      this.hideExplanationPopup();

      // Reload annotations
      await this.loadAnnotations(this.selectedPaper.id);
      this.renderHighlightsOnPdf();

      // Ensure annotations panel is visible
      const annotationsPanel = document.getElementById('annotations-panel');
      const annotationsResize = document.getElementById('annotations-resize');
      const notesCollapsedToggle = document.getElementById('notes-collapsed-toggle');
      annotationsPanel.classList.remove('hidden');
      annotationsResize.classList.remove('hidden');
      notesCollapsedToggle.classList.add('hidden');

      // Start editing the new note
      requestAnimationFrame(() => {
        this.editAnnotation(result.annotation.id);
      });

      this.showNotification('Added as note', 'success');
    } else {
      this.showNotification('Failed to create note', 'error');
    }
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

  // Build a map of annotation ID -> sequential number (sorted by page, then y position)
  buildAnnotationNumberMap() {
    const sorted = [...this.annotations].sort((a, b) => {
      // First by page
      const pageA = a.page_number || 1;
      const pageB = b.page_number || 1;
      if (pageA !== pageB) return pageA - pageB;

      // Then by y position (top of first rect)
      const yA = a.selection_rects?.[0]?.y || 0;
      const yB = b.selection_rects?.[0]?.y || 0;
      if (yA !== yB) return yA - yB;

      // Then by x position
      const xA = a.selection_rects?.[0]?.x || 0;
      const xB = b.selection_rects?.[0]?.x || 0;
      return xA - xB;
    });

    const map = new Map();
    sorted.forEach((a, index) => {
      map.set(a.id, index + 1);
    });
    return map;
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

    // Build annotation number map (sorted by page, then position)
    this.annotationNumbers = this.buildAnnotationNumberMap();

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
        const noteNum = this.annotationNumbers.get(a.id) || '?';

        // Render markdown for note content
        const renderedNote = hasNote ? this.renderMarkdown(a.note_content) : 'Click to add a note...';

        html += `
          <div class="annotation-item" data-id="${a.id}" data-page="${pageNum}">
            <div class="annotation-header">
              <span class="annotation-number">${noteNum}</span>
              <span class="annotation-page-badge">p.${pageNum}</span>
              <span class="annotation-timestamp">${timeStr}</span>
              <div class="annotation-actions">
                <button class="annotation-btn edit" data-id="${a.id}" title="Edit">✎</button>
                <button class="annotation-btn delete" data-id="${a.id}" title="Delete">×</button>
              </div>
            </div>
            ${a.selection_text ? `<div class="annotation-quote" style="border-color: ${a.color}">${this.escapeHtml(a.selection_text)}</div>` : ''}
            <div class="annotation-content">
              <div class="annotation-text ${hasNote ? '' : 'empty'}" data-id="${a.id}">
                ${renderedNote}
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

  async exportAnnotations() {
    if (!this.selectedPaper) {
      this.showNotification('No paper selected', 'error');
      return;
    }

    const result = await window.electronAPI.exportAnnotations(this.selectedPaper.id);
    if (result.success) {
      this.showNotification(`Exported ${result.count} annotations to Markdown`, 'success');
    } else if (!result.canceled) {
      this.showNotification(result.error || 'Export failed', 'error');
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

    if (result.success && result.annotation) {
      await this.loadAnnotations(this.selectedPaper.id);
      this.renderHighlightsOnPdf();

      // Ensure annotations panel is visible
      const annotationsPanel = document.getElementById('annotations-panel');
      const annotationsResize = document.getElementById('annotations-resize');
      annotationsPanel.classList.remove('hidden');
      annotationsResize.classList.remove('hidden');

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

      if (result.success && result.annotation) {
        await this.loadAnnotations(this.selectedPaper.id);
        this.renderHighlightsOnPdf();

        // Ensure annotations panel is visible (it's part of PDF view)
        const annotationsPanel = document.getElementById('annotations-panel');
        const annotationsResize = document.getElementById('annotations-resize');
        annotationsPanel.classList.remove('hidden');
        annotationsResize.classList.remove('hidden');

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
    const originalText = annotation.note_content || '';

    // Get saved textarea height for this annotation (or use default)
    const savedHeight = this.annotationHeights?.[id] || 80;

    // Replace with textarea (no buttons - auto-save on blur)
    contentDiv.innerHTML = `
      <textarea class="annotation-input" data-id="${id}" style="height: ${savedHeight}px" placeholder="Write your note here... (supports *markdown* and LaTeX: $formula$)">${this.escapeHtml(originalText)}</textarea>
    `;

    const textarea = contentDiv.querySelector('.annotation-input');

    // Save height when user resizes
    if (!this.annotationHeights) this.annotationHeights = {};
    textarea.addEventListener('mouseup', () => {
      this.annotationHeights[id] = textarea.offsetHeight;
    });

    // Scroll the annotation into view in the sidebar only (preserve PDF scroll position)
    const annotationItem = contentDiv.closest('.annotation-item');
    const pdfContainer = document.getElementById('pdf-container');
    const pdfScrollTop = pdfContainer?.scrollTop;

    if (annotationItem) {
      // Scroll only within the annotations list, not affecting PDF
      const annotationsList = document.getElementById('annotations-list');
      if (annotationsList) {
        const itemTop = annotationItem.offsetTop;
        const listHeight = annotationsList.clientHeight;
        const itemHeight = annotationItem.offsetHeight;
        annotationsList.scrollTop = itemTop - (listHeight / 2) + (itemHeight / 2);
      }
    }

    // Restore PDF scroll position if it changed
    if (pdfContainer && pdfScrollTop !== undefined) {
      pdfContainer.scrollTop = pdfScrollTop;
    }

    // Focus with a slight delay
    setTimeout(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    }, 50);

    // Auto-save on blur
    textarea.addEventListener('blur', async () => {
      const newText = textarea.value.trim();
      if (newText !== originalText) {
        await window.electronAPI.updateAnnotation(id, { note_content: newText });
      }
      await this.loadAnnotations(this.selectedPaper.id);
      this.renderHighlightsOnPdf();
    });

    // Save on Enter, cancel on Escape
    textarea.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        textarea.blur(); // Trigger save via blur handler
      } else if (e.key === 'Escape') {
        // Restore original and re-render without saving
        textarea.value = originalText;
        await this.loadAnnotations(this.selectedPaper.id);
      }
    });
  }

  async deleteAnnotation(id) {
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

    // Ensure we have annotation numbers
    if (!this.annotationNumbers) {
      this.annotationNumbers = this.buildAnnotationNumberMap();
    }

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
        const noteNum = this.annotationNumbers.get(annotation.id) || '?';

        // Check if this is an anchor note (no selection text, single rect with isAnchor or zero dimensions)
        const isAnchorNote = !annotation.selection_text &&
          annotation.selection_rects?.length === 1 &&
          (annotation.selection_rects[0].isAnchor ||
           (annotation.selection_rects[0].width === 0 && annotation.selection_rects[0].height === 0));

        if (isAnchorNote && annotation.selection_rects?.length) {
          // Render as numbered anchor marker
          const rect = annotation.selection_rects[0];
          const anchor = document.createElement('div');
          anchor.className = 'pdf-anchor-note';
          anchor.dataset.annotation = annotation.id;
          anchor.style.left = `${rect.x * 100}%`;
          anchor.style.top = `${rect.y * 100}%`;
          anchor.textContent = noteNum;
          anchor.title = `Note ${noteNum}: ${annotation.note_content?.substring(0, 50) || 'Empty'}`;

          anchor.addEventListener('click', () => {
            this.scrollToAnnotationInSidebar(annotation.id);
          });

          pageWrapper.appendChild(anchor);
        } else if (annotation.selection_rects?.length) {
          // Render as highlight rectangles with number badge on first rect
          annotation.selection_rects.forEach((rect, index) => {
            const highlight = document.createElement('div');
            highlight.className = `pdf-highlight ${colorClass}`;
            highlight.dataset.annotation = annotation.id;
            highlight.style.left = `${rect.x * 100}%`;
            highlight.style.top = `${rect.y * 100}%`;
            highlight.style.width = `${rect.width * 100}%`;
            highlight.style.height = `${rect.height * 100}%`;

            // Add number badge to the first rect
            if (index === 0) {
              const badge = document.createElement('span');
              badge.className = 'pdf-highlight-number';
              badge.textContent = noteNum;
              highlight.appendChild(badge);
            }

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
    // Preserve PDF scroll position
    const pdfContainer = document.getElementById('pdf-container');
    const pdfScrollTop = pdfContainer?.scrollTop;

    // Highlight in sidebar
    document.querySelectorAll('.annotation-item').forEach(el => el.classList.remove('active'));
    const item = document.querySelector(`.annotation-item[data-id="${id}"]`);
    if (item) {
      item.classList.add('active');
      // Scroll only within the annotations list
      const annotationsList = document.getElementById('annotations-list');
      if (annotationsList) {
        const itemTop = item.offsetTop;
        const listHeight = annotationsList.clientHeight;
        const itemHeight = item.offsetHeight;
        annotationsList.scrollTop = itemTop - (listHeight / 2) + (itemHeight / 2);
      }
    }

    // Restore PDF scroll position if it changed
    if (pdfContainer && pdfScrollTop !== undefined) {
      pdfContainer.scrollTop = pdfScrollTop;
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

  // Get CSS class for PDF button based on paper state
  getPdfButtonClass(paper) {
    // Has downloaded PDF
    if (paper.pdf_path) {
      return 'pdf-btn-downloaded';
    }
    // Has bibcode = might have sources available from ADS
    if (paper.bibcode) {
      return 'pdf-btn-available';
    }
    // No bibcode = no ADS sources possible
    return 'pdf-btn-unavailable';
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

  consoleLog(message, type = 'info', details = null) {
    const logEl = document.getElementById('console-log');
    if (!logEl) return;

    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = time;

    const messageSpan = document.createElement('span');
    messageSpan.className = `log-${type}`;
    messageSpan.textContent = message;

    entry.appendChild(timeSpan);
    entry.appendChild(messageSpan);

    // If error has details, make it clickable to open detail view
    if (details && type === 'error') {
      entry.classList.add('log-clickable');
      entry.title = 'Click to view error details';
      entry.addEventListener('click', () => this.showErrorDetails(details));
    }

    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;

    // Keep only last 100 entries
    while (logEl.children.length > 100) {
      logEl.removeChild(logEl.firstChild);
    }

    // Sync to drawer console
    const drawerLog = document.getElementById('drawer-console-log');
    if (drawerLog) {
      const drawerEntry = document.createElement('div');
      drawerEntry.className = `console-line console-${type}`;
      drawerEntry.textContent = `${time} ${message}`;
      drawerLog.appendChild(drawerEntry);

      // Keep only last 50 entries in drawer
      while (drawerLog.children.length > 50) {
        drawerLog.removeChild(drawerLog.firstChild);
      }

      // Auto-scroll to bottom
      drawerLog.scrollTop = drawerLog.scrollHeight;
    }
  }

  showErrorDetails(details) {
    // Create or reuse error detail modal
    let modal = document.getElementById('error-detail-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'error-detail-modal';
      modal.className = 'modal';
      modal.innerHTML = `
        <div class="modal-content error-detail-content">
          <div class="modal-header">
            <h2>Error Details</h2>
            <button class="modal-close-x" title="Close">&times;</button>
          </div>
          <pre class="error-detail-text"></pre>
          <div class="modal-footer">
            <button class="secondary-btn copy-error-btn">Copy to Clipboard</button>
            <button class="primary-btn close-error-btn">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const closeModal = () => modal.classList.remove('active');

      // Close button (X)
      modal.querySelector('.modal-close-x').addEventListener('click', closeModal);

      // Close button in footer
      modal.querySelector('.close-error-btn').addEventListener('click', closeModal);

      // Copy button
      modal.querySelector('.copy-error-btn').addEventListener('click', (e) => {
        const text = modal.querySelector('.error-detail-text').textContent;
        navigator.clipboard.writeText(text).then(() => {
          e.target.textContent = 'Copied!';
          setTimeout(() => { e.target.textContent = 'Copy to Clipboard'; }, 2000);
        });
      });

      // Close on backdrop click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });

      // Close on Escape key
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) {
          closeModal();
        }
      });
    }

    modal.querySelector('.error-detail-text').textContent = details;
    modal.classList.add('active');
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Render markdown text (supports basic markdown + LaTeX)
  renderMarkdown(text) {
    if (!text) return '';

    // Configure marked for safe rendering
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,      // Convert \n to <br>
        gfm: true,         // GitHub Flavored Markdown
        headerIds: false,  // Don't add IDs to headers
        mangle: false      // Don't mangle emails
      });

      try {
        // Render markdown
        let html = marked.parse(text);
        return html;
      } catch (e) {
        console.error('Markdown rendering error:', e);
        return this.escapeHtml(text);
      }
    }

    // Fallback: escape HTML if marked is not available
    return this.escapeHtml(text);
  }

  showNotification(message, type = 'info') {
    const toast = document.getElementById('notification-toast');
    if (!toast) return;

    // Clear any existing timeout
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }

    // Set content and type
    toast.textContent = message;
    toast.className = 'notification-toast ' + type;

    // Auto-hide after delay
    this.notificationTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIBRARY EXPORT/IMPORT
  // ═══════════════════════════════════════════════════════════════════════════

  async showExportModal() {
    const modal = document.getElementById('export-library-modal');
    if (!modal) return;

    // Reset state
    document.getElementById('export-progress-section')?.classList.add('hidden');
    document.getElementById('export-save-btn').disabled = false;
    document.getElementById('export-share-btn').disabled = false;

    // Set default library name (use current library name if available)
    const libraryNameInput = document.getElementById('export-library-name');
    if (libraryNameInput) {
      let libraryName = 'My Library';
      try {
        const currentId = await window.electronAPI.getCurrentLibraryId?.();
        if (currentId) {
          const allLibraries = await window.electronAPI.getAllLibraries?.();
          const currentLibrary = allLibraries?.find(l => l.id === currentId);
          if (currentLibrary?.name) {
            libraryName = currentLibrary.name;
          }
        }
      } catch (e) {
        console.log('Could not get current library name:', e);
      }
      libraryNameInput.value = libraryName;
    }

    // Fetch stats
    try {
      const stats = await window.electronAPI.getExportStats();
      if (stats) {
        document.getElementById('export-paper-count').textContent = stats.paperCount;
        document.getElementById('export-pdfs-size').textContent = `(${this.formatBytes(stats.pdfSize)})`;
        document.getElementById('export-refs-count').textContent = `(${stats.refCount} refs)`;
        document.getElementById('export-cites-count').textContent = `(${stats.citeCount} cites)`;
        document.getElementById('export-annotations-count').textContent = `(${stats.annotationCount} notes)`;
        document.getElementById('export-total-size').textContent = `~${this.formatBytes(stats.pdfSize)}`;
      }
    } catch (e) {
      console.error('Failed to get export stats:', e);
    }

    modal.classList.remove('hidden');
  }

  hideExportModal() {
    document.getElementById('export-library-modal')?.classList.add('hidden');
    window.electronAPI.removeExportImportListeners?.();
  }

  async handleExport() {
    const libraryName = document.getElementById('export-library-name')?.value?.trim() || 'My Library';
    const options = {
      libraryName,
      includePdfs: document.getElementById('export-pdfs').checked,
      includeRefs: document.getElementById('export-refs').checked,
      includeCites: document.getElementById('export-cites').checked,
      includeAnnotations: document.getElementById('export-annotations').checked,
      sortField: this.sortField,
      sortOrder: this.sortOrder
    };

    // Disable buttons
    document.getElementById('export-save-btn').disabled = true;
    document.getElementById('export-share-btn').disabled = true;

    // Show progress
    const progressSection = document.getElementById('export-progress-section');
    progressSection?.classList.remove('hidden');
    document.getElementById('export-progress-text').textContent = 'Creating export...';
    document.getElementById('export-progress-fill').style.width = '0%';

    try {
      const result = await window.electronAPI.exportLibrary(options);

      if (result.success) {
        this.showNotification(`Library exported to ${result.path.split('/').pop()}`, 'success');
        this.hideExportModal();
      } else if (!result.canceled) {
        this.showNotification(`Export failed: ${result.error}`, 'error');
        document.getElementById('export-save-btn').disabled = false;
        document.getElementById('export-share-btn').disabled = false;
        progressSection?.classList.add('hidden');
      } else {
        document.getElementById('export-save-btn').disabled = false;
        document.getElementById('export-share-btn').disabled = false;
        progressSection?.classList.add('hidden');
      }
    } catch (error) {
      this.showNotification(`Export failed: ${error.message}`, 'error');
      document.getElementById('export-save-btn').disabled = false;
      document.getElementById('export-share-btn').disabled = false;
      progressSection?.classList.add('hidden');
    }
  }

  async handleExportAndShare() {
    const libraryName = document.getElementById('export-library-name')?.value?.trim() || 'My Library';
    const options = {
      libraryName,
      includePdfs: document.getElementById('export-pdfs').checked,
      includeRefs: document.getElementById('export-refs').checked,
      includeCites: document.getElementById('export-cites').checked,
      includeAnnotations: document.getElementById('export-annotations').checked,
      sortField: this.sortField,
      sortOrder: this.sortOrder,
      forSharing: true  // Skip save dialog, export to temp
    };

    // Disable buttons
    const saveBtn = document.getElementById('export-save-btn');
    const shareBtn = document.getElementById('export-share-btn');
    saveBtn.disabled = true;
    shareBtn.disabled = true;

    // Show progress
    const progressSection = document.getElementById('export-progress-section');
    const progressText = document.getElementById('export-progress-text');
    const progressFill = document.getElementById('export-progress-fill');
    progressSection?.classList.remove('hidden');
    progressText.textContent = 'Preparing to share...';
    progressFill.style.width = '0%';

    try {
      const result = await window.electronAPI.exportLibrary(options);

      if (result.success) {
        // Update progress to show we're opening share sheet
        progressText.textContent = 'Opening share sheet...';
        progressFill.style.width = '100%';

        // Share the file via native share
        const shareResult = await window.electronAPI.shareFileNative(result.path, 'ADS Reader Library');

        if (shareResult.method === 'native-picker') {
          if (shareResult.canceled) {
            // User dismissed the share sheet
            this.showNotification('Share cancelled', 'info');
          } else {
            this.showNotification('Ready to share!', 'success');
          }
        } else {
          // Fallback to Finder
          this.showNotification('File revealed in Finder - right-click to share', 'success');
        }
        this.hideExportModal();
      } else if (!result.canceled) {
        this.showNotification(`Export failed: ${result.error}`, 'error');
        saveBtn.disabled = false;
        shareBtn.disabled = false;
        progressSection?.classList.add('hidden');
      } else {
        saveBtn.disabled = false;
        shareBtn.disabled = false;
        progressSection?.classList.add('hidden');
      }
    } catch (error) {
      this.showNotification(`Export failed: ${error.message}`, 'error');
      saveBtn.disabled = false;
      shareBtn.disabled = false;
      progressSection?.classList.add('hidden');
    }
  }

  updateExportProgress(data) {
    const progressText = document.getElementById('export-progress-text');
    const progressFill = document.getElementById('export-progress-fill');

    if (progressText && progressFill) {
      if (data.phase === 'pdfs') {
        progressText.textContent = `Adding PDFs: ${data.current}/${data.total}`;
        progressFill.style.width = `${(data.current / data.total) * 100}%`;
      } else {
        progressText.textContent = data.phase;
      }
    }
  }

  // Export Book Modal
  async showExportBookModal() {
    if (this.selectedPapers.size === 0) {
      this.showNotification('No papers selected', 'warn');
      return;
    }

    const modal = document.getElementById('export-book-modal');
    if (!modal) return;

    // Reset state
    document.getElementById('export-book-progress-section')?.classList.add('hidden');
    document.getElementById('export-book-save-btn').disabled = false;
    document.getElementById('export-book-share-btn').disabled = false;

    // Count papers with and without PDFs
    const selectedPapers = this.papers.filter(p => this.selectedPapers.has(p.id));
    let withPdf = 0;
    let withoutPdf = 0;

    for (const paper of selectedPapers) {
      // Check if paper has any PDF source
      const downloadedSources = await window.electronAPI.getDownloadedPdfSources(paper.id);
      const attachments = await window.electronAPI.getAttachments?.(paper.id) || [];
      const pdfAttachments = attachments.filter(a => a.filename?.toLowerCase().endsWith('.pdf'));

      if (downloadedSources.length > 0 || pdfAttachments.length > 0 || paper.pdf_path) {
        withPdf++;
      } else {
        withoutPdf++;
      }
    }

    // Update UI
    document.getElementById('export-book-count').textContent = selectedPapers.length;
    document.getElementById('export-book-with-pdf').textContent = withPdf;
    document.getElementById('export-book-without-pdf').textContent = withoutPdf;

    // Set default title
    const titleInput = document.getElementById('export-book-title');
    if (titleInput) {
      if (selectedPapers.length === 1) {
        titleInput.value = selectedPapers[0].title?.substring(0, 50) || 'Paper';
      } else {
        titleInput.value = 'Selected Papers';
      }
    }

    modal.classList.remove('hidden');
  }

  hideExportBookModal() {
    document.getElementById('export-book-modal')?.classList.add('hidden');
    window.electronAPI.removeBookExportListeners?.();
  }

  async handleExportBook(forSharing = false) {
    const bookTitle = document.getElementById('export-book-title')?.value?.trim() || 'Selected Papers';
    const paperIds = Array.from(this.selectedPapers);

    // Disable buttons
    document.getElementById('export-book-save-btn').disabled = true;
    document.getElementById('export-book-share-btn').disabled = true;

    // Show progress
    const progressSection = document.getElementById('export-book-progress-section');
    progressSection?.classList.remove('hidden');
    document.getElementById('export-book-progress-text').textContent = 'Preparing export...';
    document.getElementById('export-book-progress-fill').style.width = '0%';

    // Set up progress listener
    window.electronAPI.onBookExportProgress((data) => {
      this.updateBookExportProgress(data);
    });

    try {
      const result = await window.electronAPI.exportBook({
        paperIds,
        bookTitle,
        lastPdfSources: this.lastPdfSources,
        forSharing
      });

      if (result.success) {
        if (forSharing) {
          // Share the file
          document.getElementById('export-book-progress-text').textContent = 'Opening share sheet...';
          document.getElementById('export-book-progress-fill').style.width = '100%';

          const shareResult = await window.electronAPI.shareFileNative(result.path, bookTitle);
          if (shareResult.method === 'native-picker') {
            this.showNotification(shareResult.canceled ? 'Share cancelled' : 'Ready to share!',
              shareResult.canceled ? 'info' : 'success');
          } else {
            this.showNotification('File revealed in Finder - right-click to share', 'success');
          }
        } else {
          this.showNotification(`Book exported to ${result.path.split('/').pop()}`, 'success');
        }
        this.hideExportBookModal();
      } else if (!result.canceled) {
        this.showNotification(`Export failed: ${result.error}`, 'error');
        this.resetExportBookModal();
      } else {
        this.resetExportBookModal();
      }
    } catch (error) {
      this.showNotification(`Export failed: ${error.message}`, 'error');
      this.resetExportBookModal();
    }
  }

  resetExportBookModal() {
    document.getElementById('export-book-save-btn').disabled = false;
    document.getElementById('export-book-share-btn').disabled = false;
    document.getElementById('export-book-progress-section')?.classList.add('hidden');
  }

  updateBookExportProgress(data) {
    const progressText = document.getElementById('export-book-progress-text');
    const progressFill = document.getElementById('export-book-progress-fill');

    if (progressText && progressFill) {
      switch (data.phase) {
        case 'merging':
          progressText.textContent = `Merging PDFs: ${data.current}/${data.total}`;
          progressFill.style.width = `${(data.current / data.total) * 80}%`;
          break;
        case 'toc':
          progressText.textContent = 'Creating table of contents...';
          progressFill.style.width = '85%';
          break;
        case 'finalizing':
          progressText.textContent = 'Finalizing book...';
          progressFill.style.width = '92%';
          break;
        case 'saving':
          progressText.textContent = 'Saving PDF...';
          progressFill.style.width = '98%';
          break;
        default:
          progressText.textContent = data.phase;
      }
    }
  }

  // Import Modal
  async showImportModal() {
    const modal = document.getElementById('import-library-modal');
    if (!modal) return;

    // Reset state
    this.importFilePath = null;
    document.getElementById('import-filename').textContent = 'Select a .adslib file';
    document.getElementById('import-meta').textContent = '';
    document.getElementById('import-stats')?.classList.add('hidden');
    document.getElementById('import-options')?.classList.add('hidden');
    document.getElementById('import-progress-section')?.classList.add('hidden');
    document.getElementById('import-result-section')?.classList.add('hidden');
    document.getElementById('import-select-btn').classList.remove('hidden');
    document.getElementById('import-confirm-btn').classList.add('hidden');

    modal.classList.remove('hidden');
  }

  hideImportModal() {
    document.getElementById('import-library-modal')?.classList.add('hidden');
    window.electronAPI.removeExportImportListeners?.();
  }

  async selectImportFile() {
    try {
      const result = await window.electronAPI.previewLibraryImport();

      if (result.success) {
        this.importFilePath = result.filePath;

        // Update UI
        document.getElementById('import-filename').textContent = result.filePath.split('/').pop();
        document.getElementById('import-meta').textContent =
          `Exported on ${new Date(result.exportDate).toLocaleDateString()} from ${result.platform}`;

        // Set library name from manifest or use filename
        const libraryNameInput = document.getElementById('import-library-name');
        if (libraryNameInput) {
          const defaultName = result.libraryName || result.filePath.split('/').pop().replace('.adslib', '');
          libraryNameInput.value = defaultName;
        }

        // Show stats
        const stats = result.stats;
        document.getElementById('import-paper-count').textContent = stats.paperCount || stats.papers || 0;
        document.getElementById('import-pdf-count').textContent = stats.pdfCount || 0;
        document.getElementById('import-annotation-count').textContent = stats.annotationCount || 0;
        document.getElementById('import-stats').classList.remove('hidden');

        // Show options and reset to default (create new library)
        document.getElementById('import-options').classList.remove('hidden');
        const newLibraryRadio = document.querySelector('input[name="import-mode"][value="new"]');
        if (newLibraryRadio) newLibraryRadio.checked = true;

        // Show confirm button, hide select
        document.getElementById('import-select-btn').classList.add('hidden');
        document.getElementById('import-confirm-btn').classList.remove('hidden');
      } else if (!result.canceled) {
        this.showNotification(`Failed to read file: ${result.error}`, 'error');
      }
    } catch (error) {
      this.showNotification(`Failed to read file: ${error.message}`, 'error');
    }
  }

  async handleImport() {
    if (!this.importFilePath) {
      this.showNotification('Please select a file first', 'error');
      return;
    }

    const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'new';
    const libraryName = document.getElementById('import-library-name')?.value?.trim() || 'Imported Library';
    const importPdfs = document.getElementById('import-pdfs').checked;
    const importAnnotations = document.getElementById('import-annotations').checked;

    // Show progress
    document.getElementById('import-options').classList.add('hidden');
    document.getElementById('import-progress-section').classList.remove('hidden');
    document.getElementById('import-confirm-btn').disabled = true;
    document.getElementById('import-progress-text').textContent = mode === 'new' ? 'Creating new library...' : 'Importing papers...';
    document.getElementById('import-progress-fill').style.width = '0%';

    try {
      const result = await window.electronAPI.importLibrary({
        filePath: this.importFilePath,
        mode,
        libraryName,
        importPdfs,
        importAnnotations
      });

      if (result.success) {
        // Show result
        document.getElementById('import-progress-section').classList.add('hidden');
        document.getElementById('import-result-section').classList.remove('hidden');

        if (mode === 'new') {
          document.getElementById('import-result-text').textContent = `Library "${libraryName}" created!`;
          document.getElementById('import-result-stats').innerHTML = `
            <div>${result.papersImported} papers imported</div>
            <div>${result.pdfsImported} PDFs imported</div>
            <div>${result.annotationsImported} annotations imported</div>
            <div style="margin-top: 12px; font-size: 12px; color: var(--text-muted)">
              Switch to this library from the Libraries menu
            </div>
          `;
        } else {
          document.getElementById('import-result-text').textContent = 'Import complete!';
          document.getElementById('import-result-stats').innerHTML = `
            <div>${result.papersImported} papers imported</div>
            <div>${result.papersSkipped} skipped (duplicates)</div>
            <div>${result.pdfsImported} PDFs imported</div>
            <div>${result.annotationsImported} annotations imported</div>
          `;
          // Refresh paper list only when adding to current library
          await this.loadPapers();
        }

        // Apply sort preferences from imported library (if present)
        if (result.sortPreferences) {
          this.sortField = result.sortPreferences.field || 'added';
          this.sortOrder = result.sortPreferences.order || 'desc';
          // Save to local preferences
          if (window.electronAPI.setSortPreferences) {
            await window.electronAPI.setSortPreferences(this.sortField, this.sortOrder);
          }
          // Update UI and re-sort papers
          this.updateAllSortUI();
          if (mode !== 'new') {
            this.sortPapers();
            this.renderPaperList();
          }
        }

        // Auto-close after delay
        setTimeout(() => this.hideImportModal(), 4000);
      } else {
        this.showNotification(`Import failed: ${result.error}`, 'error');
        document.getElementById('import-progress-section').classList.add('hidden');
        document.getElementById('import-options').classList.remove('hidden');
        document.getElementById('import-confirm-btn').disabled = false;
      }
    } catch (error) {
      this.showNotification(`Import failed: ${error.message}`, 'error');
      document.getElementById('import-progress-section').classList.add('hidden');
      document.getElementById('import-options').classList.remove('hidden');
      document.getElementById('import-confirm-btn').disabled = false;
    }
  }

  updateLibraryImportProgress(data) {
    const progressText = document.getElementById('import-progress-text');
    const progressFill = document.getElementById('import-progress-fill');

    if (progressText && progressFill) {
      if (data.phase === 'papers') {
        progressText.textContent = `Importing papers: ${data.current}/${data.total}`;
      } else if (data.phase === 'pdfs') {
        progressText.textContent = `Importing PDFs: ${data.current}/${data.total}`;
      }
      progressFill.style.width = `${(data.current / data.total) * 100}%`;
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  window.app = new ADSReader();
});
