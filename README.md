# Google Drive Duplicate PDF Finder

Find duplicate PDFs in own Google Drive using Google Drive File Stream to Windows.

## Why this project exists

Over the years, personal and financial PDFs — bank statements, pay slips, utility bills — accumulate and get duplicated across different folder structures organised for different purposes:

- **By category** — e.g. a folder for all electricity bills for one address.
- **By tax year** — all electricity bills for a single financial year (multiple addresses) grouped for tax filing.
- **By KYC submission** — one electricity bill, one telecom bill, etc., bundled for a Know Your Customer request.

With ~8,000+ PDFs this duplication is impossible to resolve manually. A naive local hashing script also won't work: many files exist as cloud-only placeholders on Google Drive for Desktop, and touching them would trigger Drive to download every file one-by-one.

The solution is a two-pronged approach — a **local Python script** that uses Win32 API calls to detect and skip cloud-only files while hashing the rest, and a **Google Apps Script** that runs server-side against the Drive API to deduplicate the cloud-only files without downloading anything.

## Local syntax verification

Use Python 3.12+ with no pip dependencies. From this repository root, check the Python source without scanning Drive or writing reports:

```powershell
python -c "import ast, pathlib; ast.parse(pathlib.Path('find_duplicate_pdfs.py').read_text(encoding='utf-8-sig')); print('Python syntax OK')"
```

This checks syntax only. It does not verify Win32 placeholder handling or Google Apps Script behavior.

## Scripts

### 1. `find_duplicate_pdfs.py` — Local Python script

Two-pass deduplication on locally synced files:

1. **Pass 1** — Groups all PDFs by file size (fast, no reads).
2. **Pass 2** — SHA-256 hashes only size-collision candidates to confirm duplicates.

Detects Google Drive cloud-only placeholders via Win32 file attributes and skips them (reported separately).

**Configuration:** Edit `config.json` to set your paths:
```json
{
    "scan_dir": "G:\\My Drive\\Documents",
    "output_dir": "C:\\Users\\harsh\\Documents\\...\\gdrive_duplicate_pdf_finder"
}
```

**Run:**
```powershell
python find_duplicate_pdfs.py
```

**Example terminal output:**
```
Pass 1 — Scanning for PDFs in: G:\My Drive\Documents
  ... scanned 100 PDFs so far
  ... scanned 200 PDFs so far
  ... scanned 300 PDFs so far
  Found 312 PDFs total. 45 size groups with 102 candidate files.

Pass 2 — Hashing candidate files …
  ... hashed 100/102 candidates
  Hashing complete. 12 confirmed duplicate groups.

CSV report written to: ...\duplicate_pdfs_report.csv
Text report written to: ...\duplicate_pdfs_report.txt

Done in 8.3s.
```

**Output files:**
- `duplicate_pdfs_report.csv` — machine-readable, every file with status; duplicate groups sorted by descending saveable space
- `duplicate_pdfs_report.txt` — human-readable grouped report with wasted space; duplicate groups sorted by descending saveable space

### 2. `find_duplicate_pdfs_apps_script.js` — Google Apps Script

Server-side duplicate detection using Drive API's `getMd5Checksum()` — works for **all** files including cloud-only ones, no downloads needed.

**Setup:**
1. Go to [script.google.com](https://script.google.com) → new project
2. Paste the script contents
3. Set `ROOT_FOLDER_ID` from your Drive folder URL
4. Run `findDuplicatePDFs`

Auto-resumes across the 6-minute execution limit via triggers. Outputs a Google Sheet with Duplicates, All PDFs, and Summary tabs.

**Run log:** Every execution appends a structured block to `Duplicate PDFs - Run Log.txt` in your My Drive root. The log captures start/resume, progress, warnings, scan results, and timing — useful for AI agent review and debugging.

## When to use which

| Scenario | Use |
|---|---|
| Most files synced locally | Python script (faster) |
| Many cloud-only files | Apps Script |
| Full coverage | Run both — Python for local, Apps Script for cloud-only gaps |

## Target folder

`G:\My Drive\Documents` — configured in `config.json` (Python script) and in the Apps Script source.
