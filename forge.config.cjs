const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    name: 'ADS Reader',
    executableName: 'ADS Reader',
    appBundleId: 'io.adsreader.app',
    icon: './assets/icon',  // Electron finds .icns/.ico automatically
    // Exclude unnecessary files from the bundle
    ignore: [
      // iOS/Capacitor (not needed for desktop)
      /^\/ios/,
      /^\/android/,
      /capacitor\.config/,

      // Website/docs
      /^\/docs/,

      // Build artifacts
      /^\/dist/,
      /^\/out/,

      // Dev files
      /^\/\.github/,
      /^\/\.conductor/,
      /\.md$/,
      /\.map$/,
      /tsconfig/,
      /\.eslintrc/,
      /vite\.config/,
      /vitest\.config/,

      // Test files
      /\.test\./,
      /\.spec\./,
      /__tests__/,

      // Dev dependencies in node_modules
      /node_modules\/typescript/,
      /node_modules\/vitest/,
      /node_modules\/eslint/,
      /node_modules\/prettier/,
      /node_modules\/@capacitor/,
      /node_modules\/@vitest/,
      /node_modules\/vite($|\/)/,
      /node_modules\/@esbuild/,
      /node_modules\/electron-winstaller/,
    ],
    // macOS code signing configuration
    // Uses environment variables for flexibility between dev and CI environments
    osxSign: {
      identity: 'Developer ID Application: THOMAS G ABEL (QG3MEYVHMS)'
    },
    // macOS notarization - disabled during make, done manually after
    // osxNotarize: {
    //   keychainProfile: 'ADS-Reader-Notarize'
    // },
    // Extra resources to include
    extraResource: [
      './entitlements.mac.plist',
      './native'  // Swift share helper for native macOS sharing
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'ADS_Reader',
        setupIcon: './assets/icon.ico'
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin']
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'ADS Reader',
        icon: './assets/icon.icns',
        format: 'ULFO'
      }
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          name: 'adsreader',
          productName: 'ADS Reader',
          icon: './assets/icon.png'
        }
      }
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          name: 'adsreader',
          productName: 'ADS Reader',
          icon: './assets/icon.png'
        }
      }
    }
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {}
    }
    // Fuses disabled temporarily for signing compatibility
    // new FusesPlugin({
    //   version: FuseVersion.V1,
    //   [FuseV1Options.RunAsNode]: false,
    //   [FuseV1Options.EnableCookieEncryption]: true,
    //   [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    //   [FuseV1Options.EnableNodeCliInspectArguments]: false,
    //   [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    //   [FuseV1Options.OnlyLoadAppFromAsar]: true
    // })
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'yipihey',
          name: 'adsreader'
        },
        prerelease: false,
        draft: true  // Create as draft first, then manually publish
      }
    }
  ]
};
