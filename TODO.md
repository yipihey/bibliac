# Bibliac - TODO & Known Issues

## Known Issues

### ADS API
- **Intermittent 500 errors**: ADS API occasionally returns 500 Internal Server Error. Retry logic (up to 3 attempts with exponential backoff) is implemented in `ads-api.js:getByBibcodes()`.
- **Missing bibcodes**: Some older or unusual bibcodes are not found in ADS. Workaround: DOI fallback lookup is implemented in main.js sync handler.
- **Bibcode normalization**: Some bibcodes with special characters (like `..`) need quoting in queries.

### PDF Downloads
- **Library proxy authentication**: Proxy downloads sometimes return a login page instead of PDF. Detection is implemented (checks content-type), but manual re-authentication may be needed.
- **Publisher rate limiting**: Some publishers block rapid PDF requests. No automated retry currently.

### UI/UX
- **Large libraries slow**: Libraries with 500+ papers may have slow initial load. Database queries are not paginated.

---

## Planned Features

### High Priority
- [ ] **Smart collections**: Saved searches that update automatically. Partially implemented (database schema exists, UI incomplete).
- [ ] **Batch PDF download**: Download all PDFs for selected papers in one action.
- [ ] **PDF text extraction on import**: Currently only extracts text when syncing, not on initial import.

### Medium Priority
- [ ] **Test suite**: Add Jest tests for critical paths (ADS API, database, PDF handling).
- [ ] **TypeScript migration**: Gradual migration from vanilla JS for better type safety.
- [ ] **Keyboard navigation**: Full keyboard support for paper list and PDF viewer.
- [ ] **Export annotations**: Export highlights/notes to Markdown or text file.

### Low Priority
- [ ] **Multiple libraries**: Support for separate library databases.
- [ ] **Tag system**: Alternative to collections for flexible organization.
- [ ] **PDF comparison**: Side-by-side view of arXiv vs published versions.
- [ ] **Reading progress**: Track reading position in PDFs.

---

## What's Been Tried

### ADS Lookup Failures
**Problem**: Papers with valid bibcodes not found in ADS.
**Tried**:
- Direct bibcode query → fails for some bibcodes with special chars
- Normalized bibcode (dots removed) → partial improvement
**Solution**: DOI fallback lookup if bibcode fails. Implemented in main.js `ads-sync-papers` handler.

### Publisher PDF Downloads
**Problem**: Direct publisher URLs blocked or require authentication.
**Tried**:
- Direct download → usually blocked
- User-Agent spoofing → some sites still block
**Solution**: Library proxy support. User configures their institution's proxy URL in Preferences.

### Full-text Search Performance
**Problem**: Searching large libraries was slow.
**Tried**:
- SQLite FTS5 → complexity not worth it for current scale
**Solution**: Simple LIKE queries with regex for now. Works well up to ~1000 papers.

---

## Code Quality TODOs

- [ ] Add ESLint configuration
- [ ] Add JSDoc comments to exported functions
- [ ] Reduce app.js size (4800+ lines) by extracting components
- [ ] Error boundary for renderer crashes

---

## Recent Changes (Dec 2024)

- Multi-PDF support (arxiv + publisher versions per paper)
- PDF source dropdown with delete button
- Citation count display and sorting
- Console panel with resize and data progress
- DOI-first search in ADS lookup
- Retry logic for ADS 500 errors
- Progress feedback during sync (bytes received)
