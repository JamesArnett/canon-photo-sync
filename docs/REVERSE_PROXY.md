# DSM reverse proxy

Use a dedicated HTTPS subdomain reachable only from your actual trusted LAN or existing VPN. Point internal DNS at the NAS and assign a TLS certificate and chain that iOS trusts. The origin must stay stable for cookies, the OIDC callback, the service worker and Web Push registrations.

1. Open **Control Panel → Login Portal → Advanced → Reverse Proxy** and create an HTTPS source using the dedicated hostname and port 443. Forward to HTTP `127.0.0.1:8787`, or the configured backend port. Preserve the source Host header and overwrite forwarded host and scheme with the expected hostname and `https` if those headers are emitted. The app uses its configured origin for redirects and ignores forwarded client addresses.
2. Create and assign a DSM **Access Control Profile** allowing your actual LAN and optionally trusted VPN CIDRs. Deny other sources including IPv6 sources you have not authorized. Verify compatibility with IPv4/IPv6 DNS and listener behavior.
3. Under **Security → Certificate → Settings**, assign the existing trusted certificate to the new proxy entry. Validate renewal preserves that assignment and that issuer and app certificates both remain trusted from the NAS and iPhone. For a private CA, install it through your existing trust process and enable full trust on iPhone when applicable.
4. Register the exact app callback URL in OIDC and test the dedicated origin. Check from outside the home network, including IPv6 if enabled, that neither the app nor its SSO endpoint is exposed. Check other existing publicly reachable virtual hosts cannot route this Host to the app.
5. Keep the backend loopback-only. Leave router, firewall, DSM account protection and public proxy policy under existing management. Path-prefix deployments are unsupported because the app uses root-scoped callbacks, routes and service worker assets.

[DSM Login Portal](https://kb.synology.com/en-me/DSM/help/DSM/AdminCenter/system_login_portal_advanced)
