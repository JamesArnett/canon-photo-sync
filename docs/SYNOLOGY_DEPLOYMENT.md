# Native DSM deployment

1. Create a dedicated nonadministrator service account in DSM. Deny DSM applications and unrelated shares via normal DSM permissions. Grant it traverse rights to the configured parent directories, read access to application files and write access to the selected import destination, state and log directories. Keep unrelated NAS security settings in place.
2. Create separate directories for releases, configuration, state, logs, backups and imports. Canonical import roots must already exist and must exclude runtime and private data. The configured state directory needs mode 0700 and service-account ownership. Bootstrap and secret files must be regular files owned by the service account with mode 0600.
3. Detect Node and use its absolute executable path in Task Scheduler. Verify `node -v`, `node -p "process.arch"` and `command -v flock`. Use the newest Node 22.x patch available on DSM x86-64, with 22.13.0 as the minimum for this release line. Node 20 reached end of life in March 2026 and is included for compatibility testing only. Node 20 requires at least 20.19 and the npm-provided `@libsql/linux-x64-gnu` prebuilt through libsql. Verify on DSM before depending on it. Node 22.13+ uses built-in SQLite. [Node.js release status](https://nodejs.org/en/about/previous-releases)
4. Build an immutable release with `npm ci` and `npm run build`. Run `npm test` on the build machine before copying the release. If building elsewhere, install production dependencies with the target runtime and architecture using `npm ci --omit=dev` on DSM or an ABI-compatible Linux build host. Retain public assets and package metadata alongside `dist`. Use a new release path for each upgrade.
5. Copy the example bootstrap and secret files into the private configuration directory, remove placeholders, set the HTTPS origin, SSO issuer/client details and exact authorized subjects or verified group claims. Set approved camera CIDRs as narrowly as practical. Use the built-in EOS R6 Mark II adapter and configure an HTTPS camera credential profile if needed. See [CCAPI research](CCAPI_RESEARCH.md).
6. Configure [Synology SSO](SYNOLOGY_SSO.md) and the [existing DSM reverse proxy](REVERSE_PROXY.md). Open the app only through the trusted HTTPS origin.
7. In DSM Control Panel → Task Scheduler create a Triggered Task → User-defined script, select the service account, and set the event to Boot-up. Use a script similar to the following, substituting actual paths. Test with **Run** first. The supervisor holds an advisory flock and restarts the daemon after a 15-second delay. The daemon also refuses to start a second listener on the configured port.

```sh
export CANON_BOOTSTRAP=/volume1/photo-sync/config/bootstrap.json
export CANON_SECRETS=/volume1/photo-sync/config/secrets.json
export CANON_NODE=/path/to/node
export CANON_WORK_DIR=/volume1/photo-sync
export CANON_RELEASE=/volume1/photo-sync/releases/current
exec /bin/sh "$CANON_RELEASE/scripts/supervise.sh"
```

Run `"$CANON_NODE" dist/main.js doctor` from the release with the same exported configuration. It checks the database, VAPID keys, OIDC discovery, destination permissions and camera identities. It prints the configured loopback address; verify that the proxy actually reaches it separately. Confirm the supervisor and child survive logout and restart from an intentional non-root process termination.

For upgrades, stop the supervisor with SIGTERM as the service account after verifying the PID in its private PID file still refers to it. Back up state, build and test the next release, switch the release path, and start the task. Check the changelog for schema compatibility. To roll back compatible releases, restore the previous release path. For incompatible schema changes restore a matching backup first, preserving newer photos and reconciling any history since the backup. On removal, disable the scheduled task, stop the daemon and remove the reverse-proxy entry. Preserve or archive imports and private state independently.

The daemon handles SIGTERM and aborts in-flight downloads before closing the database. The supervisor keeps one 1 MiB startup/error log archive and rotates at supervisor launch or child restart. Activity events have configurable retention. For more frequent file rotation, use a DSM-supported log policy outside the app.
