# Canon Camera Control API research

## Sources and model support

Canon added CCAPI to the EOS R6 Mark II in firmware 1.7.0. The supplied **Camera Control API Reference v1.4.0 Rev. 1.6** lists the model and its supported operations in section 6.3.17. The library uses the version groups listed there. The reference and Canon tooling are distributed separately by Canon. [Firmware notice](https://www.usa.canon.com/support/canon-product-advisories/Firmware-Notice-EOS-R6-Mark-II-Firmware-Version-1-7-0) · [US SDK program](https://www.usa.canon.com/support/sdk) · [Canon Asia SDK list](https://asia.canon/en/campaign/developerresources/sdk)

| Function | Documented operation used |
| --- | --- |
| Identity | GET `/ccapi/ver100/deviceinformation` to read the product name and verify the configured serial. |
| Storage enumeration | GET `/ccapi/ver120/contents` and GET the returned card paths to find directories on both mounted slots. |
| Media listing and metadata | GET directory counts, list pages of up to 100 entries, and GET per-file information for byte size and last modification time. |
| Originals and previews | GET the original stream with `kind=main` and optionally a bounded JPEG with `kind=thumbnail`. |
| Camera status | GET storage and battery-list information in version group 1.1.0 after enumeration, when available. |

Section 3.2 and the common 401 description specify Digest authentication. The application supports Canon's MD5 challenge with `qop=auth` over verified HTTPS. CA trust can be selected by credential profile. The app allows an HTTP camera URL for unauthenticated operation on an approved local network. Where camera HTTPS is available, prefer it. The NAS daemon never sends Synology credentials to a camera.

Canon documents UPnP discovery, event monitoring and polling, and byte-range downloads. Canon Photo Sync uses an explicit camera address, periodic enumeration, and whole-file streaming. A busy camera is retried, and the built-in adapter permits one simultaneous transfer per camera. The app sends only GET requests; its adapter exposes no capture or camera settings operations. When an optional custom `ccapiModule` is configured in the bootstrap, that trusted module still takes precedence.

## First connection

### Check whether you need activation

1. Confirm the EOS R6 Mark II is on firmware 1.7.0. Open **Wi-Fi settings** and look for **Camera Control API**. If the menu is present, proceed to the Wi-Fi setup below. Canon's **Camera Control API Operation Guide, English Rev. 1.3**, also says that separate activation is unnecessary when the camera's Advanced User Guide describes CCAPI.
2. If the menu is absent, confirm with Canon that the supplied Activation Tool supports your R6 Mark II and firmware before running it. Rev. 1.3 illustrates an EOS R100, and the English R6 Mark II Advanced User Guide for firmware 1.7.0 or later did not contain a CCAPI section when checked. The firmware notice confirms CCAPI support without specifying activation steps. [R6 Mark II Advanced User Guide](https://cam.start.canon/en/C012/manual/c012.pdf) · [Firmware notice](https://www.usa.canon.com/support/canon-product-advisories/Firmware-Notice-EOS-R6-Mark-II-Firmware-Version-1-7-0)
3. If Canon confirms activation is needed, follow section 4 of the supplied Operation Guide and the tool's instructions. It uses a Windows or Mac computer with internet access and connects one camera via USB. Check that **Camera Control API** appears after activation.

### Join the LAN and test the NAS connection

1. In **Wi-Fi settings → Camera Control API**, choose **Add connection → Add with wizard**. The labels are from section 6 of Rev. 1.3 and may vary by model.
2. Choose the Wi-Fi network the NAS can reach. Select its SSID, enter its password, and choose **Auto setting** for the IP address unless your network requires manual settings. Set a DHCP reservation on your router if you want the address to stay stable. Canon's **Camera access point mode** is the separate direct-connection workflow.
3. Read the URL shown by the camera. In Canon Photo Sync, add the camera paused with the displayed scheme, host, and port, dropping the `/ccapi` path if present. For example, `https://camera.example.invalid:8443/ccapi` becomes `https://camera.example.invalid:8443`. Enter the camera's serial and check the NAS allowlist for its network.
4. If Digest is enabled on the camera, use the camera's HTTPS endpoint and assign a matching private credential profile in the app. For example, inside `cameras` in `secrets.json`, create a profile called `r6` with `"digest": {"username": "...", "password": "..."}`. Add `"ca": "..."` to the same profile if the camera uses a private CA. The value is the trusted PEM certificate. Use an address that matches the camera certificate, then restart the daemon after editing its secrets. Rev. 1.3 covers Wi-Fi setup and does not specify how to configure HTTPS certificates or Digest on the R6 Mark II. The separate CCAPI Reference documents the protocol.
5. Run **Test connectivity**, then **Estimate matching media**. Resume the camera for a small test import into a disposable NAS folder.
6. To reopen a saved camera connection, use **Wi-Fi settings → Camera Control API → Connect** and select the saved entry. Rev. 1.3 documents this manual reconnect. Verify on the physical R6 Mark II what happens after it sleeps or loses power.

## Physical validation still required

- Verify activation, Wi-Fi reconnection, sleep, shooting behavior, product/serial values, HTTPS certificate verification and authentication on the actual firmware. Canon documents that enumeration and content access can be unavailable during shooting, recording, movie mode, or another content operation.
- Validate both slots and compare the streamed JPEG, CR3, HEIF and supported video formats to independent card copies. Verify available preview formats, larger cards, and camera battery/space readings.
- The metadata operation supplies modification time and source size. Compare camera timestamps to trusted UTC and use a small test batch before enabling the new-files-only policy. The adapter supplies no capture timestamp or source checksum. The app verifies source size and computes a local SHA-256.
- Range requests, discovery, event notifications, and firmware-specific behaviors remain outside the adapter's initial implementation. See the [hardware validation checklist](HARDWARE_VALIDATION.md).
