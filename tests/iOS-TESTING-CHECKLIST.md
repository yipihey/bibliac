# iOS Testing Checklist - iPhone 15 Pro Max / iPhone 16 Pro Max

## Test Environment
- Device: iPhone 15 Pro Max or iPhone 16 Pro Max Simulator
- iOS Version: iOS 17+
- iCloud: Enabled in Simulator (Settings > [Sign in])

---

## First Launch (Fresh Install)

- [ ] App launches without crash
- [ ] iCloud permission prompt appears (if not already granted)
- [ ] Library picker shows "No libraries yet" message
- [ ] "New iCloud Library" button is visible and tappable
- [ ] Creating a library shows success feedback
- [ ] Library folder appears in iCloud Drive (verify in Files app)
- [ ] `libraries.json` created with correct schema in iCloud

---

## Library Management

### Create Library
- [ ] Can create new iCloud library
- [ ] Library name is sanitized (special characters removed)
- [ ] Library appears in picker immediately after creation
- [ ] Library folders (papers/, text/) created in iCloud

### Switch Library
- [ ] Can switch between multiple libraries
- [ ] Papers list updates when switching
- [ ] Current library indicated in header
- [ ] Database closes properly on switch

### Library Picker UI
- [ ] Shows current library name and paper count
- [ ] Dropdown opens/closes correctly
- [ ] iCloud libraries show cloud icon
- [ ] Animations smooth on Pro Max display

---

## Paper Operations

### Add Paper
- [ ] Can add paper manually via ADS search
- [ ] Can import paper from bibcode
- [ ] Paper appears in list after adding
- [ ] Metadata populates correctly

### View Paper
- [ ] Tapping paper shows detail view
- [ ] Abstract displays correctly
- [ ] Authors list properly formatted
- [ ] PDF viewer opens when PDF downloaded

### PDF Download
- [ ] Download button triggers download
- [ ] Progress indicator shows during download
- [ ] PDF saves to papers/ folder
- [ ] Multiple PDF sources work (arXiv, publisher)

### Delete Paper
- [ ] Can delete paper via swipe or menu
- [ ] Confirmation dialog appears
- [ ] Paper removed from list
- [ ] PDF files deleted from storage

---

## iCloud Sync

### Cross-Device Visibility
- [ ] Library created on iOS visible on macOS
- [ ] Library created on macOS visible on iOS
- [ ] Papers added on one device appear on other

### Sync Timing
- [ ] Changes sync within 30 seconds
- [ ] No duplicate entries after sync
- [ ] Read status preserved across devices

### Conflict Detection
- [ ] App detects conflict files (library 2.sqlite)
- [ ] Conflict resolution UI appears
- [ ] "Keep Current" option works
- [ ] "Keep Conflict" option works
- [ ] "Backup Both" option works

---

## Migration (Existing Users)

### Migration Check
- [ ] Migration prompt appears on first launch with existing data
- [ ] Shows correct paper count
- [ ] Shows iCloud availability status

### Migration to iCloud
- [ ] "Migrate to iCloud" option works
- [ ] All papers copied to iCloud location
- [ ] Old Documents/Bibliac deleted
- [ ] Database intact after migration

### Keep Local
- [ ] "Keep Local" option registers library
- [ ] Library accessible after selection
- [ ] No data loss

---

## Offline Behavior

- [ ] App opens with last-used library when offline
- [ ] Can browse existing papers offline
- [ ] Can view downloaded PDFs offline
- [ ] Graceful error when trying to sync offline
- [ ] No crash when iCloud unavailable

---

## UI/UX on Pro Max Display

### Layout
- [ ] Full screen utilization on 6.7" display
- [ ] No clipping or overflow issues
- [ ] Touch targets appropriately sized

### Performance
- [ ] Smooth scrolling in paper list
- [ ] Quick app launch (< 2 seconds)
- [ ] PDF renders smoothly
- [ ] No memory warnings

### Dark Mode
- [ ] App respects system dark mode setting
- [ ] All UI elements visible in dark mode
- [ ] PDF viewer adapts to dark mode

---

## Settings

### ADS Token
- [ ] Can enter and save ADS API token
- [ ] Token stored in Keychain (secure)
- [ ] Token persists after app restart

### PDF Priority
- [ ] Can reorder PDF source priority
- [ ] Order persists after restart
- [ ] Downloads follow priority order

### Cloud LLM Config (if applicable)
- [ ] Can configure Anthropic API key
- [ ] Key stored securely
- [ ] AI features work with configured key

---

## Error Handling

- [ ] Graceful error when ADS API unavailable
- [ ] Graceful error when PDF download fails
- [ ] Recovery from database corruption
- [ ] Proper error messages displayed

---

## Console Verification (Safari Web Inspector)

Connect iOS Simulator to Safari Web Inspector and run:

```javascript
// Test iCloud availability
await window.electronAPI.isICloudAvailable()
// Expected: true

// Test get all libraries
await window.electronAPI.getAllLibraries()
// Expected: Array of library objects

// Test current library ID
await window.electronAPI.getCurrentLibraryId()
// Expected: UUID string or null

// Test migration check
await window.electronAPI.checkMigrationNeeded()
// Expected: { needed: boolean, ... }

// Test library stats
await window.electronAPI.getStats()
// Expected: { total: N, unread: N, reading: N, read: N }
```

---

## Test Results

| Category | Pass | Fail | Notes |
|----------|------|------|-------|
| First Launch | | | |
| Library Management | | | |
| Paper Operations | | | |
| iCloud Sync | | | |
| Migration | | | |
| Offline Behavior | | | |
| UI/UX Pro Max | | | |
| Settings | | | |
| Error Handling | | | |

---

## Issues Found

1.
2.
3.

---

## Sign-off

Tested by: ____________________
Date: ____________________
Device: iPhone 15/16 Pro Max Simulator
iOS Version: ____________________
