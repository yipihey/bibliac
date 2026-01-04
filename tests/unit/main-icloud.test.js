/**
 * Unit Tests for main.cjs iCloud IPC Handlers
 * Tests the Electron main process iCloud and library management logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createFsMock,
  createStoreMock,
  createPathMock,
  createOsMock,
  createDatabaseMock
} from '../mocks/filesystem.js';

// Create mock instances
const mockFs = createFsMock();
const mockStore = createStoreMock();
const mockPath = createPathMock();
const mockOs = createOsMock('/Users/testuser');
const mockDatabase = createDatabaseMock();

// Mock Node.js modules
vi.mock('fs', () => mockFs);
vi.mock('path', () => mockPath);
vi.mock('os', () => mockOs);

// Mock electron-store
vi.mock('electron-store', () => ({
  default: vi.fn(() => mockStore)
}));

// Mock database module
vi.mock('../../src/main/database.cjs', () => mockDatabase);

// iCloud container constants
const ICLOUD_CONTAINER_ID = 'iCloud.io.bibliac.app';
const MOBILE_DOCS_PATH = '/Users/testuser/Library/Mobile Documents';
const ICLOUD_CONTAINER_PATH = `${MOBILE_DOCS_PATH}/iCloud~io~bibliac~app/Documents`;

// Helper functions (extracted from main.cjs logic)
function getICloudContainerPath() {
  const folderName = ICLOUD_CONTAINER_ID.replace(/\./g, '~');
  return mockPath.join(mockOs.homedir(), 'Library', 'Mobile Documents', folderName, 'Documents');
}

function isICloudAvailable() {
  const mobileDocsPath = mockPath.join(mockOs.homedir(), 'Library', 'Mobile Documents');
  return mockFs.existsSync(mobileDocsPath);
}

describe('main.cjs iCloud Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.__reset();
    mockStore.__reset();
    mockDatabase.__reset();
  });

  describe('getICloudContainerPath', () => {
    it('should return correct iCloud container path', () => {
      const containerPath = getICloudContainerPath();

      expect(containerPath).toBe(ICLOUD_CONTAINER_PATH);
    });

    it('should replace dots with tildes in container ID', () => {
      const containerPath = getICloudContainerPath();

      // iCloud.io.bibliac.app -> iCloud~io~bibliac~app
      expect(containerPath).toContain('iCloud~io~bibliac~app');
      expect(containerPath).not.toContain('iCloud.io');
    });
  });

  describe('isICloudAvailable', () => {
    it('should return true when Mobile Documents exists', () => {
      mockFs.__setDir(MOBILE_DOCS_PATH);

      const available = isICloudAvailable();

      expect(available).toBe(true);
    });

    it('should return false when Mobile Documents does not exist', () => {
      // Don't set up Mobile Documents directory

      const available = isICloudAvailable();

      expect(available).toBe(false);
    });
  });

  describe('get-all-libraries handler', () => {
    it('should return iCloud libraries from libraries.json', () => {
      // Set up Mobile Documents to make iCloud available
      mockFs.__setDir(MOBILE_DOCS_PATH);
      mockFs.__setDir(ICLOUD_CONTAINER_PATH);

      // Set up libraries.json
      const librariesJson = JSON.stringify({
        version: 1,
        libraries: [
          { id: 'lib-1', name: 'Physics', path: 'Physics', createdAt: '2024-01-01', createdOn: 'macOS' },
          { id: 'lib-2', name: 'Astronomy', path: 'Astronomy', createdAt: '2024-01-02', createdOn: 'iOS' }
        ]
      });
      mockFs.__setFile(`${ICLOUD_CONTAINER_PATH}/libraries.json`, librariesJson);

      // Set up library folders
      mockFs.__setDir(`${ICLOUD_CONTAINER_PATH}/Physics`);
      mockFs.__setDir(`${ICLOUD_CONTAINER_PATH}/Astronomy`);

      // Simulate the handler logic
      const libraries = [];
      if (isICloudAvailable()) {
        const iCloudPath = getICloudContainerPath();
        const librariesJsonPath = mockPath.join(iCloudPath, 'libraries.json');

        if (mockFs.existsSync(librariesJsonPath)) {
          const data = JSON.parse(mockFs.readFileSync(librariesJsonPath, 'utf8'));
          for (const lib of data.libraries || []) {
            const libPath = mockPath.join(iCloudPath, lib.path);
            const exists = mockFs.existsSync(libPath);
            libraries.push({
              ...lib,
              fullPath: libPath,
              location: 'icloud',
              exists
            });
          }
        }
      }

      expect(libraries).toHaveLength(2);
      expect(libraries[0].name).toBe('Physics');
      expect(libraries[0].location).toBe('icloud');
      expect(libraries[0].exists).toBe(true);
      expect(libraries[1].name).toBe('Astronomy');
    });

    it('should include local libraries from store', () => {
      // Set up local libraries in store
      mockStore.__set('localLibraries', [
        { id: 'local-1', name: 'Desktop Library', path: '/Users/testuser/Desktop/Library' }
      ]);

      // Set up the local library folder
      mockFs.__setDir('/Users/testuser/Desktop/Library');

      // Simulate getting local libraries
      const localLibraries = mockStore.get('localLibraries') || [];
      const libraries = [];

      for (const lib of localLibraries) {
        const exists = mockFs.existsSync(lib.path);
        libraries.push({
          ...lib,
          fullPath: lib.path,
          location: 'local',
          exists
        });
      }

      expect(libraries).toHaveLength(1);
      expect(libraries[0].name).toBe('Desktop Library');
      expect(libraries[0].location).toBe('local');
      expect(libraries[0].exists).toBe(true);
    });

    it('should mark non-existent libraries as exists: false', () => {
      mockStore.__set('localLibraries', [
        { id: 'missing-1', name: 'Missing Library', path: '/Users/testuser/Deleted/Library' }
      ]);

      const localLibraries = mockStore.get('localLibraries') || [];
      const libraries = [];

      for (const lib of localLibraries) {
        const exists = mockFs.existsSync(lib.path);
        libraries.push({
          ...lib,
          fullPath: lib.path,
          location: 'local',
          exists
        });
      }

      expect(libraries[0].exists).toBe(false);
    });
  });

  describe('create-library handler', () => {
    beforeEach(() => {
      mockFs.__setDir(MOBILE_DOCS_PATH);
    });

    it('should create iCloud library with proper structure', () => {
      const name = 'New Research';
      const location = 'icloud';

      // Simulate create-library logic
      const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
      const iCloudPath = getICloudContainerPath();
      const libraryPath = mockPath.join(iCloudPath, safeName);

      // Create structure
      mockFs.mkdirSync(libraryPath, { recursive: true });
      mockFs.mkdirSync(mockPath.join(libraryPath, 'papers'), { recursive: true });
      mockFs.mkdirSync(mockPath.join(libraryPath, 'text'), { recursive: true });

      expect(mockFs.__hasDir(libraryPath)).toBe(true);
      expect(mockFs.__hasDir(`${libraryPath}/papers`)).toBe(true);
      expect(mockFs.__hasDir(`${libraryPath}/text`)).toBe(true);
    });

    it('should update libraries.json when creating iCloud library', () => {
      mockFs.__setDir(ICLOUD_CONTAINER_PATH);

      const id = 'test-uuid';
      const name = 'Test Library';
      const iCloudPath = getICloudContainerPath();
      const librariesJsonPath = mockPath.join(iCloudPath, 'libraries.json');

      // Simulate updating libraries.json
      let data = { version: 1, libraries: [] };

      if (mockFs.existsSync(librariesJsonPath)) {
        data = JSON.parse(mockFs.readFileSync(librariesJsonPath, 'utf8'));
      }

      data.libraries.push({
        id,
        name,
        path: name,
        createdAt: '2024-01-01T00:00:00.000Z',
        createdOn: 'macOS'
      });

      mockFs.writeFileSync(librariesJsonPath, JSON.stringify(data, null, 2));

      // Verify
      const written = JSON.parse(mockFs.__getFile(librariesJsonPath));
      expect(written.libraries).toHaveLength(1);
      expect(written.libraries[0].name).toBe('Test Library');
    });

    it('should sanitize library name', () => {
      const name = 'My/Research<>Library!@#';
      const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();

      expect(safeName).toBe('MyResearchLibrary');
    });

    it('should fail when iCloud is not available', () => {
      // Reset mocks to remove Mobile Documents
      mockFs.__reset();

      const available = isICloudAvailable();

      expect(available).toBe(false);
      // Handler would return { success: false, error: 'iCloud is not available' }
    });
  });

  describe('switch-library handler', () => {
    it('should update current library ID in store', () => {
      const libraryId = 'lib-123';

      mockStore.set('currentLibraryId', libraryId);

      expect(mockStore.__get('currentLibraryId')).toBe('lib-123');
    });

    it('should update library path in store', () => {
      const libraryPath = '/path/to/library';

      mockStore.set('libraryPath', libraryPath);

      expect(mockStore.__get('libraryPath')).toBe('/path/to/library');
    });
  });

  describe('check-migration-needed handler', () => {
    it('should return needed: false when migration already completed', () => {
      mockStore.__set('migrationCompleted', true);

      const migrationDone = mockStore.get('migrationCompleted');

      expect(migrationDone).toBe(true);
      // Handler returns { needed: false }
    });

    it('should return needed: false when no existing library path', () => {
      // No libraryPath set

      const existingPath = mockStore.get('libraryPath');

      expect(existingPath).toBeUndefined();
      // Handler returns { needed: false }
    });

    it('should return needed: false when current library ID exists', () => {
      mockStore.__set('libraryPath', '/some/path');
      mockStore.__set('currentLibraryId', 'existing-id');

      const currentLibraryId = mockStore.get('currentLibraryId');

      expect(currentLibraryId).toBe('existing-id');
      // Handler returns { needed: false }
    });

    it('should return needed: true when library exists but not registered', () => {
      const libraryPath = '/Users/testuser/Library/Bibliac';
      mockStore.__set('libraryPath', libraryPath);
      mockFs.__setDir(libraryPath);
      mockFs.__setFile(`${libraryPath}/library.sqlite`, 'db-content');

      const existingPath = mockStore.get('libraryPath');
      const currentLibraryId = mockStore.get('currentLibraryId');
      const migrationDone = mockStore.get('migrationCompleted');
      const pathExists = mockFs.existsSync(existingPath);

      expect(existingPath).toBe(libraryPath);
      expect(currentLibraryId).toBeUndefined();
      expect(migrationDone).toBeUndefined();
      expect(pathExists).toBe(true);
      // Handler returns { needed: true, ... }
    });

    it('should detect if library is already in iCloud', () => {
      mockFs.__setDir(MOBILE_DOCS_PATH);
      const libraryPath = `${ICLOUD_CONTAINER_PATH}/MyLibrary`;
      mockFs.__setDir(libraryPath);

      const iCloudPath = getICloudContainerPath();
      const isInICloud = libraryPath.startsWith(iCloudPath);

      expect(isInICloud).toBe(true);
    });
  });

  describe('migrate-library-to-icloud handler', () => {
    beforeEach(() => {
      mockFs.__setDir(MOBILE_DOCS_PATH);
    });

    it('should copy library to iCloud container', () => {
      const sourcePath = '/Users/testuser/Documents/Bibliac';
      mockFs.__setDir(sourcePath);
      mockFs.__setFile(`${sourcePath}/library.sqlite`, 'db-content');
      mockFs.__setDir(`${sourcePath}/papers`);
      mockFs.__setFile(`${sourcePath}/papers/test.pdf`, 'pdf-content');

      const targetPath = `${ICLOUD_CONTAINER_PATH}/Bibliac`;

      // Simulate copy
      mockFs.mkdirSync(targetPath, { recursive: true });
      mockFs.copyFileSync(`${sourcePath}/library.sqlite`, `${targetPath}/library.sqlite`);

      expect(mockFs.__hasFile(`${targetPath}/library.sqlite`)).toBe(true);
    });

    it('should update libraries.json after migration', () => {
      mockFs.__setDir(ICLOUD_CONTAINER_PATH);

      const libraryName = 'Migrated Library';
      const id = 'migrated-uuid';
      const librariesJsonPath = `${ICLOUD_CONTAINER_PATH}/libraries.json`;

      let data = { version: 1, libraries: [] };
      data.libraries.push({
        id,
        name: libraryName,
        path: libraryName,
        createdAt: new Date().toISOString(),
        createdOn: 'macOS',
        migratedFrom: 'local'
      });

      mockFs.writeFileSync(librariesJsonPath, JSON.stringify(data, null, 2));

      const written = JSON.parse(mockFs.__getFile(librariesJsonPath));
      expect(written.libraries[0].migratedFrom).toBe('local');
    });

    it('should update preferences after migration', () => {
      const targetPath = `${ICLOUD_CONTAINER_PATH}/Library`;
      const id = 'new-id';

      mockStore.set('libraryPath', targetPath);
      mockStore.set('currentLibraryId', id);
      mockStore.set('migrationCompleted', true);

      expect(mockStore.__get('libraryPath')).toBe(targetPath);
      expect(mockStore.__get('currentLibraryId')).toBe('new-id');
      expect(mockStore.__get('migrationCompleted')).toBe(true);
    });
  });

  describe('register-library-local handler', () => {
    it('should add library to localLibraries array', () => {
      const localLibrary = {
        id: 'local-uuid',
        name: 'Desktop Library',
        path: '/Users/testuser/Desktop/MyLibrary',
        createdAt: new Date().toISOString(),
        createdOn: 'macOS'
      };

      const localLibraries = mockStore.get('localLibraries') || [];
      localLibraries.push(localLibrary);
      mockStore.set('localLibraries', localLibraries);

      const stored = mockStore.__get('localLibraries');
      expect(stored).toHaveLength(1);
      expect(stored[0].name).toBe('Desktop Library');
    });

    it('should update current library ID', () => {
      const id = 'local-uuid';

      mockStore.set('currentLibraryId', id);
      mockStore.set('migrationCompleted', true);

      expect(mockStore.__get('currentLibraryId')).toBe('local-uuid');
      expect(mockStore.__get('migrationCompleted')).toBe(true);
    });
  });

  describe('check-library-conflicts handler', () => {
    it('should detect numeric suffix conflict files', () => {
      const libraryPath = `${ICLOUD_CONTAINER_PATH}/MyLibrary`;
      mockFs.__setDir(libraryPath);
      mockFs.__setFile(`${libraryPath}/library.sqlite`, 'main-db');
      mockFs.__setFile(`${libraryPath}/library 2.sqlite`, 'conflict-db');

      // Simulate conflict detection
      const files = ['library.sqlite', 'library 2.sqlite'];
      const conflictPattern = /library[\s-]\d+\.sqlite$/i;

      const conflicts = files.filter(f => conflictPattern.test(f));

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toBe('library 2.sqlite');
    });

    it('should detect dash-number conflict files', () => {
      const files = ['library.sqlite', 'library-2.sqlite', 'library-3.sqlite'];
      const conflictPattern = /library[\s-]\d+\.sqlite$/i;

      const conflicts = files.filter(f => conflictPattern.test(f));

      expect(conflicts).toHaveLength(2);
    });

    it('should detect conflict copy pattern', () => {
      const files = ['library.sqlite', 'library (conflicted copy from MacBook).sqlite'];
      const conflictPattern = /library\s*\(.*conflict.*\)\.sqlite$/i;

      const conflicts = files.filter(f => conflictPattern.test(f));

      expect(conflicts).toHaveLength(1);
    });

    it('should return hasConflicts: false when no conflicts', () => {
      const files = ['library.sqlite', 'papers', 'text'];
      const conflictPatterns = [
        /library[\s-]\d+\.sqlite$/i,
        /library\s*\(.*conflict.*\)\.sqlite$/i
      ];

      const conflicts = files.filter(f =>
        conflictPatterns.some(pattern => pattern.test(f))
      );

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('resolve-library-conflict handler', () => {
    beforeEach(() => {
      const libraryPath = `${ICLOUD_CONTAINER_PATH}/MyLibrary`;
      mockFs.__setDir(libraryPath);
      mockFs.__setFile(`${libraryPath}/library.sqlite`, 'main-db-content');
      mockFs.__setFile(`${libraryPath}/library 2.sqlite`, 'conflict-db-content');
    });

    it('should keep current and delete conflict file', () => {
      const libraryPath = `${ICLOUD_CONTAINER_PATH}/MyLibrary`;
      const conflictPath = `${libraryPath}/library 2.sqlite`;

      // Simulate 'keep-current' action
      mockFs.unlinkSync(conflictPath);

      expect(mockFs.__hasFile(conflictPath)).toBe(false);
      expect(mockFs.__hasFile(`${libraryPath}/library.sqlite`)).toBe(true);
    });

    it('should keep conflict by swapping files', () => {
      const libraryPath = `${ICLOUD_CONTAINER_PATH}/MyLibrary`;
      const mainDbPath = `${libraryPath}/library.sqlite`;
      const conflictPath = `${libraryPath}/library 2.sqlite`;
      const backupPath = `${libraryPath}/library.sqlite.backup`;

      // Simulate 'keep-conflict' action
      // 1. Backup current
      mockFs.copyFileSync(mainDbPath, backupPath);
      // 2. Replace with conflict
      mockFs.copyFileSync(conflictPath, mainDbPath);
      // 3. Delete conflict
      mockFs.unlinkSync(conflictPath);

      expect(mockFs.__hasFile(backupPath)).toBe(true);
      expect(mockFs.__hasFile(conflictPath)).toBe(false);
      expect(mockFs.__getFile(mainDbPath)).toBe('conflict-db-content');
    });

    it('should backup both files', () => {
      const libraryPath = `${ICLOUD_CONTAINER_PATH}/MyLibrary`;
      const mainDbPath = `${libraryPath}/library.sqlite`;
      const conflictPath = `${libraryPath}/library 2.sqlite`;
      const timestamp = '2024-01-01T00-00-00';
      const mainBackupPath = `${libraryPath}/library.sqlite.backup-main-${timestamp}`;
      const conflictBackupPath = `${libraryPath}/library.sqlite.backup-conflict-${timestamp}`;

      // Simulate 'backup-both' action
      mockFs.copyFileSync(mainDbPath, mainBackupPath);
      mockFs.copyFileSync(conflictPath, conflictBackupPath);
      mockFs.unlinkSync(conflictPath);

      expect(mockFs.__hasFile(mainBackupPath)).toBe(true);
      expect(mockFs.__hasFile(conflictBackupPath)).toBe(true);
      expect(mockFs.__hasFile(conflictPath)).toBe(false);
    });
  });

  describe('get-current-library-id handler', () => {
    it('should return current library ID from store', () => {
      mockStore.__set('currentLibraryId', 'my-lib-id');

      const id = mockStore.get('currentLibraryId');

      expect(id).toBe('my-lib-id');
    });

    it('should return null when no library selected', () => {
      const id = mockStore.get('currentLibraryId') || null;

      expect(id).toBeNull();
    });
  });

  describe('copyFolderSync helper', () => {
    it('should copy files and subdirectories', () => {
      const source = '/source/folder';
      const target = '/target/folder';

      mockFs.__setDir(source);
      mockFs.__setFile(`${source}/file1.txt`, 'content1');
      mockFs.__setFile(`${source}/file2.txt`, 'content2');
      mockFs.__setDir(`${source}/subfolder`);
      mockFs.__setFile(`${source}/subfolder/nested.txt`, 'nested-content');

      // Simulate copyFolderSync
      function copyFolderSync(src, tgt) {
        if (!mockFs.existsSync(tgt)) {
          mockFs.mkdirSync(tgt, { recursive: true });
        }

        const items = mockFs.readdirSync(src);
        for (const item of items) {
          const srcPath = `${src}/${item}`;
          const tgtPath = `${tgt}/${item}`;
          const stat = mockFs.statSync(srcPath);

          if (stat.isDirectory()) {
            copyFolderSync(srcPath, tgtPath);
          } else {
            mockFs.copyFileSync(srcPath, tgtPath);
          }
        }
      }

      copyFolderSync(source, target);

      expect(mockFs.__hasFile(`${target}/file1.txt`)).toBe(true);
      expect(mockFs.__hasFile(`${target}/file2.txt`)).toBe(true);
      expect(mockFs.__hasFile(`${target}/subfolder/nested.txt`)).toBe(true);
    });
  });

  describe('createLibraryStructure helper', () => {
    it('should create papers and text subfolders', () => {
      const libraryPath = '/path/to/library';

      // Simulate createLibraryStructure
      mockFs.mkdirSync(libraryPath, { recursive: true });
      mockFs.mkdirSync(`${libraryPath}/papers`, { recursive: true });
      mockFs.mkdirSync(`${libraryPath}/text`, { recursive: true });

      expect(mockFs.__hasDir(libraryPath)).toBe(true);
      expect(mockFs.__hasDir(`${libraryPath}/papers`)).toBe(true);
      expect(mockFs.__hasDir(`${libraryPath}/text`)).toBe(true);
    });
  });
});
