# Agent instructions — Google Drive Duplicate PDF Finder

## Parent workspace

This folder lives under the workspace root:

`c:\Users\harsh\Documents\building_cursor_2026_02_06\gdrive_duplicate_pdf_finder`

When the parent workspace defines global rules (e.g. `AGENTS.md`, `PS_AGENTS.md`, `.cursor/MCP_AGENTS.md`), follow those **in addition** to this file.

## Diary

For any non-trivial task in this project, maintain a task diary under `docs/diaries/YYYY/MM/YYYY-MM-DD--<task-slug>.md`. Follow the workspace-level diary operating rules from the parent `AGENTS.md`:

- One diary per task, updated over time (not per session).
- Record: task narrative, debugging trail, architectural decisions, commands run, evidence gathered, verification, and handoff notes.
- Do not paste raw transcripts or large dumps — summarize and reference paths.
- Diaries do **not** replace backlog or changelog.

## Project conventions

- **Stack:** Python 3.12+ (stdlib only, no pip), Google Apps Script.
- **Target:** `G:\My Drive\Documents` (~8,000+ PDFs synced via Google Drive for Desktop).
- **Secrets:** No secrets in this project. Folder IDs are not sensitive.
- **Scope:** Prefer small, focused changes; extend existing patterns.

## Files to keep updated

- User-facing behavior and setup → `README.md`
- Notable changes → `docs/changelog.md`
- Planned work → `docs/backlog.md`

## Before running shell commands

Use syntax for the environment you are actually running in. On Windows PowerShell, use **PowerShell** syntax. Codex usually runs in WSL/bash even when project files are on Windows, so Codex should use bash/Linux commands unless it has confirmed the current shell is PowerShell. Read the parent workspace's `PS_AGENTS.md` for command mapping and gotchas.
