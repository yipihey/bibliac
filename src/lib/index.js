/**
 * ADS Reader Core Library
 *
 * This is the main entry point for the shared core library.
 * It exports all public APIs that can be used by:
 * - Electron desktop app
 * - iOS Capacitor app
 * - Future apps embedding this as a plugin
 *
 * Usage:
 *   import { ADSApi, BibtexParser, LibraryManager } from '@ads-reader/core';
 *   // or
 *   import * as AdsReaderCore from './src/lib';
 */

// Re-export all modules
export * from './ads-api/index.js';
export * from './bibtex/index.js';
export * from './database/index.js';
export * from './pdf/index.js';
export * from './utils/index.js';
export * from './adapters/index.js';
export * from './types.js';

// Version info
export const VERSION = '0.1.0';
