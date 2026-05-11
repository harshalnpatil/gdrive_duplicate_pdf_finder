"""
find_duplicate_pdfs.py
~~~~~~~~~~~~~~~~~~~~~~
Two-pass duplicate-PDF finder for a Google Drive–synced folder on Windows.

Pass 1 – Group every .pdf by file size (no I/O beyond stat).
Pass 2 – SHA-256 hash each candidate, skipping cloud-only placeholders
          detected via Win32 file attributes.

Outputs:
  • Console summary
  • CSV  report  (duplicate_pdfs_report.csv)
  • Text report  (duplicate_pdfs_report.txt)

Only uses the Python standard library (+ ctypes for Win32 API).
"""

import os
import sys
import csv
import json
import hashlib
import ctypes
import time
from collections import defaultdict
from typing import Dict, List, Tuple, Optional

# ── Configuration ────────────────────────────────────────────────────────────

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_CONFIG_PATH = os.path.join(_SCRIPT_DIR, "config.json")

with open(_CONFIG_PATH, "r", encoding="utf-8") as _cf:
    _config = json.load(_cf)

SCAN_DIR = _config["scan_dir"]
OUTPUT_DIR = _config["output_dir"]
CSV_REPORT = os.path.join(OUTPUT_DIR, "duplicate_pdfs_report.csv")
TXT_REPORT = os.path.join(OUTPUT_DIR, "duplicate_pdfs_report.txt")

HASH_CHUNK_SIZE = 65536  # 64 KB
PROGRESS_INTERVAL = 100  # print status every N files

# ── Win32 file-attribute flags used to detect cloud-only placeholders ────────

FILE_ATTRIBUTE_OFFLINE = 0x1000
FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000
FILE_ATTRIBUTE_SPARSE_FILE = 0x0200
FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000

_CLOUD_ONLY_MASK = (
    FILE_ATTRIBUTE_OFFLINE
    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
    | FILE_ATTRIBUTE_SPARSE_FILE
    | FILE_ATTRIBUTE_RECALL_ON_OPEN
)

# Load kernel32 once
_kernel32 = ctypes.windll.kernel32
_GetFileAttributesW = _kernel32.GetFileAttributesW
_GetFileAttributesW.argtypes = [ctypes.c_wchar_p]
_GetFileAttributesW.restype = ctypes.c_uint32

INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF


def _long_path(path: str) -> str:
    """Add \\\\?\\ prefix to support paths longer than MAX_PATH (260 chars)."""
    if path.startswith("\\\\?\\"):
        return path
    # For UNC paths (\\server\share) use \\?\UNC\server\share
    if path.startswith("\\\\"):
        return "\\\\?\\UNC\\" + path[2:]
    return "\\\\?\\" + os.path.abspath(path)


def _short_path(path: str) -> str:
    """Strip the \\\\?\\ long-path prefix for display."""
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith("\\\\?\\"):
        return path[4:]
    return path


def is_cloud_only(path: str) -> bool:
    """Return True if *path* is a Google Drive cloud-only placeholder."""
    attrs = _GetFileAttributesW(_long_path(path))
    if attrs == INVALID_FILE_ATTRIBUTES:
        return False  # can't determine — treat as local
    return bool(attrs & _CLOUD_ONLY_MASK)


# ── Helpers ──────────────────────────────────────────────────────────────────

def sha256_of_file(path: str) -> Optional[str]:
    """Return hex SHA-256 digest, or None on read failure."""
    h = hashlib.sha256()
    try:
        with open(_long_path(path), "rb") as f:
            while True:
                chunk = f.read(HASH_CHUNK_SIZE)
                if not chunk:
                    break
                h.update(chunk)
    except (OSError, PermissionError) as exc:
        print(f"  [WARN] Cannot read {path}: {exc}")
        return None
    return h.hexdigest()


def human_size(n: int) -> str:
    """Format byte count as a human-readable string."""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def walk_pdfs(root: str):
    """
    Yield (path, size, mtime) for every .pdf under *root* using os.scandir
    for speed.  Recurses into subdirectories.
    """
    try:
        with os.scandir(_long_path(root)) as entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        yield from walk_pdfs(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        if entry.name.lower().endswith(".pdf"):
                            stat = entry.stat(follow_symlinks=False)
                            yield (entry.path, stat.st_size, stat.st_mtime)
                except (OSError, PermissionError) as exc:
                    print(f"  [WARN] {exc}")
    except (OSError, PermissionError) as exc:
        print(f"  [WARN] Cannot scan {root}: {exc}")


# ── Core logic ───────────────────────────────────────────────────────────────

def pass1_group_by_size(
    root: str,
) -> Tuple[Dict[int, List[Tuple[str, float]]], int]:
    """
    Walk the tree, return {size: [(path, mtime), ...]} keeping only sizes
    with 2+ files.  Also returns total PDF count.
    """
    print(f"Pass 1 — Scanning for PDFs in: {root}")
    size_map: Dict[int, List[Tuple[str, float]]] = defaultdict(list)
    total = 0
    for path, size, mtime in walk_pdfs(root):
        size_map[size].append((path, mtime))
        total += 1
        if total % PROGRESS_INTERVAL == 0:
            print(f"  ... scanned {total} PDFs so far")

    # Keep only candidate groups (2+ files with the same size)
    candidates = {sz: items for sz, items in size_map.items() if len(items) >= 2}
    n_candidates = sum(len(v) for v in candidates.values())
    print(f"  Found {total} PDFs total. "
          f"{len(candidates)} size groups with {n_candidates} candidate files.\n")
    return candidates, total


def pass2_hash_candidates(
    candidates: Dict[int, List[Tuple[str, float]]],
) -> Tuple[
    Dict[Tuple[int, str], List[Tuple[str, float]]],  # confirmed duplicates
    Dict[Tuple[int, str], List[Tuple[str, float]]],  # unique hashed
    List[Tuple[str, int]],                            # cloud-only files
    List[Tuple[str, int]],                            # unreadable files
]:
    """
    Hash every candidate file (unless cloud-only).
    Returns duplicate groups (with mtime), unique-hash groups, cloud-only
    list, and unreadable list.
    """
    print("Pass 2 — Hashing candidate files …")
    hash_map: Dict[Tuple[int, str], List[Tuple[str, float]]] = defaultdict(list)
    cloud_only_files: List[Tuple[str, int]] = []
    unreadable_files: List[Tuple[str, int]] = []

    processed = 0
    total_to_hash = sum(len(v) for v in candidates.values())

    for size, items in candidates.items():
        for path, mtime in items:
            processed += 1
            if processed % PROGRESS_INTERVAL == 0:
                print(f"  ... hashed {processed}/{total_to_hash} candidates")

            # Check for cloud-only placeholder before reading
            if is_cloud_only(path):
                cloud_only_files.append((path, size))
                continue

            digest = sha256_of_file(path)
            if digest is None:
                unreadable_files.append((path, size))
                continue

            hash_map[(size, digest)].append((path, mtime))

    duplicates = {k: v for k, v in hash_map.items() if len(v) >= 2}
    unique_hashed = {k: v for k, v in hash_map.items() if len(v) == 1}
    print(f"  Hashing complete. {len(duplicates)} confirmed duplicate groups.\n")
    return duplicates, unique_hashed, cloud_only_files, unreadable_files


# ── Reporting ────────────────────────────────────────────────────────────────

def _oldest_in_group(
    items: List[Tuple[str, float]],
) -> Tuple[str, str, str]:
    """Return (oldest_file_name, oldest_file_path, oldest_mtime_iso) for a group."""
    oldest_path, oldest_mtime = min(items, key=lambda x: x[1])
    oldest_name = os.path.basename(oldest_path)
    oldest_date = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(oldest_mtime))
    return oldest_name, oldest_path, oldest_date


def _sorted_duplicate_groups(
    duplicates: Dict[Tuple[int, str], List[Tuple[str, float]]],
) -> List[Tuple[Tuple[int, str], List[Tuple[str, float]]]]:
    """Sort duplicate groups by descending saveable space, then file size."""
    return sorted(
        duplicates.items(),
        key=lambda item: (
            -(item[0][0] * (len(item[1]) - 1)),
            -item[0][0],
            item[0][1],
        ),
    )


def write_csv_report(
    duplicates: Dict[Tuple[int, str], List[Tuple[str, float]]],
    cloud_only_files: List[Tuple[str, int]],
    unique_hashed: Dict[Tuple[int, str], List[Tuple[str, float]]],
    csv_path: str,
):
    """Write every file that was evaluated into a CSV with its status."""
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["group_id", "file_path", "file_size_bytes",
                         "sha256_hash", "status",
                         "oldest_file_name", "oldest_file_path",
                         "oldest_file_mtime"])

        gid = 0
        # Duplicate groups
        for (size, digest), items in _sorted_duplicate_groups(duplicates):
            gid += 1
            o_name, o_path, o_date = _oldest_in_group(items)
            for p in sorted(items, key=lambda x: x[0]):
                writer.writerow([gid, _short_path(p[0]), size, digest,
                                 "duplicate", o_name,
                                 _short_path(o_path), o_date])

        # Cloud-only files
        for p, size in sorted(cloud_only_files):
            gid += 1
            writer.writerow([gid, _short_path(p), size, "", "cloud_only",
                             "", "", ""])

        # Unique (hashed but not duplicated)
        for (size, digest), items in sorted(unique_hashed.items()):
            for p, _mtime in sorted(items, key=lambda x: x[0]):
                gid += 1
                writer.writerow([gid, _short_path(p), size, digest,
                                 "unique", "", "", ""])

    print(f"CSV report written to: {csv_path}")


def write_text_report(
    total_pdfs: int,
    duplicates: Dict[Tuple[int, str], List[Tuple[str, float]]],
    cloud_only_files: List[Tuple[str, int]],
    unreadable_files: List[Tuple[str, int]],
    candidates: Dict[int, List[Tuple[str, float]]],
    txt_path: str,
):
    """Write a human-readable text report."""
    # Calculate wasted space
    wasted = 0
    for (size, _digest), items in duplicates.items():
        # All copies beyond the first are "wasted"
        wasted += size * (len(items) - 1)

    total_dup_files = sum(len(v) for v in duplicates.values())

    # Identify cloud-only files whose size matches a confirmed duplicate group
    dup_sizes = {size for (size, _) in duplicates}
    cloud_maybe_dups = [(p, s) for p, s in cloud_only_files if s in dup_sizes]
    cloud_no_match = [(p, s) for p, s in cloud_only_files if s not in dup_sizes]

    os.makedirs(os.path.dirname(txt_path), exist_ok=True)
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write("=" * 72 + "\n")
        f.write("  DUPLICATE PDF REPORT\n")
        f.write(f"  Scanned: {SCAN_DIR}\n")
        f.write(f"  Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write("=" * 72 + "\n\n")

        # ── Summary ──
        f.write("SUMMARY\n")
        f.write("-" * 72 + "\n")
        f.write(f"  Total PDFs found:               {total_pdfs}\n")
        f.write(f"  Cloud-only PDFs (skipped):       {len(cloud_only_files)}\n")
        f.write(f"  Unreadable PDFs (skipped):       {len(unreadable_files)}\n")
        f.write(f"  Confirmed duplicate groups:      {len(duplicates)}\n")
        f.write(f"  Total files in duplicate groups: {total_dup_files}\n")
        f.write(f"  Wasted space (duplicates):       {human_size(wasted)}"
                f"  ({wasted:,} bytes)\n\n")

        # ── Duplicate groups ──
        f.write("DUPLICATE GROUPS\n")
        f.write("-" * 72 + "\n")
        if not duplicates:
            f.write("  (none)\n")
        else:
            for idx, ((size, digest), items) in enumerate(
                _sorted_duplicate_groups(duplicates), start=1
            ):
                saveable = size * (len(items) - 1)
                o_name, o_path, o_date = _oldest_in_group(items)
                f.write(f"\n  Group {idx}  |  File size: {human_size(size)}"
                        f"  |  Saveable: {human_size(saveable)}"
                        f"  ({len(items)-1} extra)"
                        f"  |  SHA-256: {digest[:16]}…\n")
                f.write(f"    ★ Oldest (likely original): {o_name}"
                        f"  [{o_date}]\n")
                for p, _mt in sorted(items, key=lambda x: x[0]):
                    f.write(f"    • {_short_path(p)}\n")

        # ── Cloud-only files that might be duplicates ──
        f.write("\n\nCLOUD-ONLY FILES — POSSIBLE DUPLICATES (matched by size)\n")
        f.write("-" * 72 + "\n")
        if not cloud_maybe_dups:
            f.write("  (none)\n")
        else:
            for p, s in sorted(cloud_maybe_dups):
                f.write(f"  [{human_size(s)}]  {_short_path(p)}\n")

        # ── Cloud-only files with no size match ──
        f.write("\n\nCLOUD-ONLY FILES — NO SIZE MATCH (unlikely duplicates)\n")
        f.write("-" * 72 + "\n")
        if not cloud_no_match:
            f.write("  (none)\n")
        else:
            for p, s in sorted(cloud_no_match):
                f.write(f"  [{human_size(s)}]  {_short_path(p)}\n")

        # ── Unreadable files ──
        if unreadable_files:
            f.write("\n\nUNREADABLE FILES (permission or I/O errors)\n")
            f.write("-" * 72 + "\n")
            for p, s in sorted(unreadable_files):
                f.write(f"  {_short_path(p)}\n")

        f.write("\n" + "=" * 72 + "\n")
        f.write("  END OF REPORT\n")
        f.write("=" * 72 + "\n")

    print(f"Text report written to: {txt_path}")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if not os.path.isdir(SCAN_DIR):
        print(f"ERROR: Scan directory does not exist: {SCAN_DIR}")
        sys.exit(1)

    t0 = time.time()

    # Pass 1: group by size
    candidates, total_pdfs = pass1_group_by_size(SCAN_DIR)

    if not candidates:
        print("No size-based duplicates found. Nothing to hash.")
        # Still write reports for completeness
        write_csv_report({}, [], {}, CSV_REPORT)
        write_text_report(total_pdfs, {}, [], [], {}, TXT_REPORT)
        return

    # Pass 2: hash to confirm
    duplicates, unique_hashed, cloud_only_files, unreadable_files = \
        pass2_hash_candidates(candidates)

    # Write reports
    write_csv_report(duplicates, cloud_only_files, unique_hashed, CSV_REPORT)
    write_text_report(total_pdfs, duplicates, cloud_only_files,
                      unreadable_files, candidates, TXT_REPORT)

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s.")


if __name__ == "__main__":
    main()
