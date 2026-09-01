/** Little-endian binary helpers and PTP dataset parsing. */

export function u16le(value) {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, value & 0xffff, true)
  return b
}

export function i16le(value) {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setInt16(0, Math.max(-32768, Math.min(32767, value)), true)
  return b
}

export function u32le(value) {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, value >>> 0, true)
  return b
}

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** PTP string: uint8 char count (including NUL), then UCS-2LE chars. Empty string = single 0 byte. */
export function packPTPString(str) {
  if (!str) return new Uint8Array([0])
  const chars = [...str].slice(0, 254)
  const out = new Uint8Array(1 + (chars.length + 1) * 2)
  const view = new DataView(out.buffer)
  out[0] = chars.length + 1
  chars.forEach((ch, i) => view.setUint16(1 + i * 2, ch.charCodeAt(0), true))
  view.setUint16(1 + chars.length * 2, 0, true)
  return out
}

export function unpackPTPString(bytes) {
  if (!bytes || bytes.length < 1 || bytes[0] === 0) return ''
  const count = bytes[0]
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let out = ''
  for (let i = 0; i < count && 1 + i * 2 + 1 < bytes.length; i++) {
    const ch = view.getUint16(1 + i * 2, true)
    if (ch === 0) break
    out += String.fromCharCode(ch)
  }
  return out
}

export function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ')
}

export function fromHex(hex) {
  const parts = String(hex).trim().split(/[\s,]+/).filter(Boolean)
  return new Uint8Array(parts.map(p => parseInt(p, 16) & 0xff))
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Cursor reader for PTP datasets (DeviceInfo, DevicePropDesc). */
export class PTPReader {
  constructor(bytes) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.pos = 0
  }
  get remaining() { return this.view.byteLength - this.pos }
  u8()  { const v = this.view.getUint8(this.pos); this.pos += 1; return v }
  i8()  { const v = this.view.getInt8(this.pos); this.pos += 1; return v }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v }
  i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v }
  str() {
    const count = this.u8()
    let out = ''
    for (let i = 0; i < count; i++) {
      const ch = this.u16()
      if (ch !== 0) out += String.fromCharCode(ch)
    }
    return out
  }
  u16array() {
    const count = this.u32()
    const arr = []
    for (let i = 0; i < count && this.remaining >= 2; i++) arr.push(this.u16())
    return arr
  }
  /** Read one value of the given PTP data type code. */
  byType(dataType) {
    switch (dataType) {
      case 0x0001: return this.i8()
      case 0x0002: return this.u8()
      case 0x0003: return this.i16()
      case 0x0004: return this.u16()
      case 0x0005: return this.i32()
      case 0x0006: return this.u32()
      case 0xffff: return this.str()
      default: return this.u32()
    }
  }
}

export function typeWidth(dataType) {
  switch (dataType) {
    case 0x0001: case 0x0002: return 1
    case 0x0003: case 0x0004: return 2
    case 0x0005: case 0x0006: return 4
    default: return 2
  }
}
