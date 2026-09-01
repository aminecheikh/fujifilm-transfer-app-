# Why USB-only, why a web app, and what a phone app would take

## Why wireless is not in

Two separate reasons — one is a hard blocker for *this* architecture, the other is
an unknown about the camera.

### 1. A browser cannot open a TCP socket (hard blocker)

Fujifilm's wireless protocol is PTP/IP: a raw TCP connection to the camera on port
**55740** (plus 55742 for live view, 51560 for the tether handshake), using
ISO-compliant PTP/IP REQ/ACK packets for the handshake and USB-style PTP packets
afterwards.

Browsers expose WebUSB, but there is no equivalent for raw TCP. `WebSocket` needs a
WebSocket server on the other end; the camera speaks plain TCP. So a page served to
a browser physically cannot talk to the camera over Wi-Fi, no matter what the
camera supports. Wireless requires either:

* a **native app** (Android or iOS — both can open TCP sockets), or
* a **local bridge**: a small desktop process that holds the socket and relays to
  the page over WebSocket. That works, but it means running a program on a
  computer, which defeats the point of going wireless in the field.

USB is the opposite: WebUSB exists, so the zero-install web app can drive it.

### 2. Whether the preset properties exist in a wireless mode (unknown, but promising)

The custom-preset properties (`0xD18C`–`0xD1A5`) were mapped in **USB RAW
CONV./BACKUP RESTORE** mode. In libfuji's transport enum that mode
(`FUJI_FEATURE_RAW_CONV`) is USB-only; the wireless features are separate
(`FUJI_FEATURE_WIRELESS_TETHER`, `FUJI_FEATURE_WIRELESS_COMM`,
`FUJI_FEATURE_AUTOSAVE`).

But FujiStyle reports its recipe import also works in **USB TETHER SHOOTING
FIXED** — and the X-S20 manual confirms the camera has **WIRELESS TETHER SHOOTING
FIXED**, the same tether feature over Wi-Fi. If the preset properties are exposed
in tether mode, then wireless recipe writing is very likely reachable through
wireless tether. Nobody has published a confirmation, and FujiStyle lists its own
wireless support as "coming soon", so treat it as plausible and untested.

**How to settle it in an afternoon:** put the camera in WIRELESS TETHER SHOOTING
FIXED, connect from a machine that can open sockets, run libfuji's handshake, and
try `GetDevicePropValue(0xD18C)`. If it answers, wireless works; if it returns
`DevicePropNotSupported`, it does not.

Note also `PTP_DPC_FUJI_SetUSBMode` (`0xD15D`) and `PTP_DPC_FUJI_USBMode`
(`0xD16E`, where 5 = tether and 6 = raw conv): the mode may be switchable over the
wire rather than only through the camera menu.

## Platform matrix

| Platform | USB | Wireless | Cost |
|---|---|---|---|
| **Android** — this web app | ✅ works today: Chrome has WebUSB, USB-C OTG cable | ❌ no TCP in a browser | free |
| **Android** — native app | ✅ USB Host API | ✅ plausible (sockets are unrestricted); Fudge already does Fuji wireless on Android | $25 one-off to publish; free to sideload |
| **iPhone** — any browser | ❌ **no WebUSB on iOS** — every iOS browser is WebKit underneath, Chrome and Firefox included | ❌ | — |
| **iPhone** — native app | ✅ `ImageCaptureCore` → `ICCameraDevice.requestSendPTPCommand` (iOS 13.2+, needs `NSCameraUsageDescription`) | ✅ `Network.framework` raw TCP — no cable at all | $99/yr, or free 7-day sideload with a Mac + Xcode |
| **Desktop** (Linux/macOS) | ✅ this web app | via a local bridge | free |
| **Desktop** (Windows) | ⚠️ the WPD/MTP driver claims the camera, so WebUSB usually cannot; needs a native build through WPD | via a local bridge | free |

## The iPhone picture in more detail

An iOS app is the one route to using this in the field with an iPhone, and there
are two ways in.

**USB (proven).** The Fuji X Weekly app does exactly this today — iOS, USB-C
cable, PTP, X-S20 on its supported list — so `requestSendPTPCommand` on a real
iPhone is known to work. Caveats: iPhone 15 or later for a native USB-C data port
(earlier iPhones need the Lightning-to-USB camera adapter, and third-party
adapters are unreliable), and there are developer reports of `ICDeviceBrowser`
failing to enumerate cameras on iOS 18, so the framework needs testing on the
target OS version before committing.

Worth being precise about one thing that muddies searches: Apple's *AVCaptureDevice*
external-camera support genuinely does not work on iPhone (iPad only). That is live
video capture, a different framework from ImageCaptureCore/PTP, and it says nothing
about this use case.

**Wireless (unproven, but the better product if it works).** On iOS, raw TCP is
allowed via `Network.framework`, so wireless is not blocked the way it is in a
browser — and for field use it is plainly nicer: no cable, no adapter, phone in one
hand. The work is bigger: Fuji's PTP/IP handshake and pairing (Bluetooth handover
in the X App flow), plus confirming the preset properties are reachable in wireless
tether mode. libfuji implements the handshake in C and is MIT licensed, so it can
be compiled into an iOS app rather than reimplemented in Swift.

**Cost, honestly.** Free means the web app on Android, or a laptop. An iOS app
cannot be distributed for free: $99/yr for the Apple Developer Program (App Store
or TestFlight), or a free Apple ID with Xcode on a Mac, which signs the app onto
your own phone for 7 days before it needs re-signing.

## Reusing what is already here

The layers above the transport are transport-agnostic on purpose. `js/camera.js`,
`js/props.js` and `js/plan.js` only need an object with `sendCommand` and
`sendDataCommand`. A wireless transport is a third implementation alongside
`WebUsbTransport` and `MockCameraTransport` — everything else stays as it is. A
Swift or Kotlin port would follow the same split: the property map and the write
ordering are the valuable part, and they are protocol-level, not platform-level.
