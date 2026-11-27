# Canon Photo Sync from laptop to production

Use the latest available **Node.js 22.x** patch on your laptop and DS1525+. The application requires **22.13.0 or newer** on that release line and uses Node's built-in SQLite. The NAS release process below assumes your DSM package supplies Node and npm. Keep DSM account protection enabled throughout.

## 1. Put the source on your laptop

1. Download `canon-photo-sync-source.zip` from the project handoff and extract it into a normal local folder. The archive contains the source, lockfile, examples, and CI workflow. If you downloaded the checksum alongside it, compare SHA-256 before extracting. On Linux use `sha256sum canon-photo-sync-source.zip`, on macOS use `shasum -a 256 canon-photo-sync-source.zip`, or in PowerShell use `Get-FileHash .\canon-photo-sync-source.zip -Algorithm SHA256`.
2. Open Terminal on macOS or Linux, or a WSL shell on Windows. On WSL, put the extracted repository in your Linux home directory for filesystem tests such as symlink and hard-link handling.
3. Install Git and Node.js 22.x, then enter the extracted folder containing `package.json`. Check the versions and SQLite.

```sh
git --version
node --version
npm --version
node -e 'new (require("node:sqlite").DatabaseSync)(":memory:").close()'
```

A SQLite experimental warning from some Node 22 builds is expected. A missing module or a Node version below 22.13.0 needs a runtime update.

## 2. Run the tests on your laptop

Run these from the project directory as your normal user. Make sure `openssl` is on your PATH for the HTTPS camera test. The automated suite opens local loopback sockets and uses generated media and simulated providers. You can finish this phase without the camera, the NAS, an SSO account, or a real push subscription.

```sh
npm ci --omit=optional
npm run build
npm run lint
npm test
npm run simulate
npm audit --omit=dev
```

Run `npm run simulate -- --large` if you have at least 3 GiB free in your temporary-file area. For the browser smoke test, install Chrome or Chromium and set `CHROMIUM_PATH` to its executable.

```sh
# Linux example
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser

# macOS example
CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:browser
```

Look for successful imports from two simulated cameras in the simulation output. The browser smoke test exercises the local test fixture. Use it for laptop validation instead of starting the production daemon with placeholder SSO settings.

## 3. Put the tested source in private GitHub

1. Sign in to GitHub and create an **empty private** repository called `canon-photo-sync`. Leave GitHub's README, license, and .gitignore initializers unchecked.
2. From the extracted folder, initialize Git and review the staged list before committing. The archive comes without Git metadata. If you are working in an existing initialized checkout, skip `git init`.

```sh
git init -b main
git add .
git diff --cached --name-only
git diff --cached --stat
```

3. Check that the staged list includes `.github/workflows/ci.yml` and `package-lock.json`. Keep runtime configuration, credentials, GitHub tokens, VAPID keys, SQLite state, camera media, and Canon SDK downloads or other vendor materials out of Git. Example JSON files contain placeholders.
4. Commit and push. Replace `YOUR-OWNER` with your GitHub user or organization. Authenticate on your laptop using your usual GitHub sign-in or credential manager.

```sh
git commit -m "Initial Canon Photo Sync source"
git remote add origin https://github.com/YOUR-OWNER/canon-photo-sync.git
git push -u origin main
```

5. In GitHub, confirm the repository has a **Private** badge and check **Actions** for the Node 22 job. Wait for green checks on the commit you intend to deploy. [GitHub guide to importing local code](https://docs.github.com/en/repositories/creating-and-managing-repositories/adding-locally-hosted-code-to-github)

## 4. Prepare the EOS R6 Mark II

Canon supports CCAPI on EOS R6 Mark II firmware 1.7.0. The built-in read-only adapter implements the documented API. Check for **Camera Control API** in the camera's Wi-Fi settings. If it is present, use its Wi-Fi wizard to join the network your NAS can reach and record the displayed origin and camera serial. If the menu is absent, confirm the supported activation procedure with Canon. Use a DHCP reservation or configured hostname and a test card with expendable media. Keep the Canon SDK materials outside the application checkout. [CCAPI setup](CCAPI_RESEARCH.md)

## 5. Install a versioned test release on DSM

1. In DSM Package Center, install or update **Node.js v22**. In a DSM shell, find the executable with `command -v node` and verify the returned version. If the command resolves to Node 20, locate the Node v22 package's executable under `/var/packages` and use its absolute path. Confirm `x64` from `node -p 'process.arch'`, the SQLite check from step 1, and `command -v flock`. The supervisor uses `flock` for a singleton lock.
2. Create a dedicated DSM account such as `photosync` with no administrator privileges. Prepare separate release, config, state, log, backup, and import locations. Grant the account the minimum directory permissions it needs. Use a new test import directory outside your main photography tree. Create that directory before configuring it. Keep the state directory owned by the service account with mode `0700` and the live config files owned by that account with mode `0600`.
3. On the laptop, archive the exact commit you tested.

```sh
git rev-parse --short HEAD
git archive --format=zip --prefix=canon-photo-sync-test/ \
  --output=../canon-photo-sync-test.zip HEAD
```

4. Upload the ZIP to the NAS over your existing LAN, for example with DSM File Station. Extract it into a new versioned release directory such as `/volume1/photo-sync/releases/canon-photo-sync-test`. This workflow keeps GitHub credentials on your laptop. Keep the import directory and private state separate from the release.
5. From the release directory on DSM, use the Node 22 executable directory first in `PATH` and run the commands below. Replace the example path with your verified package path. The second install leaves only runtime dependencies while keeping the compiled `dist/` output. These installs need npm registry access. If the NAS lacks that access, prepare the release and production dependencies on a trusted Linux x64 build host using Node 22.

```sh
export CANON_NODE=/actual/path/to/node
export PATH="$(dirname "$CANON_NODE"):$PATH"
node --version
npm ci --omit=optional
npm run build
npm ci --omit=dev --omit=optional
```

[Native deployment details](SYNOLOGY_DEPLOYMENT.md)

## 6. Set up SSO and the internal HTTPS proxy

1. Copy the repository's `bootstrap.example.json` and `secrets.example.json` to the private NAS config directory as `bootstrap.json` and `secrets.json`. Use the actual internal HTTPS origin, the approved test import root and destination, the intended camera CIDR, and the stable state path. Keep private values in those NAS copies.
2. In Synology SSO Server, enable OIDC and register an app with the exact redirect URI `https://<app-host>/auth/callback`. Enter the exact issuer, registered client ID and confidential client secret. Configure an explicit allowlist of stable OIDC subjects or verified signed group claims. If needed, follow the provider's client authentication mode and PKCE guidance. [Synology SSO setup](SYNOLOGY_SSO.md)
3. In DSM **Control Panel → Login Portal → Advanced → Reverse Proxy**, add the dedicated internal hostname with a trusted certificate. Forward HTTPS on that hostname to HTTP at `127.0.0.1:8787`. Apply a DSM Access Control Profile for your actual trusted LAN or VPN networks. Keep public access and router forwarding closed. [Reverse proxy setup](REVERSE_PROXY.md)
4. Run diagnostics as the service account. If that account has no interactive shell, create a temporary DSM **Task Scheduler → Scheduled Task → User-defined script** under the service account and use **Run**. Set `CANON_NODE` to the verified absolute executable and run the commands from the extracted release directory. For a scheduled task, include the `cd` and all variable assignments in its script.

```sh
cd /volume1/photo-sync/releases/canon-photo-sync-test
export CANON_NODE=/actual/path/to/node
export CANON_BOOTSTRAP=/volume1/photo-sync/config/bootstrap.json
export CANON_SECRETS=/volume1/photo-sync/config/secrets.json
"$CANON_NODE" dist/main.js doctor
```

Investigate any failing database, permissions, OIDC or configured-camera checks. With the config in place, you can run `"$CANON_NODE" dist/main.js` in the foreground as the service account to validate login. If you use Task Scheduler, create the boot task from step 8 and run it manually for this first sign-in check. Check that an authorized user succeeds, an unauthorized user fails, and the application and issuer are inaccessible from outside your allowed networks, including IPv6 where enabled.

## 7. Validate a real import and install the iPhone app

1. Add the camera paused with its CCAPI origin, expected serial, and the disposable destination. If the camera uses Digest, configure its private HTTPS profile first. Use **Test connectivity** and **Estimate matching media**, then resume.
2. Import sample photos and video across both slots. Compare SHA-256 hashes on NAS imports with hashes of the corresponding original card files. Check collision handling, interrupted-transfer recovery, power cycling, reconnection, and a large video. Move one completed import elsewhere and confirm it stays deduplicated. Check pause/resume and a credentials or certificate failure in a controlled test. [Hardware checklist](HARDWARE_VALIDATION.md)
3. Open the trusted app origin in iPhone Safari. Use **Add to Home Screen** and reopen the app from the icon. Go to **Settings → Notifications**, enable permission, and send a test. Confirm actual receipt on Wi-Fi and then cellular, and verify the dashboard still requires LAN or your existing VPN. Allow outbound push access to `*.push.apple.com` for Apple devices. [iPhone instructions](PWA.md) · [Push behavior](NOTIFICATIONS.md)

## 8. Promote to unattended operation

1. Configure a DSM **Task Scheduler → Triggered Task → User-defined script** at boot, running as the service account. Use the example in the deployment guide with the exact `CANON_NODE`, `CANON_RELEASE`, `CANON_WORK_DIR`, `CANON_BOOTSTRAP`, and `CANON_SECRETS` values. Stop any foreground instance before starting the task.
2. Confirm the daemon starts after an actual NAS reboot, works after you close your SSH session, and restarts after the child process exits. Check the logs under the working directory. Repeat a small import after reboot.
3. Run the documented backup and test restoring into a disposable state directory. Preserve the SQLite database, private bootstrap and secrets, VAPID keys, and any custom adapter release. Keep an earlier release and matching backup for rollback. [Backup and restore](BACKUP_RESTORE.md)
4. Once the real camera, DSM restart, authorized and unauthorized SSO, proxy exposure, and actual iPhone push checks pass, point the camera at your intended import destination. Confirm its current media estimate and import mode before enabling it. Review a first unattended import before relying on the daemon for everyday use.
