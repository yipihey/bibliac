/**
 * Bibliac - Platform Initialization
 *
 * This script runs early to set up platform-specific styling and API.
 *
 * On Electron: window.electronAPI is provided by preload.js
 * On Capacitor/iOS: API is created by api-adapter.js and attached to window.electronAPI
 */

// Detect platform
const isCapacitor = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform?.();
const isElectron = typeof window.electronAPI !== 'undefined';

// Add platform class to body for CSS styling
if (isCapacitor) {
  document.body.classList.add('ios', 'mobile');
  console.log('[Platform] Running on iOS/Capacitor');
} else if (isElectron) {
  document.body.classList.add('electron', 'desktop');
  console.log('[Platform] Running on Electron');
} else {
  document.body.classList.add('web');
  console.log('[Platform] Running in web browser');
}

// On iOS/Capacitor, we need to initialize the API before the app runs
// This is done asynchronously, so we expose a promise that app.js can await
window._platformReady = (async () => {
  if (isCapacitor && !window.electronAPI) {
    console.log('[Platform] Initializing Capacitor API...');
    try {
      const { createCapacitorAPI } = await import('../capacitor/api-adapter.js');
      window.electronAPI = await createCapacitorAPI();
      console.log('[Platform] Capacitor API attached to window.electronAPI');
    } catch (error) {
      console.error('[Platform] Failed to initialize Capacitor API:', error);
      throw error;
    }
  }
  return true;
})();
