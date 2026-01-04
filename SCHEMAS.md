# Bibliac - Data Schemas Reference

This document describes the database schema, key object shapes, and IPC API for future development reference.

## Database Schema

SQLite database stored at `{libraryPath}/library.sqlite` using sql.js (in-memory with periodic saves).

### papers
Main table storing paper metadata.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key, auto-increment |
| bibcode | TEXT | ADS bibcode (unique) |
| doi | TEXT | DOI identifier |
| arxiv_id | TEXT | arXiv ID (e.g., "2401.12345") |
| title | TEXT | Paper title |
| authors | TEXT | JSON array of author names |
| year | INTEGER | Publication year |
| journal | TEXT | Journal/publication name |
| abstract | TEXT | Paper abstract |
| keywords | TEXT | JSON array of keywords |
| pdf_path | TEXT | Relative path to PDF file |
| text_path | TEXT | Relative path to extracted text |
| bibtex | TEXT | BibTeX entry |
| read_status | TEXT | "unread", "reading", or "read" |
| rating | INTEGER | 0-4 (0=unrated, 1=seminal, 2=important, 3=useful, 4=meh) |
| added_date | TEXT | ISO timestamp when added |
| modified_date | TEXT | ISO timestamp of last modification |
| import_source | TEXT | Source .bib file path |
| import_source_key | TEXT | Original BibTeX key from import |

### refs
Papers referenced by a paper (bibliography).

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| paper_id | INTEGER | FK to papers.id |
| ref_bibcode | TEXT | Bibcode of referenced paper |
| ref_title | TEXT | Title of referenced paper |
| ref_authors | TEXT | Authors (string, not JSON) |
| ref_year | INTEGER | Publication year |

### citations
Papers that cite a paper.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| paper_id | INTEGER | FK to papers.id |
| citing_bibcode | TEXT | Bibcode of citing paper |
| citing_title | TEXT | Title of citing paper |
| citing_authors | TEXT | Authors (string, not JSON) |
| citing_year | INTEGER | Publication year |

### collections
User-created folders for organizing papers.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| name | TEXT | Collection name |
| parent_id | INTEGER | FK to collections.id (for nesting) |
| is_smart | INTEGER | 1 if smart collection (saved search) |
| query | TEXT | Search query for smart collections |
| created_date | TEXT | ISO timestamp |

### paper_collections
Junction table for paper-collection relationships.

| Column | Type | Description |
|--------|------|-------------|
| paper_id | INTEGER | FK to papers.id |
| collection_id | INTEGER | FK to collections.id |

Composite primary key: (paper_id, collection_id)

### paper_summaries
LLM-generated paper summaries.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| paper_id | INTEGER | FK to papers.id (unique) |
| summary | TEXT | Generated summary text |
| key_points | TEXT | JSON array of key points |
| model | TEXT | LLM model used |
| generated_date | TEXT | ISO timestamp |

### paper_qa
LLM Q&A history for papers.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| paper_id | INTEGER | FK to papers.id |
| question | TEXT | User's question |
| answer | TEXT | LLM's answer |
| context_used | TEXT | Text chunks used for context |
| model | TEXT | LLM model used |
| created_date | TEXT | ISO timestamp |

### text_embeddings
Vector embeddings for semantic search.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| paper_id | INTEGER | FK to papers.id |
| chunk_index | INTEGER | Position of chunk in document |
| chunk_text | TEXT | Text content of chunk |
| embedding | BLOB | Float32Array as buffer |
| created_date | TEXT | ISO timestamp |

### annotations
PDF highlights and notes.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| paper_id | INTEGER | FK to papers.id |
| page_number | INTEGER | PDF page (1-indexed) |
| selection_text | TEXT | Highlighted text |
| selection_rects | TEXT | JSON array of {x, y, width, height} |
| note_content | TEXT | User's note |
| color | TEXT | Highlight color (default: "#ffeb3b") |
| pdf_source | TEXT | PDF source type (EPRINT_PDF, PUB_PDF, ADS_PDF) |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |

---

## Key Object Shapes

### Paper Object (from getAllPapers)
Returned by `getAllPapers()` with computed fields:

```javascript
{
  id: 1,
  bibcode: "2024ApJ...123..456A",
  doi: "10.3847/1538-4357/abc123",
  arxiv_id: "2401.12345",
  title: "Paper Title",
  authors: ["Smith, J.", "Jones, M."],  // Parsed from JSON
  year: 2024,
  journal: "The Astrophysical Journal",
  abstract: "...",
  keywords: ["galaxies", "cosmology"],  // Parsed from JSON
  pdf_path: "papers/2024ApJ...123..456A_EPRINT_PDF.pdf",
  text_path: "papers/2024ApJ...123..456A_EPRINT_PDF.txt",
  bibtex: "@article{...",
  read_status: "unread",
  rating: 0,
  added_date: "2024-12-29T10:00:00.000Z",
  modified_date: "2024-12-29T10:00:00.000Z",
  import_source: "/path/to/file.bib",
  import_source_key: "Smith2024",
  // Computed fields:
  is_indexed: true,        // Has embeddings
  annotation_count: 5,     // Number of annotations
  citation_count: 42       // Number of citing papers
}
```

### ADS Document (from API)
Shape returned by NASA ADS search:

```javascript
{
  bibcode: "2024ApJ...123..456A",
  title: ["Paper Title"],           // Array with single element
  author: ["Smith, J.", "Jones, M."],
  year: "2024",                     // String, not number
  doi: ["10.3847/1538-4357/abc123"], // Array
  pub: "The Astrophysical Journal",
  abstract: "...",
  keyword: ["galaxies", "cosmology"],
  identifier: ["arXiv:2401.12345", "2024ApJ...123..456A"],
  arxiv_class: ["astro-ph.GA"]
}
```

### Esource Record (PDF links)
From `getEsources()`:

```javascript
{
  title: "https://arxiv.org/pdf/2401.12345",
  url: "https://arxiv.org/pdf/2401.12345",
  link_type: "ESOURCE|EPRINT_PDF"  // or PUB_PDF, ADS_PDF
}
```

### Annotation Object
From `getAnnotations()`:

```javascript
{
  id: 1,
  paper_id: 42,
  page_number: 5,
  selection_text: "highlighted text",
  selection_rects: [  // Parsed from JSON
    { x: 100, y: 200, width: 150, height: 12 }
  ],
  note_content: "My note about this",
  color: "#ffeb3b",
  pdf_source: "EPRINT_PDF",
  created_at: "2024-12-29T10:00:00.000Z",
  updated_at: "2024-12-29T10:00:00.000Z"
}
```

---

## IPC API Reference

Methods exposed via `window.electronAPI.*` in the renderer process.

### Library Management
| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getLibraryPath()` | - | string | Current library folder path |
| `selectLibraryFolder()` | - | string | Open folder picker, returns path |
| `checkCloudStatus(path)` | path: string | object | Check if path is in iCloud/Dropbox |
| `getLibraryInfo(path)` | path: string | object | Paper count and size info |

### Paper Management
| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getAllPapers(options)` | options?: {readStatus?, search?, orderBy?, order?, limit?} | Paper[] | Get papers with computed fields |
| `getPaper(id)` | id: number | Paper | Get single paper by ID |
| `updatePaper(id, updates)` | id: number, updates: object | void | Update paper fields |
| `deletePaper(id)` | id: number | void | Delete paper and related data |
| `deletePapersBulk(ids)` | ids: number[] | void | Bulk delete papers |
| `importPDFs()` | - | object | Open file picker, import PDFs |
| `searchPapers(query)` | query: string | SearchResult[] | Full-text search |

### ADS Integration
| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getAdsToken()` | - | string | Get stored ADS API token |
| `setAdsToken(token)` | token: string | void | Save ADS API token |
| `adsSearch(query, options)` | query: string, options?: object | {docs, numFound} | Search ADS |
| `adsLookup(identifier, type)` | identifier: string, type: "bibcode"\|"doi"\|"arxiv" | ADSDoc | Lookup single paper |
| `adsGetReferences(bibcode)` | bibcode: string | ADSDoc[] | Get paper's references |
| `adsGetCitations(bibcode)` | bibcode: string | ADSDoc[] | Get papers citing this |
| `adsGetEsources(bibcode)` | bibcode: string | Esource[] | Get PDF source links |
| `adsSyncPapers(paperIds)` | paperIds: number[] | {success, updated, failed} | Sync papers with ADS |
| `adsFetchMetadata(paperId)` | paperId: number | ADSDoc | Fetch metadata for paper |

### PDF Management
| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getPdfPath(relativePath)` | relativePath: string | string | Get absolute PDF path |
| `getPdfPriority()` | - | string[] | Get PDF source priority order |
| `setPdfPriority(priority)` | priority: string[] | void | Set PDF source priority |
| `downloadPdfFromSource(paperId, sourceType)` | paperId: number, sourceType: string | object | Download specific PDF source |
| `checkPdfExists(paperId, sourceType)` | paperId: number, sourceType: string | boolean | Check if PDF exists |
| `deletePdf(paperId, sourceType)` | paperId: number, sourceType: string | boolean | Delete specific PDF |
| `getDownloadedPdfSources(paperId)` | paperId: number | string[] | List available PDF sources |
| `getLibraryProxy()` | - | string | Get library proxy URL |
| `setLibraryProxy(proxyUrl)` | proxyUrl: string | void | Set library proxy URL |

### Collections
| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getCollections()` | - | Collection[] | Get all collections with paper counts |
| `createCollection(name, parentId, isSmart, query)` | name: string, parentId?: number, isSmart?: boolean, query?: string | number | Create collection, returns ID |
| `deleteCollection(collectionId)` | collectionId: number | void | Delete collection |
| `addPaperToCollection(paperId, collectionId)` | paperId: number, collectionId: number | void | Add paper to collection |
| `removePaperFromCollection(paperId, collectionId)` | paperId: number, collectionId: number | void | Remove paper from collection |
| `getPapersInCollection(collectionId)` | collectionId: number | Paper[] | Get papers in collection |

### References & Citations
| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getReferences(paperId)` | paperId: number | Ref[] | Get paper's references |
| `getCitations(paperId)` | paperId: number | Citation[] | Get papers citing this |

### BibTeX
| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `copyCite(paperId, style)` | paperId: number, style: "cite"\|"citep" | void | Copy citation to clipboard |
| `exportBibtex(paperIds)` | paperIds: number[] | string | Generate BibTeX for papers |
| `saveBibtexFile(content)` | content: string | void | Save BibTeX to file |
| `importBibtex()` | - | object | Import from .bib file |

### LLM / AI
| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getLlmConfig()` | - | object | Get LLM configuration |
| `setLlmConfig(config)` | config: object | void | Save LLM configuration |
| `checkLlmConnection()` | - | boolean | Test LLM connectivity |
| `listLlmModels()` | - | string[] | List available models |
| `llmSummarize(paperId, options)` | paperId: number, options?: object | Summary | Generate paper summary |
| `llmAsk(paperId, question)` | paperId: number, question: string | string | Ask question about paper |
| `llmExplain(text, paperId)` | text: string, paperId: number | string | Explain selected text |
| `llmGenerateEmbeddings(paperId)` | paperId: number | void | Generate text embeddings |
| `llmSemanticSearch(query, limit)` | query: string, limit?: number | SearchResult[] | Semantic search |
| `llmExtractMetadata(paperId)` | paperId: number | object | Extract metadata from PDF |

### Annotations
| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getAnnotations(paperId)` | paperId: number | Annotation[] | Get paper's annotations |
| `getAnnotationCountsBySource(paperId)` | paperId: number | {[source]: count} | Count annotations per PDF source |
| `createAnnotation(paperId, data)` | paperId: number, data: object | Annotation | Create annotation |
| `updateAnnotation(id, data)` | id: number, data: object | void | Update annotation |
| `deleteAnnotation(id)` | id: number | void | Delete annotation |

### Events (via callbacks)
| Event | Callback Data | Description |
|-------|---------------|-------------|
| `onAdsSyncProgress(callback)` | {current, total, paper, status} | Sync progress updates |
| `onImportProgress(callback)` | {current, total, title} | Import progress updates |
| `onLlmStream(callback)` | {chunk} | LLM streaming response |
| `onConsoleLog(callback)` | {message, type} | Console log messages |

---

## PDF File Naming

PDFs are stored as: `papers/{BIBCODE}_{SOURCETYPE}.pdf`

Source types:
- `EPRINT_PDF` - arXiv version
- `PUB_PDF` - Publisher version
- `ADS_PDF` - ADS scanned version

Example: `papers/2024ApJ...123..456A_EPRINT_PDF.pdf`

Special characters in bibcode (like `&`) are sanitized for filesystem compatibility.
