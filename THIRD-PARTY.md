# Third-party work this project builds on

No third-party code is bundled here — the app has no dependencies and no build
step. What it does reuse is *knowledge*: the Fujifilm custom-preset property
codes and their encodings.

## FilmKit — github.com/eggricesoy/filmkit (MIT)

The property map in `js/props.js` (slot selector `0xD18C`, preset name `0xD18D`,
the 24 preset parameters `0xD18E`–`0xD1A5`) and the encoding notes it carries
come from FilmKit's reverse-engineering work, which confirmed them on an X100VI
via preset cross-referencing and Wireshark captures. Specifically:

* the ×10 encoding of tone/colour/sharpness/clarity values,
* the 1-indexed effect encoding (1 = Off, 2 = Weak, 3 = Strong),
* the flat grain enum (1–5 rather than a packed strength/size byte pair),
* dynamic range stored as a raw percentage (100/200/400),
* white-balance mode values including `0x8007` for colour temperature,
* the conditional-write behaviour (colour temperature needs colour-temp WB,
  monochrome simulations refuse colour writes, monochromatic colour refuses 0),
* the non-linear High ISO NR encoding, which is why this app never re-encodes it.

FilmKit is MIT licensed, so its copyright notice is reproduced below. The
implementation in this repository was written independently.

```
MIT License

Copyright (c) 2026 eggricesoy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Also consulted

* [petabyt/libfuji](https://github.com/petabyt/libfuji) and
  [petabyt/libpict](https://github.com/petabyt/libpict) (MIT) — PTP and Fuji
  PTP/IP implementations; the reference for a future wireless transport.
* [hkr/fuji-cam-wifi-tool](https://github.com/hkr/fuji-cam-wifi-tool) — earlier
  wireless protocol reverse engineering.
* ISO 15740 (PTP) for container layout, string format and response codes.

## Recipes

No published recipe collections are included. The two files in `examples/` were
written for this repository. Recipe parameter sets published by Fuji X Weekly,
FujiStyle, Fuji Recipes and others are their authors' editorial work — keep them
out of this repository and enter or import them per-user instead.
