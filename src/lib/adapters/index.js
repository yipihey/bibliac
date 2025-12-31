/**
 * ADS Reader Core - Platform Adapters
 *
 * This module exports the platform adapter interface and factory functions.
 * Platform adapters abstract platform-specific operations like:
 * - File system access
 * - HTTP requests
 * - Secure storage (keychain)
 * - Database persistence
 */

export { PlatformAdapter } from './platform-adapter.js';
