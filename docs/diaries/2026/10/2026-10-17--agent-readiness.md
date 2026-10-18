# Safe syntax verification

## Changes

Documented the existing Python 3.12+ stdlib toolchain and an AST-only syntax check, separate from scanning personal Drive files.

2-way door: this focused setup/documentation change can be reverted without changing stored data or deploying a service.

## Verification

The documented AST command passed. No Drive scan, report rewrite, or Apps Script execution ran.
