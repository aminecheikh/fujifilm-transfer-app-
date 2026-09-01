/**
 * The Fujifilm custom-preset property model.
 *
 * Property codes and their encodings are reverse-engineered work from FilmKit
 * (github.com/eggricesoy/filmkit, MIT) — see THIRD-PARTY.md. They were confirmed
 * on an X100VI; anything marked `confirmed: false` below is a best guess and may
 * differ on other bodies, which is why captured raw bytes always win over
 * re-encoding (see plan.js).
 */

import { i16le, u16le, packPTPString, unpackPTPString, PTPReader } from './binary.js'

export const SLOT_PROP = 0xd18c
export const NAME_PROP = 0xd18d
export const FIRST_PRESET_PROP = 0xd18e
export const LAST_PRESET_PROP = 0xd1a5

export const FILM_SIMS = {
  0x01: 'Provia / Standard',
  0x02: 'Velvia / Vivid',
  0x03: 'Astia / Soft',
  0x04: 'PRO Neg. Hi',
  0x05: 'PRO Neg. Std',
  0x06: 'Monochrome',
  0x07: 'Monochrome + Ye',
  0x08: 'Monochrome + R',
  0x09: 'Monochrome + G',
  0x0a: 'Sepia',
  0x0b: 'Classic Chrome',
  0x0c: 'Acros',
  0x0d: 'Acros + Ye',
  0x0e: 'Acros + R',
  0x0f: 'Acros + G',
  0x10: 'Eterna / Cinema',
  0x11: 'Classic Neg.',
  0x12: 'Eterna Bleach Bypass',
  0x13: 'Nostalgic Neg.',
  0x14: 'Reala Ace',
}

/** Film simulations with no colour channel — Color and Monochromatic Colour swap places. */
export const MONO_SIMS = new Set([0x06, 0x07, 0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x0e, 0x0f])

export const WB_MODES = {
  0x0000: 'As shot',
  0x0002: 'Auto',
  0x8021: 'Auto — ambience priority',
  0x0004: 'Daylight',
  0x8006: 'Shade',
  0x8001: 'Fluorescent 1',
  0x8002: 'Fluorescent 2',
  0x8003: 'Fluorescent 3',
  0x0006: 'Incandescent',
  0x0008: 'Underwater',
  0x8007: 'Colour temperature',
}

export const WB_COLOR_TEMP = 0x8007

const EFFECT = { 1: 'Off', 2: 'Weak', 3: 'Strong' }
const GRAIN = { 1: 'Off', 2: 'Weak / Small', 3: 'Strong / Small', 4: 'Weak / Large', 5: 'Strong / Large' }
const ON_OFF = { 0: 'Off', 1: 'On' }
const COLOR_SPACE = { 1: 'sRGB', 2: 'Adobe RGB' }

/**
 * kind:
 *   enum   — integer with a label table
 *   x10    — display value stored as tenths (-2.0 → -20)
 *   int    — plain signed integer
 *   kelvin — unsigned Kelvin
 *   raw    — opaque bytes, only ever replayed verbatim
 */
export const PRESET_PROPS = [
  { key: 'imageSize', code: 0xd18e, label: 'Image size', kind: 'raw', group: 'file', confirmed: false, writeByDefault: false },
  { key: 'imageQuality', code: 0xd18f, label: 'Image quality', kind: 'raw', group: 'file', confirmed: false, writeByDefault: false },
  {
    key: 'dynamicRange', code: 0xd190, label: 'Dynamic range', kind: 'enum', group: 'tone',
    options: { 100: 'DR100%', 200: 'DR200%', 400: 'DR400%' }, confirmed: true, writeByDefault: true,
    note: 'The camera rejects DR200/DR400 when the current ISO is too low.',
  },
  { key: 'unknownD191', code: 0xd191, label: 'Unknown (D191)', kind: 'raw', group: 'file', confirmed: false, writeByDefault: false },
  {
    key: 'filmSimulation', code: 0xd192, label: 'Film simulation', kind: 'enum', group: 'look',
    options: FILM_SIMS, confirmed: true, writeByDefault: true,
  },
  {
    key: 'monoWarmCool', code: 0xd193, label: 'Monochromatic colour — warm/cool', kind: 'x10', group: 'look',
    min: -18, max: 18, step: 1, confirmed: false, writeByDefault: true,
    note: 'Black-and-white simulations only; the camera rejects a write of 0.',
  },
  {
    key: 'monoMagentaGreen', code: 0xd194, label: 'Monochromatic colour — magenta/green', kind: 'x10', group: 'look',
    min: -18, max: 18, step: 1, confirmed: false, writeByDefault: true,
    note: 'Black-and-white simulations only; the camera rejects a write of 0.',
  },
  { key: 'grain', code: 0xd195, label: 'Grain effect', kind: 'enum', group: 'look', options: GRAIN, confirmed: true, writeByDefault: true },
  { key: 'colorChrome', code: 0xd196, label: 'Colour chrome effect', kind: 'enum', group: 'look', options: EFFECT, confirmed: true, writeByDefault: true },
  { key: 'colorChromeFxBlue', code: 0xd197, label: 'Colour chrome FX blue', kind: 'enum', group: 'look', options: EFFECT, confirmed: true, writeByDefault: true },
  { key: 'smoothSkin', code: 0xd198, label: 'Smooth skin effect', kind: 'enum', group: 'look', options: EFFECT, confirmed: true, writeByDefault: true },
  { key: 'whiteBalance', code: 0xd199, label: 'White balance', kind: 'enum', group: 'wb', options: WB_MODES, confirmed: true, writeByDefault: true },
  { key: 'wbShiftRed', code: 0xd19a, label: 'WB shift — red', kind: 'int', group: 'wb', min: -9, max: 9, step: 1, confirmed: true, writeByDefault: true },
  { key: 'wbShiftBlue', code: 0xd19b, label: 'WB shift — blue', kind: 'int', group: 'wb', min: -9, max: 9, step: 1, confirmed: true, writeByDefault: true },
  {
    key: 'colorTemp', code: 0xd19c, label: 'Colour temperature (K)', kind: 'kelvin', group: 'wb',
    min: 2500, max: 10000, step: 10, confirmed: true, writeByDefault: true,
    note: 'Only writable while white balance is set to Colour temperature.',
  },
  { key: 'highlightTone', code: 0xd19d, label: 'Highlight tone', kind: 'x10', group: 'tone', min: -2, max: 4, step: 0.5, confirmed: true, writeByDefault: true },
  { key: 'shadowTone', code: 0xd19e, label: 'Shadow tone', kind: 'x10', group: 'tone', min: -2, max: 4, step: 0.5, confirmed: true, writeByDefault: true },
  {
    key: 'color', code: 0xd19f, label: 'Colour', kind: 'x10', group: 'tone', min: -4, max: 4, step: 1,
    confirmed: true, writeByDefault: true, note: 'Not applicable to black-and-white simulations.',
  },
  { key: 'sharpness', code: 0xd1a0, label: 'Sharpness', kind: 'x10', group: 'tone', min: -4, max: 4, step: 1, confirmed: true, writeByDefault: true },
  {
    key: 'highIsoNR', code: 0xd1a1, label: 'High ISO NR', kind: 'raw', group: 'tone', confirmed: false, writeByDefault: false,
    note: 'Non-linear proprietary encoding (-4 → 0x8000, 0 → 0x2000, +4 → 0x5000) and often a sentinel. Replayed verbatim only.',
  },
  { key: 'clarity', code: 0xd1a2, label: 'Clarity', kind: 'x10', group: 'tone', min: -5, max: 5, step: 1, confirmed: true, writeByDefault: true,
    note: 'The camera rejects clarity writes unless it is in still-image drive mode.' },
  { key: 'longExpNR', code: 0xd1a3, label: 'Long exposure NR', kind: 'enum', group: 'file', options: ON_OFF, confirmed: false, writeByDefault: false },
  { key: 'colorSpace', code: 0xd1a4, label: 'Colour space', kind: 'enum', group: 'file', options: COLOR_SPACE, confirmed: false, writeByDefault: false },
  { key: 'unknownD1A5', code: 0xd1a5, label: 'Unknown (D1A5)', kind: 'raw', group: 'file', confirmed: false, writeByDefault: false },
]

export const PROPS_BY_KEY = new Map(PRESET_PROPS.map(p => [p.key, p]))
export const PROPS_BY_CODE = new Map(PRESET_PROPS.map(p => [p.code, p]))

export const GROUP_LABELS = { look: 'Look', tone: 'Tone & colour', wb: 'White balance', file: 'File & advanced' }

/** Order matters: film simulation and WB mode gate the writes that follow them. */
export const WRITE_ORDER = [
  'filmSimulation', 'whiteBalance', 'colorTemp', 'wbShiftRed', 'wbShiftBlue',
  'dynamicRange', 'highlightTone', 'shadowTone', 'color', 'sharpness', 'clarity',
  'grain', 'colorChrome', 'colorChromeFxBlue', 'smoothSkin',
  'monoWarmCool', 'monoMagentaGreen',
  'imageSize', 'imageQuality', 'longExpNR', 'colorSpace', 'highIsoNR', 'unknownD191', 'unknownD1A5',
]

export function isMonochrome(filmSimulation) {
  return MONO_SIMS.has(Number(filmSimulation))
}

/**
 * Why a property must not be written for this recipe, or null when it is fine.
 * These mirror the camera's own refusals — writing anyway just yields errors.
 */
export function skipReason(prop, settings) {
  const mono = isMonochrome(settings.filmSimulation)
  if ((prop.key === 'monoWarmCool' || prop.key === 'monoMagentaGreen')) {
    if (!mono) return 'colour simulation — monochromatic colour does not apply'
    const value = settings[prop.key]
    if (value !== undefined && value !== null && Number(value) === 0) return 'the camera rejects a write of 0'
  }
  if (prop.key === 'color' && mono) return 'black-and-white simulation has no colour channel'
  if (prop.key === 'colorTemp' && Number(settings.whiteBalance) !== WB_COLOR_TEMP) {
    return 'white balance is not set to Colour temperature'
  }
  return null
}

export function encodeValue(prop, value) {
  switch (prop.kind) {
    case 'x10': return i16le(Math.round(Number(value) * 10))
    case 'int': return i16le(Math.round(Number(value)))
    case 'enum': case 'kelvin': return u16le(Math.round(Number(value)))
    default: throw new Error(`${prop.key} is raw-only and cannot be encoded from a value`)
  }
}

export function decodeValue(prop, bytes) {
  if (!bytes || bytes.length === 0) return null
  const reader = new PTPReader(bytes)
  switch (prop.kind) {
    case 'x10': return (bytes.length >= 2 ? reader.i16() : reader.i8()) / 10
    case 'int': return bytes.length >= 2 ? reader.i16() : reader.i8()
    case 'enum': case 'kelvin': return bytes.length >= 2 ? reader.u16() : reader.u8()
    default: return null
  }
}

export function formatValue(prop, value) {
  if (value === null || value === undefined) return '—'
  switch (prop.kind) {
    case 'enum': return prop.options?.[Number(value)] ?? `unknown (${value})`
    case 'kelvin': return `${value} K`
    case 'x10': case 'int': {
      const n = Number(value)
      const text = prop.step && prop.step < 1 ? n.toFixed(1) : String(n)
      return n > 0 ? `+${text}` : text
    }
    default: return String(value)
  }
}

export function encodeName(name) { return packPTPString(name) }
export function decodeName(bytes) { return unpackPTPString(bytes) }
