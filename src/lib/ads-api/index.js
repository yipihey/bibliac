/**
 * Bibliac Core - ADS API Module
 *
 * Platform-agnostic NASA ADS API integration.
 * Uses a platform adapter for HTTP requests.
 */

export { ADSApi, createADSApi } from './ads-api.js';
export { adsToPaper, extractArxivId, normalizeBibcode } from './transforms.js';
