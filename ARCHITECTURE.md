# ADS Reader Architecture

This document describes the architecture of the ADS Reader codebase, designed for reusability across multiple platforms.

## Overview

ADS Reader is a reference management application for astronomers that integrates with the NASA Astrophysics Data System (ADS). The codebase is structured to support:

1. **Desktop (Electron)** - macOS/Windows/Linux application
2. **iOS (Capacitor)** - Native iOS app
3. **Plugin Usage** - Embedding the library manager in larger applications

## Directory Structure

```
ads-reader/
├── src/
│   ├── lib/                    # Core library (platform-agnostic)
│   │   ├── ads-api/            # ADS API integration
│   │   ├── bibtex/             # BibTeX parsing and generation
│   │   ├── database/           # SQLite database operations
│   │   ├── pdf/                # PDF utilities
│   │   ├── utils/              # Common utilities
│   │   ├── adapters/           # Platform adapter interface
│   │   ├── types.js            # Type definitions (JSDoc)
│   │   └── index.js            # Main entry point
│   │
│   ├── main/                   # Electron main process
│   │   ├── ads-api.cjs         # ADS API (uses lib internally)
│   │   ├── database.cjs        # Database operations
│   │   ├── bibtex.cjs          # BibTeX handling
│   │   ├── pdf-import.cjs      # PDF import logic
│   │   ├── pdf-download.cjs    # PDF download logic
│   │   └── llm-service.cjs     # LLM integration
│   │
│   ├── renderer/               # UI (shared between platforms)
│   │   ├── app.js              # Main application
│   │   ├── api.js              # Platform API abstraction
│   │   ├── components/         # UI components
│   │   ├── index.html          # Main HTML
│   │   └── styles.css          # Styles
│   │
│   ├── capacitor/              # iOS-specific code
│   │   ├── api-adapter.js      # Capacitor API adapter
│   │   ├── mobile-database.js  # sql.js implementation
│   │   └── platform.js         # Platform detection
│   │
│   └── shared/                 # Legacy shared modules (deprecated)
│       └── *.js                # Re-exports from lib/
│
├── main.cjs                    # Electron main entry point
├── preload.js                  # Electron preload script
└── package.json
```

## Core Library (`src/lib/`)

The core library contains all platform-agnostic business logic. It is designed to be:

- **Pure JavaScript** - No TypeScript for simplicity
- **Framework-agnostic** - No Electron/Capacitor dependencies
- **Testable** - All functions are pure where possible
- **Tree-shakeable** - ES modules with named exports

### Modules

#### `ads-api/` - NASA ADS API Integration

```javascript
import { ADSApi, createADSApi, adsToPaper } from './src/lib/ads-api';

// Create an API instance with custom HTTP adapter
const api = createADSApi({
  token: 'your-ads-token',
  httpGet: customHttpGet,
  httpPost: customHttpPost
});

// Search for papers
const results = await api.search('author:"Einstein"');

// Get paper by bibcode
const paper = await api.getByBibcode('2020ApJ...900..100D');

// Get references and citations
const refs = await api.getReferences(bibcode);
const cites = await api.getCitations(bibcode);

// Transform ADS document to Paper format
const paper = adsToPaper(adsDoc);
```

#### `bibtex/` - BibTeX Parsing and Generation

```javascript
import {
  parseBibtex,
  parseSingleEntry,
  paperToBibtex,
  getCiteCommand
} from './src/lib/bibtex';

// Parse a .bib file
const entries = parseBibtex(fileContent);

// Generate BibTeX from paper
const bibtex = paperToBibtex(paper);

// Get citation command
const cite = getCiteCommand(paper, 'citep'); // \citep{key}
```

#### `database/` - SQLite Database Operations

```javascript
import { createDatabaseManager } from './src/lib/database';

// Create database manager with platform-specific adapters
const db = createDatabaseManager({
  initSqlJs: async () => initSqlJs(),
  save: async (data) => writeToFile(data),
  load: async () => readFromFile()
});

await db.init();

// CRUD operations
const id = db.addPaper(paper);
const paper = db.getPaper(id);
const papers = db.getAllPapers({ readStatus: 'unread' });
db.updatePaper(id, { read_status: 'read' });
db.deletePaper(id);

// Collections
const collectionId = db.createCollection('Favorites');
db.addPaperToCollection(paperId, collectionId);
```

#### `pdf/` - PDF Utilities

```javascript
import {
  generatePdfFilename,
  getSourceTypeFromFilename,
  PDF_SOURCE_TYPES
} from './src/lib/pdf';

// Generate filename
const filename = generatePdfFilename(bibcode, 'EPRINT_PDF');
// "2020ApJ___900__100D_EPRINT_PDF.pdf"

// Extract source type
const type = getSourceTypeFromFilename(filename);
// "EPRINT_PDF"
```

#### `adapters/` - Platform Adapter Interface

```javascript
import { PlatformAdapter } from './src/lib/adapters';

// Implement for your platform
class MyPlatformAdapter extends PlatformAdapter {
  getPlatform() { return 'my-platform'; }

  async readFile(path) { /* ... */ }
  async writeFile(path, content) { /* ... */ }
  async httpGet(url, options) { /* ... */ }
  async getSecureItem(key) { /* ... */ }
  // ... etc
}
```

## Platform Adapters

### Electron Adapter

The Electron implementation uses:
- **Main Process**: Node.js APIs for file system, HTTP, etc.
- **IPC**: Communication between main and renderer
- **Preload**: Secure bridge via `contextBridge`

Key files:
- `main.cjs` - Main process entry
- `preload.js` - IPC bridge
- `src/main/*.cjs` - Main process modules

### Capacitor Adapter

The Capacitor implementation uses:
- **Capacitor Plugins**: Filesystem, Preferences, SecureStorage
- **sql.js**: SQLite in WebAssembly
- **CapacitorHttp**: Native HTTP for CORS bypass

Key files:
- `src/capacitor/api-adapter.js` - Main API adapter
- `src/capacitor/mobile-database.js` - sql.js wrapper
- `src/capacitor/platform.js` - Platform detection

## Data Flow

### Desktop (Electron)

```
┌─────────────────────────────────────────────────────────┐
│                     Renderer Process                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   UI/React  │ -> │   api.js    │ -> │  preload.js │  │
│  └─────────────┘    └─────────────┘    └──────┬──────┘  │
└───────────────────────────────────────────────┼─────────┘
                                                │ IPC
┌───────────────────────────────────────────────┼─────────┐
│                      Main Process              │         │
│  ┌─────────────┐    ┌─────────────┐    ┌──────▼──────┐  │
│  │  database   │ <- │   main.cjs  │ <- │ IPC Handler │  │
│  └─────────────┘    └─────────────┘    └─────────────┘  │
│         │                                               │
│  ┌──────▼──────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   better    │    │   ads-api   │    │   bibtex    │  │
│  │   sqlite3   │    │    (lib)    │    │    (lib)    │  │
│  └─────────────┘    └─────────────┘    └─────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Mobile (Capacitor)

```
┌─────────────────────────────────────────────────────────┐
│                    WebView (WKWebView)                   │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   UI/React  │ -> │   api.js    │ -> │ api-adapter │  │
│  └─────────────┘    └─────────────┘    └──────┬──────┘  │
│                                               │         │
│  ┌─────────────┐    ┌─────────────┐    ┌──────▼──────┐  │
│  │  sql.js     │ <- │mobile-db.js │ <- │  Capacitor  │  │
│  │  (WASM)     │    └─────────────┘    │  Plugins    │  │
│  └─────────────┘                       └─────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Public APIs

### For Plugin Authors

To embed the library manager in another app:

```javascript
import {
  // Database
  createDatabaseManager,

  // ADS API
  createADSApi,
  adsToPaper,

  // BibTeX
  parseBibtex,
  paperToBibtex,
  getCiteCommand,

  // PDF utilities
  generatePdfFilename,
  PDF_SOURCE_TYPES,

  // Types
  ReadStatus,
  RatingLabels
} from 'ads-reader/lib';

// Or import specific modules
import { ADSApi } from 'ads-reader/lib/ads-api';
import { parseBibtex } from 'ads-reader/lib/bibtex';
```

### Type Definitions

See `src/lib/types.js` for JSDoc type definitions:

- `Paper` - Paper metadata
- `Collection` - Collection/folder
- `Annotation` - PDF annotation
- `ADSDocument` - ADS API response
- `SearchOptions` - API search options
- `GetPapersOptions` - Database query options

## Backwards Compatibility

The `src/shared/` directory contains files that re-export from `src/lib/` for backwards compatibility. These will be deprecated in future versions.

Current files should be updated to import from `src/lib/`:

```javascript
// Old (deprecated)
import { adsToPaper } from '../shared/paper-utils.js';

// New (preferred)
import { adsToPaper } from '../lib/ads-api/index.js';
```

## Extension Points

### Adding a New Platform

1. Create a platform adapter implementing `PlatformAdapter`
2. Implement all required methods (file I/O, HTTP, storage)
3. Create a platform-specific API bridge (like `api-adapter.js`)
4. Update `src/renderer/api.js` to detect and use the new platform

### Adding New Features

1. Add platform-agnostic logic to `src/lib/`
2. Create JSDoc types in `src/lib/types.js`
3. Add platform-specific implementations in adapters
4. Export from `src/lib/index.js`

## Testing

The core library is designed for easy testing:

```javascript
import { parseBibtex } from './src/lib/bibtex';

// Pure functions can be tested directly
test('parseBibtex parses entries', () => {
  const result = parseBibtex('@article{key, title={Test}}');
  expect(result[0].title).toBe('Test');
});

// Use mock adapters for platform-dependent code
const mockAdapter = {
  httpGet: jest.fn().mockResolvedValue({ status: 200, data: {} }),
  // ...
};
const api = createADSApi({ ...mockAdapter, token: 'test' });
```

## Future Considerations

1. **Web App**: Add a web platform adapter using localStorage + fetch
2. **Android**: Add Capacitor Android support
3. **npm Package**: Publish `src/lib/` as `@ads-reader/core`
4. **TypeScript**: Optionally add `.d.ts` files for type checking
