/**
 * Bibliac Core - BibTeX Cleanup Utilities
 *
 * Functions for cleaning up BibTeX field values.
 */

/**
 * Clean up LaTeX escape sequences
 * @param {string} str
 * @returns {string}
 */
export function cleanLatexEscapes(str) {
  if (!str) return str;
  return str
    // After \t is interpreted as tab: extasciitilde, extbackslash
    .replace(/extasciitilde\s*\{\s*\}/g, ' ')
    .replace(/extasciitilde/g, ' ')
    .replace(/extbackslash\s*\{\s*\}/g, '')
    .replace(/extbackslash/g, '')
    // With full backslash preserved (raw BibTeX)
    .replace(/\\textasciitilde\s*\{\s*\}/g, ' ')
    .replace(/\\textasciitilde/g, ' ')
    .replace(/\\textbackslash\s*\{\s*\}/g, '')
    .replace(/\\textbackslash/g, '')
    // Common LaTeX escapes
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\\\$/g, '$')
    .replace(/\\#/g, '#')
    .replace(/\\_/g, '_')
    .replace(/\\ /g, ' ')
    .replace(/~/g, ' ')
    .replace(/\t/g, ' ');
}

/**
 * Clean up BibTeX field value
 * @param {string} str
 * @returns {string}
 */
export function cleanBibtexValue(str) {
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

/**
 * Clean author name from BibTeX format
 * @param {string} author
 * @returns {string}
 */
export function cleanAuthorName(author) {
  if (!author) return author;
  // First clean LaTeX escapes
  let cleaned = cleanLatexEscapes(author);
  // Remove braces
  cleaned = cleaned.replace(/\{|\}/g, '');
  // Clean up multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned.trim();
}
