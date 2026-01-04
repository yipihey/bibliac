/**
 * Bibliac - Capacitor Plugin Wrappers
 * Provides unified interface for native iOS capabilities
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

// ═══════════════════════════════════════════════════════════════════════════
// FILE SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

export const FileSystem = {
  /**
   * Read text file from Documents directory
   */
  async readFile(path) {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Documents,
      encoding: Encoding.UTF8
    });
    return result.data;
  },

  /**
   * Write text file to Documents directory
   */
  async writeFile(path, data) {
    await Filesystem.writeFile({
      path,
      data,
      directory: Directory.Documents,
      encoding: Encoding.UTF8
    });
  },

  /**
   * Read binary file as base64
   */
  async readBinaryFile(path) {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Documents
    });
    return result.data; // Base64 encoded
  },

  /**
   * Write binary file from base64
   */
  async writeBinaryFile(path, base64Data) {
    await Filesystem.writeFile({
      path,
      data: base64Data, // Base64 encoded
      directory: Directory.Documents
    });
  },

  /**
   * Delete a file
   */
  async deleteFile(path) {
    await Filesystem.deleteFile({
      path,
      directory: Directory.Documents
    });
  },

  /**
   * Check if file exists
   */
  async exists(path) {
    try {
      await Filesystem.stat({
        path,
        directory: Directory.Documents
      });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Create directory recursively
   */
  async mkdir(path) {
    await Filesystem.mkdir({
      path,
      directory: Directory.Documents,
      recursive: true
    });
  },

  /**
   * Read directory contents
   */
  async readdir(path) {
    const result = await Filesystem.readdir({
      path,
      directory: Directory.Documents
    });
    return result.files;
  },

  /**
   * Get native URI for a file
   */
  async getUri(path) {
    const result = await Filesystem.getUri({
      path,
      directory: Directory.Documents
    });
    return result.uri;
  },

  /**
   * Copy file
   */
  async copy(from, to) {
    await Filesystem.copy({
      from,
      to,
      directory: Directory.Documents,
      toDirectory: Directory.Documents
    });
  },

  /**
   * Get file info
   */
  async stat(path) {
    return await Filesystem.stat({
      path,
      directory: Directory.Documents
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PREFERENCES (replaces electron-store)
// ═══════════════════════════════════════════════════════════════════════════

export const Storage = {
  /**
   * Get a value from storage
   */
  async get(key) {
    const result = await Preferences.get({ key });
    try {
      return result.value ? JSON.parse(result.value) : null;
    } catch {
      return result.value;
    }
  },

  /**
   * Set a value in storage
   */
  async set(key, value) {
    await Preferences.set({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value)
    });
  },

  /**
   * Remove a value from storage
   */
  async remove(key) {
    await Preferences.remove({ key });
  },

  /**
   * Clear all storage
   */
  async clear() {
    await Preferences.clear();
  },

  /**
   * Get all keys
   */
  async keys() {
    const result = await Preferences.keys();
    return result.keys;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// SHARING
// ═══════════════════════════════════════════════════════════════════════════

export const Sharing = {
  /**
   * Share text content
   */
  async shareText(text, title = '') {
    await Share.share({
      title,
      text,
      dialogTitle: title
    });
  },

  /**
   * Share a URL
   */
  async shareUrl(url, title = '') {
    await Share.share({
      title,
      url,
      dialogTitle: title
    });
  },

  /**
   * Share a file
   */
  async shareFile(path, title = '') {
    const uri = await FileSystem.getUri(path);
    await Share.share({
      title,
      url: uri,
      dialogTitle: title
    });
  },

  /**
   * Check if sharing is available
   */
  async canShare() {
    try {
      const result = await Share.canShare();
      return result.value;
    } catch {
      return false;
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// HAPTICS
// ═══════════════════════════════════════════════════════════════════════════

export const HapticFeedback = {
  /**
   * Light impact feedback
   */
  async light() {
    await Haptics.impact({ style: ImpactStyle.Light });
  },

  /**
   * Medium impact feedback
   */
  async medium() {
    await Haptics.impact({ style: ImpactStyle.Medium });
  },

  /**
   * Heavy impact feedback
   */
  async heavy() {
    await Haptics.impact({ style: ImpactStyle.Heavy });
  },

  /**
   * Success notification
   */
  async success() {
    await Haptics.notification({ type: NotificationType.Success });
  },

  /**
   * Warning notification
   */
  async warning() {
    await Haptics.notification({ type: NotificationType.Warning });
  },

  /**
   * Error notification
   */
  async error() {
    await Haptics.notification({ type: NotificationType.Error });
  },

  /**
   * Selection changed feedback
   */
  async selectionChanged() {
    await Haptics.selectionChanged();
  },

  /**
   * Start selection feedback
   */
  async selectionStart() {
    await Haptics.selectionStart();
  },

  /**
   * End selection feedback
   */
  async selectionEnd() {
    await Haptics.selectionEnd();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// STATUS BAR
// ═══════════════════════════════════════════════════════════════════════════

export const AppStatusBar = {
  /**
   * Set status bar style to dark (light content)
   */
  async setDark() {
    await StatusBar.setStyle({ style: Style.Dark });
  },

  /**
   * Set status bar style to light (dark content)
   */
  async setLight() {
    await StatusBar.setStyle({ style: Style.Light });
  },

  /**
   * Hide status bar
   */
  async hide() {
    await StatusBar.hide();
  },

  /**
   * Show status bar
   */
  async show() {
    await StatusBar.show();
  },

  /**
   * Set background color (iOS)
   */
  async setBackgroundColor(color) {
    await StatusBar.setBackgroundColor({ color });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// SPLASH SCREEN
// ═══════════════════════════════════════════════════════════════════════════

export const AppSplashScreen = {
  /**
   * Show splash screen
   */
  async show() {
    await SplashScreen.show({
      autoHide: false
    });
  },

  /**
   * Hide splash screen
   */
  async hide() {
    await SplashScreen.hide();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// SECURE STORAGE (iOS Keychain)
// ═══════════════════════════════════════════════════════════════════════════

export const Keychain = {
  /**
   * Store a secret in the iOS Keychain
   */
  async setItem(key, value) {
    await SecureStorage.set(key, value);
  },

  /**
   * Retrieve a secret from the iOS Keychain
   */
  async getItem(key) {
    const result = await SecureStorage.get(key);
    return result;
  },

  /**
   * Remove a secret from the iOS Keychain
   */
  async removeItem(key) {
    await SecureStorage.remove(key);
  },

  /**
   * Check if a key exists in the Keychain
   */
  async hasItem(key) {
    try {
      const result = await SecureStorage.get(key);
      return result !== null;
    } catch {
      return false;
    }
  },

  /**
   * Get all keys stored in the Keychain for this app
   */
  async getAllKeys() {
    const result = await SecureStorage.keys();
    return result || [];
  },

  /**
   * Clear all secrets from the Keychain for this app
   */
  async clear() {
    await SecureStorage.clear();
  }
};
