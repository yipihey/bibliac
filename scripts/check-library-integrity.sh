#!/bin/bash
# Bibliac - Library Integrity Check
# Verifies a specific library folder has all required files and no corruption

if [ -z "$1" ]; then
  echo "Usage: $0 <library-path>"
  echo ""
  echo "Example:"
  echo "  $0 ~/Library/Mobile\\ Documents/iCloud~io~bibliac~app/Documents/My\\ Library"
  echo "  $0 ~/Documents/Bibliac"
  exit 1
fi

LIBRARY_PATH="$1"

echo "=========================================="
echo "Bibliac - Library Integrity Check"
echo "=========================================="
echo ""
echo "Checking: $LIBRARY_PATH"
echo ""

# Check if path exists
if [ ! -d "$LIBRARY_PATH" ]; then
  echo "✗ ERROR: Directory does not exist"
  exit 1
fi

echo "1. Required Files"
echo "   --------------"

# Check database
if [ -f "$LIBRARY_PATH/library.sqlite" ]; then
  echo "   ✓ library.sqlite"
  DB_SIZE=$(ls -lh "$LIBRARY_PATH/library.sqlite" | awk '{print $5}')
  echo "     Size: $DB_SIZE"
else
  echo "   ✗ library.sqlite MISSING (critical)"
fi

# Check papers folder
if [ -d "$LIBRARY_PATH/papers" ]; then
  echo "   ✓ papers/"
  PDF_COUNT=$(ls "$LIBRARY_PATH/papers"/*.pdf 2>/dev/null | wc -l | tr -d ' ')
  echo "     PDFs: $PDF_COUNT"
else
  echo "   ✗ papers/ MISSING"
fi

# Check text folder
if [ -d "$LIBRARY_PATH/text" ]; then
  echo "   ✓ text/"
  TXT_COUNT=$(ls "$LIBRARY_PATH/text"/*.txt 2>/dev/null | wc -l | tr -d ' ')
  echo "     Text files: $TXT_COUNT"
else
  echo "   ✗ text/ MISSING"
fi

# Check master.bib (optional)
if [ -f "$LIBRARY_PATH/master.bib" ]; then
  echo "   ✓ master.bib"
  BIB_ENTRIES=$(grep -c "@" "$LIBRARY_PATH/master.bib" 2>/dev/null || echo "0")
  echo "     Entries: ~$BIB_ENTRIES"
else
  echo "   - master.bib (not present, optional)"
fi

echo ""
echo "2. Conflict Detection"
echo "   ------------------"

CONFLICT_FILES=$(ls "$LIBRARY_PATH" 2>/dev/null | grep -E "(library[\s-][0-9]+\.sqlite|library.*conflict.*\.sqlite)")
if [ -n "$CONFLICT_FILES" ]; then
  echo "   ⚠ CONFLICTS FOUND:"
  echo "$CONFLICT_FILES" | while read f; do
    echo "     - $f"
  done
else
  echo "   ✓ No conflict files detected"
fi

echo ""
echo "3. Database Integrity"
echo "   ------------------"

if [ -f "$LIBRARY_PATH/library.sqlite" ]; then
  # Try to run integrity check
  INTEGRITY=$(sqlite3 "$LIBRARY_PATH/library.sqlite" "PRAGMA integrity_check;" 2>&1)
  if [ "$INTEGRITY" = "ok" ]; then
    echo "   ✓ SQLite integrity check: PASSED"
  else
    echo "   ✗ SQLite integrity check: FAILED"
    echo "     $INTEGRITY"
  fi

  # Count records
  echo ""
  echo "   Record counts:"
  for table in papers collections annotations refs citations; do
    COUNT=$(sqlite3 "$LIBRARY_PATH/library.sqlite" "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "N/A")
    printf "     %-15s %s\n" "$table:" "$COUNT"
  done

  # Check for orphaned records
  echo ""
  echo "   Orphan check:"
  ORPHAN_ANNOTATIONS=$(sqlite3 "$LIBRARY_PATH/library.sqlite" "SELECT COUNT(*) FROM annotations WHERE paper_id NOT IN (SELECT id FROM papers);" 2>/dev/null || echo "N/A")
  echo "     Orphaned annotations: $ORPHAN_ANNOTATIONS"

  ORPHAN_REFS=$(sqlite3 "$LIBRARY_PATH/library.sqlite" "SELECT COUNT(*) FROM refs WHERE paper_id NOT IN (SELECT id FROM papers);" 2>/dev/null || echo "N/A")
  echo "     Orphaned references: $ORPHAN_REFS"
else
  echo "   Cannot check - database file missing"
fi

echo ""
echo "4. PDF Files Check"
echo "   ---------------"

if [ -d "$LIBRARY_PATH/papers" ]; then
  # List PDFs with sizes
  echo "   PDF files:"
  ls -lh "$LIBRARY_PATH/papers"/*.pdf 2>/dev/null | awk '{print "     " $9 " (" $5 ")"}' | head -10

  TOTAL_PDFS=$(ls "$LIBRARY_PATH/papers"/*.pdf 2>/dev/null | wc -l | tr -d ' ')
  if [ "$TOTAL_PDFS" -gt 10 ]; then
    echo "     ... and $((TOTAL_PDFS - 10)) more"
  fi

  # Check for empty PDFs
  EMPTY_PDFS=$(find "$LIBRARY_PATH/papers" -name "*.pdf" -size 0 2>/dev/null | wc -l | tr -d ' ')
  if [ "$EMPTY_PDFS" -gt 0 ]; then
    echo ""
    echo "   ⚠ Empty PDF files: $EMPTY_PDFS"
  fi
else
  echo "   papers/ folder missing"
fi

echo ""
echo "=========================================="
echo "Integrity check complete"
echo "=========================================="
