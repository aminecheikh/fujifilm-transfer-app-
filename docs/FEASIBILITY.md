# Feasibility: transferring film simulation recipes to a Fujifilm X-S20

Research notes, September 2026. Target camera: **X-S20** (4 custom slots, C1–C4).

> **Status:** built. The app in this repository implements the USB path described
> below — recipe library, write to C1–C4 with read-back verification, slot capture
> and backup. See the root `README.md` and `docs/PROTOCOL.md`.

## Verdict

**Yes — doable, and doable for $0.** It is not speculative: the protocol is already
reverse-engineered, an MIT-licensed reference implementation exists, and three
shipping apps already do it (one for free) with the X-S20 explicitly on their
supported list.

**But it does not give you more than 4 slots.** Nothing on the host side can add
custom-setting slots to the body — the 4 slots are a firmware limit. What an app
buys you is:

* an unlimited recipe *library* on the phone/laptop, and
* instant reprogramming of C1–C4 (seconds, instead of ~20 menu presses per recipe).

So the realistic product is "swap the 4 slots on demand / by shooting set", not
"unlimited recipes in camera". If the goal was literally more slots, the only
route is camera-side firmware patching (see fujihack below), which is not
realistic for a usable product.

## How it actually works

Plain PTP over USB. No vendor operations needed.

1. Camera: `MENU → CONNECTION SETTING → CONNECTION MODE →`
   **`USB RAW CONV./BACKUP RESTORE`** (this mode exists on the X-S20 and is what
   X RAW STUDIO / X Acquire use). `USB TETHER SHOOTING FIXED` also reportedly works.
2. Shooting mode must be P/A/S/M — AUTO/SP override the recipe.
3. Standard PTP session, then read/modify/write device properties.

### Opcodes (all ISO 15740 standard)

| Op | Code |
|---|---|
| OpenSession | `0x1002` |
| GetDevicePropValue | `0x1015` |
| SetDevicePropValue | `0x1016` |
| CloseSession | `0x1003` |

(`0x900C`/`0x900D` SendObjectInfo/SendObject2, `0x1007`/`0x1009`/`0x100B` and
`0xD185`/`0xD183` are the *RAW conversion* path — only needed if you also want
X RAW STUDIO-style RAF→JPEG rendering, not for writing recipes.)

### Device properties that matter

| Property | Meaning |
|---|---|
| `0xD18C` | **custom slot selector** — 1..7 for C1..C7; on the X-S20 expect 1..4 |
| `0xD18D` | preset name (PTP string) |
| `0xD18E` – `0xD1A5` | the 24 recipe parameters (film sim, DR, highlight/shadow, colour, sharpness, NR, grain, colour chrome, clarity, WB + shift, …) |

Write sequence per recipe: `SetDevicePropValue(0xD18C, slot)` → write `0xD18D`
name → write each of `0xD18E..0xD1A5`. Read the slot back to verify.

Source for these codes: **FilmKit** (`eggricesoy/filmkit`, MIT, TypeScript) — a
browser/WebUSB app that already reads and writes these presets. Its
`QUICK_REFERENCE.md` is the single most valuable document for this project.

### Known protocol gotchas (documented by FilmKit / FujiStyle / Fuji X Weekly)

* Some properties have conditional writes: High ISO NR uses a **non-linear
  proprietary encoding** (lookup table, not a linear scale); colour temperature
  only writes if WB mode is already Color Temp; monochrome film sims reject colour
  writes.
* Dynamic Range writes are rejected if ISO is too low; Clarity is rejected unless
  the camera is in still-image drive mode.
* Not settable at all: ISO, exposure compensation, video recipes.
* Property codes and their meanings are **per-model** — FilmKit is verified only
  on the X100VI. Everything must be confirmed empirically on the X-S20.

## Prior art

| Project | What it is | Relevance |
|---|---|---|
| [FilmKit](https://github.com/eggricesoy/filmkit) | MIT, TypeScript, WebUSB, browser-based preset read/write + RAW conversion | **The reference implementation.** Verified on X100VI, "likely" others. Author does not accept PRs. |
| [Fuji X Weekly app](https://fujixweekly.com/2026/08/20/new-send-recipes-to-your-camera-directly-from-the-fuji-x-weekly-app/) | iOS, PTP over USB-C; X-S20 listed as supported | Sending single recipes is **free**; recipe *sets* need a Patron sub. Android "coming soon". |
| [FujiStyle](https://www.fujistyleapp.com/) | iOS + Android, USB, 50+ bodies incl. X-S20, freemium | Confirms tether-mode also works; wireless "coming soon" |
| [Fuji Recipes](https://fujirecipes.co/) | iOS + Android, USB-C, X-S20 listed | 130+ recipes to C1–C7 |
| [petabyt/libfuji](https://github.com/petabyt/libfuji) + [libpict](https://github.com/petabyt/libpict) | MIT C libraries; USB + WiFi, covers Xapp/Camera Connect, BLE pairing, autosave, tether, RAW-conv modes | Best base for a **native** app, esp. for the WiFi path |
| [petabyt/fp](https://github.com/petabyt/fp) | parses/validates X RAW Studio profile blobs | Profile format work |
| [hkr/fuji-cam-wifi-tool](https://github.com/hkr/fuji-cam-wifi-tool) | older WiFi RE (X-T10/X-T2 era): connect, shutter, ISO, WB, live view | Proof WiFi control is reachable |
| [fujihack](https://github.com/fujihack/fujihack) | firmware RE, PTP/USB debugger with read/write/exec | The only conceivable "more than 4 slots" route; high risk, not a product |
| libgphoto2 | supports Fuji X bodies over USB PTP | Handy for probing properties from a shell |

## Cable vs WiFi

**Cable (USB): proven, do this first.** The recipe properties live in the
USB-labelled connection modes, all three shipping apps use USB, and the codes above
are documented.

**WiFi: possible in principle, materially harder, and unverified for recipe
writing.** Fuji uses a *non-standard* PTP/IP: ISO-compliant REQ/ACK packets for the
handshake but USB-style PTP packets for everything after, on port **55740** instead
of the standard 15740, plus a pairing/handshake dance. libfuji and
fuji-cam-wifi-tool have that decoded and can change shooting settings wirelessly.
What is **not** established is whether `0xD18C`/`0xD18D`/`0xD18E..0xD1A5` are
exposed in any wireless mode — the camera's menu ties the RAW-conv/backup mode to
USB. FujiStyle listing wireless as "coming soon" suggests it is not trivially
available. Treat WiFi as phase 3, after USB works.

## Platform choice (cost matters here)

| Option | Cost | Notes |
|---|---|---|
| **Web app + WebUSB** | $0 | Chrome/Edge/Brave on desktop **and Android**; needs HTTPS (GitHub Pages is fine); no store, no signing, no install. **Recommended MVP.** |
| Native desktop (libusb / libfuji) | $0 | Linux needs udev rules; **Windows is the trap** — the camera is claimed by the WPD/MTP kernel driver, so raw USB access needs a WPD translation layer ([libwpd](https://github.com/petabyt/libwpd)) or a driver swap. |
| Android native | $25 one-off | Android USB-Host API works well; only needed if WebUSB proves insufficient |
| iOS native | $99/yr | Technically possible: `ImageCaptureCore` → `ICCameraDevice.requestSendPTPCommand` (iOS 13.2+, needs `NSCameraUsageDescription`). This is how the Fuji X Weekly iOS app does it. External-USB support on iPhones is inconsistent; iPads are better. Not "free". |

## Suggested build order

1. **Verify before writing any code.** Put the X-S20 in `USB RAW CONV./BACKUP RESTORE`
   and open FilmKit in Chrome. If it reads and writes C1–C4, the whole project is
   de-risked in ten minutes. If it doesn't, capture the traffic and diff against
   FilmKit's property table.
2. **Probe and record the X-S20 property map** — dump `0xD18C..0xD1A5` for each of
   the 4 slots, with known-good recipes in them, and build a model-specific
   property/enum table (film sim enum values in particular).
3. **MVP:** static web app — recipe library in JSON/localStorage, WebUSB transport,
   "write recipe → slot 1..4", read-back verification, import/export recipes as
   JSON.
4. **Then:** recipe *sets* (write all 4 slots in one action — this is the feature
   that actually addresses the 4-slot limit), plus read-current-slots-to-library.
5. **Optional:** whole-camera settings backup/restore as a second path (X Acquire /
   Fujifilm X App do this over USB, and the X App does it over WiFi to a phone) —
   swaps every slot at once as an opaque blob. Fine as a bulk mechanism, poor for
   per-recipe editing, and model-specific.
6. **Optional, later:** WiFi via libfuji.

## Risks

* Per-model property differences: the X-S20 pairs an X-Trans IV sensor with
  X-Processor 5, so its film-simulation enum values and available parameters sit
  somewhere between the X-S10 and X-T5 generations. Nothing here is verified on an
  X-S20 yet.
* A bad property write can leave a slot in a weird state — always read back, and
  offer "back up my current 4 slots" before the first write.
* Recipe *content* is other people's work: Fuji X Weekly / FujiStyle recipe lists
  are copyrighted editorial content. Ship the transfer engine and let users enter
  or import their own recipes; do not scrape a recipe database into the app.
* Reverse-engineering PTP for interoperability is well-trodden (libgphoto2 has done
  it for 25 years), but don't redistribute Fujifilm binaries or firmware.

## Bottom line

A free, open-source web app that pushes recipes into the X-S20's C1–C4 over USB is
a weekend-to-a-few-weekends project standing on FilmKit's property table. Just be
clear with yourself about the payoff: it removes the *tedium* of the 4-slot limit,
not the limit.
