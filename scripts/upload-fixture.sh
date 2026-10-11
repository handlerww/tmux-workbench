#!/bin/sh
set -eu
# Only the isolated browser fixture subtree is modified.
[ -d /tmp/workbench-e2e/project ] && [ ! -L /tmp/workbench-e2e/project ]
for name in upload-root.txt upload-binary.bin after-conflict.txt upload-image.png from-git.txt cancelled-refresh.txt cancelled-switch.txt queued-switch.txt; do
  rm -f "/tmp/workbench-e2e/project/$name"
done
rm -f /tmp/workbench-e2e/project/src/nested.txt /tmp/workbench-e2e/project/src/sibling.txt /tmp/workbench-e2e/other/beta.txt /tmp/workbench-e2e/other/phone.txt
mkdir -p /tmp/workbench-e2e/upload-input
cp /tmp/workbench-e2e/project/pixel.png /tmp/workbench-e2e/upload-input/upload-image.png
printf 'PHONE_PICKER_UPLOAD\n' > /tmp/workbench-e2e/upload-input/phone.txt
