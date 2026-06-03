# Legion GO Driver Manager

Open-source tool to download and install official Lenovo drivers for the **Legion GO (8APU1)**.

Unlike tools with hardcoded URLs, this fetches the driver list **live from Lenovo's official support API** every time it opens — so you always get the latest versions with no manual updates needed.

## What it does

- Fetches all drivers for the Legion GO from `pcsupport.lenovo.com`
- Shows drivers grouped by category (Audio, BIOS, Chipset, GPU, etc.)
- **Verifies SHA256 checksums** before installing — every file is authenticated against Lenovo's own hash
- Download-only mode, or download + silent install
- All download URLs are `download.lenovo.com` — no third-party mirrors

## Drivers it finds

| Category | Examples |
|---|---|
| BIOS / UEFI | BIOS Update |
| Display & Graphics | AMD Graphics Driver |
| Chipset | AMD Chipset Driver |
| Audio | Realtek Audio Driver |
| Bluetooth | Mediatek Bluetooth Driver |
| Wireless LAN | Mediatek WLAN Driver |
| Camera & Card Reader | CardReader Driver |
| Power Management | Lenovo Energy Management |
| Software & Utilities | Legion Space |

## Running from source

```bash
git clone https://github.com/your-username/legion-go-drivers
cd legion-go-drivers
npm install
npm start
```

Requires [Node.js](https://nodejs.org) 18+ and [npm](https://npmjs.com).

## Building a Windows installer

```bash
npm run build
```

Outputs to `dist/`. Requires Windows or a Windows build environment.

## Security model

- No hardcoded download URLs — the driver list is fetched fresh from Lenovo each launch
- Every downloaded file is verified against the SHA256 checksum published by Lenovo before any installer runs
- All downloads originate from `download.lenovo.com`
- No telemetry, no analytics, no network requests other than to `pcsupport.lenovo.com` and `download.lenovo.com`

## License

MIT
