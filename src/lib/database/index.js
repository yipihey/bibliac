/**
 * Bibliac Core - Database Module
 *
 * Platform-agnostic database operations using sql.js.
 */

export { DatabaseManager, createDatabaseManager } from './database-manager.js';
export { SCHEMA_SQL, INDEXES_SQL, MIGRATIONS, applySchema, PAPER_COLUMNS, DEFAULT_SORT } from './schema.js';
