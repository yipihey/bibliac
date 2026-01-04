# Bibliac iOS App - Implementation Plan

## Overview

This document outlines the strategy and step-by-step implementation plan for creating an iOS version of Bibliac using Capacitor. A fresh Claude Code session can follow this plan to execute the migration.

**Approach**: Capacitor (wraps existing web app in native iOS shell)
**Estimated effort**: 2-3 weeks
**Code sharing**: 95%+ (existing HTML/CSS/JS reused)
**Sync method**: iCloud Drive (same as desktop)

---

## Why Capacitor?

1. **Minimal code changes** - Existing renderer works as-is
2. **Single codebase** - Same files build Electron desktop + Capacitor iOS
3. **Fast iteration** - Test on iPhone in days, not weeks
4. **Native plugins** - File system, iCloud, PDF viewing available
5. **Escape hatch** - Can add native Swift modules if needed later

---

## Architecture

### Current (Electron)
```
bibliac/
├── main.js                    # Electron main process
├── preload.js                 # IPC bridge
├── src/
│   ├── main/                  # Business logic (Node.js)
│   │   ├── ads-api.js
│   │   ├── database.js
│   │   ├── pdf-download.js
│   │   ├── bibtex.js
│   │   └── llm-service.js
│   └── renderer/              # UI (runs in browser)
│       ├── app.js
│       ├── index.html
│       └── styles.css
└── package.json
```

### Target (Electron + Capacitor)
```
bibliac/
├── main.js                    # Electron main process (unchanged)
├── preload.js                 # IPC bridge (unchanged)
├── src/
│   ├── main/                  # Business logic
│   ├── renderer/              # UI (shared, with mobile CSS)
│   └── capacitor/             # NEW: Mobile-specific code
│       ├── platform.js        # Platform detection & adaptation
│       └── plugins.js         # Capacitor plugin wrappers
├── ios/                       # NEW: Generated Xcode project
├── capacitor.config.ts        # NEW: Capacitor configuration
└── package.json               # Updated with Capacitor deps
```

---

## Phase 1: Project Setup (Day 1-2)

### Step 1.1: Install Capacitor

```bash
# Install Capacitor CLI and core
npm install @capacitor/core @capacitor/cli

# Initialize Capacitor in the project
npx cap init "Bibliac" "io.bibliac.app" --web-dir=src/renderer

# Add iOS platform
npm install @capacitor/ios
npx cap add ios
```

### Step 1.2: Configure Capacitor

Create `capacitor.config.ts`:

```typescript
import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.bibliac.app',
  appName: 'Bibliac',
  webDir: 'src/renderer',
  server: {
    // For development, can connect to local server
    // url: 'http://localhost:3000',
    // cleartext: true
  },
  ios: {
    contentInset: 'automatic',
    scrollEnabled: true,
    // Enable iCloud
    preferences: {
      'UIFileSharingEnabled': true,
      'LSSupportsOpeningDocumentsInPlace': true
    }
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#1a1a2e',
      showSpinner: false
    }
  }
};

export default config;
```

### Step 1.3: Update index.html for Mobile

Add to `<head>` in `src/renderer/index.html`:

```html
<!-- Viewport for mobile -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">

<!-- iOS specific -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">

<!-- Capacitor -->
<script src="capacitor.js"></script>
```

### Step 1.4: Sync and Open in Xcode

```bash
# Sync web code to iOS project
npx cap sync ios

# Open in Xcode
npx cap open ios
```

### Step 1.5: Test Basic Launch

1. In Xcode, select a simulator (iPhone 15 Pro recommended)
2. Click Run (⌘R)
3. Verify app launches and shows the UI
4. Note: Most features won't work yet (no file system access)

---

## Phase 2: Mobile Responsive CSS (Day 3-5)

### Step 2.1: Add Platform Detection

Create `src/capacitor/platform.js`:

```javascript
// Platform detection for Capacitor
export function isMobile() {
  return window.Capacitor?.isNativePlatform() || false;
}

export function isIOS() {
  return window.Capacitor?.getPlatform() === 'ios';
}

export function isElectron() {
  return typeof window.electronAPI !== 'undefined';
}

// Initialize platform-specific behavior
export function initPlatform() {
  if (isMobile()) {
    document.body.classList.add('mobile');
    document.body.classList.add('ios');

    // Prevent overscroll bounce
    document.body.style.overscrollBehavior = 'none';
  }
}
```

### Step 2.2: Add Mobile CSS Breakpoints

Add to `src/renderer/styles.css`:

```css
/* ═══════════════════════════════════════════════════════════════════════════
   MOBILE STYLES
   ═══════════════════════════════════════════════════════════════════════════ */

/* Mobile detection */
@media (max-width: 768px), (pointer: coarse) {
  /* Hide desktop-only elements */
  .desktop-only {
    display: none !important;
  }

  /* Show mobile-only elements */
  .mobile-only {
    display: block !important;
  }
}

/* iOS safe areas */
body.ios {
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}

/* Mobile layout - convert 3-pane to single pane with navigation */
@media (max-width: 768px) {
  .app-container {
    flex-direction: column;
  }

  /* Hide sidebar by default on mobile */
  .sidebar {
    position: fixed;
    left: -280px;
    top: 0;
    bottom: 0;
    z-index: 1000;
    transition: left 0.3s ease;
    width: 280px;
  }

  .sidebar.open {
    left: 0;
  }

  /* Overlay when sidebar is open */
  .sidebar-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 999;
  }

  .sidebar.open + .sidebar-overlay {
    display: block;
  }

  /* Paper list takes full width */
  .paper-list-pane {
    width: 100%;
    min-width: unset;
    max-width: unset;
  }

  /* Detail pane is hidden or full-screen */
  .detail-pane {
    position: fixed;
    inset: 0;
    z-index: 100;
    transform: translateX(100%);
    transition: transform 0.3s ease;
  }

  .detail-pane.visible {
    transform: translateX(0);
  }

  /* Larger touch targets */
  .paper-item {
    min-height: 64px;
    padding: 12px 16px;
  }

  button, .btn {
    min-height: 44px;
    min-width: 44px;
  }

  /* Bottom navigation bar */
  .mobile-nav {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 56px;
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-color);
    z-index: 1001;
  }

  .mobile-nav-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: var(--text-muted);
  }

  .mobile-nav-item.active {
    color: var(--accent);
  }

  .mobile-nav-item svg {
    width: 24px;
    height: 24px;
    margin-bottom: 2px;
  }
}

/* Hide mobile nav on desktop */
.mobile-nav {
  display: none;
}

@media (min-width: 769px) {
  .mobile-only {
    display: none !important;
  }
}
```

### Step 2.3: Add Mobile Navigation HTML

Add to `src/renderer/index.html` before `</body>`:

```html
<!-- Mobile bottom navigation -->
<nav class="mobile-nav mobile-only" id="mobile-nav">
  <button class="mobile-nav-item active" data-view="library">
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z"/>
    </svg>
    <span>Library</span>
  </button>
  <button class="mobile-nav-item" data-view="search">
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
    </svg>
    <span>Search</span>
  </button>
  <button class="mobile-nav-item" data-view="settings">
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
    </svg>
    <span>Settings</span>
  </button>
</nav>

<!-- Mobile header with back button -->
<header class="mobile-header mobile-only" id="mobile-header">
  <button class="mobile-back-btn" id="mobile-back">
    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
      <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
    </svg>
  </button>
  <h1 class="mobile-title" id="mobile-title">Library</h1>
  <button class="mobile-menu-btn" id="mobile-menu">
    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
    </svg>
  </button>
</header>
```

### Step 2.4: Update app.js for Mobile Navigation

Add to `src/renderer/app.js` in the `init()` method:

```javascript
// In init() method, add:
this.initMobileNav();

// Add new method:
initMobileNav() {
  if (!document.body.classList.contains('mobile')) return;

  // Mobile navigation
  const mobileNav = document.getElementById('mobile-nav');
  if (mobileNav) {
    mobileNav.addEventListener('click', (e) => {
      const navItem = e.target.closest('.mobile-nav-item');
      if (!navItem) return;

      // Update active state
      mobileNav.querySelectorAll('.mobile-nav-item').forEach(item => {
        item.classList.remove('active');
      });
      navItem.classList.add('active');

      // Handle navigation
      const view = navItem.dataset.view;
      this.handleMobileNav(view);
    });
  }

  // Back button
  const backBtn = document.getElementById('mobile-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => this.mobileGoBack());
  }
}

handleMobileNav(view) {
  const detailPane = document.querySelector('.detail-pane');
  const sidebar = document.querySelector('.sidebar');

  switch(view) {
    case 'library':
      detailPane?.classList.remove('visible');
      sidebar?.classList.remove('open');
      break;
    case 'search':
      this.showSearchModal();
      break;
    case 'settings':
      this.showPreferences();
      break;
  }
}

mobileGoBack() {
  const detailPane = document.querySelector('.detail-pane');
  if (detailPane?.classList.contains('visible')) {
    detailPane.classList.remove('visible');
  }
}

// Modify selectPaper to show detail pane on mobile
selectPaper(paper) {
  // ... existing code ...

  // On mobile, show detail pane
  if (document.body.classList.contains('mobile')) {
    document.querySelector('.detail-pane')?.classList.add('visible');
  }
}
```

---

## Phase 3: Native Plugins (Day 6-10)

### Step 3.1: Install Required Plugins

```bash
# Core plugins
npm install @capacitor/filesystem
npm install @capacitor/preferences
npm install @capacitor/share
npm install @capacitor/haptics
npm install @capacitor/status-bar
npm install @capacitor/splash-screen

# Sync to iOS
npx cap sync ios
```

### Step 3.2: Create Plugin Wrapper

Create `src/capacitor/plugins.js`:

```javascript
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { StatusBar, Style } from '@capacitor/status-bar';

// ═══════════════════════════════════════════════════════════════════════════
// FILE SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

export const FileSystem = {
  async readFile(path) {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Documents,
      encoding: Encoding.UTF8
    });
    return result.data;
  },

  async writeFile(path, data) {
    await Filesystem.writeFile({
      path,
      data,
      directory: Directory.Documents,
      encoding: Encoding.UTF8
    });
  },

  async readBinaryFile(path) {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Documents
    });
    return result.data; // Base64 encoded
  },

  async writeBinaryFile(path, data) {
    await Filesystem.writeFile({
      path,
      data, // Base64 encoded
      directory: Directory.Documents
    });
  },

  async deleteFile(path) {
    await Filesystem.deleteFile({
      path,
      directory: Directory.Documents
    });
  },

  async exists(path) {
    try {
      await Filesystem.stat({
        path,
        directory: Directory.Documents
      });
      return true;
    } catch {
      return false;
    }
  },

  async mkdir(path) {
    await Filesystem.mkdir({
      path,
      directory: Directory.Documents,
      recursive: true
    });
  },

  async readdir(path) {
    const result = await Filesystem.readdir({
      path,
      directory: Directory.Documents
    });
    return result.files;
  },

  async getUri(path) {
    const result = await Filesystem.getUri({
      path,
      directory: Directory.Documents
    });
    return result.uri;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PREFERENCES (replaces electron-store)
// ═══════════════════════════════════════════════════════════════════════════

export const Storage = {
  async get(key) {
    const result = await Preferences.get({ key });
    try {
      return result.value ? JSON.parse(result.value) : null;
    } catch {
      return result.value;
    }
  },

  async set(key, value) {
    await Preferences.set({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value)
    });
  },

  async remove(key) {
    await Preferences.remove({ key });
  },

  async clear() {
    await Preferences.clear();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// SHARING
// ═══════════════════════════════════════════════════════════════════════════

export const Sharing = {
  async shareText(text, title = '') {
    await Share.share({
      title,
      text,
      dialogTitle: title
    });
  },

  async shareFile(path, title = '') {
    const uri = await FileSystem.getUri(path);
    await Share.share({
      title,
      url: uri,
      dialogTitle: title
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// HAPTICS
// ═══════════════════════════════════════════════════════════════════════════

export const HapticFeedback = {
  light() {
    Haptics.impact({ style: ImpactStyle.Light });
  },
  medium() {
    Haptics.impact({ style: ImpactStyle.Medium });
  },
  heavy() {
    Haptics.impact({ style: ImpactStyle.Heavy });
  },
  success() {
    Haptics.notification({ type: 'success' });
  },
  warning() {
    Haptics.notification({ type: 'warning' });
  },
  error() {
    Haptics.notification({ type: 'error' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// STATUS BAR
// ═══════════════════════════════════════════════════════════════════════════

export const AppStatusBar = {
  async setDark() {
    await StatusBar.setStyle({ style: Style.Dark });
  },
  async setLight() {
    await StatusBar.setStyle({ style: Style.Light });
  },
  async hide() {
    await StatusBar.hide();
  },
  async show() {
    await StatusBar.show();
  }
};
```

### Step 3.3: Create API Adapter

Create `src/capacitor/api-adapter.js`:

```javascript
/**
 * API Adapter - provides unified interface for Electron and Capacitor
 *
 * On Electron: Uses window.electronAPI (IPC)
 * On Capacitor: Uses native plugins + in-browser implementations
 */

import { isMobile, isElectron } from './platform.js';
import { FileSystem, Storage, Sharing, HapticFeedback } from './plugins.js';

// Import business logic modules (these work in both environments)
// Note: These need to be bundled for browser use
import * as database from '../main/database.js';
import * as adsApi from '../main/ads-api.js';
import * as bibtex from '../main/bibtex.js';

class MobileAPI {
  constructor() {
    this.libraryPath = 'library';
    this.db = null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LIBRARY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  async getLibraryPath() {
    return this.libraryPath;
  }

  async selectLibraryFolder() {
    // On mobile, use fixed Documents/library folder
    // Could add folder picker in future
    return this.libraryPath;
  }

  async getLibraryInfo(path) {
    const papers = await this.getAllPapers();
    return {
      paperCount: papers.length,
      path: path
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PREFERENCES
  // ═══════════════════════════════════════════════════════════════════════

  async getAdsToken() {
    return await Storage.get('adsToken');
  }

  async setAdsToken(token) {
    await Storage.set('adsToken', token);
  }

  async getPdfPriority() {
    return await Storage.get('pdfPriority') || ['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF'];
  }

  async setPdfPriority(priority) {
    await Storage.set('pdfPriority', priority);
  }

  async getLibraryProxy() {
    return await Storage.get('libraryProxy');
  }

  async setLibraryProxy(url) {
    await Storage.set('libraryProxy', url);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DATABASE (uses sql.js in browser)
  // ═══════════════════════════════════════════════════════════════════════

  async initDatabase() {
    // Load database from file if exists
    const dbPath = `${this.libraryPath}/library.sqlite`;
    let dbData = null;

    if (await FileSystem.exists(dbPath)) {
      dbData = await FileSystem.readBinaryFile(dbPath);
    }

    this.db = await database.initDatabase(this.libraryPath, dbData);
    return true;
  }

  async saveDatabase() {
    if (!this.db) return;
    const data = database.exportDatabase();
    const dbPath = `${this.libraryPath}/library.sqlite`;
    await FileSystem.writeBinaryFile(dbPath, data);
  }

  async getAllPapers(options) {
    return database.getAllPapers(options);
  }

  async getPaper(id) {
    return database.getPaper(id);
  }

  async updatePaper(id, updates) {
    database.updatePaper(id, updates);
    await this.saveDatabase();
  }

  async deletePaper(id) {
    database.deletePaper(id);
    await this.saveDatabase();
  }

  async searchPapers(query) {
    return database.searchPapersFullText(query, this.libraryPath);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADS API (works unchanged in browser)
  // ═══════════════════════════════════════════════════════════════════════

  async adsSearch(query, options) {
    const token = await this.getAdsToken();
    return adsApi.search(token, query, options);
  }

  async adsLookup(identifier, type) {
    const token = await this.getAdsToken();
    switch(type) {
      case 'bibcode': return adsApi.getByBibcode(token, identifier);
      case 'doi': return adsApi.getByDOI(token, identifier);
      case 'arxiv': return adsApi.getByArxiv(token, identifier);
      default: return null;
    }
  }

  async adsGetReferences(bibcode) {
    const token = await this.getAdsToken();
    return adsApi.getReferences(token, bibcode);
  }

  async adsGetCitations(bibcode) {
    const token = await this.getAdsToken();
    return adsApi.getCitations(token, bibcode);
  }

  async adsGetEsources(bibcode) {
    const token = await this.getAdsToken();
    return adsApi.getEsources(token, bibcode);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BIBTEX
  // ═══════════════════════════════════════════════════════════════════════

  async exportBibtex(paperIds) {
    const papers = await Promise.all(paperIds.map(id => this.getPaper(id)));
    return papers.map(p => bibtex.paperToBibtex(p)).join('\n\n');
  }

  async copyCite(paperId, style) {
    const paper = await this.getPaper(paperId);
    const key = bibtex.generateBibtexKey(paper);
    const cite = style === 'citep' ? `\\citep{${key}}` : `\\cite{${key}}`;

    // Copy to clipboard
    await navigator.clipboard.writeText(cite);
    HapticFeedback.success();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SHARING
  // ═══════════════════════════════════════════════════════════════════════

  async sharePaper(paperId) {
    const paper = await this.getPaper(paperId);
    const bibtexEntry = bibtex.paperToBibtex(paper);
    await Sharing.shareText(bibtexEntry, paper.title);
  }

  async sharePdf(paperId) {
    const paper = await this.getPaper(paperId);
    if (paper.pdf_path) {
      await Sharing.shareFile(paper.pdf_path, paper.title);
    }
  }
}

// Export the appropriate API based on platform
export function getAPI() {
  if (isElectron()) {
    return window.electronAPI;
  } else {
    return new MobileAPI();
  }
}
```

### Step 3.4: Update app.js to Use API Adapter

At the top of `src/renderer/app.js`:

```javascript
// Replace direct window.electronAPI usage with adapter
import { getAPI } from '../capacitor/api-adapter.js';

const api = getAPI();

// Then replace all window.electronAPI.xxx calls with api.xxx
// Example:
// Before: const papers = await window.electronAPI.getAllPapers();
// After:  const papers = await api.getAllPapers();
```

---

## Phase 4: Mobile UX Polish (Day 11-14)

### Step 4.1: Pull-to-Refresh

Add to `src/renderer/app.js`:

```javascript
initPullToRefresh() {
  if (!document.body.classList.contains('mobile')) return;

  const paperList = document.querySelector('.paper-list');
  let startY = 0;
  let pulling = false;

  paperList.addEventListener('touchstart', (e) => {
    if (paperList.scrollTop === 0) {
      startY = e.touches[0].pageY;
      pulling = true;
    }
  });

  paperList.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const currentY = e.touches[0].pageY;
    const diff = currentY - startY;

    if (diff > 0 && diff < 150) {
      paperList.style.transform = `translateY(${diff * 0.5}px)`;
    }
  });

  paperList.addEventListener('touchend', async (e) => {
    if (!pulling) return;
    pulling = false;

    const currentY = e.changedTouches[0].pageY;
    const diff = currentY - startY;

    paperList.style.transform = '';

    if (diff > 80) {
      HapticFeedback.medium();
      await this.loadPapers();
    }
  });
}
```

### Step 4.2: Swipe Gestures

Add swipe-to-delete and swipe-to-mark-read:

```javascript
initSwipeGestures() {
  if (!document.body.classList.contains('mobile')) return;

  const paperList = document.querySelector('.paper-list');
  let startX = 0;
  let currentItem = null;

  paperList.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.paper-item');
    if (item) {
      startX = e.touches[0].pageX;
      currentItem = item;
    }
  });

  paperList.addEventListener('touchmove', (e) => {
    if (!currentItem) return;
    const diff = e.touches[0].pageX - startX;

    // Limit swipe distance
    if (Math.abs(diff) < 100) {
      currentItem.style.transform = `translateX(${diff}px)`;
    }
  });

  paperList.addEventListener('touchend', async (e) => {
    if (!currentItem) return;

    const diff = e.changedTouches[0].pageX - startX;
    currentItem.style.transform = '';

    const paperId = parseInt(currentItem.dataset.id);

    if (diff < -60) {
      // Swipe left - delete
      HapticFeedback.warning();
      if (confirm('Delete this paper?')) {
        await api.deletePaper(paperId);
        this.loadPapers();
      }
    } else if (diff > 60) {
      // Swipe right - toggle read status
      HapticFeedback.light();
      const paper = await api.getPaper(paperId);
      const newStatus = paper.read_status === 'read' ? 'unread' : 'read';
      await api.updatePaper(paperId, { read_status: newStatus });
      this.loadPapers();
    }

    currentItem = null;
  });
}
```

### Step 4.3: iOS-Style Search Bar

Update search input styling and behavior for iOS feel.

---

## Phase 5: Testing & Deployment (Day 15-21)

### Step 5.1: Test on Real Device

```bash
# Ensure latest code is synced
npx cap sync ios

# Open Xcode
npx cap open ios
```

1. Connect iPhone via USB
2. Select your device in Xcode
3. Click Run
4. Trust developer certificate on device (Settings → General → Device Management)

### Step 5.2: Performance Testing

Test these scenarios on real device:
- [ ] Scrolling paper list with 100+ papers
- [ ] PDF viewing and scrolling
- [ ] Search responsiveness
- [ ] ADS sync with multiple papers
- [ ] iCloud database sync

### Step 5.3: App Store Preparation

1. **App Icons**: Generate all required sizes
   - Use https://appicon.co or similar tool
   - Place in `ios/App/App/Assets.xcassets/AppIcon.appiconset/`

2. **Launch Screen**: Update `ios/App/App/Base.lproj/LaunchScreen.storyboard`

3. **Info.plist**: Configure in `ios/App/App/Info.plist`
   - App name
   - Bundle identifier
   - Permissions (file access, network)

4. **Screenshots**: Capture for App Store
   - iPhone 6.5" (iPhone 15 Pro Max)
   - iPhone 5.5" (iPhone 8 Plus)

### Step 5.4: TestFlight

1. In Xcode: Product → Archive
2. Upload to App Store Connect
3. Add testers in TestFlight
4. Distribute beta build

---

## Checklist

### Phase 1: Setup
- [ ] Install Capacitor CLI and core
- [ ] Initialize Capacitor in project
- [ ] Add iOS platform
- [ ] Create capacitor.config.ts
- [ ] Update index.html with viewport meta
- [ ] Sync and open in Xcode
- [ ] Test basic app launch in simulator

### Phase 2: Mobile CSS
- [ ] Create platform.js for detection
- [ ] Add mobile CSS breakpoints
- [ ] Implement responsive sidebar
- [ ] Add mobile navigation bar
- [ ] Add mobile header
- [ ] Update app.js for mobile nav
- [ ] Test navigation flow

### Phase 3: Native Plugins
- [ ] Install Capacitor plugins
- [ ] Create plugins.js wrapper
- [ ] Create api-adapter.js
- [ ] Update app.js to use adapter
- [ ] Test file system access
- [ ] Test preferences storage
- [ ] Test sharing functionality

### Phase 4: UX Polish
- [ ] Implement pull-to-refresh
- [ ] Add swipe gestures
- [ ] Polish search bar
- [ ] Add haptic feedback
- [ ] Test touch interactions

### Phase 5: Deployment
- [ ] Test on real device
- [ ] Performance testing
- [ ] Create app icons
- [ ] Configure launch screen
- [ ] Update Info.plist
- [ ] Take screenshots
- [ ] Archive and upload to TestFlight
- [ ] Beta testing

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `capacitor.config.ts` | Capacitor configuration |
| `src/capacitor/platform.js` | Platform detection |
| `src/capacitor/plugins.js` | Native plugin wrappers |
| `src/capacitor/api-adapter.js` | Unified API for Electron/Capacitor |
| `src/renderer/styles.css` | Mobile responsive styles |
| `src/renderer/index.html` | Mobile navigation HTML |
| `src/renderer/app.js` | Mobile navigation JS |
| `ios/` | Generated Xcode project |

---

## Troubleshooting

### Common Issues

**"Module not found" errors**
- Capacitor uses ES modules - ensure imports use `.js` extension
- May need a bundler (Vite, webpack) for complex imports

**PDF.js not loading**
- Ensure PDF.js worker is accessible
- May need to configure CORS for local files

**iCloud not syncing**
- Enable iCloud capability in Xcode
- Sign in to iCloud on device
- Check entitlements file

**White screen on launch**
- Check browser console for JS errors
- Verify capacitor.config.ts webDir path

---

## Future Enhancements

After initial release, consider:

1. **Native PDF viewer** - Replace PDF.js with native PDFKit for better performance
2. **Background sync** - Sync papers when app is backgrounded
3. **Offline support** - Cache ADS data for offline access
4. **Push notifications** - Alert when cited papers are updated
5. **Widget** - iOS home screen widget showing reading list
