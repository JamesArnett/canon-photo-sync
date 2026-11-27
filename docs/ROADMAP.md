# Roadmap

1. Validate the built-in Canon adapter against target hardware, focusing on reconnect, authentication, both storage slots, timestamps, and camera thumbnails.
2. Run hardware validation on the target camera, DSM, proxy, SSO package and iPhone. Capture NAS resource and power measurements.
3. Add an authenticated publication reconciliation flow and failure-injection tests at every SQLite/filesystem publication transition.
4. Expand embedded RAW JPEG and local thumbnail support using bounded decoders. Expand browser coverage beyond the Chromium smoke test and add resource soak testing for real-size libraries.
5. Evaluate reliable CCAPI events and liveness before introducing camera event subscriptions or SSE across the DSM reverse proxy.
