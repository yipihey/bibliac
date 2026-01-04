/**
 * Platform detection for Bibliac
 * Detects whether running in Electron (desktop) or Capacitor (iOS)
 */

/**
 * Check if running in Capacitor native environment
 */
export function isMobile() {
  return typeof window !== 'undefined' &&
         window.Capacitor?.isNativePlatform?.() === true;
}

/**
 * Check if running on iOS
 */
export function isIOS() {
  return typeof window !== 'undefined' &&
         window.Capacitor?.getPlatform?.() === 'ios';
}

/**
 * Check if running in Electron
 */
export function isElectron() {
  return typeof window !== 'undefined' &&
         typeof window.electronAPI !== 'undefined';
}

/**
 * Check if running in web browser (not native)
 */
export function isWeb() {
  return !isElectron() && !isMobile();
}

/**
 * Get current platform name
 */
export function getPlatform() {
  if (isElectron()) return 'electron';
  if (isIOS()) return 'ios';
  if (isMobile()) return 'mobile';
  return 'web';
}

/**
 * Initialize platform-specific behavior
 * Call this early in app initialization
 */
export function initPlatform() {
  if (typeof document === 'undefined') return;

  const platform = getPlatform();
  document.body.dataset.platform = platform;

  if (isMobile()) {
    document.body.classList.add('mobile');

    if (isIOS()) {
      document.body.classList.add('ios');
    }

    // Prevent overscroll bounce on iOS
    document.body.style.overscrollBehavior = 'none';

    // Disable text selection on mobile (except in inputs)
    document.body.style.webkitUserSelect = 'none';
    document.body.style.userSelect = 'none';
  }

  if (isElectron()) {
    document.body.classList.add('electron');
  }

  console.log(`Bibliac running on: ${platform}`);
}

/**
 * Check if a feature is available on current platform
 */
export function hasFeature(feature) {
  const features = {
    // Available on all platforms
    'ads-api': true,
    'bibtex': true,
    'pdf-viewer': true,
    'collections': true,
    'annotations': true,
    'cloud-llm': true,  // Anthropic, Perplexity, Gemini

    // Desktop only (Electron)
    'local-llm': isElectron(),  // Ollama
    'ocr': isElectron(),
    'pdf-text-extraction': isElectron(),
    'file-picker': true,  // Available on both but different APIs

    // Mobile only
    'haptics': isMobile(),
    'ios-keychain': isIOS(),
    'share-sheet': isMobile(),
  };

  return features[feature] ?? false;
}
