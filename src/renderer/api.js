/**
 * Bibliac - Unified Platform API
 *
 * This module provides a single API interface that works on both:
 * - Electron (desktop): delegates to window.electronAPI
 * - Capacitor (iOS): delegates to the Capacitor adapter
 *
 * Usage:
 *   import { getAPI } from './api.js';
 *   const api = await getAPI();
 *   const papers = await api.getAllPapers();
 */

let apiInstance = null;
let initPromise = null;

// Platform detection
function isCapacitor() {
  return typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform?.() === true;
}

function isElectron() {
  return typeof window.electronAPI !== 'undefined';
}

/**
 * Get the platform-appropriate API instance.
 * This is async because on iOS we need to dynamically import and initialize the adapter.
 *
 * @returns {Promise<object>} The API instance
 */
export async function getAPI() {
  // Return cached instance if available
  if (apiInstance) {
    return apiInstance;
  }

  // Prevent multiple concurrent initializations
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    // Electron - use the preload-provided API directly
    if (isElectron()) {
      console.log('[API] Using Electron API');
      apiInstance = window.electronAPI;
      return apiInstance;
    }

    // Capacitor/iOS - use the Capacitor adapter
    if (isCapacitor()) {
      console.log('[API] Initializing Capacitor API');
      const { createCapacitorAPI } = await import('../capacitor/api-adapter.js');
      apiInstance = await createCapacitorAPI();
      console.log('[API] Capacitor API initialized');
      return apiInstance;
    }

    // Unknown platform
    console.error('[API] No platform API available');
    throw new Error('No platform API available. Running in unsupported environment.');
  })();

  return initPromise;
}

/**
 * Get the current platform name
 * @returns {'electron' | 'ios' | 'unknown'}
 */
export function getPlatform() {
  if (isElectron()) return 'electron';
  if (isCapacitor()) return 'ios';
  return 'unknown';
}

/**
 * Check if running on mobile (iOS)
 * @returns {boolean}
 */
export function isMobile() {
  return isCapacitor();
}

/**
 * Check if running on desktop (Electron)
 * @returns {boolean}
 */
export function isDesktop() {
  return isElectron();
}
