# ADS Reader Beta Testing Guide

## Overview

Thank you for participating in the ADS Reader beta! Your feedback is invaluable in helping us build a better app for managing astronomy papers.

## Getting Started

### iOS (TestFlight)

1. **Install TestFlight** from the App Store (if not already installed)
2. **Open the invitation link** you received on your iPhone or iPad
3. **Accept the invitation** and install ADS Reader
4. **Launch the app** and create your first library

### macOS

1. **Download the DMG** from the provided link
2. **Open the DMG** and drag ADS Reader to your Applications folder
3. **Open ADS Reader** from Applications
4. If you see a security warning:
   - Right-click the app and select "Open"
   - Click "Open" in the dialog that appears
5. **Create your library** (iCloud recommended for cross-device sync)

## First Launch Setup

1. **Enter your ADS API token**
   - Get your token from [ui.adsabs.harvard.edu/user/settings/token](https://ui.adsabs.harvard.edu/user/settings/token)
   - Click Settings > ADS API Token
   - Paste your token and click Save

2. **Create a library**
   - Choose "Create iCloud Library" for cross-device sync
   - Or select a local folder for desktop-only use

3. **Import papers**
   - Search ADS using the "ADS" button
   - Drag and drop PDF files
   - Import .bib files

## What We're Testing

### Core Features
- Library creation and management
- iCloud sync between devices
- ADS search and paper import
- PDF viewing and annotations
- References and citations

### iOS-Specific
- Touch interactions and gestures
- PDF pinch-to-zoom
- Bottom sheet for PDF source selection
- Landscape mode for PDF reading

### macOS-Specific
- Keyboard shortcuts
- Focus Notes mode (Cmd+Shift+N)
- Menu bar integration
- Window management

## Sending Feedback

### In-App (Recommended)
1. Click **Settings > Send Feedback**
2. Or press **Cmd+Shift+F** (macOS)
3. Or use **Help > Send Feedback** from the menu bar
4. Select feedback type (Bug, Feature, General)
5. Describe the issue or suggestion
6. Click "Send Feedback" to open your email client

### Email Directly
Send feedback to: **adsreader@tomabel.org**

Please include:
- What you were trying to do
- What happened instead
- Steps to reproduce (for bugs)
- Device and iOS/macOS version

## Known Issues

- First sync with large libraries may take a few minutes
- Some PDF annotations may not render on very complex PDFs
- iCloud sync may have a short delay between devices

## Keyboard Shortcuts (macOS)

| Shortcut | Action |
|----------|--------|
| `/` | Focus search |
| `j/k` | Next/Previous paper |
| `s` | Sync with ADS |
| `a` | Open in ADS |
| `p` | PDF tab |
| `Shift+P` | Open in Preview |
| `n` | Toggle Notes panel |
| `Cmd+Shift+N` | Focus Notes mode |
| `1/2/3` | Set read status |
| `Shift+1-4` | Set rating |
| `+/-` | Zoom in/out |
| `r` | Rotate page |
| `Backspace` | Delete paper |
| `Cmd+Shift+F` | Send Feedback |

## Version History

### v1.0.0-beta.1 (Current)
- Initial beta release
- Core library management
- iCloud sync
- PDF viewing and annotations
- ADS integration
- AI features (summary, Q&A)
- In-app feedback submission

## Contact

- **Email**: adsreader@tomabel.org
- **GitHub**: Issues for technical bug reports

---

Thank you for testing ADS Reader!
