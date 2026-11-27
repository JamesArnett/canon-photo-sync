# Canon Photo Sync

A native Node.js daemon and installable PWA for importing camera originals to a local NAS. This repository runs the complete simulated import path. Canon confirms CCAPI support on EOS R6 Mark II firmware 1.7.0. The included read-only adapter implements the documented EOS R6 Mark II operations. Physical camera validation is pending. [Canon research](docs/CCAPI_RESEARCH.md)

Start with the [laptop-to-production walkthrough](docs/LAPTOP_TO_PRODUCTION.md) for local tests, private GitHub setup, and native DSM deployment.

## Build and simulate

```sh
npm ci
npm run build
npm run lint
npm test
npm run simulate
npm run simulate -- --large
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

The large simulation temporarily writes a 2.25 GiB video and a second 16 MiB video. Tests start loopback fixtures and generate test data. The production entry point has no simulation switch and requires OIDC. Use Node 22.13 or later on the Node 22 release line for the target NAS. Node 20 is supported for compatibility testing through npm-distributed libsql binaries and has reached end of life.

## Run on DSM

Use a dedicated service account, existing internal HTTPS proxy, supported SSO Server package, private bootstrap and secret files, and a boot-time Task Scheduler entry. Use the PWA to configure cameras, destinations, transfers and notifications after bootstrap. See [native installation](docs/SYNOLOGY_DEPLOYMENT.md), [SSO](docs/SYNOLOGY_SSO.md), [proxy](docs/REVERSE_PROXY.md), and [iPhone setup](docs/PWA.md).

| Location | Contents |
| --- | --- |
| `src/` | Adapter, transport, SQLite, transfer engine, auth, push and HTTP API |
| `public/` | PWA, service worker, manifest and icons |
| `test/` | Simulated cameras, fixture providers, automated tests and resource simulation |
| `scripts/` | DSM supervisor |
| `docs/` | Architecture, research, threat model, deployment, recovery and validation |

[Security](docs/SECURITY.md) · [Backup/restore](docs/BACKUP_RESTORE.md) · [Hardware validation](docs/HARDWARE_VALIDATION.md) · [Roadmap](docs/ROADMAP.md)

## Validation scope

The automated suite runs on Node 20, Node 22, and Node 24. A separate Chromium mobile-viewport smoke test exercises signed synthetic OIDC, camera configuration, automatic import, activity, directory browsing, dark appearance, the service worker, offline state and logout. A cloud Node 24 engine-only run transferred 2,432,696,320 bytes across two simulated cameras in 4.85 seconds, with 53.3 MiB baseline RSS and 68.0 MiB sampled peak RSS. Preview and browser work were outside the measured process. These figures are cloud smoke-test measurements. Sustained resource use and throughput on DSM remain to be measured.

Physical validation starts with a disposable import destination and both camera slots. Verify the firmware responses, authentication, modification timestamps, automatic reconnect, sleep, shooting behavior, previews and original contents. Refer to [Canon research](docs/CCAPI_RESEARCH.md) and the [physical validation checklist](docs/HARDWARE_VALIDATION.md).
