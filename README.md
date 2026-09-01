# Fujifilm Recipe Transfer

Keep an unlimited library of film simulation recipes in the browser, and push any
of them into your camera's custom slots (C1–C4 on an X-S20) over USB in a couple
of seconds — instead of thumbing through the menu for every change.

No build step, no dependencies, no account, no cost. One static page that talks
PTP to the camera over WebUSB.

> This cannot add slots — four is a firmware limit on the X-S20. What it removes
> is the tedium of reprogramming them, and it gives the four slots a library to
> draw from. Save recipes as *sets* ("Street", "Travel") and swap all four at once.

## What it does

* **Library** — unlimited recipes, stored in your browser, exportable as JSON.
* **Write** — send a recipe to any slot, with a read-back check on every field.
* **Sets** — assign recipes to C1–C4 and write the whole set in one action.
* **Capture** — read what's already in the camera's slots into the library.
* **Backup** — the slots are read and snapshotted before the first write, and
  "Back up to file" saves a copy you can keep.
* **Demo mode** — a simulated X-S20 so you can try everything without hardware.

Every camera refusal and mismatch is reported per field in the activity log
rather than silently swallowed.

## Run it

```sh
git clone https://github.com/aminecheikh/fujifilm-transfer-app-
cd fujifilm-transfer-app-
python3 -m http.server 8000     # or: npm run serve
```

Open <http://localhost:8000> in Chrome, Edge or Brave — desktop or Android.
WebUSB needs a secure context, so `localhost` or https, not `file://`. Hosting it
on GitHub Pages works and costs nothing.

## Camera setup

1. `MENU → CONNECTION SETTING → CONNECTION MODE → USB RAW CONV./BACKUP RESTORE`
2. Shooting mode **P/A/S/M** — AUTO and SP override custom settings.
3. A **data** USB-C cable (charge-only cables do nothing), then switch the camera on.
4. Press **Connect camera** and pick it from the browser's device list.

### Platform notes

* **Linux** — needs a udev rule so the browser may claim the device:
  `SUBSYSTEM=="usb", ATTR{idVendor}=="04cb", MODE="0666"` in
  `/etc/udev/rules.d/70-fujifilm.rules`, then `sudo udevadm control --reload`.
* **Windows** — the WPD/MTP kernel driver claims the camera, so WebUSB usually
  cannot. Android or Linux/macOS is the easy path; on Windows a native build
  through the WPD layer would be needed.
* **Android** — works in Chrome with a USB-C OTG cable.
* **iOS** — no WebUSB. iOS would need a native app using `ImageCaptureCore`.

## First run

1. **Demo mode** first, to see the shape of it.
2. Connect for real, then **Read slots** — this is your backup, and it also tells
   you whether the property map matches your body (see below).
3. **Save to library** on a slot you like, or **New recipe** to enter one by hand.
4. Assign recipes to slots, then **Write** one or **Write all assigned**.

## Is the property map right for your camera?

The property codes are confirmed on an X100VI (via
[FilmKit](https://github.com/eggricesoy/filmkit)) and are **unverified on the
X-S20**. Fields whose encoding is a best guess are tagged `unverified` in the
editor. To check: program one slot by hand with values you'll recognise, press
**Read slots**, and compare against the log. Anything off is a wrong row in
`PRESET_PROPS` in `js/props.js` — and the raw hex the camera returned is stored on
the captured recipe, so the fix is usually obvious.

Recipes captured from the camera store raw bytes as well as decoded values, and
those bytes are replayed verbatim, so capture → write round trips are exact even
where the decoding model is wrong.

## Layout

| Path | What's in it |
|---|---|
| `index.html`, `styles.css` | the page |
| `js/ptp.js` | PTP containers and the WebUSB transport |
| `js/camera.js` | session, slot read/write, verification |
| `js/props.js` | the property map, encodings and conditional-write rules |
| `js/plan.js` | recipe → ordered list of property writes |
| `js/store.js` | library and sets, import/export |
| `js/mock-camera.js` | the simulated camera behind demo mode and the tests |
| `js/app.js` | UI |
| `test/` | 25 tests, `npm test`, no dependencies |
| `docs/PROTOCOL.md` | the protocol in detail |
| `docs/FEASIBILITY.md` | the research this was built from |

## Tests

```sh
npm test
```

Node's built-in runner, no install step. They cover container packing, value
encodings, the conditional-write rules, and full slot write/verify/capture round
trips against the mock camera.

## Limitations

* Four slots stay four slots.
* ISO, exposure compensation and video recipes cannot be written — the camera
  does not expose them as preset properties.
* Dynamic range above DR100 is refused when the current ISO is too low; clarity is
  refused unless the camera is in still-image drive mode. Both are reported.
* USB only for now. See the wireless section in `docs/PROTOCOL.md`.
* Not affiliated with or endorsed by Fujifilm.

## Licence

MIT — see `LICENSE`. Reverse-engineering credit in `THIRD-PARTY.md`.
