# The protocol this app speaks

Everything here happens over plain PTP (ISO 15740) on the USB bulk endpoints. No
vendor operations are needed to read or write custom presets — only vendor
*properties*.

## Camera setup

| Step | Setting |
|---|---|
| Connection mode | `MENU → CONNECTION SETTING → CONNECTION MODE → USB RAW CONV./BACKUP RESTORE` |
| Shooting mode | P / A / S / M (AUTO and SP override custom settings) |
| Cable | a data-capable USB-C cable, not charge-only |

`USB TETHER SHOOTING FIXED` is also reported to work. On the X-S20 the modes live
under the network/USB menu; the camera must be switched on after the cable is in.

## Operations used

| Operation | Code | Used for |
|---|---|---|
| OpenSession | `0x1002` | start of every session (session id 1) |
| CloseSession | `0x1003` | clean teardown |
| GetDeviceInfo | `0x1001` | model, firmware, and the list of supported property codes |
| GetDevicePropDesc | `0x1014` | datatype, writability, and the camera's own allowed values |
| GetDevicePropValue | `0x1015` | read a preset field |
| SetDevicePropValue | `0x1016` | write a preset field |

Container layout (`js/ptp.js`): uint32 length, uint16 type, uint16 code, uint32
transaction id, then up to five uint32 params (command containers) or the payload
(data containers). A `SetDevicePropValue` is two writes — the command container,
then a data container carrying the value — followed by one response container.

## Properties

| Code | Meaning | Encoding |
|---|---|---|
| `0xD18C` | Custom slot selector | uint16, 1 = C1 … n = Cn. Everything below applies to the selected slot. |
| `0xD18D` | Preset name | PTP string: uint8 char count including NUL, then UCS-2LE. 16 characters reach the camera. |
| `0xD18E` | Image size | opaque — replayed verbatim |
| `0xD18F` | Image quality | opaque — replayed verbatim |
| `0xD190` | Dynamic range | raw percentage: 100 / 200 / 400 |
| `0xD191` | unknown (0 on every slot seen) | opaque |
| `0xD192` | Film simulation | enum, `0x01` Provia … `0x14` Reala Ace |
| `0xD193` | Monochromatic colour, warm/cool | ×10, black-and-white simulations only, refuses 0 |
| `0xD194` | Monochromatic colour, magenta/green | as above |
| `0xD195` | Grain effect | flat enum 1 Off, 2 Weak/Small, 3 Strong/Small, 4 Weak/Large, 5 Strong/Large |
| `0xD196` | Colour chrome effect | 1 Off, 2 Weak, 3 Strong |
| `0xD197` | Colour chrome FX blue | 1 Off, 2 Weak, 3 Strong |
| `0xD198` | Smooth skin effect | 1 Off, 2 Weak, 3 Strong |
| `0xD199` | White balance mode | uint16 enum; `0x8007` = colour temperature |
| `0xD19A` | WB shift, red | signed int16 |
| `0xD19B` | WB shift, blue | signed int16 |
| `0xD19C` | Colour temperature | uint16 Kelvin; only writable while WB is `0x8007` |
| `0xD19D` | Highlight tone | ×10 (`+1.5` → `15` → `0f 00`) |
| `0xD19E` | Shadow tone | ×10 |
| `0xD19F` | Colour | ×10; refused on black-and-white simulations |
| `0xD1A0` | Sharpness | ×10 |
| `0xD1A1` | High ISO NR | non-linear: −4 → `0x8000`, 0 → `0x2000`, +4 → `0x5000`, and often a sentinel. Never re-encoded here. |
| `0xD1A2` | Clarity | ×10; refused unless the camera is in still-image drive mode |
| `0xD1A3` | Long exposure NR | 0/1 |
| `0xD1A4` | Colour space | 1 sRGB, 2 Adobe RGB |
| `0xD1A5` | unknown (7 on every slot seen) | opaque |

Source: FilmKit's reverse engineering, confirmed on an X100VI. See `THIRD-PARTY.md`.

## Write sequence

`js/camera.js` writes a slot like this:

1. `SetDevicePropValue(0xD18C, slot)`, then a ~120 ms pause — the camera needs a
   beat before the slot's fields are readable.
2. `SetDevicePropValue(0xD18D, name)`.
3. The plan's property writes, in `WRITE_ORDER` (`js/props.js`): film simulation
   first, then white balance, then colour temperature, then everything else.
   The order matters because the camera evaluates later writes against the values
   already in the slot — colour temperature is refused unless WB is already set to
   colour temperature, and colour is refused once a monochrome simulation is in.
4. A verification pass: read every accepted property back and compare bytes.

Refusals are per-property and non-fatal. `PTPResp.InvalidDevicePropValue` on
dynamic range usually means the current ISO is too low for DR200/DR400; on clarity
it usually means the camera is not in still-image drive mode.

## Two rules that keep this safe

**Captured bytes beat re-encoding.** A recipe read off a camera stores the raw
bytes of every property alongside the decoded values. Writing it back replays
those bytes verbatim for anything whose encoding is not fully understood, so a
capture → write round trip is byte-exact even where the model is wrong.

**Nothing is written blind.** The app reads all slots before its first write of a
session and keeps that snapshot (in the browser, and downloadable), so any slot
can be put back.

## Verifying the map on a new body

The property table is confirmed on an X100VI, not an X-S20. To check it:

1. Program one slot by hand in the camera menu with values you can recognise
   (highlight `+1.5`, colour `-2`, grain Strong/Large, and so on).
2. Connect, press **Read slots**, and compare the log line for that slot against
   what you entered.
3. Anything that does not line up is a wrong entry in `PRESET_PROPS` — the raw hex
   in the recipe's `raw` map shows what the camera actually returned.

## Wireless

Not implemented. Fujifilm's wireless transport is a non-standard PTP/IP on port
55740 (ISO-compliant REQ/ACK for the handshake, USB-style PTP packets afterwards)
with a pairing step; `libfuji` has it decoded. Whether `0xD18C`–`0xD1A5` are
reachable in any wireless mode is unverified — the camera ties the RAW-conv mode
to USB. If it turns out they are, only a new transport class is needed: everything
above `sendCommand`/`sendDataCommand` is transport-agnostic.
