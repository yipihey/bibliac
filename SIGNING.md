# Bibliac - Code Signing and Notarization Guide

This document explains how to set up code signing and notarization for distributing Bibliac outside the Mac App Store.

## Overview

For macOS apps distributed outside the App Store:
1. **Code Signing** - Signs the app with your Developer ID certificate
2. **Notarization** - Apple scans the app and issues a "ticket" for Gatekeeper approval
3. **Stapling** - Attaches the notarization ticket to the app for offline verification

## Prerequisites

### Apple Developer Program
You need an active Apple Developer Program membership ($99/year):
- Enroll at: https://developer.apple.com/programs/

### Developer ID Certificates
You need two certificates:
1. **Developer ID Application** - For signing the app
2. **Developer ID Installer** - For signing pkg installers (optional)

## Step 1: Create Certificates

### Option A: Using Xcode (Recommended)

1. Open Xcode > Preferences > Accounts
2. Sign in with your Apple ID
3. Select your team (QG3MEYVHMS)
4. Click "Manage Certificates..."
5. Click "+" and select "Developer ID Application"
6. Xcode will create and install the certificate in Keychain

### Option B: Using Developer Portal

1. Go to https://developer.apple.com/account/resources/certificates
2. Click "+" to create a new certificate
3. Select "Developer ID Application"
4. Follow the instructions to create a CSR using Keychain Access
5. Upload CSR and download the certificate
6. Double-click to install in Keychain

### Verify Certificate Installation

```bash
# List all Developer ID certificates
security find-identity -v -p codesigning | grep "Developer ID"

# You should see something like:
# 1) ABCD1234... "Developer ID Application: Your Name (QG3MEYVHMS)"
```

## Step 2: App-Specific Password

Notarization requires an app-specific password (not your Apple ID password):

1. Go to https://appleid.apple.com/account/manage
2. Sign in with your Apple ID
3. Under "Security", click "App-Specific Passwords"
4. Click "Generate an App-Specific Password"
5. Name it "Bibliac Notarization"
6. Save the generated password securely

## Step 3: Environment Variables

Set these environment variables before building:

```bash
# Required for code signing
export APPLE_IDENTITY="Developer ID Application: Your Name (QG3MEYVHMS)"

# Required for notarization
export APPLE_ID="your-apple-id@example.com"
export APPLE_ID_PASSWORD="xxxx-xxxx-xxxx-xxxx"  # App-specific password
export APPLE_TEAM_ID="QG3MEYVHMS"
```

### Persistent Setup

Add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
# Bibliac Code Signing
export APPLE_IDENTITY="Developer ID Application: Your Name (QG3MEYVHMS)"
export APPLE_ID="your-apple-id@example.com"
export APPLE_TEAM_ID="QG3MEYVHMS"

# Store password in Keychain instead of plaintext (more secure)
# Run once: security add-generic-password -a "your-apple-id@example.com" -w "xxxx-xxxx-xxxx-xxxx" -s "AC_PASSWORD"
export APPLE_ID_PASSWORD=$(security find-generic-password -s "AC_PASSWORD" -w 2>/dev/null)
```

## Step 4: Build Commands

### Development (Unsigned)
```bash
# Package without signing (for local testing)
npm run package:unsigned

# Build distributable without signing
npm run make:unsigned
```

### Production (Signed + Notarized)
```bash
# Ensure environment variables are set, then:
npm run make:signed

# Or simply:
npm run make
```

The build process will:
1. Package the app
2. Sign with Developer ID
3. Submit to Apple for notarization
4. Wait for notarization to complete
5. Staple the ticket to the app

## Step 5: Verify Signing

```bash
# Check code signature
codesign -dv --verbose=4 "out/Bibliac-darwin-arm64/Bibliac.app"

# Verify against Gatekeeper
spctl -a -vv "out/Bibliac-darwin-arm64/Bibliac.app"

# Check notarization stapling
stapler validate "out/Bibliac-darwin-arm64/Bibliac.app"
```

## Entitlements

The app uses `entitlements.mac.plist` which includes:

### Hardened Runtime (Required for Notarization)
- `com.apple.security.cs.allow-jit` - Required for V8 JavaScript engine
- `com.apple.security.cs.allow-unsigned-executable-memory` - Required for Electron
- `com.apple.security.cs.disable-library-validation` - Required for native modules

### iCloud Access
- `com.apple.developer.icloud-container-identifiers` - Access to iCloud container
- `com.apple.developer.icloud-services` - CloudDocuments service
- `com.apple.developer.ubiquity-container-identifiers` - Ubiquity container access

### Other Permissions
- `com.apple.security.network.client` - Outgoing network (ADS API)
- `com.apple.security.files.user-selected.read-write` - User-selected files
- `com.apple.security.files.downloads.read-write` - Downloads folder access

## iCloud Configuration

### Bundle ID and Container
- **Bundle ID**: `io.bibliac.app`
- **Team ID**: `QG3MEYVHMS`
- **iCloud Container**: `iCloud.io.bibliac.app`

### iCloud Folder Structure
```
~/Library/Mobile Documents/iCloud~io~bibliac~app/
  Documents/
    libraries.json              # Registry of all libraries
    My Library/                 # A library folder
      library.sqlite           # Paper database
      master.bib               # BibTeX file
      papers/                  # PDF files
      text/                    # Extracted text
    Research Papers/           # Another library
      ...
```

### Development Without Code Signing
When the app is not code-signed, it cannot write to the actual iCloud container.
The app automatically falls back to:
```
~/Documents/Bibliac-Cloud/
```

This allows testing iCloud-like functionality during development.

## Troubleshooting

### "Developer ID Application" not found
```bash
# List available identities
security find-identity -v -p codesigning

# If empty, you need to create the certificate (see Step 1)
```

### Notarization Fails
```bash
# Check notarization history
xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_ID_PASSWORD" --team-id "$APPLE_TEAM_ID"

# Get details on a specific submission
xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" --password "$APPLE_ID_PASSWORD" --team-id "$APPLE_TEAM_ID"
```

### "The app is damaged" Error
This usually means:
1. The app wasn't signed properly
2. Notarization failed
3. The ticket wasn't stapled

Try:
```bash
# Remove quarantine attribute
xattr -d com.apple.quarantine "Bibliac.app"

# Or right-click > Open in Finder (bypasses Gatekeeper first time)
```

### iCloud Container Not Accessible
1. Ensure the app is code-signed with proper entitlements
2. The bundle ID must match: `io.bibliac.app`
3. The container ID must be registered in Apple Developer portal
4. The iCloud capability must be enabled in the provisioning profile

## CI/CD Setup

For automated builds (GitHub Actions, etc.):

```yaml
env:
  APPLE_IDENTITY: ${{ secrets.APPLE_IDENTITY }}
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_ID_PASSWORD: ${{ secrets.APPLE_ID_PASSWORD }}
  APPLE_TEAM_ID: QG3MEYVHMS

steps:
  - name: Import certificate
    run: |
      # Decode and import certificate from base64 secret
      echo "${{ secrets.CERTIFICATE_P12 }}" | base64 --decode > certificate.p12
      security create-keychain -p "" build.keychain
      security import certificate.p12 -k build.keychain -P "${{ secrets.CERTIFICATE_PASSWORD }}" -T /usr/bin/codesign
      security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" build.keychain

  - name: Build and sign
    run: npm run make:signed
```

## Related Files

| File | Purpose |
|------|---------|
| `forge.config.js` | Electron Forge build configuration with signing settings |
| `entitlements.mac.plist` | macOS entitlements for code signing |
| `package.json` | Build scripts for signed/unsigned builds |
| `ios/App/App/App.entitlements` | iOS entitlements (mirrors macOS) |

## References

- [Apple Developer: Notarizing macOS Software](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Electron Forge: Code Signing](https://www.electronforge.io/guides/code-signing)
- [Apple Developer: iCloud Documentation](https://developer.apple.com/documentation/cloudkit/enabling_cloudkit_in_your_app)
