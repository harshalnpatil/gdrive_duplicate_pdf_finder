# Changelog — Google Drive Duplicate PDF Finder

This file documents completed features and improvements. For planned work, see `backlog.md`.

## 2026-10-17 - Agent setup and verification

- Documented a stdlib syntax check that does not scan Google Drive or rewrite reports.
- Verification: the documented AST parse passed.

## Sort duplicate groups by saveable space (2026-04-05)

- **CSV + text group ordering** — Duplicate groups in both `duplicate_pdfs_report.csv` and `duplicate_pdfs_report.txt` are now ordered by descending saveable space, calculated as `file_size × extra copies`, so the biggest cleanup opportunities appear first.

## Extract paths to config.json (2026-04-05)

- **config.json** — Moved `scan_dir` and `output_dir` out of `find_duplicate_pdfs.py` into a `config.json` file next to the script. The script loads these at startup via `json` (stdlib). No pip dependencies added.

## Improved duplicate group size info in text report (2026-04-05)

- **Two-size group header** — Each duplicate group now shows both the individual file size and the total saveable space (file size × extra copies), e.g. `File size: 3.5 MB  |  Saveable: 7.0 MB  (2 extra)`.

## Oldest-file detection & path cleanup (2026-04-05)

- **Oldest mtime columns** — CSV now includes `oldest_file_name`, `oldest_file_path`, and `oldest_file_mtime` for each duplicate group, identifying the likely original file by earliest modification date.
- **Text report ★ marker** — Each duplicate group in the text report shows a `★ Oldest (likely original)` line with filename and date.
- **Clean paths in output** — Stripped the `\\?\` long-path prefix from all paths written to CSV and text reports so they display as normal `G:\My Drive\…` paths.

## Fix long-path errors on Windows (2026-04-04)

- **Extended-length path support** — Added `\\?\` prefix to all file operations (`open`, `os.scandir`, `GetFileAttributesW`) so paths exceeding the Windows 260-character MAX_PATH limit no longer fail with `[Errno 2] No such file or directory`.

## Apps Script run logging (2026-04-04)

- **Append-only run log** — Every Apps Script execution appends a structured log block to `Duplicate PDFs - Run Log.txt` in My Drive root, capturing start/resume, progress, folder-access warnings, scan results, wasted-space stats, and execution time. Full history is preserved across timed-out partial runs and completions.

## Initial project setup (2026-04-04)

- **Python script** — `find_duplicate_pdfs.py`: two-pass (size → SHA-256) duplicate finder for a Google Drive–synced folder on Windows. Detects Win32 cloud-only placeholders via `ctypes`/`kernel32` file attributes and skips them. Outputs console summary, CSV report, and human-readable text report with per-group details and wasted-space total.
- **Apps Script** — `find_duplicate_pdfs_apps_script.js`: server-side duplicate finder using Google Drive's MD5 checksums — no file downloads needed. Auto-resumes across the 6-minute execution limit via `PropertiesService` + time-based triggers. Outputs a Google Spreadsheet with Duplicates, All PDFs, and Summary sheets (including wasted space).
- **Project structure** — README, AGENTS.md, `docs/backlog.md`, `docs/changelog.md`.
