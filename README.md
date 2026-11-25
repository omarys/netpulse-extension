# NetPulse Outage Diagnostics

A GNOME Shell extension (45–51) that runs layered network health diagnostics from the top bar so you can tell at a glance whether a drop is local Wi-Fi/router, ISP WAN routing, DNS, or HTTP/captive-portal related.

## Features

- **4-layer diagnostics:**
  1. **Local Interface & Gateway** — inspects active links via native `NetworkManager` (`NM.Client`) and pings the default gateway.
  2. **WAN / ISP Routing** — ICMP reachability and round-trip latency to a configurable public IP (`1.1.1.1` by default).
  3. **DNS Resolution** — live lookup timing via `Gio.Resolver` (`fedoraproject.org` by default).
  4. **HTTP / Captive Portal** — end-to-end HTTP/HTTPS check via `Soup 3.0` (`https://fedoraproject.org/static/hotspot.txt` by default).
- **Top-bar status & latency badge** — color-coded status icon with an optional live WAN latency badge and a root-cause diagnosis banner in the popup menu.
- **Automatic outage route tracing** — runs parallel `mtr` captures (falling back to `traceroute` or `tracepath`) against `1.1.1.1` and `8.8.8.8` when an outage is detected.
- **On-demand speed test** — measures latency, download, and upload throughput via Cloudflare HTTP endpoints directly from the menu.
- **Copyable diagnostic report** — exports the latest layer results, `nmcli device status`, `ip route` (IPv4/IPv6), speed test, and outage trace to the clipboard.
- **Rotating JSONL logs & notifications** — appends structured diagnostics and outage traces to `~/.local/state/netpulse/logs/netpulse.log` with configurable retention, plus optional desktop notifications on outage and recovery.
- **Power-aware polling** — automatically pauses background checks while the screen is locked or when no network link is active.

## Requirements

- **GNOME Shell:** 45, 46, 47, 48, 49, 50, or 51
- **System libraries:** `NetworkManager`, `libsoup3`, `libadwaita`, `glib2` (`glib-compile-schemas`)
- **Optional CLI tools:**
  - `mtr` (recommended), `traceroute`, or `tracepath` for automatic outage route traces
  - `ip` (`iproute2`) and `nmcli` for routing table and device status in exported reports

## Installation

### From source (with `mise`)

```bash
git clone https://github.com/omarys/netpulse-extension.git
cd netpulse-extension
mise run install-enable
```

### Build & install bundle manually

```bash
git clone https://github.com/omarys/netpulse-extension.git
cd netpulse-extension
gnome-extensions pack \
  --extra-source=diagnostics.js \
  --extra-source=logger.js \
  --schema=schemas/org.gnome.shell.extensions.netpulse.gschema.xml \
  --force
gnome-extensions install --force netpulse@omary.github.io.shell-extension.zip
gnome-extensions enable netpulse@omary.github.io
```

> **Wayland note:** GNOME Shell on Wayland only discovers newly installed extensions after logging out and back in (or in a nested session via `dbus-run-session -- gnome-shell --nested --wayland`).

## Preferences

Open extension preferences from the NetPulse menu or via `gnome-extensions prefs netpulse@omary.github.io`:

| Setting | Default | Description |
| --- | --- | --- |
| Check Interval | `15` s | Polling frequency (`5`–`3600` seconds) |
| Show Latency Badge | `true` | Show live WAN latency next to the top-bar icon |
| Public IP Target | `1.1.1.1` | Target for WAN ICMP checks |
| DNS Test Domain | `fedoraproject.org` | Domain resolved during DNS checks |
| HTTP Check Endpoint | `https://fedoraproject.org/static/hotspot.txt` | URL used for HTTP and captive-portal checks |
| Notify on Network Outage | `true` | Desktop notification on outage detection and recovery |
| Log Rotation Interval | `3` days | Days before rotating `netpulse.log` (`1`–`90`) |

## Logs

Diagnostic checks and `outage_trace` captures are stored as newline-delimited JSON in:

```text
~/.local/state/netpulse/logs/netpulse.log
```

## Development

Tasks are defined in [`mise.toml`](mise.toml):

```bash
mise run check          # Validate metadata.json, GSettings XML, and JS syntax
mise run pack           # Build extensions.gnome.org zip bundle
mise run install        # Compile schemas and symlink into ~/.local/share/gnome-shell/extensions/
mise run install-enable # Install and enable the extension
mise run uninstall      # Disable and remove the local symlink
mise run clean          # Remove compiled schemas and zip archives
```
