#!/bin/sh
# Data lives in the volume mounted at /fb/data: import the last export if one
# exists, export on graceful shutdown. The emulator replaces the export dir by
# rename, which fails on a mount point, so the target is a subdirectory.
# exec keeps firebase as PID 1 so the compose SIGINT reaches it.
if [ -f /fb/data/export/firebase-export-metadata.json ]; then
  exec firebase emulators:start --project memory-keepers-local \
    --import /fb/data/export --export-on-exit /fb/data/export
fi
exec firebase emulators:start --project memory-keepers-local \
  --export-on-exit /fb/data/export
