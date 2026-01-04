// Bibliac - BibTeX Management Module

const fs = require('fs');
const path = require('path');

// Generate BibTeX key from paper info
function generateBibtexKey(paper) {
  // If bibcode exists, use a cleaned version
  if (paper.bibcode) {
    return paper.bibcode.replace(/[^a-zA-Z0-9]/g, '');
  }

  // Otherwise generate from author + year
  let key = '';

  if (paper.authors && paper.authors.length > 0) {
    // Get first author's last name
    const firstAuthor = paper.authors[0];
    const lastName = firstAuthor.split(',')[0].trim().replace(/[^a-zA-Z]/g, '');
    key = lastName;
  } else {
    key = 'Unknown';
  }

  if (paper.year) {
    key += paper.year;
  }

  // Add title word if needed to avoid duplicates
  if (paper.title) {
    const titleWord = paper.title.split(/\s+/).find(w => w.length > 3);
    if (titleWord) {
      key += titleWord.replace(/[^a-zA-Z]/g, '');
    }
  }

  return key;
}

// Generate BibTeX entry from paper
function paperToBibtex(paper) {
  // If paper already has bibtex from ADS, return it
  if (paper.bibtex) {
    return paper.bibtex;
  }

  const key = generateBibtexKey(paper);
  const type = paper.arxiv_id && !paper.journal ? 'misc' : 'article';

  const lines = [`@${type}{${key},`];

  if (paper.title) {
    lines.push(`  title = {${escapeLatex(paper.title)}},`);
  }

  if (paper.authors && paper.authors.length > 0) {
    const authorStr = paper.authors.join(' and ');
    lines.push(`  author = {${escapeLatex(authorStr)}},`);
  }

  if (paper.year) {
    lines.push(`  year = {${paper.year}},`);
  }

  if (paper.journal) {
    lines.push(`  journal = {${escapeLatex(paper.journal)}},`);
  }

  if (paper.doi) {
    lines.push(`  doi = {${paper.doi}},`);
  }

  if (paper.arxiv_id) {
    lines.push(`  eprint = {${paper.arxiv_id}},`);
    lines.push(`  archivePrefix = {arXiv},`);
  }

  if (paper.bibcode) {
    lines.push(`  adsurl = {https://ui.adsabs.harvard.edu/abs/${paper.bibcode}},`);
  }

  if (paper.abstract) {
    lines.push(`  abstract = {${escapeLatex(paper.abstract)}},`);
  }

  // Remove trailing comma from last entry
  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = lastLine.replace(/,$/, '');

  lines.push('}');

  return lines.join('\n');
}

// Escape special LaTeX characters
function escapeLatex(str) {
  if (!str) return '';

  return str
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

// Parse a BibTeX field value, handling nested braces
function parseBibtexValue(str, startPos) {
  let pos = startPos;

  // Skip whitespace
  while (pos < str.length && /\s/.test(str[pos])) pos++;

  if (pos >= str.length) return { value: '', endPos: pos };

  const startChar = str[pos];

  // Braced value
  if (startChar === '{') {
    let depth = 1;
    let value = '';
    pos++;
    while (pos < str.length && depth > 0) {
      if (str[pos] === '{') depth++;
      else if (str[pos] === '}') depth--;
      if (depth > 0) value += str[pos];
      pos++;
    }
    return { value: value.trim(), endPos: pos };
  }

  // Quoted value
  if (startChar === '"') {
    let value = '';
    pos++;
    while (pos < str.length && str[pos] !== '"') {
      value += str[pos];
      pos++;
    }
    pos++; // Skip closing quote
    return { value: value.trim(), endPos: pos };
  }

  // Unquoted value (number or single word)
  let value = '';
  while (pos < str.length && /[^\s,}]/.test(str[pos])) {
    value += str[pos];
    pos++;
  }
  return { value: value.trim(), endPos: pos };
}

// Parse a BibTeX file
function parseBibtex(content) {
  const entries = [];
  const entryPattern = /@(\w+)\s*{\s*([^,]+),/g;

  let match;
  while ((match = entryPattern.exec(content)) !== null) {
    const type = match[1].toLowerCase();
    const key = match[2].trim();

    // Find the end of this entry by counting braces
    let pos = match.index + match[0].length;
    let depth = 1;
    let entryEnd = pos;
    while (entryEnd < content.length && depth > 0) {
      if (content[entryEnd] === '{') depth++;
      else if (content[entryEnd] === '}') depth--;
      entryEnd++;
    }

    const fieldsStr = content.substring(pos, entryEnd - 1);
    const fields = {};

    // Parse fields with a simple state machine
    const fieldPattern = /(\w[\w-]*)\s*=\s*/g;
    let fieldMatch;
    while ((fieldMatch = fieldPattern.exec(fieldsStr)) !== null) {
      const fieldName = fieldMatch[1].toLowerCase();
      const { value } = parseBibtexValue(fieldsStr, fieldMatch.index + fieldMatch[0].length);
      if (value) {
        fields[fieldName] = value;
      }
    }

    entries.push({
      type,
      key,
      ...fields
    });
  }

  return entries;
}

// Update master.bib file with all papers
function updateMasterBib(libraryPath, papers) {
  const bibPath = path.join(libraryPath, 'master.bib');

  const header = `% Bibliac Master BibTeX File
% Auto-generated - manual edits may be overwritten
% Last updated: ${new Date().toISOString()}
% Total entries: ${papers.length}

`;

  const entries = papers
    .map(paper => paperToBibtex(paper))
    .join('\n\n');

  fs.writeFileSync(bibPath, header + entries + '\n');

  return bibPath;
}

// Export selected papers to a separate .bib file
function exportBibtex(papers, outputPath) {
  const header = `% BibTeX export from Bibliac
% Exported: ${new Date().toISOString()}
% Entries: ${papers.length}

`;

  const entries = papers
    .map(paper => paperToBibtex(paper))
    .join('\n\n');

  fs.writeFileSync(outputPath, header + entries + '\n');

  return outputPath;
}

// Get \cite command for clipboard
function getCiteCommand(paper, style = 'cite') {
  const key = generateBibtexKey(paper);

  switch (style) {
    case 'citep':
      return `\\citep{${key}}`;
    case 'citet':
      return `\\citet{${key}}`;
    case 'citeauthor':
      return `\\citeauthor{${key}}`;
    default:
      return `\\cite{${key}}`;
  }
}

// Get \cite command for multiple papers
function getMultiCiteCommand(papers, style = 'cite') {
  const keys = papers.map(p => generateBibtexKey(p)).join(', ');

  switch (style) {
    case 'citep':
      return `\\citep{${keys}}`;
    case 'citet':
      return `\\citet{${keys}}`;
    case 'citeauthor':
      return `\\citeauthor{${keys}}`;
    default:
      return `\\cite{${keys}}`;
  }
}

// Clean up LaTeX escape sequences (handles both with and without backslash)
function cleanLatexEscapes(str) {
  if (!str) return str;
  return str
    // After \t is interpreted as tab: extasciitilde, extbackslash
    .replace(/extasciitilde\s*\{\s*\}/g, ' ')      // extasciitilde{} -> space
    .replace(/extasciitilde/g, ' ')                 // extasciitilde -> space
    .replace(/extbackslash\s*\{\s*\}/g, '')        // extbackslash{} -> remove
    .replace(/extbackslash/g, '')                   // extbackslash -> remove
    // With full backslash preserved (raw BibTeX)
    .replace(/\\textasciitilde\s*\{\s*\}/g, ' ')   // \textasciitilde{} -> space
    .replace(/\\textasciitilde/g, ' ')              // \textasciitilde -> space
    .replace(/\\textbackslash\s*\{\s*\}/g, '')     // \textbackslash{} -> remove
    .replace(/\\textbackslash/g, '')                // \textbackslash -> remove
    // Common LaTeX escapes
    .replace(/\\&/g, '&')                          // \& -> &
    .replace(/\\%/g, '%')                          // \% -> %
    .replace(/\\\$/g, '$')                         // \$ -> $
    .replace(/\\#/g, '#')                          // \# -> #
    .replace(/\\_/g, '_')                          // \_ -> _
    .replace(/\\ /g, ' ')                          // "\ " -> space
    .replace(/~/g, ' ')                            // ~ -> space (non-breaking space)
    .replace(/\t/g, ' ');                          // tab -> space
}

// Clean up BibTeX field value - remove outer braces and clean author names
function cleanBibtexValue(str) {
  if (!str) return str;
  // First clean LaTeX escapes
  let cleaned = cleanLatexEscapes(str);
  // Remove outer braces if present
  cleaned = cleaned.replace(/^\{(.+)\}$/, '$1');
  // Remove remaining braces (used for capitalization protection)
  cleaned = cleaned.replace(/\{|\}/g, '');
  // Clean up multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned.trim();
}

// Clean author name - handle BibTeX author format
function cleanAuthorName(author) {
  if (!author) return author;
  // First clean LaTeX escapes
  let cleaned = cleanLatexEscapes(author);
  // Remove braces
  cleaned = cleaned.replace(/\{|\}/g, '');
  // Clean up multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned.trim();
}

// Extract bibcode from ADS URL
function extractBibcodeFromAdsUrl(adsurl) {
  if (!adsurl) return null;
  // Match patterns like:
  // http://adsabs.harvard.edu/abs/2011MNRAS.tmp.1739P
  // https://ui.adsabs.harvard.edu/abs/2011MNRAS.tmp.1739P
  // https://ui.adsabs.harvard.edu/abs/2013ARA%26A...51..105C (URL-encoded &)
  // https://ui.adsabs.harvard.edu/abs/2013ARA&A...51..105C (literal &)
  // http://adsabs.harvard.edu/cgi-bin/nph-bib_query?bibcode=2011MNRAS.tmp.1739P

  // For /abs/ URLs, capture everything after /abs/ until end, whitespace, or query string (?)
  // Note: bibcodes can contain & (e.g., ARA&A for Annual Review of Astronomy & Astrophysics)
  const absMatch = adsurl.match(/\/abs\/([^\/\s?]+)/);
  if (absMatch) {
    // URL-decode to handle %26 -> &
    return decodeURIComponent(absMatch[1]);
  }

  const bibcodeMatch = adsurl.match(/bibcode=([^&\s]+)/);
  if (bibcodeMatch) return decodeURIComponent(bibcodeMatch[1]);

  return null;
}

// Import papers from a BibTeX file
function importBibtex(bibPath) {
  const content = fs.readFileSync(bibPath, 'utf-8');
  const entries = parseBibtex(content);
  const sourceFilename = path.basename(bibPath);

  return entries.map(entry => {
    // Try to extract bibcode from adsurl field
    const bibcodeFromUrl = extractBibcodeFromAdsUrl(entry.adsurl);
    // Use entry key as bibcode if it looks like one (e.g., 2011MNRAS.tmp.1739P)
    const bibcodeFromKey = /^\d{4}[A-Za-z]/.test(entry.key) ? entry.key : null;

    return {
      title: cleanBibtexValue(entry.title),
      authors: entry.author ? entry.author.split(' and ').map(a => cleanAuthorName(a.trim())) : [],
      year: entry.year ? parseInt(entry.year) : null,
      journal: cleanBibtexValue(entry.journal || entry.booktitle),
      doi: entry.doi,
      arxiv_id: entry.eprint,
      bibcode: bibcodeFromUrl || bibcodeFromKey,
      abstract: cleanBibtexValue(entry.abstract),
      import_source: sourceFilename,
      import_source_key: entry.key,
      bibtex: paperToBibtex({
        title: entry.title,
        authors: entry.author ? entry.author.split(' and ').map(a => a.trim()) : [],
        year: entry.year ? parseInt(entry.year) : null,
        journal: entry.journal || entry.booktitle,
        doi: entry.doi,
        arxiv_id: entry.eprint
      })
    };
  });
}

// Parse a single BibTeX entry and extract metadata for paper update
function parseSingleBibtexEntry(bibtexString) {
  const entries = parseBibtex(bibtexString);
  if (entries.length === 0) {
    return null;
  }

  const entry = entries[0];

  // Extract metadata in the same format as paper fields
  const result = {};

  if (entry.title) {
    result.title = cleanBibtexValue(entry.title);
  }

  if (entry.author) {
    result.authors = entry.author.split(' and ').map(a => cleanAuthorName(a.trim()));
  }

  if (entry.year) {
    result.year = parseInt(entry.year) || null;
  }

  if (entry.journal || entry.booktitle) {
    result.journal = cleanBibtexValue(entry.journal || entry.booktitle);
  }

  if (entry.doi) {
    result.doi = entry.doi;
  }

  if (entry.eprint) {
    result.arxiv_id = entry.eprint;
  }

  if (entry.abstract) {
    result.abstract = cleanBibtexValue(entry.abstract);
  }

  // Try to extract bibcode from adsurl
  if (entry.adsurl) {
    const bibcode = extractBibcodeFromAdsUrl(entry.adsurl);
    if (bibcode) {
      result.bibcode = bibcode;
    }
  }

  return result;
}

module.exports = {
  generateBibtexKey,
  paperToBibtex,
  escapeLatex,
  parseBibtex,
  parseSingleBibtexEntry,
  updateMasterBib,
  exportBibtex,
  getCiteCommand,
  getMultiCiteCommand,
  importBibtex
};
