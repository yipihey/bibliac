// SciX Reader - PDF Download Module

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Download a file from URL to destination path
function downloadFile(url, destPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    console.log(`Starting download: ${url}`);
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    // Trust ADS/Harvard domains even with expired certs (common issue)
    const trustedDomains = ['adsabs.harvard.edu', 'articles.adsabs.harvard.edu', 'arxiv.org'];
    const isTrusted = trustedDomains.some(d => parsedUrl.hostname.endsWith(d));

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
      },
      // Allow expired certs for trusted academic domains
      rejectUnauthorized: !isTrusted
    };

    const req = protocol.request(options, (res) => {
      console.log(`Response: ${res.statusCode} ${res.headers['content-type']} (${res.headers['content-length']} bytes)`);

      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsedUrl.protocol}//${parsedUrl.host}${res.headers.location}`;
        console.log(`Redirecting to: ${redirectUrl}`);
        downloadFile(redirectUrl, destPath, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(destPath);
      let downloadedBytes = 0;
      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0 && downloadedBytes % 100000 < chunk.length) {
          console.log(`Downloaded ${Math.round(downloadedBytes/1024)}KB / ${Math.round(totalBytes/1024)}KB`);
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          console.log(`Download complete: ${destPath}`);
          // Verify file was written and is a valid PDF
          try {
            const stats = fs.statSync(destPath);
            if (stats.size < 1000) {
              fs.unlinkSync(destPath);
              reject(new Error('Downloaded file too small, likely not a valid PDF'));
              return;
            }

            // Check PDF magic bytes
            const fd = fs.openSync(destPath, 'r');
            const buffer = Buffer.alloc(8);
            fs.readSync(fd, buffer, 0, 8, 0);
            fs.closeSync(fd);

            const header = buffer.toString('ascii', 0, 5);
            if (header !== '%PDF-') {
              fs.unlinkSync(destPath);
              // Check if it's HTML (auth redirect)
              if (buffer.toString().includes('<!DOC') || buffer.toString().includes('<html')) {
                reject(new Error('Received login page instead of PDF - authentication required'));
              } else {
                reject(new Error('Downloaded file is not a valid PDF'));
              }
              return;
            }

            resolve({ success: true, path: destPath });
          } catch (e) {
            reject(new Error(`Failed to verify download: ${e.message}`));
          }
        });
      });

      file.on('error', (err) => {
        console.error(`File write error: ${err.message}`);
        fs.unlink(destPath, () => {}); // Clean up
        reject(err);
      });

      res.on('error', (err) => {
        console.error(`Response error: ${err.message}`);
        reject(err);
      });
    });

    req.on('error', (err) => {
      console.error(`Request error: ${err.message}`);
      reject(err);
    });

    req.setTimeout(300000, () => {  // 5 minute timeout for large scanned PDFs
      console.error('Download timeout');
      req.destroy();
      reject(new Error('Download timeout'));
    });

    req.end();
  });
}

// Download PDF from arXiv
async function downloadFromArxiv(arxivId, destPath) {
  // Normalize arXiv ID (remove version suffix for URL)
  const normalizedId = arxivId.replace(/v\d+$/, '');
  const url = `https://arxiv.org/pdf/${normalizedId}.pdf`;

  console.log(`Downloading from arXiv: ${url}`);
  return downloadFile(url, destPath);
}

// Find PDF URL from ADS esources
// priorityOrder is an array like ['PUB_PDF', 'ADS_PDF', 'EPRINT_PDF', 'AUTHOR_PDF']
function findPdfUrl(esources, priorityOrder = null) {
  // Default priority order: Publisher > ADS > arXiv > Author
  const priorityTypes = priorityOrder || [
    'PUB_PDF',      // Publisher PDF (highest quality, peer-reviewed)
    'ADS_PDF',      // ADS scanned PDF (best for old papers)
    'EPRINT_PDF',   // arXiv PDF (preprint)
    'AUTHOR_PDF'    // Author-hosted PDF
  ];

  // Helper to check if source matches type (handles both 'type' and 'link_type' formats)
  const matchesType = (source, ptype) => {
    if (source.type === ptype) return true;
    // Handle format like "ESOURCE|ADS_PDF"
    if (source.link_type && source.link_type.includes(ptype)) return true;
    return false;
  };

  // Helper to check if URL is valid (not a DOI or other identifier)
  const isValidUrl = (url) => {
    return url && (url.startsWith('http://') || url.startsWith('https://'));
  };

  for (const ptype of priorityTypes) {
    const source = esources.find(s => matchesType(s, ptype) && isValidUrl(s.url));
    if (source) {
      return { url: source.url, type: ptype };
    }
  }

  // Fallback: look for any valid PDF link
  const pdfSource = esources.find(s =>
    isValidUrl(s.url) && (s.url.includes('.pdf') || s.type?.includes('PDF') || s.link_type?.includes('PDF'))
  );

  return pdfSource ? { url: pdfSource.url, type: pdfSource.type || pdfSource.link_type || 'UNKNOWN' } : null;
}

// Download PDF using ADS esources
async function downloadFromADS(adsApi, token, bibcode, destPath, proxyUrl = null, priorityOrder = null) {
  console.log(`Fetching esources for: ${bibcode}`);
  const esources = await adsApi.getEsources(token, bibcode);

  if (!esources || esources.length === 0) {
    throw new Error('No esources available');
  }

  const pdfInfo = findPdfUrl(esources, priorityOrder);
  if (!pdfInfo) {
    throw new Error('No PDF URL found in esources');
  }
  console.log(`Selected PDF source: ${pdfInfo.type} (priority: ${priorityOrder?.join(' > ') || 'default'})`);


  let downloadUrl = pdfInfo.url;

  // Apply library proxy for publisher PDFs (PUB_PDF) if proxy is configured
  if (proxyUrl && pdfInfo.type === 'PUB_PDF') {
    // Encode the target URL and prepend proxy
    downloadUrl = proxyUrl + encodeURIComponent(pdfInfo.url);
    console.log(`Using library proxy for PUB_PDF: ${downloadUrl}`);
  } else {
    console.log(`Downloading from ADS esource (${pdfInfo.type}): ${downloadUrl}`);
  }

  return downloadFile(downloadUrl, destPath);
}

// Main download function with fallback chain
// priorityOrder: array like ['PUB_PDF', 'ADS_PDF', 'EPRINT_PDF', 'AUTHOR_PDF']
async function downloadPDF(paper, libraryPath, token, adsApi, proxyUrl = null, priorityOrder = null) {
  // Generate filename from bibcode or arxiv_id
  const baseFilename = paper.bibcode || paper.arxiv_id || `paper_${Date.now()}`;
  const safeFilename = baseFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${safeFilename}.pdf`;
  const destPath = path.join(libraryPath, 'papers', filename);

  // Check if file already exists
  if (fs.existsSync(destPath)) {
    return { success: true, path: destPath, source: 'cache', pdf_path: `papers/${filename}` };
  }

  // Ensure papers directory exists
  const papersDir = path.join(libraryPath, 'papers');
  if (!fs.existsSync(papersDir)) {
    fs.mkdirSync(papersDir, { recursive: true });
  }

  // Try ADS esources first (uses priority order)
  if (paper.bibcode && token && adsApi) {
    try {
      await downloadFromADS(adsApi, token, paper.bibcode, destPath, proxyUrl, priorityOrder);
      return { success: true, path: destPath, source: 'ads', pdf_path: `papers/${filename}` };
    } catch (error) {
      console.log(`ADS download failed: ${error.message}`);
    }
  }

  // Fall back to arXiv direct download
  if (paper.arxiv_id) {
    try {
      await downloadFromArxiv(paper.arxiv_id, destPath);
      return { success: true, path: destPath, source: 'arxiv', pdf_path: `papers/${filename}` };
    } catch (error) {
      console.log(`arXiv download failed: ${error.message}`);
    }
  }

  // No PDF available
  return {
    success: false,
    reason: 'No PDF source available',
    pdf_path: null
  };
}

// Download multiple PDFs with progress callback
async function downloadMultiplePDFs(papers, libraryPath, token, adsApi, progressCallback) {
  const results = [];
  let completed = 0;

  for (const paper of papers) {
    try {
      const result = await downloadPDF(paper, libraryPath, token, adsApi);
      results.push({ ...result, paper });
    } catch (error) {
      results.push({
        success: false,
        reason: error.message,
        paper
      });
    }

    completed++;
    if (progressCallback) {
      progressCallback(completed, papers.length, paper);
    }

    // Rate limiting - small delay between downloads
    if (completed < papers.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}

module.exports = {
  downloadFile,
  downloadFromArxiv,
  downloadFromADS,
  downloadPDF,
  downloadMultiplePDFs,
  findPdfUrl
};
