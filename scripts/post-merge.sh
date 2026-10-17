#!/usr/bin/env bash
set -euo pipefail

# Pulling source is not authorization to migrate a database, install lifecycle
# hooks, or restart the running app. Replit gives postMerge only 20 seconds.
test -f package.json
test -f package-lock.json
printf '%s\n' \
  'Source updated. No database migration or application restart was run.' \
  'Before running the app, use npm ci, npm run check, npm test, npm run build.' \
  'Database migrations require a separate reviewed migration and approval.'
