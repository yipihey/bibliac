/**
 * Unit Tests for api-adapter.js
 * Tests the Capacitor API adapter for iOS, focusing on iCloud-related functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Capacitor Filesystem
const mockFilesystemStorage = new Map();

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: {
    readFile: vi.fn(async ({ path, directory }) => {
      const key = `${directory}:${path}`;
      if (!mockFilesystemStorage.has(key)) {
        throw new Error(`File does not exist: ${path}`);
      }
      return { data: mockFilesystemStorage.get(key) };
    }),
    writeFile: vi.fn(async ({ path, directory, data }) => {
      const key = `${directory}:${path}`;
      mockFilesystemStorage.set(key, data);
      return { uri: `file://${path}` };
    }),
    mkdir: vi.fn(async () => ({})),
    readdir: vi.fn(async ({ path, directory }) => {
      const prefix = `${directory}:${path}`;
      const files = [];
      for (const [key, value] of mockFilesystemStorage) {
        if (key.startsWith(prefix) && key !== prefix) {
          const relativePath = key.slice(prefix.length + 1);
          const parts = relativePath.split('/');
          if (parts.length === 1) {
            files.push({
              name: parts[0],
              type: value === '__DIR__' ? 'directory' : 'file'
            });
          }
        }
      }
      return { files };
    }),
    stat: vi.fn(async ({ path, directory }) => {
      const key = `${directory}:${path}`;
      if (!mockFilesystemStorage.has(key)) {
        throw new Error(`File does not exist: ${path}`);
      }
      return { type: 'file', size: 1024 };
    }),
    deleteFile: vi.fn(async () => ({})),
    rmdir: vi.fn(async () => ({})),
    rename: vi.fn(async () => ({})),
    downloadFile: vi.fn(async ({ path }) => ({ path })),
    getUri: vi.fn(async ({ path }) => ({ uri: `file://${path}` })),
    copy: vi.fn(async () => ({}))
  },
  Directory: {
    Documents: 'DOCUMENTS',
    ICloud: 'ICLOUD',
    Cache: 'CACHE'
  },
  Encoding: {
    UTF8: 'utf8'
  }
}));

// Mock Capacitor Preferences
const mockPreferencesStorage = new Map();

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }) => {
      return { value: mockPreferencesStorage.get(key) ?? null };
    }),
    set: vi.fn(async ({ key, value }) => {
      mockPreferencesStorage.set(key, value);
    }),
    remove: vi.fn(async ({ key }) => {
      mockPreferencesStorage.delete(key);
    })
  }
}));

// Mock Haptics
vi.mock('@capacitor/haptics', () => ({
  Haptics: {
    impact: vi.fn(async () => {})
  },
  ImpactStyle: {
    Light: 'LIGHT'
  }
}));

// Mock SecureStorage
const mockKeychainStorage = new Map();

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    get: vi.fn(async (key) => mockKeychainStorage.get(key) ?? null),
    set: vi.fn(async (key, value) => {
      mockKeychainStorage.set(key, value);
    })
  }
}));

// Mock CapacitorHttp
vi.mock('@capacitor/core', () => ({
  CapacitorHttp: {
    get: vi.fn(async () => ({
      status: 200,
      data: {}
    })),
    post: vi.fn(async () => ({
      status: 200,
      data: {}
    }))
  }
}));

// Mock mobile-database
vi.mock('../../src/capacitor/mobile-database.js', () => ({
  initDatabase: vi.fn(async () => true),
  initDatabaseFromICloud: vi.fn(async () => true),
  saveDatabase: vi.fn(async () => {}),
  closeDatabase: vi.fn(),
  isInitialized: vi.fn(() => true),
  getStats: vi.fn(() => ({ total: 5, unread: 3, reading: 1, read: 1 })),
  getPaper: vi.fn((id) => ({
    id,
    bibcode: '2024Test.....1A',
    title: 'Test Paper'
  })),
  getPaperByBibcode: vi.fn(() => null),
  getAllPapers: vi.fn(() => []),
  addPaper: vi.fn(() => 1),
  updatePaper: vi.fn(() => true),
  deletePaper: vi.fn(() => true),
  getCollections: vi.fn(() => []),
  createCollection: vi.fn(() => 1),
  addPaperToCollection: vi.fn(),
  removePaperFromCollection: vi.fn()
}));

// Mock crypto.randomUUID using vi.stubGlobal
vi.stubGlobal('crypto', {
  randomUUID: () => 'test-uuid-1234-5678-9abc-def012345678'
});

// Import after mocks are set up
let apiAdapter;
let capacitorAPI;

describe('api-adapter.js', () => {
  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();
    mockFilesystemStorage.clear();
    mockPreferencesStorage.clear();
    mockKeychainStorage.clear();

    // Reset module to clear state
    vi.resetModules();
    apiAdapter = await import('../../src/capacitor/api-adapter.js');

    // Get the API object
    capacitorAPI = await apiAdapter.createCapacitorAPI();
  });

  describe('isICloudAvailable', () => {
    it('should return true when iCloud is accessible', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      Filesystem.readdir.mockResolvedValueOnce({ files: [] });

      const result = await capacitorAPI.isICloudAvailable();

      expect(result).toBe(true);
      expect(Filesystem.readdir).toHaveBeenCalledWith({
        path: '',
        directory: 'ICLOUD'
      });
    });

    it('should return false when iCloud is not accessible', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      Filesystem.readdir.mockRejectedValueOnce(new Error('iCloud not available'));

      const result = await capacitorAPI.isICloudAvailable();

      expect(result).toBe(false);
    });
  });

  describe('getICloudContainerPath', () => {
    it('should return iCloud identifier', async () => {
      const result = await capacitorAPI.getICloudContainerPath();

      expect(result).toBe('iCloud');
    });
  });

  describe('getAllLibraries', () => {
    it('should return empty array when iCloud is not available', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      Filesystem.readdir.mockRejectedValueOnce(new Error('iCloud not available'));

      const libraries = await capacitorAPI.getAllLibraries();

      expect(libraries).toEqual([]);
    });

    it('should return libraries from libraries.json', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      // Mock iCloud available
      Filesystem.readdir.mockResolvedValueOnce({ files: [] });

      // Set up libraries.json in mock storage
      const librariesData = JSON.stringify({
        version: 1,
        libraries: [
          { id: 'lib-1', name: 'Physics', path: 'Physics', createdAt: '2024-01-01', createdOn: 'iOS' },
          { id: 'lib-2', name: 'Astronomy', path: 'Astronomy', createdAt: '2024-01-02', createdOn: 'macOS' }
        ]
      });
      mockFilesystemStorage.set('ICLOUD:libraries.json', librariesData);

      const libraries = await capacitorAPI.getAllLibraries();

      expect(libraries).toHaveLength(2);
      expect(libraries[0].name).toBe('Physics');
      expect(libraries[0].location).toBe('icloud');
      expect(libraries[1].name).toBe('Astronomy');
    });

    it('should return empty array when no libraries.json exists', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      Filesystem.readdir.mockResolvedValueOnce({ files: [] });
      // No libraries.json in mockFilesystemStorage

      const libraries = await capacitorAPI.getAllLibraries();

      expect(libraries).toEqual([]);
    });
  });

  describe('createLibrary', () => {
    it('should create library in iCloud', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      // Mock iCloud available
      Filesystem.readdir.mockResolvedValue({ files: [] });

      const result = await capacitorAPI.createLibrary({ name: 'My Research' });

      expect(result.success).toBe(true);
      expect(result.id).toBe('test-uuid-1234-5678-9abc-def012345678');
      expect(result.path).toBe('My Research');

      // Should have created directories
      expect(Filesystem.mkdir).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'My Research',
          directory: 'ICLOUD'
        })
      );

      // Should have updated libraries.json
      expect(Filesystem.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'libraries.json',
          directory: 'ICLOUD'
        })
      );
    });

    it('should sanitize library name', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      Filesystem.readdir.mockResolvedValue({ files: [] });

      const result = await capacitorAPI.createLibrary({ name: 'My/Research<>Library' });

      expect(result.success).toBe(true);
      // Should have stripped invalid characters
      expect(result.path).toBe('MyResearchLibrary');
    });

    it('should fail when iCloud is not available', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      Filesystem.readdir.mockRejectedValue(new Error('iCloud not available'));

      const result = await capacitorAPI.createLibrary({ name: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('iCloud');
    });

    it('should add to existing libraries.json', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      Filesystem.readdir.mockResolvedValue({ files: [] });

      // Set up existing libraries.json
      const existingData = JSON.stringify({
        version: 1,
        libraries: [
          { id: 'existing-lib', name: 'Existing', path: 'Existing' }
        ]
      });
      mockFilesystemStorage.set('ICLOUD:libraries.json', existingData);

      await capacitorAPI.createLibrary({ name: 'New Library' });

      // Check the written data
      const writtenData = mockFilesystemStorage.get('ICLOUD:libraries.json');
      const parsed = JSON.parse(writtenData);

      expect(parsed.libraries).toHaveLength(2);
      expect(parsed.libraries[0].name).toBe('Existing');
      expect(parsed.libraries[1].name).toBe('New Library');
    });
  });

  describe('switchLibrary', () => {
    it('should switch to specified library', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      const { Preferences } = await import('@capacitor/preferences');
      const MobileDB = await import('../../src/capacitor/mobile-database.js');

      // Setup libraries.json
      Filesystem.readdir.mockResolvedValue({ files: [] });
      const librariesData = JSON.stringify({
        version: 1,
        libraries: [
          { id: 'target-lib', name: 'Target', path: 'Target' }
        ]
      });
      mockFilesystemStorage.set('ICLOUD:libraries.json', librariesData);

      const result = await capacitorAPI.switchLibrary('target-lib');

      expect(result.success).toBe(true);
      expect(MobileDB.closeDatabase).toHaveBeenCalled();
      expect(MobileDB.initDatabase).toHaveBeenCalledWith('Target');
      expect(Preferences.set).toHaveBeenCalledWith({ key: 'currentLibraryId', value: 'target-lib' });
    });

    it('should fail when library not found', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      Filesystem.readdir.mockResolvedValue({ files: [] });
      // Empty libraries.json
      mockFilesystemStorage.set('ICLOUD:libraries.json', JSON.stringify({ version: 1, libraries: [] }));

      const result = await capacitorAPI.switchLibrary('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('getCurrentLibraryId', () => {
    it('should return current library ID from preferences', async () => {
      mockPreferencesStorage.set('currentLibraryId', 'my-lib-id');

      const result = await capacitorAPI.getCurrentLibraryId();

      expect(result).toBe('my-lib-id');
    });

    it('should return null when no library selected', async () => {
      const result = await capacitorAPI.getCurrentLibraryId();

      expect(result).toBeNull();
    });
  });

  describe('checkMigrationNeeded', () => {
    it('should return needed:false when migration already completed', async () => {
      mockPreferencesStorage.set('migrationCompleted', 'true');

      const result = await capacitorAPI.checkMigrationNeeded();

      expect(result.needed).toBe(false);
    });

    it('should return needed:false when current library ID exists', async () => {
      mockPreferencesStorage.set('currentLibraryId', 'some-id');

      const result = await capacitorAPI.checkMigrationNeeded();

      expect(result.needed).toBe(false);
    });

    it('should return needed:true when local library exists', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');

      // Mock local library directory exists with database
      Filesystem.readdir.mockImplementation(async ({ path, directory }) => {
        if (directory === 'DOCUMENTS' && path === 'Bibliac') {
          return {
            files: [
              { name: 'library.sqlite', type: 'file' },
              { name: 'papers', type: 'directory' }
            ]
          };
        }
        if (directory === 'ICLOUD') {
          return { files: [] };
        }
        throw new Error('Not found');
      });

      const result = await capacitorAPI.checkMigrationNeeded();

      expect(result.needed).toBe(true);
      expect(result.existingPath).toBe('Bibliac');
      expect(result.iCloudAvailable).toBe(true);
    });

    it('should return needed:false when no local library exists', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');

      // Mock no local library
      Filesystem.readdir.mockRejectedValue(new Error('No such directory'));

      const result = await capacitorAPI.checkMigrationNeeded();

      expect(result.needed).toBe(false);
    });
  });

  describe('migrateLibraryToICloud', () => {
    it('should migrate local library to iCloud', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      const { Preferences } = await import('@capacitor/preferences');
      const MobileDB = await import('../../src/capacitor/mobile-database.js');

      // Mock iCloud available
      Filesystem.readdir.mockImplementation(async ({ directory }) => {
        if (directory === 'ICLOUD') {
          return { files: [] };
        }
        if (directory === 'DOCUMENTS') {
          return {
            files: [
              { name: 'library.sqlite', type: 'file' }
            ]
          };
        }
        return { files: [] };
      });

      // Mock file content
      mockFilesystemStorage.set('DOCUMENTS:Bibliac/library.sqlite', 'db-content');

      const result = await capacitorAPI.migrateLibraryToICloud({ libraryPath: 'Bibliac' });

      expect(result.success).toBe(true);
      expect(result.path).toBe('ADS Library');

      // Should have created iCloud directories
      expect(Filesystem.mkdir).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'ADS Library',
          directory: 'ICLOUD'
        })
      );

      // Should update preferences
      expect(Preferences.set).toHaveBeenCalledWith({ key: 'migrationCompleted', value: 'true' });

      // Should reinitialize database from iCloud
      expect(MobileDB.initDatabaseFromICloud).toHaveBeenCalledWith('ADS Library');
    });

    it('should fail when iCloud is not available', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      Filesystem.readdir.mockRejectedValue(new Error('iCloud not available'));

      const result = await capacitorAPI.migrateLibraryToICloud({ libraryPath: 'Bibliac' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('iCloud');
    });
  });

  describe('getAdsToken', () => {
    it('should return ADS token from keychain', async () => {
      mockKeychainStorage.set('adsToken', 'my-secret-token');

      const token = await capacitorAPI.getAdsToken();

      expect(token).toBe('my-secret-token');
    });

    it('should return null when no token stored', async () => {
      const token = await capacitorAPI.getAdsToken();

      expect(token).toBeNull();
    });
  });

  describe('setAdsToken', () => {
    it('should store ADS token in keychain', async () => {
      const result = await capacitorAPI.setAdsToken('new-token');

      expect(result.success).toBe(true);
      expect(mockKeychainStorage.get('adsToken')).toBe('new-token');
    });
  });

  describe('getPdfPriority', () => {
    it('should return stored PDF priority', async () => {
      mockPreferencesStorage.set('pdfPriority', '["PUB_PDF","EPRINT_PDF","ADS_PDF"]');

      const priority = await capacitorAPI.getPdfPriority();

      expect(priority).toEqual(['PUB_PDF', 'EPRINT_PDF', 'ADS_PDF']);
    });

    it('should return default priority when not set', async () => {
      const priority = await capacitorAPI.getPdfPriority();

      expect(priority).toEqual(['EPRINT_PDF', 'PUB_PDF', 'ADS_PDF']);
    });
  });

  describe('setPdfPriority', () => {
    it('should store PDF priority', async () => {
      const result = await capacitorAPI.setPdfPriority(['ADS_PDF', 'EPRINT_PDF']);

      expect(result.success).toBe(true);
      expect(mockPreferencesStorage.get('pdfPriority')).toBe('["ADS_PDF","EPRINT_PDF"]');
    });
  });

  describe('getCloudLlmConfig', () => {
    it('should return cloud LLM config with API key', async () => {
      mockPreferencesStorage.set('cloudLlmConfig', '{"provider":"anthropic","model":"claude-3-sonnet"}');
      mockKeychainStorage.set('cloudLlmApiKey', 'sk-ant-xxx');

      const config = await capacitorAPI.getCloudLlmConfig();

      expect(config.provider).toBe('anthropic');
      expect(config.model).toBe('claude-3-sonnet');
      expect(config.apiKey).toBe('sk-ant-xxx');
    });

    it('should return null when no config', async () => {
      const config = await capacitorAPI.getCloudLlmConfig();

      expect(config).toBeNull();
    });
  });

  describe('getAllPapers', () => {
    it('should return papers with proper sort mapping', async () => {
      const MobileDB = await import('../../src/capacitor/mobile-database.js');

      await capacitorAPI.getAllPapers({ sortBy: 'date_added', sortOrder: 'desc' });

      expect(MobileDB.getAllPapers).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: 'added_date',
          order: 'DESC'
        })
      );
    });
  });

  describe('deletePaper', () => {
    it('should delete paper and its PDF', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      const MobileDB = await import('../../src/capacitor/mobile-database.js');

      MobileDB.getPaper.mockReturnValueOnce({
        id: 1,
        pdf_path: 'papers/test.pdf'
      });

      const result = await capacitorAPI.deletePaper(1);

      expect(result.success).toBe(true);
      expect(Filesystem.deleteFile).toHaveBeenCalledWith({
        path: 'Bibliac/papers/test.pdf',
        directory: 'DOCUMENTS'
      });
      expect(MobileDB.deletePaper).toHaveBeenCalledWith(1);
    });
  });

  describe('getDownloadedPdfSources', () => {
    it('should return list of downloaded PDF sources', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      const MobileDB = await import('../../src/capacitor/mobile-database.js');

      MobileDB.getPaper.mockReturnValueOnce({
        id: 1,
        bibcode: '2024Test.....1A'
      });

      // Mock that EPRINT_PDF and ADS_PDF exist
      Filesystem.stat.mockImplementation(async ({ path }) => {
        if (path.includes('EPRINT_PDF') || path.includes('ADS_PDF')) {
          return { type: 'file' };
        }
        throw new Error('File not found');
      });

      const sources = await capacitorAPI.getDownloadedPdfSources(1);

      expect(sources).toContain('EPRINT_PDF');
      expect(sources).toContain('ADS_PDF');
      expect(sources).not.toContain('PUB_PDF');
    });
  });

  describe('deletePdf', () => {
    it('should delete specific PDF source', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      const MobileDB = await import('../../src/capacitor/mobile-database.js');

      MobileDB.getPaper.mockReturnValueOnce({
        id: 1,
        bibcode: '2024Test.....1A',
        pdf_source: 'EPRINT_PDF'
      });

      const result = await capacitorAPI.deletePdf(1, 'EPRINT_PDF');

      expect(result.success).toBe(true);
      expect(Filesystem.deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({
          path: expect.stringContaining('EPRINT_PDF.pdf')
        })
      );
    });

    it('should clear pdf_path if deleting primary source', async () => {
      const { Filesystem } = await import('@capacitor/filesystem');
      const MobileDB = await import('../../src/capacitor/mobile-database.js');

      MobileDB.getPaper.mockReturnValueOnce({
        id: 1,
        bibcode: '2024Test.....1A',
        pdf_source: 'EPRINT_PDF',
        pdf_path: 'papers/test.pdf'
      });

      await capacitorAPI.deletePdf(1, 'EPRINT_PDF');

      expect(MobileDB.updatePaper).toHaveBeenCalledWith(1, {
        pdf_path: null,
        pdf_source: null
      });
    });
  });

  describe('event emitter', () => {
    it('should emit consoleLog events', async () => {
      const callback = vi.fn();
      capacitorAPI.onConsoleLog(callback);

      // Trigger an action that emits consoleLog
      const { emit } = apiAdapter;
      emit('consoleLog', { message: 'Test message', level: 'info' });

      expect(callback).toHaveBeenCalledWith({ message: 'Test message', level: 'info' });
    });

    it('should remove listeners', async () => {
      const callback = vi.fn();
      capacitorAPI.onConsoleLog(callback);
      capacitorAPI.removeConsoleLogListeners();

      const { emit } = apiAdapter;
      emit('consoleLog', { message: 'Test', level: 'info' });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('platform', () => {
    it('should identify as iOS platform', () => {
      expect(capacitorAPI.platform).toBe('ios');
    });
  });

  describe('checkCloudStatus', () => {
    it('should return iCloud status', async () => {
      const result = await capacitorAPI.checkCloudStatus('/path');

      expect(result.isCloud).toBe(true);
      expect(result.service).toBe('iCloud');
    });
  });

  describe('adsImportSearch', () => {
    it('should search ADS API', async () => {
      const { CapacitorHttp } = await import('@capacitor/core');
      mockKeychainStorage.set('adsToken', 'test-token');

      CapacitorHttp.get.mockResolvedValueOnce({
        status: 200,
        data: {
          response: {
            numFound: 2,
            start: 0,
            docs: [
              { bibcode: '2024A', title: ['Paper A'], author: ['Author 1'] },
              { bibcode: '2024B', title: ['Paper B'], author: ['Author 2'] }
            ]
          }
        }
      });

      const result = await capacitorAPI.adsImportSearch('author:Einstein');

      expect(result.success).toBe(true);
      expect(result.data.papers).toHaveLength(2);
      expect(result.data.numFound).toBe(2);
    });

    it('should fail when no token configured', async () => {
      const result = await capacitorAPI.adsImportSearch('test query');

      expect(result.success).toBe(false);
      expect(result.error).toContain('token');
    });
  });

  describe('createCollection', () => {
    it('should create collection via MobileDB', async () => {
      const MobileDB = await import('../../src/capacitor/mobile-database.js');

      const result = await capacitorAPI.createCollection('New Collection');

      expect(result.success).toBe(true);
      expect(MobileDB.createCollection).toHaveBeenCalledWith('New Collection', null);
    });
  });

  describe('addPaperToCollection', () => {
    it('should add paper to collection', async () => {
      const MobileDB = await import('../../src/capacitor/mobile-database.js');

      const result = await capacitorAPI.addPaperToCollection(1, 5);

      expect(result.success).toBe(true);
      expect(MobileDB.addPaperToCollection).toHaveBeenCalledWith(1, 5);
    });
  });

  describe('PDF settings', () => {
    it('should get and set PDF zoom', async () => {
      await capacitorAPI.setPdfZoom(1.5);
      const zoom = await capacitorAPI.getPdfZoom();

      expect(zoom).toBe(1.5);
    });

    it('should return default zoom when not set', async () => {
      const zoom = await capacitorAPI.getPdfZoom();

      expect(zoom).toBe(1.0);
    });

    it('should get and set PDF positions', async () => {
      await capacitorAPI.setPdfPosition(1, { page: 5, scroll: 100 });
      const positions = await capacitorAPI.getPdfPositions();

      expect(positions[1]).toEqual({ page: 5, scroll: 100 });
    });
  });

  describe('last selected paper', () => {
    it('should get and set last selected paper', async () => {
      await capacitorAPI.setLastSelectedPaper(42);
      const paperId = await capacitorAPI.getLastSelectedPaper();

      expect(paperId).toBe(42);
    });

    it('should return null when no paper selected', async () => {
      const paperId = await capacitorAPI.getLastSelectedPaper();

      expect(paperId).toBeNull();
    });
  });

  describe('library proxy', () => {
    it('should get and set library proxy', async () => {
      await capacitorAPI.setLibraryProxy('https://proxy.university.edu');
      const proxy = await capacitorAPI.getLibraryProxy();

      expect(proxy).toBe('https://proxy.university.edu');
    });

    it('should return empty string when not set', async () => {
      const proxy = await capacitorAPI.getLibraryProxy();

      expect(proxy).toBe('');
    });
  });
});
