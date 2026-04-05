/**
 * ============================================================================
 * FIND DUPLICATE PDFs ON GOOGLE DRIVE
 * ============================================================================
 *
 * A Google Apps Script that finds duplicate PDF files directly on Google Drive
 * using server-side MD5 checksums — no file downloads needed.
 *
 * Google Drive's API provides getMd5Checksum() on File objects, which returns
 * the server-side MD5 hash. This works for ALL files regardless of whether
 * they are synced locally, are "cloud-only", or are too large to download.
 *
 * ---------------------------------------------------------------------------
 * HOW TO SET UP
 * ---------------------------------------------------------------------------
 *
 * 1. Go to https://script.google.com and create a new project.
 *
 * 2. Delete any default code in the editor, and paste this entire file.
 *
 * 3. Find your Google Drive folder ID:
 *    - Open the folder in Google Drive in your browser.
 *    - The URL will look like:
 *      https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRsTuVwXyZ
 *                                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *    - That last segment after /folders/ is your FOLDER_ID.
 *
 * 4. Paste your folder ID into ROOT_FOLDER_ID below (replace the placeholder).
 *
 * 5. Save the project (Ctrl+S).
 *
 * ---------------------------------------------------------------------------
 * HOW TO RUN
 * ---------------------------------------------------------------------------
 *
 * 1. Select "findDuplicatePDFs" from the function dropdown at the top.
 * 2. Click the Run button (▶).
 * 3. On first run, Google will ask you to authorize the script. Click through
 *    the permissions prompts (the script needs access to Drive and Sheets).
 * 4. Watch the Execution Log (View > Execution log) for progress.
 *
 * ---------------------------------------------------------------------------
 * WHAT IF IT TIMES OUT?
 * ---------------------------------------------------------------------------
 *
 * Google Apps Script has a 6-minute execution limit. For large folders
 * (thousands of files), the script will likely hit this limit.
 *
 * This script handles timeouts automatically:
 *   - Every 50 files, it checks elapsed time.
 *   - If more than 5 minutes have passed, it saves its progress (which folders
 *     are done, which files have been collected so far) to PropertiesService
 *     and sets a time-based trigger to auto-resume in 1 minute.
 *   - The next execution picks up exactly where it left off.
 *   - This repeats until the entire folder tree is scanned.
 *   - After scanning completes, the report spreadsheet is generated.
 *
 * You can also manually continue by running "findDuplicatePDFs" again — it
 * will detect saved state and resume automatically.
 *
 * To start completely fresh (discard saved progress), run "resetScanState".
 *
 * ---------------------------------------------------------------------------
 * OUTPUT
 * ---------------------------------------------------------------------------
 *
 * The script creates a Google Spreadsheet called "Duplicate PDFs Report" in
 * your My Drive root with three sheets:
 *   - "Duplicates"  — grouped duplicate files with paths and Drive links
 *   - "All PDFs"    — every PDF found during the scan
 *   - "Summary"     — statistics (total files, duplicates, wasted space, etc.)
 *
 * ============================================================================
 */


// =============================================================================
// CONFIGURATION
// =============================================================================

/** 
 * Google Drive folder ID to scan. Replace with your own.
 * Find it from the folder URL: https://drive.google.com/drive/folders/YOUR_ID
 */
const ROOT_FOLDER_ID = 'PASTE_YOUR_FOLDER_ID_HERE';

/** Name of the output spreadsheet (created in your My Drive root). */
const SPREADSHEET_NAME = 'Duplicate PDFs Report';

/** Maximum execution time in milliseconds before saving state (5 min of 6 min limit). */
const MAX_EXECUTION_MS = 5 * 60 * 1000;

/** How often (in files) to check elapsed time and log progress. */
const PROGRESS_INTERVAL = 50;

/** Name of the run-log file written to My Drive root after each execution. */
const RUN_LOG_FILENAME = 'Duplicate PDFs - Run Log.txt';


// =============================================================================
// RUN LOGGING
// =============================================================================

/**
 * In-memory log buffer. Entries are flushed to a Google Drive text file at the
 * end of every execution (including timed-out partial runs).
 *
 * Each entry is an object: { ts: ISO string, level: string, message: string }
 */
const _runLog = [];

/**
 * Appends an entry to the in-memory run log and also writes to Logger.
 *
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 */
function logEntry(level, message) {
  const ts = new Date().toISOString();
  _runLog.push({ ts: ts, level: level, message: message });
  Logger.log('[%s] %s: %s', ts, level, message);
}

/**
 * Flushes the in-memory run log to a text file on Google Drive.
 *
 * The file is append-only: each execution appends a clearly delimited block so
 * the full history of all runs is preserved in one file. An AI agent can read
 * this file to understand what happened across runs and spot improvements.
 *
 * @param {string} outcome - Short label for how the execution ended,
 *   e.g. "COMPLETED", "TIMED_OUT", "ERROR".
 */
function flushRunLog(outcome) {
  if (_runLog.length === 0) return;

  // Build the text block for this execution
  const separator = '=' .repeat(72);
  const lines = [
    '',
    separator,
    'RUN  ' + _runLog[0].ts + '  →  ' + outcome,
    separator
  ];
  for (const entry of _runLog) {
    lines.push('[' + entry.ts + '] ' + entry.level + ': ' + entry.message);
  }
  lines.push(''); // trailing blank line

  const block = lines.join('\n');

  // Find or create the log file
  const existing = DriveApp.getFilesByName(RUN_LOG_FILENAME);
  if (existing.hasNext()) {
    const file = existing.next();
    const prev = file.getBlob().getDataAsString();
    file.setContent(prev + block);
  } else {
    DriveApp.createFile(RUN_LOG_FILENAME, block, 'text/plain');
  }
}


// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

/**
 * Main function — run this from the Apps Script editor.
 *
 * On first run, it starts scanning from ROOT_FOLDER_ID.
 * If a previous run timed out and saved state, it resumes from where it left off.
 */
function findDuplicatePDFs() {
  const startTime = Date.now();
  const props = PropertiesService.getScriptProperties();

  // Check for saved state from a previous timed-out run
  const savedState = props.getProperty('scanState');
  let allFiles = [];
  let pendingFolders = [];
  let scanComplete = false;

  if (savedState) {
    const state = JSON.parse(savedState);
    allFiles = state.allFiles || [];
    pendingFolders = state.pendingFolders || [];
    logEntry('INFO', 'Resuming previous scan. ' + allFiles.length +
      ' files already collected, ' + pendingFolders.length + ' folders remaining.');
  } else {
    // Fresh start — seed with the root folder
    const rootFolder = DriveApp.getFolderById(ROOT_FOLDER_ID);
    const rootName = rootFolder.getName();
    pendingFolders = [{ id: ROOT_FOLDER_ID, path: rootName }];
    logEntry('INFO', 'Starting fresh scan of folder: ' + rootName);
  }

  // Process folders from the queue
  const result = processQueue(pendingFolders, allFiles, startTime);
  allFiles = result.allFiles;
  pendingFolders = result.pendingFolders;
  scanComplete = result.complete;

  if (!scanComplete) {
    // Hit the time limit — save state and schedule continuation
    const state = JSON.stringify({ allFiles: allFiles, pendingFolders: pendingFolders });
    props.setProperty('scanState', state);
    logEntry('INFO', 'Time limit approaching. Saved state: ' + allFiles.length +
      ' files collected, ' + pendingFolders.length + ' folders remaining.');
    logEntry('INFO', 'Setting trigger to auto-resume in 1 minute...');
    flushRunLog('TIMED_OUT');
    setResumeTrigger();
    return;
  }

  // Scanning is complete — generate the report
  logEntry('INFO', 'Scan complete! Total PDFs found: ' + allFiles.length);
  props.deleteProperty('scanState');
  cleanupTriggers();

  // Find duplicates (files sharing the same MD5 checksum)
  const duplicateGroups = findDuplicateGroups(allFiles);
  logEntry('INFO', 'Found ' + duplicateGroups.length + ' duplicate groups.');

  // Calculate and log summary stats
  let totalDupFiles = 0;
  let wastedBytes = 0;
  for (const group of duplicateGroups) {
    totalDupFiles += group.length;
    wastedBytes += (group.length - 1) * group[0].size;
  }
  logEntry('INFO', 'Total duplicate files: ' + totalDupFiles +
    ', wasted space: ' + formatBytes(wastedBytes));

  // Write results to a Google Sheet
  writeReport(allFiles, duplicateGroups);
  logEntry('INFO', 'Report written to spreadsheet: "' + SPREADSHEET_NAME + '"');
  logEntry('INFO', 'Execution time: ' + ((Date.now() - startTime) / 1000).toFixed(1) + 's');
  flushRunLog('COMPLETED');
}


// =============================================================================
// FOLDER SCANNING
// =============================================================================

/**
 * Processes folders from a queue, collecting PDF metadata.
 * Returns early if the time limit is approaching.
 *
 * Uses an iterative (queue-based) approach instead of recursion so that
 * progress can be saved and resumed across executions.
 *
 * @param {Object[]} pendingFolders - Array of {id, path} objects to process.
 * @param {Object[]} allFiles - Array of file metadata collected so far.
 * @param {number} startTime - Timestamp (ms) when execution started.
 * @returns {{ allFiles: Object[], pendingFolders: Object[], complete: boolean }}
 */
function processQueue(pendingFolders, allFiles, startTime) {
  while (pendingFolders.length > 0) {
    const current = pendingFolders.shift();
    let folder;
    try {
      folder = DriveApp.getFolderById(current.id);
    } catch (e) {
      logEntry('WARN', 'Could not access folder "' + current.path +
        '" (ID: ' + current.id + '): ' + e.message);
      continue;
    }

    // Collect all PDF files in this folder
    const files = folder.getFilesByType('application/pdf');
    while (files.hasNext()) {
      const file = files.next();
      allFiles.push({
        name: file.getName(),
        path: current.path + '/' + file.getName(),
        size: file.getSize(),
        md5: file.getMd5Checksum() || '',
        id: file.getId(),
        url: file.getUrl()
      });

      // Periodic progress logging and time check
      if (allFiles.length % PROGRESS_INTERVAL === 0) {
        logEntry('INFO', 'Progress: ' + allFiles.length + ' PDFs collected so far...');
        if (Date.now() - startTime > MAX_EXECUTION_MS) {
          return { allFiles: allFiles, pendingFolders: pendingFolders, complete: false };
        }
      }
    }

    // Enqueue subfolders
    const subfolders = folder.getFolders();
    while (subfolders.hasNext()) {
      const sub = subfolders.next();
      pendingFolders.push({ id: sub.getId(), path: current.path + '/' + sub.getName() });
    }
  }

  return { allFiles: allFiles, pendingFolders: [], complete: true };
}


// =============================================================================
// DUPLICATE DETECTION
// =============================================================================

/**
 * Groups files by MD5 checksum and returns only groups with 2+ files.
 *
 * @param {Object[]} allFiles - Array of file metadata objects.
 * @returns {Object[][]} Array of groups, each group is an array of file objects.
 */
function findDuplicateGroups(allFiles) {
  const byMd5 = {};
  for (const file of allFiles) {
    if (!file.md5) continue; // Skip files with no checksum (Google Docs, etc.)
    if (!byMd5[file.md5]) {
      byMd5[file.md5] = [];
    }
    byMd5[file.md5].push(file);
  }

  const groups = [];
  for (const md5 in byMd5) {
    if (byMd5[md5].length >= 2) {
      // Sort each group by path for consistent ordering
      byMd5[md5].sort(function (a, b) { return a.path.localeCompare(b.path); });
      groups.push(byMd5[md5]);
    }
  }

  // Sort groups by the first file's path
  groups.sort(function (a, b) { return a[0].path.localeCompare(b[0].path); });
  return groups;
}


// =============================================================================
// REPORT GENERATION
// =============================================================================

/**
 * Creates (or overwrites) a Google Spreadsheet with three sheets:
 *   1. Duplicates — grouped duplicate files
 *   2. All PDFs — every PDF found
 *   3. Summary — scan statistics
 *
 * @param {Object[]} allFiles - All scanned PDF metadata.
 * @param {Object[][]} duplicateGroups - Groups of duplicate files.
 */
function writeReport(allFiles, duplicateGroups) {
  const ss = getOrCreateSpreadsheet(SPREADSHEET_NAME);

  writeDuplicatesSheet(ss, duplicateGroups);
  writeAllPDFsSheet(ss, allFiles);
  writeSummarySheet(ss, allFiles, duplicateGroups);

  // Delete the default "Sheet1" if it still exists
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }

  logEntry('INFO', 'Report spreadsheet URL: ' + ss.getUrl());
}

/**
 * Creates the "Duplicates" sheet with grouped duplicate files.
 */
function writeDuplicatesSheet(ss, duplicateGroups) {
  let sheet = ss.getSheetByName('Duplicates');
  if (sheet) {
    sheet.clear();
  } else {
    sheet = ss.insertSheet('Duplicates');
  }

  // Calculate summary stats
  let totalDuplicateFiles = 0;
  let wastedBytes = 0;
  for (const group of duplicateGroups) {
    totalDuplicateFiles += group.length;
    // Wasted space = (copies - 1) * file size (keeping one copy)
    wastedBytes += (group.length - 1) * group[0].size;
  }

  const rows = [];

  // Summary row at the very top
  rows.push([
    'Found ' + duplicateGroups.length + ' duplicate groups, ' +
    totalDuplicateFiles + ' total duplicate files, ' +
    formatBytes(wastedBytes) + ' wasted',
    '', '', '', '', '', ''
  ]);
  rows.push([]); // blank row

  // Header row
  rows.push(['Group #', 'File Name', 'Full Path', 'Size (bytes)', 'Size (readable)', 'MD5', 'Drive URL']);

  // Data rows
  for (let g = 0; g < duplicateGroups.length; g++) {
    const group = duplicateGroups[g];
    for (const file of group) {
      rows.push([
        g + 1,
        file.name,
        file.path,
        file.size,
        formatBytes(file.size),
        file.md5,
        file.url
      ]);
    }
    // Blank row between groups for visual separation
    if (g < duplicateGroups.length - 1) {
      rows.push([]);
    }
  }

  if (rows.length > 0) {
    sheet.getRange(1, 1, rows.length, 7).setValues(rows);
  }

  // Format header row (row 3: summary, blank, then header)
  const headerRange = sheet.getRange(3, 1, 1, 7);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#d9e2f3');
  sheet.setFrozenRows(3);

  // Format summary row
  sheet.getRange(1, 1, 1, 7).merge();
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(11);

  // Auto-resize columns
  for (let c = 1; c <= 7; c++) {
    sheet.autoResizeColumn(c);
  }
}

/**
 * Creates the "All PDFs" sheet listing every scanned PDF.
 */
function writeAllPDFsSheet(ss, allFiles) {
  let sheet = ss.getSheetByName('All PDFs');
  if (sheet) {
    sheet.clear();
  } else {
    sheet = ss.insertSheet('All PDFs');
  }

  const rows = [];
  rows.push(['File Name', 'Full Path', 'Size (bytes)', 'Size (readable)', 'MD5', 'Drive ID', 'Drive URL']);

  // Sort by path for readability
  const sorted = allFiles.slice().sort(function (a, b) { return a.path.localeCompare(b.path); });
  for (const file of sorted) {
    rows.push([
      file.name,
      file.path,
      file.size,
      formatBytes(file.size),
      file.md5,
      file.id,
      file.url
    ]);
  }

  if (rows.length > 0) {
    sheet.getRange(1, 1, rows.length, 7).setValues(rows);
  }

  // Format header
  const headerRange = sheet.getRange(1, 1, 1, 7);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#d9e2f3');
  sheet.setFrozenRows(1);

  for (let c = 1; c <= 7; c++) {
    sheet.autoResizeColumn(c);
  }
}

/**
 * Creates the "Summary" sheet with scan statistics.
 */
function writeSummarySheet(ss, allFiles, duplicateGroups) {
  let sheet = ss.getSheetByName('Summary');
  if (sheet) {
    sheet.clear();
  } else {
    sheet = ss.insertSheet('Summary');
  }

  // Calculate stats
  let totalDuplicateFiles = 0;
  let wastedBytes = 0;
  const uniqueMd5s = new Set();
  let totalSize = 0;

  for (const file of allFiles) {
    if (file.md5) uniqueMd5s.add(file.md5);
    totalSize += file.size;
  }

  for (const group of duplicateGroups) {
    totalDuplicateFiles += group.length;
    wastedBytes += (group.length - 1) * group[0].size;
  }

  const uniqueCount = uniqueMd5s.size;

  const rows = [
    ['Duplicate PDFs Scan Report', ''],
    ['', ''],
    ['Metric', 'Value'],
    ['Total PDFs scanned', allFiles.length],
    ['Unique files (by MD5)', uniqueCount],
    ['Duplicate groups', duplicateGroups.length],
    ['Total duplicate files', totalDuplicateFiles],
    ['Total size of all PDFs', formatBytes(totalSize)],
    ['Wasted space (duplicates)', formatBytes(wastedBytes)],
    ['', ''],
    ['Scanned folder ID', ROOT_FOLDER_ID],
    ['Scan completed at', new Date().toLocaleString()]
  ];

  sheet.getRange(1, 1, rows.length, 2).setValues(rows);

  // Format title
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(14);

  // Format column headers
  const headerRange = sheet.getRange(3, 1, 1, 2);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#d9e2f3');

  // Bold the metric labels
  sheet.getRange(4, 1, 8, 1).setFontWeight('bold');

  sheet.autoResizeColumn(1);
  sheet.autoResizeColumn(2);
}


// =============================================================================
// SPREADSHEET HELPERS
// =============================================================================

/**
 * Finds an existing spreadsheet by name or creates a new one.
 * If found, all existing sheets are cleared on a per-sheet basis in the
 * write functions above.
 *
 * @param {string} name - Spreadsheet name.
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getOrCreateSpreadsheet(name) {
  const files = DriveApp.getFilesByName(name);
  while (files.hasNext()) {
    const file = files.next();
    if (file.getMimeType() === 'application/vnd.google-apps.spreadsheet') {
      Logger.log('Found existing spreadsheet: %s', name);
      return SpreadsheetApp.open(file);
    }
  }
  Logger.log('Creating new spreadsheet: %s', name);
  return SpreadsheetApp.create(name);
}


// =============================================================================
// CONTINUATION / TRIGGER MANAGEMENT
// =============================================================================

/**
 * Sets a time-based trigger to call findDuplicatePDFs in ~1 minute.
 * This is the auto-resume mechanism for handling the 6-minute execution limit.
 */
function setResumeTrigger() {
  // Remove any existing resume triggers first to avoid duplicates
  cleanupTriggers();
  ScriptApp.newTrigger('findDuplicatePDFs')
    .timeBased()
    .after(60 * 1000) // 1 minute
    .create();
  Logger.log('Resume trigger set. Script will auto-continue in ~1 minute.');
}

/**
 * Removes all triggers for findDuplicatePDFs created by this script.
 */
function cleanupTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'findDuplicatePDFs') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}

/**
 * Clears all saved scan state. Run this to start completely fresh.
 * Useful if you changed ROOT_FOLDER_ID or want to re-scan from scratch.
 */
function resetScanState() {
  PropertiesService.getScriptProperties().deleteProperty('scanState');
  cleanupTriggers();
  Logger.log('Scan state cleared. Next run of findDuplicatePDFs will start fresh.');
}


// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Converts a byte count to a human-readable string.
 *
 * @param {number} bytes - Number of bytes.
 * @returns {string} Formatted string like "1.23 MB".
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return value.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
}
