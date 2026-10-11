#!/bin/sh
set -eu
# Additional changed paths in the exact owned git-fixture subtree.
REPO=/tmp/workbench-e2e/project/repos/other
[ -d "$REPO/.git" ] && [ ! -L "$REPO" ]
mkdir -p "$REPO/src/api" "$REPO/src/ui" "$REPO/docs"
printf 'export const handler = "tree diff fixture";\n' > "$REPO/src/api/handler.js"
printf 'export const component = "tree preview fixture";\n' > "$REPO/src/ui/component.js"
printf '# Tree navigation fixture\n' > "$REPO/docs/guide.md"
