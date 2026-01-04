#!/bin/bash
# Bibliac - iCloud Structure Verification Script
# Verifies that the iCloud container and library structure is correct

ICLOUD_PATH="$HOME/Library/Mobile Documents/iCloud~io~bibliac~app/Documents"

echo "=========================================="
echo "Bibliac - iCloud Structure Verification"
echo "=========================================="
echo ""

# Check iCloud container
echo "1. Checking iCloud container..."
if [ -d "$ICLOUD_PATH" ]; then
  echo "   ✓ Container exists at: $ICLOUD_PATH"
else
  echo "   ✗ Container NOT FOUND"
  echo "   Expected: $ICLOUD_PATH"
  echo ""
  echo "   This could mean:"
  echo "   - iCloud Drive is not enabled"
  echo "   - The app hasn't created an iCloud library yet"
  echo "   - iCloud container ID mismatch"
  exit 1
fi

echo ""

# Check libraries.json
echo "2. Checking libraries.json..."
LIBRARIES_JSON="$ICLOUD_PATH/libraries.json"
if [ -f "$LIBRARIES_JSON" ]; then
  echo "   ✓ libraries.json exists"
  echo ""
  echo "   Content:"
  echo "   --------"
  cat "$LIBRARIES_JSON" | python3 -m json.tool 2>/dev/null || cat "$LIBRARIES_JSON"
  echo ""

  # Count libraries
  LIB_COUNT=$(python3 -c "import json; data=json.load(open('$LIBRARIES_JSON')); print(len(data.get('libraries', [])))" 2>/dev/null)
  echo "   Libraries registered: $LIB_COUNT"
else
  echo "   ✗ libraries.json NOT FOUND"
  echo "   This is normal if no iCloud libraries have been created yet"
fi

echo ""

# List library folders
echo "3. Library folders in iCloud container:"
echo "   ------------------------------------"
for dir in "$ICLOUD_PATH"/*/; do
  if [ -d "$dir" ]; then
    DIRNAME=$(basename "$dir")
    echo ""
    echo "   Library: $DIRNAME"

    # Check required files
    [ -f "$dir/library.sqlite" ] && echo "      ✓ library.sqlite" || echo "      ✗ library.sqlite MISSING"
    [ -d "$dir/papers" ] && echo "      ✓ papers/" || echo "      ✗ papers/ MISSING"
    [ -d "$dir/text" ] && echo "      ✓ text/" || echo "      ✗ text/ MISSING"
    [ -f "$dir/master.bib" ] && echo "      ✓ master.bib" || echo "      - master.bib (optional)"

    # Count PDFs
    if [ -d "$dir/papers" ]; then
      PDF_COUNT=$(ls "$dir/papers"/*.pdf 2>/dev/null | wc -l | tr -d ' ')
      echo "      PDFs: $PDF_COUNT"
    fi

    # Check for conflict files
    CONFLICTS=$(ls "$dir" 2>/dev/null | grep -E "(library.*[0-9]\.sqlite|conflict)" | wc -l | tr -d ' ')
    if [ "$CONFLICTS" -gt 0 ]; then
      echo "      ⚠ CONFLICTS DETECTED: $CONFLICTS conflict file(s)"
      ls "$dir" | grep -E "(library.*[0-9]\.sqlite|conflict)"
    fi

    # Count papers in database
    if [ -f "$dir/library.sqlite" ]; then
      PAPER_COUNT=$(sqlite3 "$dir/library.sqlite" "SELECT COUNT(*) FROM papers;" 2>/dev/null || echo "?")
      echo "      Papers in DB: $PAPER_COUNT"
    fi
  fi
done

echo ""
echo "=========================================="
echo "Verification complete"
echo "=========================================="
