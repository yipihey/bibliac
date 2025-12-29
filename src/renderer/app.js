// SciX Reader - Main Renderer Application

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

class SciXReader {
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

    // PDF state
    this.pdfDoc = null;
    this.pdfScale = 1.0; // Will be loaded from settings
    this.pageRotations = {};
    this.currentPdfSource = null; // Track which PDF source is currently loaded
    this.pdfPagePositions = {}; // Store last page position per paper ID
    this.isRendering = false; // Prevent concurrent renders
    this.pendingRender = null; // Queue next render if one is in progress

    // SciX search state
    this.scixResults = [];
    this.scixSelected = new Set();

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
    this.libraryPath = await window.electronAPI.getLibraryPath();

    // Load saved PDF zoom level
    const savedZoom = await window.electronAPI.getPdfZoom();
    if (savedZoom) {
      this.pdfScale = savedZoom;
    }

    // Load saved PDF page positions
    this.pdfPagePositions = await window.electronAPI.getPdfPositions() || {};

    if (this.libraryPath) {
      const info = await window.electronAPI.getLibraryInfo(this.libraryPath);
      if (info) {
        this.showMainScreen(info);
        await this.loadPapers();
        await this.loadCollections();
        await this.checkAdsToken();
        await this.checkLlmConnection();

        // Restore last selected paper
        const lastPaperId = await window.electronAPI.getLastSelectedPaper();
        if (lastPaperId && this.papers.find(p => p.id === lastPaperId)) {
          this.selectPaper(lastPaperId);
        }
      } else {
        this.showSetupScreen();
      }
    } else {
      this.showSetupScreen();
    }

    this.setupEventListeners();
    document.title = 'SciX Reader';
  }

  setupEventListeners() {
    // Setup screen
    document.getElementById('select-folder-btn')?.addEventListener('click', () => this.selectLibraryFolder());

    // Main screen
    document.getElementById('change-library-btn')?.addEventListener('click', () => this.selectLibraryFolder());
    document.getElementById('import-btn')?.addEventListener('click', () => this.importPDFs());
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

    // ADS settings
    document.getElementById('ads-settings-btn')?.addEventListener('click', () => this.showAdsModal());
    document.getElementById('ads-cancel-btn')?.addEventListener('click', () => this.hideAdsModal());
    document.getElementById('ads-save-btn')?.addEventListener('click', () => this.saveAdsToken());

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

    // SciX Search
    document.getElementById('scix-search-btn')?.addEventListener('click', () => this.showScixModal());
    document.getElementById('scix-close-btn')?.addEventListener('click', () => this.hideScixModal());
    document.getElementById('scix-search-execute-btn')?.addEventListener('click', () => this.executeScixSearch());
    document.getElementById('scix-query-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.executeScixSearch();
    });
    document.getElementById('scix-select-all-btn')?.addEventListener('click', () => this.scixSelectAll());
    document.getElementById('scix-select-none-btn')?.addEventListener('click', () => this.scixSelectNone());
    document.getElementById('scix-import-btn')?.addEventListener('click', () => this.importScixSelected());

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

    // ADS lookup shortcut buttons
    document.querySelectorAll('#ads-lookup-modal .scix-shortcut-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('ads-lookup-query');
        const insert = btn.dataset.insert;
        input.value += insert;
        input.focus();
      });
    });

    // SciX shortcut buttons
    document.querySelectorAll('.scix-shortcut-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('scix-query-input');
        const insertText = btn.dataset.insert;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const value = input.value;
        input.value = value.substring(0, start) + insertText + value.substring(end);
        input.focus();
        input.selectionStart = input.selectionEnd = start + insertText.length;
      });
    });

    // SciX import progress listeners
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

    // Text selection for AI explain
    document.getElementById('pdf-container')?.addEventListener('mouseup', (e) => this.handleTextSelection(e));
    document.getElementById('ctx-explain-text')?.addEventListener('click', () => this.explainSelectedText());
    document.getElementById('ctx-copy-text')?.addEventListener('click', () => this.copySelectedText());
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
      });
    });
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
  }

  showMainScreen(info) {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');
    this.updateLibraryDisplay(info);
  }

  async selectLibraryFolder() {
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
        }, 300);
      }
    }
  }

  updateLibraryDisplay(info) {
    document.getElementById('paper-count').textContent = info.paperCount;
    document.getElementById('unread-count').textContent = info.unreadCount || 0;
    document.getElementById('reading-count').textContent = info.readingCount || 0;
    document.getElementById('read-count').textContent = info.readCount || 0;

    const pathDisplay = document.getElementById('library-path-display');
    const folderName = info.path.split('/').pop();
    pathDisplay.textContent = folderName;
    pathDisplay.title = info.path;
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
          ${this.getRatingEmoji(paper.rating)}
          ${paper.bibcode ? `<button class="pdf-source-btn" data-paper-id="${paper.id}" data-bibcode="${paper.bibcode}" title="Choose PDF source">📄▾${paper.annotation_count > 0 ? `<span class="note-badge">${paper.annotation_count}</span>` : ''}</button>` : ''}
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
    document.title = 'SciX Reader';
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
      : 'SciX Reader';
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
      abstractEl.innerHTML = '<p class="no-content">No abstract available. Click "Fetch from ADS" to retrieve metadata.</p>';
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
      refsEl.innerHTML = '<p class="no-content">No references loaded. Click "Fetch from ADS" to retrieve.</p>';
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
          <button class="ref-import-btn" data-bibcode="${ref.ref_bibcode}" title="Import this paper">+</button>
        </div>
      `;
    }).join('');

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
        await this.importSingleRef(item.dataset.bibcode, importBtn);
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
      citesEl.innerHTML = '<p class="no-content">No citations loaded. Click "Fetch from ADS" to retrieve.</p>';
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
          <button class="ref-import-btn" data-bibcode="${cite.citing_bibcode}" title="Import this paper">+</button>
        </div>
      `;
    }).join('');

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
        await this.importSingleRef(item.dataset.bibcode, importBtn);
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
      // Import the paper using the SciX import
      const result = await window.electronAPI.importFromScix([{ bibcode }]);

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
    // Show the SciX modal for progress
    this.showScixModal();
    document.getElementById('scix-query-input').value = `Importing ${papers.length} ${source}...`;
    document.getElementById('scix-search-execute-btn').disabled = true;
    document.getElementById('scix-results-list').innerHTML = '<p class="no-content">Fetching paper metadata from ADS...</p>';
    document.getElementById('scix-results-header').classList.add('hidden');

    const progressEl = document.getElementById('scix-progress');
    progressEl.classList.remove('hidden');

    try {
      const result = await window.electronAPI.importFromScix(papers);
      // Progress updates handled by onImportProgress listener
    } catch (error) {
      console.error('Import error:', error);
      document.getElementById('scix-results-list').innerHTML =
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
      // Delete all selected papers
      for (const id of this.selectedPapers) {
        await window.electronAPI.deletePaper(id);
      }

      // Clear selection
      this.selectedPapers.clear();
      this.selectedPaper = null;
      this.lastClickedIndex = -1;

      // Hide viewer, show placeholder
      document.getElementById('viewer-wrapper').classList.add('hidden');
      document.getElementById('detail-placeholder').classList.remove('hidden');
      document.title = 'SciX Reader';

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
    const applyBtn = document.getElementById('ads-lookup-apply-btn');

    // Reset state
    this.adsLookupSelectedDoc = null;
    applyBtn.disabled = true;
    titleEl.textContent = this.selectedPaper.title || 'Untitled';
    resultsEl.innerHTML = '<div class="scix-empty-state"><p>Extracting metadata...</p></div>';

    modal.classList.remove('hidden');

    // Extract metadata using LLM
    statusEl.classList.remove('hidden');
    statusText.textContent = 'Extracting metadata with AI...';

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

    resultsEl.innerHTML = '<div class="scix-empty-state"><p>Click Search to find matching papers in ADS</p></div>';
  }

  buildAdsQueryFromPaper(queryInput) {
    const paper = this.selectedPaper;
    if (!paper) {
      queryInput.value = '';
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
    const footerEl = document.getElementById('sync-footer');

    const paperCount = paperIds.length;
    statusEl.textContent = `Starting sync of ${paperCount} paper${paperCount > 1 ? 's' : ''}...`;
    progressEl.style.width = '0%';
    paperEl.textContent = '';
    footerEl.style.display = 'none';

    // Add spinning animation to button
    const syncBtn = document.getElementById('ads-sync-btn');
    syncBtn.classList.add('syncing');
    syncBtn.disabled = true;

    // Set up progress listener
    window.electronAPI.onAdsSyncProgress((data) => {
      if (data.done) {
        // Sync complete
        const r = data.results;
        statusEl.textContent = `Sync complete! Updated ${r.updated}, skipped ${r.skipped}, failed ${r.failed}`;
        progressEl.style.width = '100%';
        paperEl.textContent = '';
        footerEl.style.display = 'flex';

        syncBtn.classList.remove('syncing');
        syncBtn.disabled = false;

        // Reload papers to show updated data
        this.loadPapers();
        if (this.selectedPaper) {
          this.showPaperDetail(this.selectedPaper.id);
        }
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
      statusEl.textContent = `Sync failed: ${error.message}`;
      footerEl.style.display = 'flex';
      syncBtn.classList.remove('syncing');
      syncBtn.disabled = false;
    }

    // Clean up listener
    window.electronAPI.removeAdsSyncListeners();
  }

  hideAdsSyncModal() {
    document.getElementById('ads-sync-modal').classList.add('hidden');
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
        resultsEl.innerHTML = '<div class="scix-empty-state"><p>Search error</p></div>';
      } else {
        statusText.textContent = 'No papers found. Try adjusting your search.';
        resultsEl.innerHTML = '<div class="scix-empty-state"><p>No results found</p></div>';
      }
    } catch (err) {
      console.error('ADS lookup error:', err);
      statusText.textContent = 'Search failed: ' + err.message;
    }
  }

  renderAdsLookupResults(papers) {
    const resultsEl = document.getElementById('ads-lookup-results');

    resultsEl.innerHTML = papers.map((paper, i) => `
      <div class="scix-result-item" data-index="${i}">
        <div class="scix-result-checkbox">
          <input type="radio" name="ads-lookup-select" id="ads-lookup-${i}">
        </div>
        <div class="scix-result-info">
          <div class="scix-result-title">${this.escapeHtml(paper.title || 'Untitled')}</div>
          <div class="scix-result-meta">
            <span>${paper.authors?.[0] || 'Unknown'}</span>
            <span>${paper.year || ''}</span>
            <span>${paper.bibcode || ''}</span>
          </div>
          ${paper.abstract ? `<div class="scix-result-abstract">${this.escapeHtml(paper.abstract.substring(0, 200))}...</div>` : ''}
        </div>
      </div>
    `).join('');

    // Store papers for selection
    this.adsLookupPapers = papers;

    // Add click handlers
    resultsEl.querySelectorAll('.scix-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        this.selectAdsLookupResult(index);
      });
    });
  }

  selectAdsLookupResult(index) {
    const resultsEl = document.getElementById('ads-lookup-results');
    const applyBtn = document.getElementById('ads-lookup-apply-btn');

    // Update UI
    resultsEl.querySelectorAll('.scix-result-item').forEach((item, i) => {
      item.classList.toggle('selected', i === index);
      const radio = item.querySelector('input[type="radio"]');
      if (radio) radio.checked = (i === index);
    });

    // Store selection
    this.adsLookupSelectedDoc = this.adsLookupPapers[index];
    applyBtn.disabled = false;
  }

  async applyAdsLookupMetadata() {
    if (!this.selectedPaper || !this.adsLookupSelectedDoc) return;

    const applyBtn = document.getElementById('ads-lookup-apply-btn');
    applyBtn.textContent = 'Importing from ADS...';
    applyBtn.disabled = true;

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
        this.hideAdsLookupModal();
        // Reload paper list and select the newly imported paper
        await this.loadPapers();
        if (result.paperId) {
          await this.selectPaper(result.paperId);
        }

        // Show confirmation
        const pdfMsg = result.hasPdf ? ' with PDF' : ' (no PDF available)';
        console.log(`Paper imported from ADS${pdfMsg}`);
      } else {
        alert('Failed to import from ADS: ' + result.error);
      }
    } finally {
      applyBtn.textContent = 'Import from ADS';
      applyBtn.disabled = false;
    }
  }

  async copyCite() {
    if (!this.selectedPaper) return;

    const result = await window.electronAPI.copyCite(this.selectedPaper.id, 'cite');
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
        btn.textContent = '📄▾';
        alert(`Failed to get PDF sources: ${result.error}`);
        return;
      }

      const sources = result.data;

      // Fetch annotation counts by source for this paper
      const annotationCounts = await window.electronAPI.getAnnotationCountsBySource(paperId);

      // Map dropdown types to database pdf_source values
      const sourceToDbKey = { arxiv: 'EPRINT_PDF', ads: 'ADS_PDF', publisher: 'PUB_PDF' };

      btn.textContent = '📄▾';

      // Collect available sources with annotation counts
      const availableSources = [];
      if (sources.arxiv) {
        const count = annotationCounts['EPRINT_PDF'] || 0;
        availableSources.push({ type: 'arxiv', label: '📑 arXiv PDF', noteCount: count });
      }
      if (sources.ads) {
        const count = annotationCounts['ADS_PDF'] || 0;
        availableSources.push({ type: 'ads', label: '📜 ADS Scan', noteCount: count });
      }
      if (sources.publisher) {
        const count = annotationCounts['PUB_PDF'] || 0;
        availableSources.push({ type: 'publisher', label: '📰 Publisher', noteCount: count });
      }

      // If no sources available
      if (availableSources.length === 0) {
        alert('No PDF sources available for this paper');
        return;
      }

      // If only one source, download directly without showing menu
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
        return `<div class="pdf-source-item" data-source="${s.type}">${s.label}${notesBadge}</div>`;
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
          e.stopPropagation();
          const sourceType = item.dataset.source;
          await this.downloadFromSource(paperId, sourceType, item);
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
      btn.textContent = '📄▾';
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

    const paper = this.papers.find(p => p.id === paperId);
    if (!paper) return;

    // Map source types to PDF source identifiers
    const sourceToType = {
      publisher: 'PUB_PDF',
      arxiv: 'EPRINT_PDF',
      ads: 'ADS_PDF',
      author: 'AUTHOR_PDF'
    };

    // If paper already has a PDF and it exists, just load it
    if (paper.pdf_path) {
      const pdfExists = await window.electronAPI.getPdfPath(paper.pdf_path);
      if (pdfExists) {
        console.log(`PDF already exists, loading: ${paper.pdf_path}`);
        if (this.selectedPaper && this.selectedPaper.id === paperId) {
          this.currentPdfSource = sourceToType[sourceType] || null;
          await this.loadPDF(this.selectedPaper);
        }
        return;
      }
    }

    // Publisher PDFs require authentication - open in auth window to download
    if (sourceType === 'publisher') {
      // Get the direct publisher PDF URL from esources
      const esourcesResult = await window.electronAPI.adsGetEsources(paper.bibcode);
      let publisherUrl = null;

      if (esourcesResult.success && esourcesResult.data.publisher) {
        publisherUrl = esourcesResult.data.publisher.url;
      }

      // Fall back to ADS link gateway if no direct URL
      if (!publisherUrl) {
        publisherUrl = `https://ui.adsabs.harvard.edu/link_gateway/${paper.bibcode}/PUB_PDF`;
      }

      const proxyUrl = await window.electronAPI.getLibraryProxy();
      console.log('Downloading publisher PDF:', { proxyUrl, publisherUrl, bibcode: paper.bibcode });

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
              btn.textContent = '📄▾';
              btn.disabled = false;
            }, 1500);
          }
        } else {
          alert(`Download failed: ${result.error}`);
          if (btn) {
            btn.textContent = '📄▾';
            btn.disabled = false;
          }
        }
      } catch (error) {
        console.error('Publisher PDF download error:', error);
        alert(`Download error: ${error.message}`);
        if (btn) {
          btn.textContent = '📄▾';
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
            btn.textContent = '📄▾';
            btn.disabled = false;
          }, 1500);
        }
      } else {
        alert(`Download failed: ${result.error}`);
        if (btn) {
          btn.textContent = '📄▾';
          btn.disabled = false;
        }
      }
    } catch (error) {
      console.error('Download error:', error);
      alert(`Download error: ${error.message}`);
      if (btn) {
        btn.textContent = '📄▾';
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

  // ADS Token Modal
  async checkAdsToken() {
    const token = await window.electronAPI.getAdsToken();
    this.hasAdsToken = !!token;

    const status = document.getElementById('ads-status');
    status.classList.toggle('connected', this.hasAdsToken);
  }

  async showAdsModal() {
    document.getElementById('ads-modal').classList.remove('hidden');
    document.getElementById('ads-token-input').focus();

    // Load current ADS token
    const token = await window.electronAPI.getAdsToken();
    document.getElementById('ads-token-input').value = token || '';

    // Load current library proxy URL
    const proxyUrl = await window.electronAPI.getLibraryProxy();
    document.getElementById('library-proxy-input').value = proxyUrl || '';
  }

  hideAdsModal() {
    document.getElementById('ads-modal').classList.add('hidden');
    document.getElementById('ads-token-input').value = '';
    document.getElementById('library-proxy-input').value = '';
    document.getElementById('ads-modal-status').textContent = '';
  }

  async saveAdsToken() {
    const token = document.getElementById('ads-token-input').value.trim();
    const proxyUrl = document.getElementById('library-proxy-input').value.trim();
    const statusEl = document.getElementById('ads-modal-status');

    // Token is required only if not already set
    if (!token && !this.hasAdsToken) {
      statusEl.className = 'modal-status error';
      statusEl.textContent = 'Please enter a token';
      return;
    }

    statusEl.className = 'modal-status';
    statusEl.textContent = 'Saving...';

    // Save library proxy (always)
    await window.electronAPI.setLibraryProxy(proxyUrl);

    // Save ADS token if provided
    if (token) {
      const result = await window.electronAPI.setAdsToken(token);

      if (result.success) {
        this.hasAdsToken = true;
        document.getElementById('ads-status').classList.add('connected');
        statusEl.className = 'modal-status success';
        statusEl.textContent = 'Settings saved successfully!';
        setTimeout(() => this.hideAdsModal(), 1000);
      } else {
        statusEl.className = 'modal-status error';
        statusEl.textContent = `Invalid token: ${result.error}`;
      }
    } else {
      // Just saved proxy, no token change
      statusEl.className = 'modal-status success';
      statusEl.textContent = 'Settings saved successfully!';
      setTimeout(() => this.hideAdsModal(), 1000);
    }
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

  // SciX Search Modal
  showScixModal() {
    if (!this.hasAdsToken) {
      this.showAdsModal();
      return;
    }
    document.getElementById('scix-modal').classList.remove('hidden');
    document.getElementById('scix-query-input').focus();
  }

  hideScixModal() {
    document.getElementById('scix-modal').classList.add('hidden');
    document.getElementById('scix-query-input').value = '';
    this.scixResults = [];
    this.scixSelected.clear();
    this.renderScixResults();
    document.getElementById('scix-results-header').classList.add('hidden');
    document.getElementById('scix-progress').classList.add('hidden');
  }

  async executeScixSearch() {
    const query = document.getElementById('scix-query-input').value.trim();
    if (!query) return;

    const searchBtn = document.getElementById('scix-search-execute-btn');
    searchBtn.textContent = 'Searching...';
    searchBtn.disabled = true;

    try {
      const result = await window.electronAPI.scixSearch(query, { rows: 1000 });

      if (result.success) {
        this.scixResults = result.data.papers;
        this.scixSelected.clear();
        document.getElementById('scix-results-count').textContent =
          `${result.data.numFound} papers found${result.data.numFound > 1000 ? ' (showing first 1000)' : ''}`;
        document.getElementById('scix-results-header').classList.remove('hidden');
        this.renderScixResults();
      } else {
        this.showScixError(result.error);
      }
    } catch (error) {
      this.showScixError(error.message);
    } finally {
      searchBtn.textContent = 'Search';
      searchBtn.disabled = false;
    }
  }

  renderScixResults() {
    const listEl = document.getElementById('scix-results-list');

    if (this.scixResults.length === 0) {
      listEl.innerHTML = `
        <div class="scix-empty-state">
          <p>Enter a search query to find papers in SciX/NASA ADS</p>
        </div>
      `;
      this.updateScixSelectedCount();
      return;
    }

    listEl.innerHTML = this.scixResults.map((paper, index) => {
      const authorsList = paper.authors || [];
      const authorsDisplay = this.formatAuthorsForList(authorsList);
      const hasArxiv = !!paper.arxiv_id;
      const isInLibrary = paper.inLibrary;
      const isSelected = this.scixSelected.has(index);
      const abstractPreview = paper.abstract
        ? paper.abstract.substring(0, 200) + (paper.abstract.length > 200 ? '...' : '')
        : null;

      return `
        <div class="scix-result-item${isSelected ? ' selected' : ''}${isInLibrary ? ' in-library' : ''}" data-index="${index}">
          <input type="checkbox" class="scix-result-checkbox"
            ${isSelected ? 'checked' : ''} ${isInLibrary ? 'disabled' : ''}>
          <div class="scix-result-content">
            <div class="scix-result-title">${this.escapeHtml(paper.title)}</div>
            <div class="scix-result-authors">${this.escapeHtml(authorsDisplay)}</div>
            <div class="scix-result-meta">
              <span>${paper.year || ''}</span>
              ${paper.journal ? `<span class="scix-result-journal">${this.escapeHtml(paper.journal)}</span>` : ''}
              ${paper.bibcode ? `<span>${paper.bibcode}</span>` : ''}
            </div>
            ${abstractPreview ? `<div class="scix-result-abstract">${this.escapeHtml(abstractPreview)}</div>` : ''}
          </div>
          ${isInLibrary ? '<span class="scix-result-status in-library">In Library</span>' : ''}
          ${!isInLibrary && !hasArxiv ? '<span class="scix-result-status no-pdf">No arXiv</span>' : ''}
        </div>
      `;
    }).join('');

    // Add click handlers
    listEl.querySelectorAll('.scix-result-item').forEach(item => {
      const index = parseInt(item.dataset.index);
      const paper = this.scixResults[index];

      if (!paper.inLibrary) {
        item.addEventListener('click', (e) => {
          if (e.target.type !== 'checkbox') {
            this.toggleScixSelection(index);
          }
        });

        const checkbox = item.querySelector('.scix-result-checkbox');
        checkbox.addEventListener('change', () => {
          this.toggleScixSelection(index);
        });
      }
    });

    this.updateScixSelectedCount();
  }

  toggleScixSelection(index) {
    if (this.scixSelected.has(index)) {
      this.scixSelected.delete(index);
    } else {
      this.scixSelected.add(index);
    }
    this.renderScixResults();
  }

  scixSelectAll() {
    this.scixResults.forEach((paper, index) => {
      if (!paper.inLibrary) {
        this.scixSelected.add(index);
      }
    });
    this.renderScixResults();
  }

  scixSelectNone() {
    this.scixSelected.clear();
    this.renderScixResults();
  }

  updateScixSelectedCount() {
    const count = this.scixSelected.size;
    document.getElementById('scix-selected-count').textContent = `${count} selected`;
    document.getElementById('scix-import-btn').disabled = count === 0;
  }

  async importScixSelected() {
    if (this.scixSelected.size === 0) return;

    const selectedPapers = Array.from(this.scixSelected).map(index => this.scixResults[index]);

    // Show progress
    document.getElementById('scix-progress').classList.remove('hidden');
    document.getElementById('scix-progress-fill').style.width = '0%';
    document.getElementById('scix-progress-text').textContent = 'Starting import...';
    document.getElementById('scix-import-btn').disabled = true;

    try {
      await window.electronAPI.importFromScix(selectedPapers);
      // Completion handled by onImportComplete callback
    } catch (error) {
      this.showScixError(error.message);
      document.getElementById('scix-progress').classList.add('hidden');
      document.getElementById('scix-import-btn').disabled = false;
    }
  }

  updateImportProgress(data) {
    const percent = (data.current / data.total) * 100;
    document.getElementById('scix-progress-fill').style.width = `${percent}%`;
    document.getElementById('scix-progress-text').textContent =
      `Importing ${data.current} of ${data.total}: ${data.paper?.substring(0, 50) || ''}...`;
  }

  async handleImportComplete(results) {
    const imported = results.imported?.length || 0;
    const skipped = results.skipped?.length || 0;
    const failed = results.failed?.length || 0;

    document.getElementById('scix-progress-fill').style.width = '100%';
    document.getElementById('scix-progress-text').textContent =
      `Done! Imported: ${imported}, Skipped: ${skipped}, Failed: ${failed}`;

    // Reload papers list
    await this.loadPapers();
    const info = await window.electronAPI.getLibraryInfo(this.libraryPath);
    if (info) this.updateLibraryDisplay(info);

    // Close modal after a delay
    setTimeout(() => {
      this.hideScixModal();
    }, 2000);
  }

  showScixError(message) {
    const listEl = document.getElementById('scix-results-list');
    listEl.innerHTML = `
      <div class="scix-empty-state">
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

  handleTextSelection(e) {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    if (text.length > 10) {
      this.selectedText = text;
      this.selectedTextPosition = { x: e.clientX, y: e.clientY };
      // Store selection info for annotations before showing menu (selection may be cleared on click)
      this.selectedTextPage = this.getPageFromSelection();
      this.selectedTextRects = this.getSelectionRects(this.selectedTextPage);
      this.showTextContextMenu(e.clientX, e.clientY);
    }
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

    // Highlight the PDF highlight element
    document.querySelectorAll('.pdf-highlight').forEach(el => el.classList.remove('active'));
    document.querySelectorAll(`.pdf-highlight[data-annotation="${id}"]`).forEach(el => el.classList.add('active'));
  }

  renderHighlightsOnPdf() {
    // Remove existing highlights
    document.querySelectorAll('.pdf-highlight-layer').forEach(el => el.remove());

    // Group annotations by page
    const byPage = {};
    this.annotations.forEach(a => {
      if (!a.selection_rects?.length) return;
      const page = a.page_number || 1;
      if (!byPage[page]) byPage[page] = [];
      byPage[page].push(a);
    });

    // Add highlights to each page
    Object.keys(byPage).forEach(pageNum => {
      const pageWrapper = document.querySelector(`.pdf-page-wrapper[data-page="${pageNum}"]`);
      if (!pageWrapper) return;

      const layer = document.createElement('div');
      layer.className = 'pdf-highlight-layer';

      byPage[pageNum].forEach(annotation => {
        const colorClass = this.getColorClass(annotation.color);

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

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  window.app = new SciXReader();
});
