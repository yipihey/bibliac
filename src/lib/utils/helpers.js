/**
 * Bibliac Core - Helper Utilities
 *
 * Common utility functions used across the library.
 */

/**
 * Format byte size to human-readable string
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size (e.g., "1.5 KB", "2.3 MB")
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format authors array for display
 * @param {string[]} authors - Array of author names
 * @param {boolean} [forList=false] - If true, truncate for list display
 * @param {number} [maxAuthors=3] - Maximum authors to show before truncating
 * @returns {string} Formatted author string
 */
export function formatAuthors(authors, forList = false, maxAuthors = 3) {
  if (!authors || authors.length === 0) return 'Unknown Author';

  if (forList && authors.length > maxAuthors) {
    return `${authors.slice(0, maxAuthors).join(', ')} et al.`;
  }

  return authors.join(', ');
}

/**
 * Parse a safe JSON string, returning null on error
 * @param {string|null} str - JSON string to parse
 * @returns {any|null} Parsed value or null
 */
export function safeJsonParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

/**
 * Debounce a function
 * @param {function} func - Function to debounce
 * @param {number} wait - Wait time in ms
 * @returns {function}
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Throttle a function
 * @param {function} func - Function to throttle
 * @param {number} limit - Time limit in ms
 * @returns {function}
 */
export function throttle(func, limit) {
  let inThrottle;
  return function executedFunction(...args) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

/**
 * Generate a UUID v4
 * @returns {string}
 */
export function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Deep clone an object
 * @param {any} obj - Object to clone
 * @returns {any}
 */
export function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => deepClone(item));
  const cloned = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }
  return cloned;
}
