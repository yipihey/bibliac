/**
 * ADS Reader Core - BibTeX Parser
 *
 * Pure JavaScript BibTeX parser with no dependencies.
 */

import { cleanBibtexValue, cleanAuthorName } from './cleanup.js';
import { generateBibtexKey, paperToBibtex } from './generator.js';

/**
 * Parse a BibTeX field value, handling nested braces
 * @param {string} str - BibTeX content
 * @param {number} startPos - Start position
 * @returns {{value: string, endPos: number}}
 */
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

/**
 * Parse a BibTeX file content
 * @param {string} content - BibTeX file content
 * @returns {import('../types.js').BibtexEntry[]}
 */
export function parseBibtex(content) {
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

/**
 * Parse a single BibTeX entry string and extract metadata
 * @param {string} bibtexString - Single BibTeX entry
 * @returns {Partial<import('../types.js').Paper>|null}
 */
export function parseSingleEntry(bibtexString) {
  const entries = parseBibtex(bibtexString);
  if (entries.length === 0) {
    return null;
  }

  const entry = entries[0];
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

/**
 * Extract bibcode from ADS URL
 * @param {string} adsurl - ADS URL
 * @returns {string|null}
 */
export function extractBibcodeFromAdsUrl(adsurl) {
  if (!adsurl) return null;

  // Match patterns like:
  // https://ui.adsabs.harvard.edu/abs/2011MNRAS.tmp.1739P
  // https://ui.adsabs.harvard.edu/abs/2013ARA%26A...51..105C (URL-encoded &)
  // http://adsabs.harvard.edu/cgi-bin/nph-bib_query?bibcode=2011MNRAS.tmp.1739P
  const absMatch = adsurl.match(/\/abs\/([^\/\s?]+)/);
  if (absMatch) {
    return decodeURIComponent(absMatch[1]);
  }

  const bibcodeMatch = adsurl.match(/bibcode=([^&\s]+)/);
  if (bibcodeMatch) return decodeURIComponent(bibcodeMatch[1]);

  return null;
}

/**
 * Convert BibTeX entries to paper objects for import
 * @param {import('../types.js').BibtexEntry[]} entries
 * @param {string} [sourceFilename] - Source file name
 * @returns {Partial<import('../types.js').Paper>[]}
 */
export function entriesToPapers(entries, sourceFilename = null) {
  return entries.map(entry => {
    // Try to extract bibcode from adsurl field
    const bibcodeFromUrl = extractBibcodeFromAdsUrl(entry.adsurl);
    // Use entry key as bibcode if it looks like one
    const bibcodeFromKey = /^\d{4}[A-Za-z]/.test(entry.key) ? entry.key : null;

    const paper = {
      title: cleanBibtexValue(entry.title),
      authors: entry.author ? entry.author.split(' and ').map(a => cleanAuthorName(a.trim())) : [],
      year: entry.year ? parseInt(entry.year) : null,
      journal: cleanBibtexValue(entry.journal || entry.booktitle),
      doi: entry.doi,
      arxiv_id: entry.eprint,
      bibcode: bibcodeFromUrl || bibcodeFromKey,
      abstract: cleanBibtexValue(entry.abstract),
      import_source: sourceFilename,
      import_source_key: entry.key
    };

    // Generate BibTeX for storage
    paper.bibtex = paperToBibtex({
      title: entry.title,
      authors: entry.author ? entry.author.split(' and ').map(a => a.trim()) : [],
      year: entry.year ? parseInt(entry.year) : null,
      journal: entry.journal || entry.booktitle,
      doi: entry.doi,
      arxiv_id: entry.eprint
    });

    return paper;
  });
}
