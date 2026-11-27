# Backup and restore

As the service account, with the same bootstrap environment as the daemon, run `npm run backup -- /absolute/path/to/a/new-private-backup-directory` from the release. It uses SQLite VACUUM INTO for a consistent database copy and copies bootstrap, secrets and VAPID keys. For a backup that pairs precisely with the imported files, pause and let transfers settle, stop the supervisor, then take the application backup and photograph snapshots. The application command does not archive imported files or previews. Store backups privately with encryption where available.

1. Stop the daemon and its supervisor. Archive the current data and config separately.
2. Restore `sync.sqlite` without stale `-wal` or `-shm` files. Restore matching `bootstrap.json`, `secrets.json`, `vapid.json`, and any separately installed custom CCAPI module. A changed VAPID key typically requires local re-enrollment.
3. Restore service-account ownership and permissions. Verify the allowed roots and credentials still apply. If newer imports exist than the snapshot, reconcile manually before starting to avoid repeat imports.
4. Run `doctor`, then restart the scheduled task. Verify history, SSO, camera identity and test push submission. Recovery review rows need manual inspection of the recorded destination and staged file before deciding whether to reimport.
