// ADS Reader - Export/Import Service
// Handles exporting and importing .adslib library archives

const archiver = require('archiver');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');

/**
 * Get export statistics for preview
 * @param {Object} database - Database module instance
 * @param {string} libraryPath - Path to library folder
 * @returns {Object} Export statistics
 */
function getExportStats(database, libraryPath) {
  const papers = database.getAllPapers();
  const collections = database.getCollections();

  let pdfCount = 0;
  let pdfSize = 0;
  let annotationCount = 0;
  let refCount = 0;
  let citeCount = 0;

  for (const paper of papers) {
    // Count PDFs and calculate size
    if (paper.pdf_path && libraryPath) {
      const fullPath = path.join(libraryPath, paper.pdf_path);
      if (fs.existsSync(fullPath)) {
        pdfCount++;
        try {
          const stats = fs.statSync(fullPath);
          pdfSize += stats.size;
        } catch (e) {
          // Ignore stat errors
        }
      }
    }

    // Count annotations
    annotationCount += paper.annotation_count || 0;

    // Count refs and cites
    const refs = database.getReferences(paper.id);
    const cites = database.getCitations(paper.id);
    refCount += refs.length;
    citeCount += cites.length;
  }

  // Get attachments
  const attachments = database.getAllAttachments();
  let attachmentSize = 0;
  for (const att of attachments) {
    if (att.filename && libraryPath) {
      const attPath = path.join(libraryPath, 'attachments', att.filename);
      if (fs.existsSync(attPath)) {
        try {
          attachmentSize += fs.statSync(attPath).size;
        } catch (e) {
          // Ignore
        }
      }
    }
  }

  return {
    paperCount: papers.length,
    collectionCount: collections.length,
    pdfCount,
    pdfSize,
    annotationCount,
    refCount,
    citeCount,
    attachmentCount: attachments.length,
    attachmentSize
  };
}

/**
 * Get all paper_collections for export
 * @param {Object} database - Database module instance
 * @returns {Array} Array of {paper_id, collection_id}
 */
function getAllPaperCollections(database) {
  const collections = database.getCollections();
  const paperCollections = [];

  for (const coll of collections) {
    const papers = database.getPapersInCollection(coll.id);
    for (const paper of papers) {
      paperCollections.push({
        paper_id: paper.id,
        collection_id: coll.id,
        paper_bibcode: paper.bibcode
      });
    }
  }

  return paperCollections;
}

/**
 * Export library to .adslib file
 * @param {Object} options - Export options
 * @param {Object} database - Database module instance
 * @param {string} libraryPath - Path to library folder
 * @param {string} savePath - Path to save the .adslib file
 * @param {Function} progressCallback - Progress callback (phase, current, total)
 * @returns {Promise<Object>} Result with success status
 */
async function exportLibrary(options, database, libraryPath, savePath, progressCallback) {
  const { libraryName, includePdfs, includeAttachments, includeRefs, includeCites, includeAnnotations, sortField, sortOrder } = options;

  return new Promise((resolve, reject) => {
    try {
      const output = fs.createWriteStream(savePath);
      const archive = archiver('zip', { zlib: { level: 5 } });

      output.on('close', () => {
        resolve({ success: true, path: savePath, size: archive.pointer() });
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.pipe(output);

      // Get all data
      const papers = database.getAllPapers();
      const collections = database.getCollections();
      const paperCollections = getAllPaperCollections(database);

      // Build library.json
      const libraryData = {
        papers: papers.map(p => ({
          bibcode: p.bibcode,
          doi: p.doi,
          arxiv_id: p.arxiv_id,
          title: p.title,
          authors: p.authors,
          year: p.year,
          journal: p.journal,
          abstract: p.abstract,
          keywords: p.keywords,
          bibtex: p.bibtex,
          read_status: p.read_status,
          rating: p.rating,
          added_date: p.added_date,
          modified_date: p.modified_date,
          citation_count: p.citation_count,
          pdf_path: p.pdf_path,
          pdf_source: p.pdf_source,
          import_source: p.import_source,
          import_source_key: p.import_source_key
        })),
        collections: collections.map(c => ({
          id: c.id,
          name: c.name,
          parent_id: c.parent_id,
          is_smart: c.is_smart,
          query: c.query,
          created_date: c.created_date,
          papers: paperCollections
            .filter(pc => pc.collection_id === c.id)
            .map(pc => pc.paper_bibcode)
            .filter(Boolean)
        })),
        refs: {},
        cites: {},
        annotations: {},
        rotations: {}
      };

      // Add refs if requested
      if (includeRefs) {
        for (const paper of papers) {
          if (paper.bibcode) {
            const refs = database.getReferences(paper.id);
            if (refs.length > 0) {
              libraryData.refs[paper.bibcode] = refs.map(r => ({
                ref_bibcode: r.ref_bibcode,
                ref_title: r.ref_title,
                ref_authors: r.ref_authors,
                ref_year: r.ref_year
              }));
            }
          }
        }
      }

      // Add cites if requested
      if (includeCites) {
        for (const paper of papers) {
          if (paper.bibcode) {
            const cites = database.getCitations(paper.id);
            if (cites.length > 0) {
              libraryData.cites[paper.bibcode] = cites.map(c => ({
                citing_bibcode: c.citing_bibcode,
                citing_title: c.citing_title,
                citing_authors: c.citing_authors,
                citing_year: c.citing_year
              }));
            }
          }
        }
      }

      // Add annotations if requested
      if (includeAnnotations) {
        for (const paper of papers) {
          if (paper.bibcode) {
            const annotations = database.getAnnotations(paper.id);
            if (annotations.length > 0) {
              libraryData.annotations[paper.bibcode] = annotations.map(a => ({
                page_number: a.page_number,
                selection_text: a.selection_text,
                selection_rects: a.selection_rects,
                note_content: a.note_content,
                color: a.color,
                pdf_source: a.pdf_source,
                created_at: a.created_at,
                updated_at: a.updated_at
              }));
            }
          }
        }
      }

      // Add PDF page rotations (always included if present)
      if (database.getPageRotations) {
        for (const paper of papers) {
          if (paper.bibcode) {
            const rotations = database.getPageRotations(paper.id);
            if (Object.keys(rotations).length > 0) {
              libraryData.rotations[paper.bibcode] = rotations;
            }
          }
        }
      }

      // Add sort preferences
      libraryData.sortPreferences = {
        field: sortField || 'added',
        order: sortOrder || 'desc'
      };

      // Add library.json to archive
      archive.append(JSON.stringify(libraryData, null, 2), { name: 'library.json' });

      // Build manifest.json
      const { app } = require('electron');
      const stats = {
        paperCount: papers.length,
        collectionCount: collections.length,
        pdfCount: 0,
        annotationCount: 0,
        refCount: Object.values(libraryData.refs).reduce((sum, refs) => sum + refs.length, 0),
        citeCount: Object.values(libraryData.cites).reduce((sum, cites) => sum + cites.length, 0)
      };

      // Count annotations
      for (const anns of Object.values(libraryData.annotations)) {
        stats.annotationCount += anns.length;
      }

      const manifest = {
        version: 1,
        format: 'adslib',
        libraryName: libraryName || 'Exported Library',
        exportDate: new Date().toISOString(),
        exportedBy: `ADS Reader ${app.getVersion()}`,
        platform: process.platform === 'darwin' ? 'macOS' : process.platform,
        options: { includePdfs, includeAttachments, includeRefs, includeCites, includeAnnotations },
        stats
      };

      // Add PDFs if requested
      if (includePdfs && libraryPath) {
        let pdfCount = 0;
        const papersWithPdf = papers.filter(p => p.pdf_path);

        for (let i = 0; i < papersWithPdf.length; i++) {
          const paper = papersWithPdf[i];
          const fullPath = path.join(libraryPath, paper.pdf_path);

          if (fs.existsSync(fullPath)) {
            // Sanitize bibcode for folder name
            const safeBibcode = (paper.bibcode || `paper_${paper.id}`).replace(/[/\\:*?"<>|]/g, '_');
            const pdfFilename = path.basename(paper.pdf_path);
            archive.file(fullPath, { name: `pdfs/${safeBibcode}/${pdfFilename}` });
            pdfCount++;
          }

          // Report progress
          if (progressCallback) {
            progressCallback('pdfs', i + 1, papersWithPdf.length);
          }
        }

        stats.pdfCount = pdfCount;
      }

      // Add attachments if requested
      if (includeAttachments && libraryPath) {
        const attachments = database.getAllAttachments();
        let attCount = 0;

        for (const att of attachments) {
          const attPath = path.join(libraryPath, 'attachments', att.filename);
          if (fs.existsSync(attPath)) {
            archive.file(attPath, { name: `attachments/${att.filename}` });
            attCount++;
          }
        }

        stats.attachmentCount = attCount;
      }

      // Update manifest with final stats
      manifest.stats = stats;
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

      // Finalize archive
      archive.finalize();

    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Preview import file contents
 * @param {string} filePath - Path to .adslib file
 * @returns {Promise<Object>} Preview data with manifest and stats
 */
async function previewImport(filePath) {
  return new Promise(async (resolve, reject) => {
    try {
      const zip = fs.createReadStream(filePath).pipe(unzipper.Parse({ forceStream: true }));

      let manifest = null;
      let libraryData = null;

      for await (const entry of zip) {
        const fileName = entry.path;

        if (fileName === 'manifest.json') {
          const content = await entry.buffer();
          manifest = JSON.parse(content.toString());
        } else if (fileName === 'library.json') {
          const content = await entry.buffer();
          libraryData = JSON.parse(content.toString());
        } else {
          entry.autodrain();
        }
      }

      if (!manifest || !libraryData) {
        return reject(new Error('Invalid .adslib file: missing manifest or library data'));
      }

      // Calculate additional stats from library data
      const stats = {
        ...manifest.stats,
        papers: libraryData.papers?.length || 0,
        collections: libraryData.collections?.length || 0,
        refs: Object.keys(libraryData.refs || {}).length,
        cites: Object.keys(libraryData.cites || {}).length,
        annotations: Object.keys(libraryData.annotations || {}).length
      };

      resolve({
        manifest,
        stats,
        libraryName: manifest.libraryName,
        exportDate: manifest.exportDate,
        exportedBy: manifest.exportedBy,
        platform: manifest.platform
      });

    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Import library from .adslib file
 * @param {Object} options - Import options
 * @param {Object} database - Database module instance
 * @param {string} libraryPath - Path to library folder
 * @param {Function} progressCallback - Progress callback
 * @returns {Promise<Object>} Import results
 */
async function importLibrary(options, database, libraryPath, progressCallback) {
  const { filePath, mode, importPdfs, importAnnotations } = options;

  return new Promise(async (resolve, reject) => {
    try {
      const results = {
        papersImported: 0,
        papersSkipped: 0,
        pdfsImported: 0,
        annotationsImported: 0,
        collectionsImported: 0,
        errors: []
      };

      // Read the ZIP file
      const zip = fs.createReadStream(filePath).pipe(unzipper.Parse({ forceStream: true }));

      let libraryData = null;
      const pdfEntries = [];

      // First pass: read library.json and collect PDF entries
      for await (const entry of zip) {
        const fileName = entry.path;

        if (fileName === 'library.json') {
          const content = await entry.buffer();
          libraryData = JSON.parse(content.toString());
        } else if (fileName.startsWith('pdfs/') && importPdfs) {
          // Store PDF entry for later extraction
          const content = await entry.buffer();
          pdfEntries.push({ path: fileName, content });
        } else {
          entry.autodrain();
        }
      }

      if (!libraryData) {
        return reject(new Error('Invalid .adslib file: missing library data'));
      }

      // If replace mode, clear existing papers
      if (mode === 'replace') {
        const existingPapers = database.getAllPapers();
        for (const paper of existingPapers) {
          database.deletePaper(paper.id, false);
        }
        // Clear collections too
        const existingCollections = database.getCollections();
        for (const coll of existingCollections) {
          database.deleteCollection(coll.id);
        }
        database.saveDatabase();
      }

      // Import papers
      const bibcodeToNewId = {};
      const papers = libraryData.papers || [];

      for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];

        if (progressCallback) {
          progressCallback('papers', i + 1, papers.length);
        }

        // Check for duplicates in merge mode
        if (mode === 'merge') {
          let existingPaper = null;

          if (paper.bibcode) {
            existingPaper = database.getPaperByBibcode(paper.bibcode);
          }

          if (existingPaper) {
            results.papersSkipped++;
            bibcodeToNewId[paper.bibcode] = existingPaper.id;
            continue;
          }
        }

        // Clear pdf_path for now (will be set when PDFs are imported)
        const paperToImport = { ...paper };
        if (!importPdfs) {
          paperToImport.pdf_path = null;
        }

        try {
          const newId = database.addPaper(paperToImport);
          results.papersImported++;

          if (paper.bibcode) {
            bibcodeToNewId[paper.bibcode] = newId;
          }
        } catch (e) {
          results.errors.push(`Failed to import paper: ${paper.title} - ${e.message}`);
        }
      }

      // Import collections
      const collectionIdMap = {};
      const collections = libraryData.collections || [];

      // Sort collections by parent_id to ensure parents are created first
      collections.sort((a, b) => {
        if (a.parent_id === null && b.parent_id !== null) return -1;
        if (a.parent_id !== null && b.parent_id === null) return 1;
        return 0;
      });

      for (const coll of collections) {
        try {
          const parentId = coll.parent_id ? collectionIdMap[coll.parent_id] : null;
          const newCollId = database.createCollection(coll.name, parentId, coll.is_smart, coll.query);
          collectionIdMap[coll.id] = newCollId;
          results.collectionsImported++;

          // Add papers to collection
          for (const bibcode of coll.papers || []) {
            const paperId = bibcodeToNewId[bibcode];
            if (paperId) {
              database.addPaperToCollection(paperId, newCollId);
            }
          }
        } catch (e) {
          results.errors.push(`Failed to import collection: ${coll.name} - ${e.message}`);
        }
      }

      // Import refs
      const refs = libraryData.refs || {};
      for (const [bibcode, paperRefs] of Object.entries(refs)) {
        const paperId = bibcodeToNewId[bibcode];
        if (paperId && paperRefs.length > 0) {
          database.addReferences(paperId, paperRefs.map(r => ({
            bibcode: r.ref_bibcode,
            title: r.ref_title,
            authors: r.ref_authors,
            year: r.ref_year
          })), false);
        }
      }

      // Import cites
      const cites = libraryData.cites || {};
      for (const [bibcode, paperCites] of Object.entries(cites)) {
        const paperId = bibcodeToNewId[bibcode];
        if (paperId && paperCites.length > 0) {
          database.addCitations(paperId, paperCites.map(c => ({
            bibcode: c.citing_bibcode,
            title: c.citing_title,
            authors: c.citing_authors,
            year: c.citing_year
          })), false);
        }
      }

      // Import annotations
      if (importAnnotations) {
        const annotations = libraryData.annotations || {};
        for (const [bibcode, paperAnnotations] of Object.entries(annotations)) {
          const paperId = bibcodeToNewId[bibcode];
          if (paperId) {
            for (const ann of paperAnnotations) {
              try {
                database.createAnnotation(paperId, {
                  page_number: ann.page_number,
                  selection_text: ann.selection_text,
                  selection_rects: ann.selection_rects,
                  note_content: ann.note_content,
                  color: ann.color,
                  pdf_source: ann.pdf_source
                });
                results.annotationsImported++;
              } catch (e) {
                // Ignore annotation errors
              }
            }
          }
        }
      }

      // Import PDF page rotations (always import if present)
      if (database.setPageRotations) {
        const rotations = libraryData.rotations || {};
        for (const [bibcode, paperRotations] of Object.entries(rotations)) {
          const paperId = bibcodeToNewId[bibcode];
          if (paperId && Object.keys(paperRotations).length > 0) {
            try {
              database.setPageRotations(paperId, paperRotations);
            } catch (e) {
              // Ignore rotation errors
            }
          }
        }
      }

      // Import PDFs
      if (importPdfs && libraryPath) {
        for (let i = 0; i < pdfEntries.length; i++) {
          const pdfEntry = pdfEntries[i];

          if (progressCallback) {
            progressCallback('pdfs', i + 1, pdfEntries.length);
          }

          // Extract bibcode from path: pdfs/{bibcode}/{filename}
          const pathParts = pdfEntry.path.split('/');
          if (pathParts.length >= 3) {
            const bibcode = pathParts[1];
            const filename = pathParts[2];
            const paperId = bibcodeToNewId[bibcode];

            if (paperId) {
              // Ensure papers directory exists
              const paperDir = path.join(libraryPath, 'papers');
              if (!fs.existsSync(paperDir)) {
                fs.mkdirSync(paperDir, { recursive: true });
              }

              // Save PDF
              const pdfPath = path.join(paperDir, filename);
              try {
                fs.writeFileSync(pdfPath, pdfEntry.content);

                // Update paper with pdf_path
                database.updatePaper(paperId, { pdf_path: `papers/${filename}` }, false);
                results.pdfsImported++;
              } catch (e) {
                results.errors.push(`Failed to import PDF: ${filename} - ${e.message}`);
              }
            }
          }
        }
      }

      // Save database
      database.saveDatabase();

      // Include sort preferences from imported library
      if (libraryData.sortPreferences) {
        results.sortPreferences = libraryData.sortPreferences;
      }

      resolve(results);

    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  getExportStats,
  exportLibrary,
  previewImport,
  importLibrary
};
