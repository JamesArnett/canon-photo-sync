# Troubleshooting

- **Camera disconnected**. Check power, CCAPI mode, Wi-Fi, address, network approval and model-adapter settings. An offline camera is expected between sessions.
- **Destination unavailable**. Check permissions, free space, filesystem support for hard links and canonical path requirements. Validate the destination in Settings, then retry failed jobs.
- **Approval required for publication**. Activity lists transfers in review. Inspect the retained hidden partial and destination. Compare the recorded hash and sizes. Preserve a copy and reconcile using an offline maintenance procedure.
- **Sign-in rejected**. Check the trusted issuer, exact callback, browser/server clocks, signed ID token and configured subjects/groups. Consult DSM SSO Server logs and `doctor`.
- **Dashboard unavailable**. Confirm internal DNS, proxy routing, certificate trust and supervisor logs. Check that the daemon is listening on the configured loopback port.
- **No push**. Open the installed app, check device permission and registration, then submit a test. Check Activity, VAPID key stability and outbound provider access. A successful submission can still be suppressed by device settings.
