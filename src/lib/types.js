/**
 * Bibliac Core - Type Definitions (JSDoc)
 *
 * This file contains JSDoc type definitions that serve as the API contract
 * between the core library and platform adapters.
 */

/**
 * @typedef {Object} Paper
 * @property {number} id - Primary key (auto-generated)
 * @property {string|null} bibcode - ADS bibcode identifier
 * @property {string|null} doi - DOI identifier
 * @property {string|null} arxiv_id - arXiv ID (e.g., "2401.12345")
 * @property {string} title - Paper title
 * @property {string[]} authors - Array of author names
 * @property {number|null} year - Publication year
 * @property {string|null} journal - Journal/publication name
 * @property {string|null} abstract - Paper abstract
 * @property {string[]} keywords - Array of keywords
 * @property {string|null} pdf_path - Relative path to PDF
 * @property {string|null} text_path - Relative path to extracted text
 * @property {string|null} bibtex - BibTeX entry
 * @property {'unread'|'reading'|'read'} read_status - Read status
 * @property {number} rating - 0-4 rating
 * @property {string} added_date - ISO timestamp
 * @property {string} modified_date - ISO timestamp
 * @property {string|null} import_source - Source .bib file path
 * @property {string|null} import_source_key - Original BibTeX key
 * @property {number} citation_count - Number of citing papers
 * @property {boolean} [is_indexed] - Has embeddings (computed)
 * @property {number} [annotation_count] - Number of annotations (computed)
 */

/**
 * @typedef {Object} Collection
 * @property {number} id - Primary key
 * @property {string} name - Collection name
 * @property {number|null} parent_id - Parent collection ID
 * @property {boolean} is_smart - Is this a smart collection
 * @property {string|null} query - Search query for smart collections
 * @property {string} created_date - ISO timestamp
 * @property {number} paper_count - Number of papers in collection
 */

/**
 * @typedef {Object} Annotation
 * @property {number} id - Primary key
 * @property {number} paper_id - Associated paper ID
 * @property {number} page_number - Page number
 * @property {string|null} selection_text - Selected text
 * @property {Object[]} selection_rects - Rectangle coordinates
 * @property {string} note_content - Note text
 * @property {string} color - Highlight color (hex)
 * @property {string|null} pdf_source - PDF source type
 * @property {string} created_at - ISO timestamp
 * @property {string} updated_at - ISO timestamp
 */

/**
 * @typedef {Object} ADSDocument
 * @property {string} bibcode - ADS bibcode identifier
 * @property {string[]} title - Paper title (array with single element)
 * @property {string[]} author - Author names
 * @property {string} year - Publication year (string)
 * @property {string[]} [doi] - DOI identifier(s)
 * @property {string} [pub] - Journal/publication name
 * @property {string} [abstract] - Paper abstract
 * @property {string[]} [keyword] - Keywords
 * @property {string[]} [identifier] - All identifiers (arXiv, bibcode, etc.)
 * @property {string[]} [arxiv_class] - arXiv categories
 * @property {number} [citation_count] - Number of citations
 */

/**
 * @typedef {Object} SearchOptions
 * @property {string} [fields] - Comma-separated field list
 * @property {number} [rows] - Number of results (default: 25)
 * @property {number} [start] - Result offset (default: 0)
 * @property {string} [sort] - Sort order (default: "date desc")
 */

/**
 * @typedef {Object} GetPapersOptions
 * @property {string} [readStatus] - Filter by read status
 * @property {string} [search] - Search term for title/authors/abstract
 * @property {string} [orderBy] - Column to sort by (default: "added_date")
 * @property {string} [order] - Sort direction: "ASC" or "DESC" (default: "DESC")
 * @property {number} [limit] - Maximum number of results
 * @property {number} [collectionId] - Filter by collection
 */

/**
 * @typedef {Object} SearchResult
 * @property {Paper} paper - The matching paper
 * @property {number} matchCount - Relevance score
 * @property {string} matchSource - Where match was found
 * @property {string} context - Snippet showing match context
 */

/**
 * @typedef {Object} EsourceRecord
 * @property {string} title - URL as title
 * @property {string} url - Full URL to resource
 * @property {string} link_type - Type like "ESOURCE|EPRINT_PDF"
 */

/**
 * @typedef {Object} BibtexEntry
 * @property {string} type - Entry type (article, misc, etc.)
 * @property {string} key - Citation key
 * @property {string} [title] - Paper title
 * @property {string} [author] - Authors (BibTeX format)
 * @property {string} [year] - Publication year
 * @property {string} [journal] - Journal name
 * @property {string} [doi] - DOI
 * @property {string} [eprint] - arXiv ID
 * @property {string} [abstract] - Abstract
 * @property {string} [adsurl] - ADS URL
 */

/**
 * @typedef {Object} PlatformAdapter
 * @property {function(string): Promise<string|null>} readFile - Read file content
 * @property {function(string, string): Promise<void>} writeFile - Write file content
 * @property {function(string): Promise<boolean>} fileExists - Check if file exists
 * @property {function(string): Promise<void>} deleteFile - Delete a file
 * @property {function(string): Promise<void>} mkdir - Create directory
 * @property {function(string, Object): Promise<Object>} httpGet - HTTP GET request
 * @property {function(string, Object, Object): Promise<Object>} httpPost - HTTP POST request
 * @property {function(string): Promise<string|null>} getSecureItem - Get from secure storage
 * @property {function(string, string): Promise<void>} setSecureItem - Set in secure storage
 */

/**
 * @typedef {Object} LibraryConfig
 * @property {string} path - Library folder path
 * @property {string} [id] - Unique library ID
 * @property {string} [name] - Library display name
 * @property {'local'|'icloud'} [location] - Storage location
 */

/**
 * PDF Source types
 * @enum {string}
 */
export const PDFSourceType = {
  ARXIV: 'EPRINT_PDF',
  PUBLISHER: 'PUB_PDF',
  ADS_SCAN: 'ADS_PDF'
};

/**
 * Read status values
 * @enum {string}
 */
export const ReadStatus = {
  UNREAD: 'unread',
  READING: 'reading',
  READ: 'read'
};

/**
 * Rating labels
 * @type {Object.<number, string>}
 */
export const RatingLabels = {
  1: 'Seminal',
  2: 'Important',
  3: 'Useful',
  4: 'Meh'
};
