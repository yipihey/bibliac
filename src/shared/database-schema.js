/**
 * ADS Reader - Database Schema
 * Shared schema definition for both desktop and mobile platforms
 *
 * NOTE: This file re-exports from the core library for backwards compatibility.
 * New code should import directly from '../lib/database/index.js'
 */

// Re-export everything from the core library
export {
  SCHEMA_SQL,
  INDEXES_SQL,
  MIGRATIONS,
  applySchema,
  PAPER_COLUMNS,
  DEFAULT_SORT
} from '../lib/database/schema.js';
