#!/bin/sh
# Data lives in the host folder mounted at /fb/data: import the last snapshot
# if one exists, snapshot every minute while running, export once more on
# graceful shutdown. The periodic export means a crash, a kill or a power cut
# loses at most a minute, and the host folder survives any docker cleanup.
# The emulator replaces the export dir by rename, which fails on a mount
# point, so the target is a subdirectory.
# exec keeps firebase as PID 1 so the compose SIGINT reaches it.
(
  while :; do
    sleep 60
    firebase emulators:export /fb/data/export --force \
      --project memory-keepers-local >/dev/null 2>&1 || true
  done
) &
if [ -f /fb/data/export/firebase-export-metadata.json ]; then
  exec firebase emulators:start --project memory-keepers-local \
    --import /fb/data/export --export-on-exit /fb/data/export
fi
exec firebase emulators:start --project memory-keepers-local \
  --export-on-exit /fb/data/export
