/**
 * ADS Reader Core - BibTeX Module
 *
 * Platform-agnostic BibTeX parsing and generation.
 */

export {
  parseBibtex,
  parseSingleEntry,
  extractBibcodeFromAdsUrl
} from './parser.js';

export {
  generateBibtexKey,
  paperToBibtex,
  escapeLatex,
  getCiteCommand,
  getMultiCiteCommand
} from './generator.js';

export {
  cleanLatexEscapes,
  cleanBibtexValue,
  cleanAuthorName
} from './cleanup.js';
