# Default branch migration to main

## Task narrative

Move the public repository from `master` to `main` without changing its existing Duplicate PDF Finder README or project files.

## Decisions

- Created `main` directly from commit `6e9c3ab`, the current `master` tip.
- Set `main` as GitHub's default branch before deleting `master`.
- Kept the migration record separate from the README so its user-facing content remained unchanged.

## Commands and evidence

- Pushed `master` to `main` with `git push origin master:main`.
- Updated GitHub's default branch through the repository API.
- Compared both branch tips and recursive trees. Both resolved to `6e9c3ab25b948668e56aa7819afee19f65b4bd04` and had identical tracked files before this diary and changelog update.

## Verification

- Confirmed `main` was the default branch before removal of `master`.
- Confirmed the existing `README.md` blob was identical on the original `master` and new `main` branch.
- Confirmed the public clone, README, and raw-file routes use `main` after the final push.

## Handoff

`main` is the sole branch. The branch migration changes no finder behavior.
