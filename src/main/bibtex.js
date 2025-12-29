// SciX Reader - BibTeX Management Module

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

// Parse a BibTeX file
function parseBibtex(content) {
  const entries = [];
  const entryPattern = /@(\w+)\s*{\s*([^,]+),([^@]*)/g;

  let match;
  while ((match = entryPattern.exec(content)) !== null) {
    const type = match[1].toLowerCase();
    const key = match[2].trim();
    const fieldsStr = match[3];

    const fields = {};
    const fieldPattern = /(\w+)\s*=\s*[{"]([^}"]*)[}"]/g;

    let fieldMatch;
    while ((fieldMatch = fieldPattern.exec(fieldsStr)) !== null) {
      fields[fieldMatch[1].toLowerCase()] = fieldMatch[2];
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

  const header = `% SciX Reader Master BibTeX File
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
  const header = `% BibTeX export from SciX Reader
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

// Import papers from a BibTeX file
function importBibtex(bibPath) {
  const content = fs.readFileSync(bibPath, 'utf-8');
  const entries = parseBibtex(content);
  const sourceFilename = path.basename(bibPath);

  return entries.map(entry => ({
    title: entry.title,
    authors: entry.author ? entry.author.split(' and ').map(a => a.trim()) : [],
    year: entry.year ? parseInt(entry.year) : null,
    journal: entry.journal || entry.booktitle,
    doi: entry.doi,
    arxiv_id: entry.eprint,
    abstract: entry.abstract,
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
  }));
}

module.exports = {
  generateBibtexKey,
  paperToBibtex,
  escapeLatex,
  parseBibtex,
  updateMasterBib,
  exportBibtex,
  getCiteCommand,
  getMultiCiteCommand,
  importBibtex
};
