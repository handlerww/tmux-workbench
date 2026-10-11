#!/bin/sh
set -eu
# Reset only names owned by files-create-acceptance on its isolated socket's cwd.
ROOT=/tmp/workbench-e2e/project
[ -d "$ROOT" ] && [ ! -L "$ROOT" ]
[ ! -L "$ROOT/toolbar-created" ]
[ ! -L "$ROOT/toolbar-phone" ]
rm -f "$ROOT/toolbar-created.txt" "$ROOT/toolbar-created/child.txt"
for name in toolbar-created toolbar-phone; do
  if [ -d "$ROOT/$name" ]; then rmdir "$ROOT/$name"; fi
done
