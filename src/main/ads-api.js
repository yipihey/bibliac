// SciX Reader - NASA ADS/SciX API Module

const https = require('https');

const ADS_HOST = 'api.adsabs.harvard.edu';
const ADS_BASE_PATH = '/v1';

// Make an API request to ADS
function adsRequest(endpoint, method, token, body = null) {
  return new Promise((resolve, reject) => {
    // Construct full path with /v1 prefix
    const fullPath = ADS_BASE_PATH + endpoint;

    const options = {
      hostname: ADS_HOST,
      path: fullPath,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`ADS API error: ${res.statusCode} - ${data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse ADS response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// Search for papers
async function search(token, query, options = {}) {
  const fields = options.fields || 'bibcode,title,author,year,doi,abstract,keyword,pub,identifier,arxiv_class';
  const rows = options.rows || 25;
  const start = options.start || 0;

  const params = new URLSearchParams({
    q: query,
    fl: fields,
    rows: rows.toString(),
    start: start.toString(),
    sort: options.sort || 'date desc'
  });

  const result = await adsRequest(`/search/query?${params}`, 'GET', token);
  return result.response;
}

// Get paper by bibcode
async function getByBibcode(token, bibcode) {
  // Quote bibcode to handle special characters like ".."
  const result = await search(token, `bibcode:"${bibcode}"`, { rows: 1 });
  return result.docs[0] || null;
}

// Get multiple papers by bibcodes in a single API call (batch lookup)
async function getByBibcodes(token, bibcodes, batchSize = 50) {
  if (!bibcodes || bibcodes.length === 0) return [];

  const results = [];

  // Process in batches to avoid query length limits
  for (let i = 0; i < bibcodes.length; i += batchSize) {
    const batch = bibcodes.slice(i, i + batchSize);
    const query = batch.map(b => `bibcode:"${b}"`).join(' OR ');

    try {
      const result = await search(token, query, { rows: batch.length });
      if (result.docs) {
        results.push(...result.docs);
      }
    } catch (e) {
      console.error(`Batch lookup failed for batch ${i / batchSize}:`, e.message);
    }
  }

  return results;
}

// Get paper by DOI
async function getByDOI(token, doi) {
  const result = await search(token, `doi:"${doi}"`, { rows: 1 });
  return result.docs[0] || null;
}

// Get paper by arXiv ID
async function getByArxiv(token, arxivId) {
  // Normalize arXiv ID
  const normalizedId = arxivId.replace('arXiv:', '').replace('arxiv:', '');
  const result = await search(token, `arxiv:${normalizedId}`, { rows: 1 });
  return result.docs[0] || null;
}

// Get references (papers this paper cites)
async function getReferences(token, bibcode, options = {}) {
  const rows = options.rows || 200;
  // Quote bibcode to handle special characters like ".."
  const result = await search(token, `references(bibcode:"${bibcode}")`, {
    fields: 'bibcode,title,author,year',
    rows
  });
  return result.docs || [];
}

// Get citations (papers that cite this paper)
async function getCitations(token, bibcode, options = {}) {
  const rows = options.rows || 200;
  // Quote bibcode to handle special characters like ".."
  const result = await search(token, `citations(bibcode:"${bibcode}")`, {
    fields: 'bibcode,title,author,year',
    rows
  });
  return result.docs || [];
}

// Export papers as BibTeX
async function exportBibtex(token, bibcodes) {
  if (!Array.isArray(bibcodes)) {
    bibcodes = [bibcodes];
  }

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.adsabs.harvard.edu',
      path: '/v1/export/bibtex',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const result = JSON.parse(data);
            resolve(result.export);
          } else {
            reject(new Error(`ADS export error: ${res.statusCode} - ${data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse ADS export response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify({ bibcode: bibcodes }));
    req.end();
  });
}

// Get esources (PDF/article links) for a paper
async function getEsources(token, bibcode) {
  try {
    // Need to call the specific esource endpoint to get actual PDF links
    const result = await adsRequest(`/resolver/${bibcode}/esource`, 'GET', token);
    console.log('Esources response:', JSON.stringify(result, null, 2));

    // Handle different response formats
    if (Array.isArray(result)) {
      return result;
    } else if (result && Array.isArray(result.links)) {
      return result.links;
    } else if (result && result.links && Array.isArray(result.links.records)) {
      // Nested structure: { links: { records: [...] } }
      return result.links.records;
    } else if (result && Array.isArray(result.records)) {
      return result.records;
    }
    return [];
  } catch (error) {
    console.error('Error fetching esources:', error.message);
    return [];
  }
}

// Validate API token
async function validateToken(token) {
  try {
    // Try a simple search to validate the token
    await search(token, 'bibcode:2020ApJ...900..100D', { rows: 1 });
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// Convert ADS response to our paper format
function adsToPaper(adsDoc) {
  return {
    bibcode: adsDoc.bibcode,
    doi: adsDoc.doi?.[0] || null,
    arxiv_id: extractArxivId(adsDoc.identifier),
    title: adsDoc.title?.[0] || 'Untitled',
    authors: adsDoc.author || [],
    year: adsDoc.year ? parseInt(adsDoc.year) : null,
    journal: adsDoc.pub || null,
    abstract: adsDoc.abstract || null,
    keywords: adsDoc.keyword || []
  };
}

// Extract arXiv ID from ADS identifiers
function extractArxivId(identifiers) {
  if (!identifiers) return null;

  for (const id of identifiers) {
    if (id.startsWith('arXiv:')) {
      return id.replace('arXiv:', '');
    }
    // Match pattern like 2401.12345
    const match = id.match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

// Calculate similarity between two titles
function titleSimilarity(title1, title2) {
  if (!title1 || !title2) return 0;

  const normalize = (s) => s.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter(w => !['the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'been', 'were', 'their', 'which', 'through', 'about', 'into', 'using', 'based'].includes(w));

  const words1 = new Set(normalize(title1));
  const words2 = new Set(normalize(title2));

  if (words1.size === 0 || words2.size === 0) return 0;

  let matches = 0;
  for (const w of words1) {
    if (words2.has(w)) matches++;
  }

  // Jaccard-like similarity
  const union = new Set([...words1, ...words2]).size;
  return matches / union;
}

// Smart search that tries multiple strategies
async function smartSearch(token, metadata) {
  const { title, firstAuthor, year, journal } = metadata;

  console.log('Smart search with metadata:', { title, firstAuthor, year, journal });

  const strategies = [];

  // Strategy 1: Full title as phrase (most specific)
  if (title && title.length > 10) {
    // Clean title for search - remove problematic characters
    const cleanTitle = title
      .replace(/["""'']/g, '')
      .replace(/[:;]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    strategies.push({
      name: 'exact_title',
      query: `title:"${cleanTitle}"`,
      minSimilarity: 0.5
    });
  }

  // Strategy 2: Title keywords + author + year (balanced)
  if (title) {
    const titleWords = title
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .filter(w => !['with', 'from', 'that', 'this', 'have', 'been', 'were', 'their', 'which', 'through', 'about', 'using', 'based', 'study', 'analysis', 'observations', 'properties'].includes(w.toLowerCase()));

    if (titleWords.length > 0) {
      // Use more title words but as individual terms
      const searchTerms = titleWords.slice(0, 8).join(' ');
      let query = `title:(${searchTerms})`;
      if (firstAuthor) query += ` author:"^${firstAuthor}"`;  // ^ means first author
      if (year) query += ` year:${year}`;
      strategies.push({
        name: 'title_words_author_year',
        query,
        minSimilarity: 0.4
      });
    }
  }

  // Strategy 3: First author + year + key distinctive words
  if (firstAuthor && year && title) {
    // Get the most distinctive words (longer, less common)
    const distinctiveWords = title
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 5)
      .slice(0, 4)
      .join(' ');

    if (distinctiveWords) {
      strategies.push({
        name: 'author_year_keywords',
        query: `author:"^${firstAuthor}" year:${year} title:(${distinctiveWords})`,
        minSimilarity: 0.35
      });
    }
  }

  // Strategy 4: Just first author + year (broad, last resort)
  if (firstAuthor && year) {
    strategies.push({
      name: 'author_year_only',
      query: `author:"^${firstAuthor}" year:${year}`,
      minSimilarity: 0.5  // Need higher similarity since query is broad
    });
  }

  // Strategy 5: Title words only (no author/year constraint)
  if (title && title.length > 20) {
    const importantWords = title
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4)
      .slice(0, 6)
      .join(' ');

    if (importantWords) {
      strategies.push({
        name: 'title_words_only',
        query: `title:(${importantWords})`,
        minSimilarity: 0.55
      });
    }
  }

  // Try each strategy in order
  for (const strategy of strategies) {
    console.log(`Trying strategy '${strategy.name}': ${strategy.query}`);

    try {
      const result = await search(token, strategy.query, { rows: 5, sort: 'score desc' });

      if (result.docs && result.docs.length > 0) {
        // Score each candidate
        const scored = result.docs.map(doc => ({
          doc,
          similarity: titleSimilarity(title, doc.title?.[0] || ''),
          authorMatch: firstAuthor && doc.author?.[0]?.toLowerCase().includes(firstAuthor.toLowerCase()),
          yearMatch: year && String(doc.year) === String(year)
        }));

        // Sort by similarity
        scored.sort((a, b) => b.similarity - a.similarity);

        const best = scored[0];
        console.log(`Best candidate: "${best.doc.title?.[0]}" (similarity: ${best.similarity.toFixed(2)}, author: ${best.authorMatch}, year: ${best.yearMatch})`);

        // Accept if meets threshold OR has strong author+year match with reasonable similarity
        if (best.similarity >= strategy.minSimilarity) {
          console.log(`Match accepted via '${strategy.name}' strategy`);
          return best.doc;
        }

        // Also accept if author and year match with moderate similarity
        if (best.authorMatch && best.yearMatch && best.similarity >= 0.25) {
          console.log(`Match accepted via author+year confirmation`);
          return best.doc;
        }
      }
    } catch (err) {
      console.error(`Strategy '${strategy.name}' failed:`, err.message);
    }
  }

  console.log('No match found after trying all strategies');
  return null;
}

module.exports = {
  search,
  smartSearch,
  getByBibcode,
  getByBibcodes,
  getByDOI,
  getByArxiv,
  getReferences,
  getCitations,
  getEsources,
  exportBibtex,
  validateToken,
  adsToPaper,
  extractArxivId
};
