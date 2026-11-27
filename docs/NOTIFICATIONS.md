# Notifications

Push uses VAPID and standards-based encrypted payloads. The app persists its private key once. Allow outbound HTTPS and DNS for enrolled providers, including `*.push.apple.com` for Apple. No inbound route is needed. A phone away from home can receive push; opening the app still requires trusted LAN or the existing VPN.

Global defaults, per-camera overrides and per-device suppressions are evaluated when an event is enqueued. Lock-screen privacy is on by default. Device quiet hours use the saved UTC offset from the browser, which may need updating after daylight-saving changes or travel. Urgent exceptions are configurable. Test submissions target registered devices for the signed-in subject. Device registration from Settings can renew the browser subscription. Provider 404 and 410 invalidate the registration. Retryable failures are backed off and bounded. A submitted result means provider acceptance.

The engine groups work per camera and sends a completion event after the configured quiet period when known queued and active work has settled. Completion with errors is separate. An interrupted download does not generate a successful completion while retries remain pending. Batch membership and completion deduplication persist across restarts. Duplicate transfers do not add to imported bytes. Delivery after a daemon failure can repeat an accepted message if the process stops before recording submission.

[Apple Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
