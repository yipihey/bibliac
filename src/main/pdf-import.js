// SciX Reader - PDF Import Module

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execAsync = promisify(exec);

// Minimum word count to consider a PDF as having real text (not scanned)
const MIN_TEXT_WORDS = 100;

// Check if OCR tools are available
let ocrAvailable = null;
async function checkOcrAvailable() {
  if (ocrAvailable !== null) return ocrAvailable;

  try {
    // Check for ocrmypdf (preferred - handles PDF OCR directly)
    await execAsync('which ocrmypdf');
    ocrAvailable = 'ocrmypdf';
    console.log('OCR available: ocrmypdf');
    return ocrAvailable;
  } catch (e) {
    try {
      // Check for tesseract (fallback)
      await execAsync('which tesseract');
      ocrAvailable = 'tesseract';
      console.log('OCR available: tesseract');
      return ocrAvailable;
    } catch (e2) {
      ocrAvailable = false;
      console.log('No OCR tools available (install ocrmypdf or tesseract for scanned PDF support)');
      return ocrAvailable;
    }
  }
}

// Check if extracted text is meaningful (not empty or too short)
function isTextMeaningful(textPath) {
  try {
    if (!fs.existsSync(textPath)) return false;
    const text = fs.readFileSync(textPath, 'utf-8');
    // Count words (split by whitespace)
    const words = text.trim().split(/\s+/).filter(w => w.length > 1);
    return words.length >= MIN_TEXT_WORDS;
  } catch (e) {
    return false;
  }
}

// Run OCR on a PDF and extract text
async function runOcr(pdfPath, outputPath) {
  const ocrTool = await checkOcrAvailable();
  if (!ocrTool) {
    console.log('OCR not available - scanned PDF will have limited text');
    return false;
  }

  const escapedPdf = pdfPath.replace(/'/g, "'\\''");
  const escapedOutput = outputPath.replace(/'/g, "'\\''");

  try {
    if (ocrTool === 'ocrmypdf') {
      // ocrmypdf can output a searchable PDF, then we extract text
      const tempOcrPdf = path.join(os.tmpdir(), `ocr_${Date.now()}.pdf`);
      const escapedTemp = tempOcrPdf.replace(/'/g, "'\\''");

      console.log(`Running OCR on: ${pdfPath}`);
      // --skip-text: skip pages that already have text
      // --force-ocr: OCR even if text exists (use for fully scanned docs)
      // -l eng: English language
      await execAsync(`ocrmypdf --skip-text -l eng '${escapedPdf}' '${escapedTemp}'`, {
        timeout: 300000  // 5 minute timeout for large documents
      });

      // Now extract text from the OCR'd PDF
      await execAsync(`pdftotext -layout '${escapedTemp}' '${escapedOutput}'`);

      // Clean up temp file
      try { fs.unlinkSync(tempOcrPdf); } catch (e) {}

      console.log('OCR completed successfully');
      return true;
    } else if (ocrTool === 'tesseract') {
      // Tesseract requires images, so we need to convert PDF pages to images first
      // This is more complex and slower, but works as a fallback
      const tempDir = path.join(os.tmpdir(), `ocr_images_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      console.log(`Running OCR with tesseract on: ${pdfPath}`);

      // Convert PDF to images using pdftoppm (from poppler)
      await execAsync(`pdftoppm -png '${escapedPdf}' '${tempDir}/page'`, {
        timeout: 120000
      });

      // Run tesseract on each image and combine
      const images = fs.readdirSync(tempDir).filter(f => f.endsWith('.png')).sort();
      let fullText = '';

      for (const img of images) {
        const imgPath = path.join(tempDir, img);
        const txtPath = imgPath.replace('.png', '');

        await execAsync(`tesseract '${imgPath}' '${txtPath}' -l eng`, {
          timeout: 60000
        });

        const pageTxt = fs.readFileSync(txtPath + '.txt', 'utf-8');
        fullText += pageTxt + '\n\n';
      }

      fs.writeFileSync(outputPath, fullText);

      // Clean up temp directory
      try {
        for (const f of fs.readdirSync(tempDir)) {
          fs.unlinkSync(path.join(tempDir, f));
        }
        fs.rmdirSync(tempDir);
      } catch (e) {}

      console.log('OCR completed successfully');
      return true;
    }
  } catch (error) {
    console.error('OCR failed:', error.message);
    return false;
  }

  return false;
}

// Extract text from PDF using pdftotext, with OCR fallback for scanned documents
async function extractText(pdfPath, outputPath) {
  try {
    // Try pdftotext first (from poppler or xpdf)
    const escapedPdf = pdfPath.replace(/'/g, "'\\''");
    const escapedOutput = outputPath.replace(/'/g, "'\\''");
    await execAsync(`pdftotext -layout '${escapedPdf}' '${escapedOutput}'`);

    // Check if we got meaningful text
    if (!isTextMeaningful(outputPath)) {
      console.log('PDF appears to be scanned (minimal text extracted), attempting OCR...');
      const ocrSuccess = await runOcr(pdfPath, outputPath);
      if (ocrSuccess && isTextMeaningful(outputPath)) {
        console.log('OCR extraction successful');
        return true;
      }
    }

    return true;
  } catch (error) {
    // If pdftotext fails, try using Python with PyPDF2 or pdfminer
    try {
      const tempScript = path.join(os.tmpdir(), `extract_${Date.now()}.py`);

      const pythonScript = `
import sys

pdf_path = ${JSON.stringify(pdfPath)}
output_path = ${JSON.stringify(outputPath)}

try:
    from PyPDF2 import PdfReader
    reader = PdfReader(pdf_path)
    text = ""
    for page in reader.pages:
        text += page.extract_text() or ""
        text += "\\n\\n"
    with open(output_path, "w") as f:
        f.write(text)
except ImportError:
    try:
        from pdfminer.high_level import extract_text as pdf_extract
        text = pdf_extract(pdf_path)
        with open(output_path, "w") as f:
            f.write(text)
    except ImportError:
        sys.exit(1)
`;
      fs.writeFileSync(tempScript, pythonScript);
      await execAsync(`python3 "${tempScript}"`);
      fs.unlinkSync(tempScript);

      // Check if we got meaningful text, try OCR if not
      if (!isTextMeaningful(outputPath)) {
        console.log('PDF appears to be scanned (minimal text from Python), attempting OCR...');
        await runOcr(pdfPath, outputPath);
      }

      return true;
    } catch (pyError) {
      console.error('Text extraction failed:', pyError);

      // Last resort: try OCR directly
      console.log('Direct extraction failed, attempting OCR as last resort...');
      const ocrSuccess = await runOcr(pdfPath, outputPath);
      if (ocrSuccess) return true;

      // Create empty text file as fallback
      fs.writeFileSync(outputPath, '');
      return false;
    }
  }
}

// Try to extract bibcode or identifiers from PDF filename
function extractIdentifiersFromFilename(filename) {
  const identifiers = {
    bibcode: null,
    arxiv_id: null,
    doi: null
  };

  // ADS bibcode pattern: YYYYJJJJJ.VVV..PPPP. (e.g., 2025NatAs.tmp..258J)
  const bibcodePattern = /(\d{4}[A-Za-z&.]{5}[A-Za-z0-9.]{4}[A-Za-z0-9.]{4}[A-Z.])/;
  const bibcodeMatch = filename.match(bibcodePattern);
  if (bibcodeMatch) {
    identifiers.bibcode = bibcodeMatch[1];
  }

  // arXiv pattern: YYMM.NNNNN or arxiv:YYMM.NNNNN
  const arxivPattern = /(?:arxiv[:\s]?)?(\d{4}\.\d{4,5}(?:v\d+)?)/i;
  const arxivMatch = filename.match(arxivPattern);
  if (arxivMatch) {
    identifiers.arxiv_id = arxivMatch[1];
  }

  // DOI pattern
  const doiPattern = /(10\.\d{4,}\/[^\s]+)/;
  const doiMatch = filename.match(doiPattern);
  if (doiMatch) {
    identifiers.doi = doiMatch[1];
  }

  return identifiers;
}

// Extract identifiers from PDF text content
function extractIdentifiersFromContent(textContent) {
  const identifiers = {
    bibcode: null,
    arxiv_id: null,
    doi: null
  };

  if (!textContent) return identifiers;

  // Only look at first 5000 characters (header area where identifiers usually appear)
  const header = textContent.substring(0, 5000);

  // DOI pattern - look for explicit DOI mentions
  const doiPatterns = [
    /DOI[:\s]+\s*(10\.\d{4,}\/[^\s\n<>]+)/i,
    /doi\.org\/(10\.\d{4,}\/[^\s\n<>]+)/i,
    /https?:\/\/dx\.doi\.org\/(10\.\d{4,}\/[^\s\n<>]+)/i
  ];

  for (const pattern of doiPatterns) {
    const match = header.match(pattern);
    if (match) {
      // Clean up DOI (remove trailing punctuation)
      identifiers.doi = match[1].replace(/[.,;)\]]+$/, '');
      break;
    }
  }

  // arXiv pattern - look for arXiv ID mentions
  const arxivPatterns = [
    /arXiv[:\s]+(\d{4}\.\d{4,5}(?:v\d+)?)/i,
    /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i,
    // Old-style arXiv IDs
    /arXiv[:\s]+([a-z-]+\/\d{7}(?:v\d+)?)/i
  ];

  for (const pattern of arxivPatterns) {
    const match = header.match(pattern);
    if (match) {
      identifiers.arxiv_id = match[1];
      break;
    }
  }

  // ADS bibcode pattern (often in paper footers/headers)
  const bibcodePattern = /(\d{4}[A-Za-z&.]{5}[A-Za-z0-9.]{4}[A-Za-z0-9.]{4}[A-Z.])/;
  const bibcodeMatch = header.match(bibcodePattern);
  if (bibcodeMatch) {
    identifiers.bibcode = bibcodeMatch[1];
  }

  return identifiers;
}

// Extract metadata (title, authors, year) from PDF text for search
function extractMetadataFromPDF(textContent) {
  const metadata = {
    title: null,
    firstAuthor: null,
    year: null
  };

  if (!textContent) return metadata;

  const lines = textContent.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return metadata;

  // Title is usually the first substantial line (long enough to be a title)
  // Skip short lines that are likely headers/page numbers
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i].trim();
    // Skip short lines, lines that are just numbers, email addresses, etc.
    if (line.length > 20 &&
        !/^\d+$/.test(line) &&
        !line.includes('@') &&
        !/^(page|vol|volume|issue|doi|arxiv)/i.test(line)) {
      metadata.title = line.substring(0, 300);
      break;
    }
  }

  // Look for year in first part of document (in date, copyright, etc.)
  const header = textContent.substring(0, 3000);
  const yearPatterns = [
    // Common patterns in papers
    /(?:published|submitted|received|accepted|copyright|\(c\)|©)\s*(?:\w+\s*)?(\d{4})/i,
    /(\d{4})\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)/i,
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s*\d{1,2}?,?\s*(\d{4})/i,
    // Year in isolation that looks reasonable (2000-2030)
    /\b(20[0-3][0-9])\b/
  ];

  for (const pattern of yearPatterns) {
    const match = header.match(pattern);
    if (match) {
      const year = parseInt(match[1]);
      if (year >= 1990 && year <= 2030) {
        metadata.year = year;
        break;
      }
    }
  }

  // Try to extract first author - look for common patterns
  // Authors often appear right after title, before abstract
  const authorPatterns = [
    // "Author Name1, Author Name2" pattern after title
    /^([A-Z][a-z]+(?:\s+[A-Z]\.?)*(?:\s+[A-Z][a-z]+)+)/m,
    // "LastName, FirstName" format
    /^([A-Z][a-z]+),\s+([A-Z][a-z]+)/m
  ];

  // Look in lines 2-15 for author info (after title, before abstract)
  for (let i = 1; i < Math.min(lines.length, 15); i++) {
    const line = lines[i].trim();

    // Skip lines that look like affiliations (contain university, institute, etc.)
    if (/university|institute|department|laboratory|center|college/i.test(line)) continue;

    // Skip lines with email or numbers
    if (/@/.test(line) || /^\d/.test(line)) continue;

    // Look for author-like patterns
    const authorMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z]\.?)*(?:\s+[A-Z][a-z]+)?)/);
    if (authorMatch && authorMatch[1].length > 3) {
      // Extract just the surname (first or last word depending on format)
      const parts = authorMatch[1].split(/\s+/);
      if (parts.length >= 1) {
        // Usually surname is the last word in "First Last" format
        // or first word in "Last, First" format
        metadata.firstAuthor = parts[parts.length - 1];
        break;
      }
    }
  }

  return metadata;
}

// Import a PDF file into the library
async function importPDF(sourcePath, libraryPath) {
  const filename = path.basename(sourcePath);
  const basename = path.basename(filename, '.pdf');

  // Generate unique filename if needed
  let targetFilename = filename;
  let targetPath = path.join(libraryPath, 'papers', targetFilename);
  let counter = 1;

  while (fs.existsSync(targetPath)) {
    targetFilename = `${basename}_${counter}.pdf`;
    targetPath = path.join(libraryPath, 'papers', targetFilename);
    counter++;
  }

  // Copy PDF to library
  fs.copyFileSync(sourcePath, targetPath);

  // Extract text
  const textFilename = targetFilename.replace('.pdf', '.txt');
  const textPath = path.join(libraryPath, 'text', textFilename);
  const textExtracted = await extractText(targetPath, textPath);

  // Try to extract identifiers from filename first
  const filenameIds = extractIdentifiersFromFilename(filename);

  // Also try to extract identifiers and metadata from PDF content
  let contentIds = { bibcode: null, arxiv_id: null, doi: null };
  let pdfMetadata = { title: null, firstAuthor: null, year: null };
  let textContent = null;

  if (textExtracted && fs.existsSync(textPath)) {
    textContent = fs.readFileSync(textPath, 'utf-8');
    contentIds = extractIdentifiersFromContent(textContent);
    pdfMetadata = extractMetadataFromPDF(textContent);
  }

  // Merge identifiers - prefer filename, then content
  const identifiers = {
    bibcode: filenameIds.bibcode || contentIds.bibcode,
    arxiv_id: filenameIds.arxiv_id || contentIds.arxiv_id,
    doi: filenameIds.doi || contentIds.doi
  };

  // Use extracted title if available, otherwise use filename
  const extractedTitle = pdfMetadata.title || basename;

  return {
    pdf_path: `papers/${targetFilename}`,
    text_path: `text/${textFilename}`,
    title: extractedTitle,
    textExtracted,
    // Include extracted metadata for SciX search fallback
    extractedMetadata: {
      title: pdfMetadata.title,
      firstAuthor: pdfMetadata.firstAuthor,
      year: pdfMetadata.year
    },
    ...identifiers
  };
}

// Import multiple PDFs
async function importMultiplePDFs(sourcePaths, libraryPath, progressCallback) {
  const results = [];
  let completed = 0;

  for (const sourcePath of sourcePaths) {
    try {
      const result = await importPDF(sourcePath, libraryPath);
      results.push({ success: true, path: sourcePath, ...result });
    } catch (error) {
      results.push({ success: false, path: sourcePath, error: error.message });
    }

    completed++;
    if (progressCallback) {
      progressCallback(completed, sourcePaths.length);
    }
  }

  return results;
}

// Delete a paper's files from the library
function deletePaperFiles(libraryPath, pdfPath, textPath) {
  if (pdfPath) {
    const fullPdfPath = path.join(libraryPath, pdfPath);
    if (fs.existsSync(fullPdfPath)) {
      fs.unlinkSync(fullPdfPath);
    }
  }

  if (textPath) {
    const fullTextPath = path.join(libraryPath, textPath);
    if (fs.existsSync(fullTextPath)) {
      fs.unlinkSync(fullTextPath);
    }
  }
}

module.exports = {
  extractText,
  extractIdentifiersFromFilename,
  extractIdentifiersFromContent,
  extractMetadataFromPDF,
  importPDF,
  importMultiplePDFs,
  deletePaperFiles
};
