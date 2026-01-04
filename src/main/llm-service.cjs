// Bibliac - LLM Service Module (Ollama Integration)

const http = require('http');
const https = require('https');

class OllamaService {
  constructor(config = {}) {
    // Use 127.0.0.1 instead of localhost to avoid IPv6 issues
    this.endpoint = config.endpoint || 'http://127.0.0.1:11434';
    this.model = config.model || 'qwen3:8b';
    this.embeddingModel = config.embeddingModel || 'nomic-embed-text';
  }

  // Parse endpoint URL
  _parseEndpoint() {
    const url = new URL(this.endpoint);
    return {
      protocol: url.protocol === 'https:' ? https : http,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 11434)
    };
  }

  // Make HTTP request to Ollama
  _request(path, method = 'GET', body = null, onChunk = null) {
    return new Promise((resolve, reject) => {
      const { protocol, hostname, port } = this._parseEndpoint();

      const options = {
        hostname,
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 120000 // 2 minute timeout for LLM requests
      };

      const req = protocol.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          const chunkStr = chunk.toString();

          if (onChunk) {
            // Streaming mode - parse each line as JSON
            const lines = chunkStr.split('\n').filter(line => line.trim());
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                onChunk(parsed);
              } catch (e) {
                // Partial JSON, accumulate
              }
            }
          }

          data += chunkStr;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              // For streaming, return last response
              if (onChunk) {
                const lines = data.split('\n').filter(line => line.trim());
                const lastLine = lines[lines.length - 1];
                resolve(JSON.parse(lastLine));
              } else {
                resolve(JSON.parse(data));
              }
            } catch (e) {
              resolve(data);
            }
          } else {
            reject(new Error(`Ollama API error: ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new Error('Ollama is not running. Please start Ollama and try again.'));
        } else {
          reject(err);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  // Check if Ollama is running and accessible
  async checkConnection() {
    try {
      const result = await this._request('/api/tags');
      return { connected: true, models: result.models || [] };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }

  // List available models
  async listModels() {
    try {
      const result = await this._request('/api/tags');
      return (result.models || []).map(m => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at
      }));
    } catch (error) {
      console.error('Failed to list models:', error);
      return [];
    }
  }

  // Generate text (with optional streaming)
  async generate(prompt, options = {}) {
    const {
      systemPrompt = null,
      onChunk = null,
      temperature = 0.7,
      maxTokens = 2048,
      noThink = false  // Disable thinking mode for faster responses
    } = options;

    // Try chat API first (works better with most modern models like qwen, llama3, etc.)
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const chatBody = {
      model: this.model,
      messages,
      stream: !!onChunk,
      options: {
        temperature,
        num_predict: maxTokens
      }
    };

    // Disable thinking mode for faster extraction tasks
    if (noThink) {
      chatBody.options.think = false;
    }

    try {
      console.log('Calling chat API, stream:', !!onChunk);
      // Wrapper to convert chat API streaming format to generate API format
      const chatOnChunk = onChunk ? (chunk) => {
        // Only log non-thinking chunks to reduce noise
        if (chunk.message?.content) {
          console.log('Chat content chunk:', chunk.message.content.substring(0, 50));
        }
        // Skip chunks that only have thinking content (content is empty)
        // Some models like Qwen have a thinking mode where they output reasoning first
        if (chunk.message?.content) {
          onChunk({
            response: chunk.message.content,
            done: chunk.done
          });
        } else if (chunk.done) {
          // Send done signal even if content is empty
          onChunk({
            response: '',
            done: true
          });
        }
      } : null;

      const chatResult = await this._request('/api/chat', 'POST', chatBody, chatOnChunk);
      console.log('Ollama chat result:', JSON.stringify(chatResult).substring(0, 500));

      if (chatResult.message?.content) {
        return chatResult.message.content;
      }
      // Handle thinking models (qwen3, etc.) where response is in thinking field
      if (chatResult.message?.thinking) {
        const thinking = chatResult.message.thinking;
        // Look for lines that look like ADS queries (contain field operators)
        const adsQueryPattern = /\b(author:|year:|title:|abs:|bibstem:|property:|doi:|arXiv:)/i;
        const lines = thinking.split('\n').filter(l => l.trim());

        // Find lines that look like actual ADS queries
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          // Skip lines that are clearly reasoning/explanation
          if (line.startsWith('-') || line.startsWith('*') || line.includes('we') ||
              line.includes('We') || line.includes('note:') || line.includes('Note:')) {
            continue;
          }
          // Check if it looks like an ADS query
          if (adsQueryPattern.test(line)) {
            // Clean up: remove trailing punctuation, quotes around the whole thing
            let query = line.replace(/^["'`]|["'`]$/g, '').trim();
            // Remove markdown code formatting if present
            query = query.replace(/^`+|`+$/g, '').trim();
            return query;
          }
        }
        // Fallback: return last non-empty line
        if (lines.length > 0) {
          return lines[lines.length - 1].trim();
        }
      }
      // For streaming, message may be empty in final response
      if (onChunk && chatResult.done) {
        return '';
      }
    } catch (chatErr) {
      console.log('Chat API failed, falling back to generate API:', chatErr.message);
    }

    // Fallback to generate API for older models
    const body = {
      model: this.model,
      prompt,
      stream: !!onChunk,
      options: {
        temperature,
        num_predict: maxTokens
      }
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const result = await this._request('/api/generate', 'POST', body, onChunk);
    console.log('Ollama generate result:', JSON.stringify(result).substring(0, 500));

    if (result.response) {
      return result.response;
    }
    // Handle thinking models where response is empty but thinking has content
    if (result.thinking) {
      const thinking = result.thinking;
      const adsQueryPattern = /\b(author:|year:|title:|abs:|bibstem:|property:|doi:|arXiv:)/i;
      const lines = thinking.split('\n').filter(l => l.trim());

      // Find lines that look like actual ADS queries
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('-') || line.startsWith('*') || line.includes('we') ||
            line.includes('We') || line.includes('note:') || line.includes('Note:')) {
          continue;
        }
        if (adsQueryPattern.test(line)) {
          let query = line.replace(/^["'`]|["'`]$/g, '').trim();
          query = query.replace(/^`+|`+$/g, '').trim();
          return query;
        }
      }
      if (lines.length > 0) {
        return lines[lines.length - 1].trim();
      }
    }
    return '';
  }

  // Generate embedding vector
  async embed(text) {
    const body = {
      model: this.embeddingModel,
      prompt: text
    };

    const result = await this._request('/api/embeddings', 'POST', body);
    return result.embedding || [];
  }

  // Update configuration
  updateConfig(config) {
    if (config.endpoint) this.endpoint = config.endpoint;
    if (config.model) this.model = config.model;
    if (config.embeddingModel) this.embeddingModel = config.embeddingModel;
  }
}

// Prompt templates for different tasks
const PROMPTS = {
  summarize: {
    system: `You are a scientific paper summarization assistant. Your task is to provide clear, accurate summaries of research papers. Focus on:
- The main research question or hypothesis
- Key methods used
- Primary findings and results
- Significance and implications

Be concise but comprehensive. Use technical language appropriate for researchers.`,

    user: (title, abstract, fullText) => {
      let prompt = `Summarize this scientific paper:\n\nTitle: ${title}\n\n`;
      if (abstract) {
        prompt += `Abstract: ${abstract}\n\n`;
      }
      if (fullText) {
        // Use first ~6000 chars of full text for context
        const truncated = fullText.substring(0, 6000);
        prompt += `Paper content:\n${truncated}\n\n`;
      }
      prompt += `Provide:
1. A concise summary paragraph (3-4 sentences)
2. 3-5 key points as bullet points

Format your response as:
SUMMARY:
[Your summary paragraph]

KEY POINTS:
- [Point 1]
- [Point 2]
- [Point 3]`;
      return prompt;
    }
  },

  explain: {
    system: `You are a helpful scientific assistant. Explain complex concepts in clear, accessible language while maintaining accuracy. Adjust your explanation to be understandable by someone with a general science background but not necessarily expertise in this specific field.`,

    user: (text, context = null) => {
      let prompt = `Explain the following text in simpler terms:\n\n"${text}"`;
      if (context) {
        prompt += `\n\nContext from the paper: ${context.substring(0, 1000)}`;
      }
      return prompt;
    }
  },

  qa: {
    system: `You are a research assistant helping to answer questions about scientific papers. Base your answers strictly on the provided paper content. If the answer cannot be determined from the given text, say so clearly. Cite specific parts of the paper when relevant.`,

    user: (question, paperContent, title) => {
      return `Paper: "${title}"

Content:
${paperContent.substring(0, 8000)}

Question: ${question}

Answer based on the paper content above:`;
    }
  },

  compare: {
    system: `You are a research assistant helping to compare scientific papers. Identify similarities, differences, and complementary aspects between the papers. Focus on methodology, findings, and conclusions.`,

    user: (papers) => {
      let prompt = 'Compare the following papers:\n\n';
      papers.forEach((paper, i) => {
        prompt += `Paper ${i + 1}: ${paper.title}\n`;
        if (paper.abstract) {
          prompt += `Abstract: ${paper.abstract}\n`;
        }
        prompt += '\n';
      });
      prompt += 'Provide a comparison covering:\n1. Research objectives\n2. Methods used\n3. Key findings\n4. How they relate to each other';
      return prompt;
    }
  },

  autoTag: {
    system: `You are a scientific paper categorization assistant. Suggest relevant keywords and categories for research papers based on their content. Use standard scientific terminology and established field-specific tags.`,

    user: (title, abstract) => {
      return `Based on this paper, suggest 5-8 relevant keywords/tags:

Title: ${title}
Abstract: ${abstract}

Return only the tags, one per line, no numbering or bullets.`;
    }
  },

  extractMetadata: {
    system: `You are a metadata extraction assistant for scientific papers. Your task is to extract bibliographic information from the beginning of a paper's text content. Be precise and only extract information that is clearly present.`,

    user: (textContent) => {
      // Use first ~3000 chars which should contain title, authors, abstract
      const truncated = textContent.substring(0, 3000);
      return `Extract metadata from this scientific paper text:

${truncated}

Extract and return ONLY the following in this exact format (leave blank if not found):
TITLE: [exact paper title]
AUTHORS: [comma-separated list of authors, e.g., "Smith, John; Johnson, Mary"]
YEAR: [publication year, 4 digits]
JOURNAL: [journal or conference name]
DOI: [DOI if present, e.g., 10.1234/example]
ARXIV: [arXiv ID if present, e.g., 2301.12345]

Be precise. Extract the actual values, do not guess or fabricate.`;
    }
  }
};

// Text chunking utilities
function chunkText(text, maxChars = 4000, overlap = 200) {
  if (!text || text.length <= maxChars) {
    return [{ text, startIdx: 0, endIdx: text?.length || 0 }];
  }

  const chunks = [];
  let startIdx = 0;

  while (startIdx < text.length) {
    let endIdx = startIdx + maxChars;

    // Try to break at sentence boundary
    if (endIdx < text.length) {
      const lastPeriod = text.lastIndexOf('.', endIdx);
      const lastNewline = text.lastIndexOf('\n', endIdx);
      const breakPoint = Math.max(lastPeriod, lastNewline);

      if (breakPoint > startIdx + maxChars / 2) {
        endIdx = breakPoint + 1;
      }
    }

    chunks.push({
      text: text.substring(startIdx, endIdx),
      startIdx,
      endIdx: Math.min(endIdx, text.length)
    });

    startIdx = endIdx - overlap;
  }

  return chunks;
}

// Cosine similarity for embedding comparison
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

// Parse summary response into structured format
function parseSummaryResponse(response) {
  const result = {
    summary: '',
    keyPoints: []
  };

  const summaryMatch = response.match(/SUMMARY:\s*([\s\S]*?)(?=KEY POINTS:|$)/i);
  if (summaryMatch) {
    result.summary = summaryMatch[1].trim();
  }

  const keyPointsMatch = response.match(/KEY POINTS:\s*([\s\S]*?)$/i);
  if (keyPointsMatch) {
    const points = keyPointsMatch[1]
      .split('\n')
      .map(line => line.replace(/^[-•*]\s*/, '').trim())
      .filter(line => line.length > 0);
    result.keyPoints = points;
  }

  // Fallback if parsing fails
  if (!result.summary && !result.keyPoints.length) {
    result.summary = response.trim();
  }

  return result;
}

// Parse metadata extraction response into structured object
function parseMetadataResponse(response) {
  const result = {
    title: null,
    authors: null,
    firstAuthor: null,
    year: null,
    journal: null,
    doi: null,
    arxiv_id: null
  };

  const lines = response.split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim().toUpperCase();
    const value = line.substring(colonIdx + 1).trim();

    // Skip empty values, but clean up bracketed/parenthesized values
    if (!value) continue;
    let cleanValue = value
      .replace(/^\[+|\]+$/g, '')   // Remove surrounding brackets
      .replace(/^\(+|\)+$/g, '')   // Remove surrounding parentheses
      .replace(/^["']+|["']+$/g, '') // Remove surrounding quotes
      .trim();
    if (!cleanValue) continue;

    switch (key) {
      case 'TITLE':
        result.title = cleanValue;
        break;
      case 'AUTHORS':
        result.authors = cleanValue;
        // Extract first author (before first semicolon or comma)
        const firstAuth = cleanValue.split(/[;,]/)[0].trim();
        if (firstAuth) {
          // Get last name (first word if "Last, First" format, or last word otherwise)
          const parts = firstAuth.split(/\s+/);
          // Take the first substantial word as last name
          result.firstAuthor = parts[0].replace(/[,;.]$/g, '');
        }
        break;
      case 'YEAR':
        const yearMatch = cleanValue.match(/\d{4}/);
        if (yearMatch) result.year = yearMatch[0];
        break;
      case 'JOURNAL':
        result.journal = cleanValue;
        break;
      case 'DOI':
        // Clean up DOI - extract just the DOI pattern
        const doiMatch = cleanValue.match(/10\.\d{4,}[^\s]*/);
        if (doiMatch) result.doi = doiMatch[0];
        break;
      case 'ARXIV':
        // Clean up arXiv ID
        const arxivMatch = cleanValue.match(/\d{4}\.\d{4,5}(v\d+)?/);
        if (arxivMatch) result.arxiv_id = arxivMatch[0];
        break;
    }
  }

  return result;
}

module.exports = {
  OllamaService,
  PROMPTS,
  chunkText,
  cosineSimilarity,
  parseSummaryResponse,
  parseMetadataResponse
};
