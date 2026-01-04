/**
 * Bibliac - Cloud LLM Service
 * Supports Anthropic (Claude), Google Gemini, and Perplexity
 * Works on both Electron (desktop) and Capacitor (iOS)
 */

// Provider configurations
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-sonnet-20241022',
    models: [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
    ],
  },
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
    ],
  },
  perplexity: {
    name: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    defaultModel: 'llama-3.1-sonar-small-128k-online',
    models: [
      { id: 'llama-3.1-sonar-small-128k-online', name: 'Sonar Small (Online)' },
      { id: 'llama-3.1-sonar-large-128k-online', name: 'Sonar Large (Online)' },
      { id: 'llama-3.1-sonar-huge-128k-online', name: 'Sonar Huge (Online)' },
    ],
  },
};

class CloudLLMService {
  constructor(config = {}) {
    this.provider = config.provider || 'anthropic';
    this.apiKey = config.apiKey || '';
    this.model = config.model || PROVIDERS[this.provider]?.defaultModel || '';
  }

  /**
   * Update configuration
   */
  setConfig(config) {
    if (config.provider) this.provider = config.provider;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.model) this.model = config.model;
  }

  /**
   * Get available providers
   */
  static getProviders() {
    return Object.entries(PROVIDERS).map(([id, config]) => ({
      id,
      name: config.name,
      models: config.models,
      defaultModel: config.defaultModel,
    }));
  }

  /**
   * Get models for a provider
   */
  static getModels(providerId) {
    return PROVIDERS[providerId]?.models || [];
  }

  /**
   * Check if service is configured
   */
  isConfigured() {
    return !!(this.provider && this.apiKey && this.model);
  }

  /**
   * Test connection to the API
   */
  async testConnection() {
    if (!this.isConfigured()) {
      return { success: false, error: 'Not configured' };
    }

    try {
      // Send a minimal test request
      const response = await this.generate('Say "OK" if you can hear me.', {
        maxTokens: 10,
      });
      return { success: true, response };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate text response
   */
  async generate(prompt, options = {}) {
    const {
      systemPrompt = null,
      onChunk = null,
      temperature = 0.7,
      maxTokens = 2048,
    } = options;

    if (!this.isConfigured()) {
      throw new Error('Cloud LLM not configured. Please set provider, API key, and model.');
    }

    switch (this.provider) {
      case 'anthropic':
        return this._generateAnthropic(prompt, systemPrompt, { onChunk, temperature, maxTokens });
      case 'gemini':
        return this._generateGemini(prompt, systemPrompt, { onChunk, temperature, maxTokens });
      case 'perplexity':
        return this._generatePerplexity(prompt, systemPrompt, { onChunk, temperature, maxTokens });
      default:
        throw new Error(`Unknown provider: ${this.provider}`);
    }
  }

  /**
   * Generate with Anthropic Claude API
   */
  async _generateAnthropic(prompt, systemPrompt, options) {
    const { onChunk, temperature, maxTokens } = options;

    const body = {
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (onChunk) {
      // Streaming mode
      body.stream = true;
      return this._streamAnthropic(body, onChunk);
    }

    const response = await fetch(`${PROVIDERS.anthropic.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.content[0]?.text || '';
  }

  /**
   * Stream response from Anthropic
   */
  async _streamAnthropic(body, onChunk) {
    const response = await fetch(`${PROVIDERS.anthropic.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              fullText += parsed.delta.text;
              onChunk({ text: parsed.delta.text, fullText, done: false });
            }
            if (parsed.type === 'message_stop') {
              onChunk({ text: '', fullText, done: true });
            }
          } catch (e) {
            // Ignore parse errors for partial chunks
          }
        }
      }
    }

    // Send final done signal if not already sent
    onChunk({ text: '', fullText, done: true });
    return fullText;
  }

  /**
   * Generate with Google Gemini API
   */
  async _generateGemini(prompt, systemPrompt, options) {
    const { onChunk, temperature, maxTokens } = options;

    const contents = [];

    if (systemPrompt) {
      contents.push({
        role: 'user',
        parts: [{ text: `System: ${systemPrompt}\n\nUser: ${prompt}` }],
      });
    } else {
      contents.push({
        role: 'user',
        parts: [{ text: prompt }],
      });
    }

    const body = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };

    const endpoint = onChunk ? 'streamGenerateContent' : 'generateContent';
    const url = `${PROVIDERS.gemini.baseUrl}/models/${this.model}:${endpoint}?key=${this.apiKey}`;

    if (onChunk) {
      return this._streamGemini(url, body, onChunk);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  /**
   * Stream response from Gemini
   */
  async _streamGemini(url, body, onChunk) {
    const response = await fetch(`${url}&alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (text) {
              fullText += text;
              onChunk({ text, fullText, done: false });
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }

    // Send final done signal
    onChunk({ text: '', fullText, done: true });
    return fullText;
  }

  /**
   * Generate with Perplexity API
   */
  async _generatePerplexity(prompt, systemPrompt, options) {
    const { onChunk, temperature, maxTokens } = options;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: !!onChunk,
    };

    if (onChunk) {
      return this._streamPerplexity(body, onChunk);
    }

    const response = await fetch(`${PROVIDERS.perplexity.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Perplexity API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Stream response from Perplexity
   */
  async _streamPerplexity(body, onChunk) {
    const response = await fetch(`${PROVIDERS.perplexity.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Perplexity API error: ${response.status} - ${error}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            onChunk({ text: '', fullText, done: true });
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const text = parsed.choices?.[0]?.delta?.content || '';
            if (text) {
              fullText += text;
              onChunk({ text, fullText, done: false });
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }

    // Send final done signal if not already sent
    onChunk({ text: '', fullText, done: true });
    return fullText;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Paper-specific methods (matching OllamaService interface)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a summary of a paper
   */
  async summarizePaper(paperText, options = {}) {
    const systemPrompt = `You are a scientific paper summarization assistant. Your task is to provide clear, accurate summaries of academic papers. Focus on:
1. The main research question or hypothesis
2. Key methods used
3. Major findings and results
4. Conclusions and implications

Be concise but comprehensive. Use technical language appropriate for the field.`;

    const prompt = `Please summarize the following scientific paper:\n\n${paperText}`;

    return this.generate(prompt, {
      systemPrompt,
      ...options,
    });
  }

  /**
   * Answer a question about a paper
   */
  async askAboutPaper(paperText, question, options = {}) {
    const systemPrompt = `You are a scientific research assistant. Answer questions about the provided paper accurately and concisely. Base your answers only on the content of the paper. If the paper doesn't contain information to answer the question, say so.`;

    const prompt = `Paper content:\n${paperText}\n\nQuestion: ${question}`;

    return this.generate(prompt, {
      systemPrompt,
      ...options,
    });
  }

  /**
   * Extract metadata from paper text
   */
  async extractMetadata(paperText) {
    const systemPrompt = `You are a metadata extraction assistant. Extract bibliographic information from the paper text and return it as JSON.`;

    const prompt = `Extract the following metadata from this paper text and return as JSON:
- title
- authors (array of names)
- abstract
- year
- journal (if available)
- doi (if available)
- arxiv_id (if available)

Paper text (first 5000 characters):
${paperText.substring(0, 5000)}

Return only valid JSON, no markdown formatting.`;

    const response = await this.generate(prompt, {
      systemPrompt,
      temperature: 0.1,
      maxTokens: 1024,
    });

    try {
      // Try to parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('Failed to parse metadata JSON:', e);
    }

    return null;
  }
}

// CommonJS exports for Electron main process
module.exports = { CloudLLMService, PROVIDERS };
