# Bibliac - Claude Code Context

## Project Overview
Bibliac is an Electron desktop app for managing scientific papers. It supports multiple search source plugins (NASA ADS, arXiv, INSPIRE HEP) for metadata, references, citations, and PDF downloads.

## Architecture

### Main Process (Node.js)
- `main.js` - Main Electron process, IPC handlers, window management
- `preload.js` - Context bridge exposing APIs to renderer

### Main Modules (`src/main/`)
- `ads-api.js` - NASA ADS API integration (search, metadata, refs/cites, PDF sources)
- `database.js` - SQLite database using sql.js (papers, collections, annotations)
- `bibtex.js` - BibTeX parsing and generation
- `pdf-download.js` - PDF download with source priority (arXiv, publisher, ADS)
- `pdf-import.js` - PDF import and text extraction
- `llm-service.js` - LLM integration for summaries, embeddings, metadata extraction

### Renderer (`src/renderer/`)
- `app.js` - Single-page app logic, UI state, event handlers
- `index.html` - App structure and modals
- `styles.css` - All styling (CSS variables for theming)

## Key Patterns

### IPC Communication
```javascript
// preload.js exposes APIs
window.electronAPI.methodName(args)

// main.js handles
ipcMain.handle('method-name', async (event, args) => { ... })
```

### Console Logging
```javascript
// Send to app console panel
sendConsoleLog('message', 'info|success|warn|error')
```

### PDF Source Priority
User configures in Preferences. Types: `PUB_PDF`, `EPRINT_PDF`, `ADS_PDF`
Files stored as: `papers/BIBCODE_SOURCETYPE.pdf`

### Database
- SQLite via sql.js (in-memory with periodic saves)
- Tables: papers, collections, references, citations, annotations, text_embeddings

## Common Tasks

### Adding IPC Handler
1. Add handler in `main.js`: `ipcMain.handle('name', ...)`
2. Add binding in `preload.js`: `name: (...) => ipcRenderer.invoke('name', ...)`
3. Call from renderer: `await window.electronAPI.name(...)`

### Adding UI Feature
1. Add HTML in `index.html`
2. Add styles in `styles.css`
3. Add logic in `app.js`

### Reloading Changes
- Renderer changes (app.js, styles.css, index.html): Cmd+R
- Main process changes (main.js, src/main/*): Full app restart required

## ADS API Notes
- Batch lookups use `bibcode:"X" OR bibcode:"Y"` queries
- May return 500 errors (retry logic implemented)
- Bibcode matching: try exact, then normalized (no dots), then DOI fallback

## Features

### Library Management
- Import papers from PDF files (drag & drop or file picker)
- Import from BibTeX files (parses entries, extracts bibcodes from ADS URLs)
- Multi-select papers (Shift+click, Cmd+click)
- Drag & drop to collections
- Paper ratings (1-4 scale: seminal, important, useful, meh)
- Read status tracking (unread, reading, read)
- Full-text search across titles, authors, abstracts
- Sortable columns: Date added, Title, Author, Year, Journal, Rating, Citations

### ADS Integration
- Sync papers with NASA ADS for complete metadata
- Batch sync with parallel processing (10 concurrent)
- Fetch references and citations for each paper
- Import papers directly from ADS search
- ADS quick-link buttons on refs/cites list
- DOI and arXiv ID lookup fallbacks
- Retry logic for ADS 500 errors
- Progress tracking with data received stats

### PDF Management
- Multiple PDF sources per paper (arXiv, publisher, ADS scans)
- Configurable source priority in Preferences
- Source-specific filenames: `BIBCODE_SOURCETYPE.pdf`
- PDF viewer with PDF.js
- Delete individual PDF sources via dropdown
- Library proxy support for publisher PDFs
- Annotation counts shown per source

### PDF Annotations
- Highlight text in PDFs
- Add notes to highlights
- Annotations stored per PDF source
- Note count badges in UI

### References & Citations
- View paper's references list
- View papers that cite this paper
- Import refs/cites directly to library (+button)
- Open in ADS button for each ref/cite

### Collections
- Folder-based organization
- Nested collections (drag to create hierarchy)
- Smart collections (saved searches) - partial
- "All Papers" and "Recently Added" built-in views

### BibTeX
- Auto-generated master.bib file
- Export selected papers to .bib
- Copy \cite{} command (Cmd+Shift+C)
- Copy \citep{} command (Cmd+Shift+P)
- Proper LaTeX escaping

### AI Features (LLM)
- Paper summarization
- Metadata extraction from PDF text
- Text embeddings for semantic search
- Configurable LLM provider (OpenAI, Anthropic, local)

### UI/UX
- Three-pane layout (collections, paper list, detail view)
- Resizable panels (AI section, console)
- Dark/light theme support (CSS variables)
- Console panel for activity logging
- Keyboard shortcuts (Cmd+I import, Cmd+F search, etc.)
- Context menus on papers
- Scroll to selected paper on startup

### Preferences
- ADS API token
- LLM provider configuration
- PDF source priority order (drag to reorder)
- Library proxy URL for institutional access
- Library folder location

### iCloud Libraries
- Multiple libraries support (iCloud or local)
- iCloud container: `iCloud.io.bibliac.app`
- Path: `~/Library/Mobile Documents/iCloud~io~bibliac~app/Documents/`
- Fallback for unsigned builds: `~/Documents/Bibliac-Cloud/`
- Libraries registry: `libraries.json` in container root
- Create, switch, and delete libraries
- Sync conflict detection for iCloud

## Code Signing

See `SIGNING.md` for full documentation on:
- Setting up Developer ID certificates
- Environment variables for signing
- Build commands (signed vs unsigned)
- Notarization process
- Troubleshooting

Key files:
- `forge.config.js` - Electron Forge signing config
- `entitlements.mac.plist` - macOS entitlements (iCloud, network, files)
- `ios/App/App/App.entitlements` - iOS entitlements

## Current State (Dec 2024)
Recent work:
- iCloud library support with multiple libraries
- Code signing and notarization setup
- Multi-PDF support (arxiv + publisher versions per paper)
- PDF source dropdown with delete button
- Citation count display and sorting
- Console panel with resize and data progress
- DOI-first search in ADS lookup
- Retry logic for ADS 500 errors
- Improved sync progress feedback
