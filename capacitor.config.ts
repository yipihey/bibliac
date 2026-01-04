import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.bibliac.app',
  appName: 'Bibliac',
  webDir: 'dist',

  ios: {
    // iOS 16+ required
    minVersion: '16.0',
    scrollEnabled: true,
    // Enable iCloud
    preferredContentMode: 'mobile',
    // Allow mixed content (HTTP/HTTPS)
    allowsLinkPreview: true,
  },

  plugins: {
    SplashScreen: {
      launchAutoHide: false, // We'll hide manually when app is ready
      launchShowDuration: 0,
      backgroundColor: '#1a1a2e',
      showSpinner: false,
      androidSplashResourceName: 'splash',
      splashFullScreen: true,
      splashImmersive: true,
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
    // Enable native HTTP to bypass CORS on iOS
    CapacitorHttp: {
      enabled: true,
    },
  },

  // Server configuration
  server: {
    // Allow navigation to these hosts
    allowNavigation: [
      'api.adsabs.harvard.edu',
      '*.adsabs.harvard.edu',
      'arxiv.org',
      '*.arxiv.org',
    ],
  },
};

export default config;
