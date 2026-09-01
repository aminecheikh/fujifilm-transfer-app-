/**
 * A fake camera that speaks enough PTP to exercise the app without hardware.
 *
 * It backs the app's "Demo (no camera)" mode and the test suite, and it enforces
 * the same refusals a real body does (colour temperature only in Colour-temp WB,
 * no colour channel on monochrome simulations, monochromatic colour rejects 0),
 * so the conditional-write logic is genuinely tested.
 */

import { PTPOp, PTPResp } from './ptp.js'
import { u16le, u32le, concat, packPTPString, unpackPTPString } from './binary.js'
import { FIRST_PRESET_PROP, LAST_PRESET_PROP, SLOT_PROP, NAME_PROP, MONO_SIMS, WB_COLOR_TEMP } from './props.js'

const packStr = str => packPTPString(str)
const packU16Array = values => concat(u32le(values.length), ...values.map(u16le))

const DEFAULT_SLOT = () => new Map([
  [0xd18e, u16le(1)],      // image size
  [0xd18f, u16le(2)],      // image quality
  [0xd190, u16le(100)],    // DR100
  [0xd191, u16le(0)],
  [0xd192, u16le(0x01)],   // Provia
  [0xd193, u16le(0)],
  [0xd194, u16le(0)],
  [0xd195, u16le(1)],      // grain off
  [0xd196, u16le(1)],
  [0xd197, u16le(1)],
  [0xd198, u16le(1)],
  [0xd199, u16le(0x0002)], // auto WB
  [0xd19a, u16le(0)],
  [0xd19b, u16le(0)],
  [0xd19c, u16le(5500)],
  [0xd19d, u16le(0)],
  [0xd19e, u16le(0)],
  [0xd19f, u16le(0)],
  [0xd1a0, u16le(0)],
  [0xd1a1, u16le(0x8000)],
  [0xd1a2, u16le(0)],
  [0xd1a3, u16le(1)],
  [0xd1a4, u16le(1)],
  [0xd1a5, u16le(7)],
])

export class MockCameraTransport {
  constructor({ model = 'X-S20 (demo)', slotCount = 4, lowIso = false } = {}) {
    this.model = model
    this.slotCount = slotCount
    this.lowIso = lowIso // when true, DR200/DR400 writes are refused, as a real body does
    this.currentSlot = 1
    this.slots = new Map()
    for (let slot = 1; slot <= slotCount; slot++) {
      this.slots.set(slot, { name: `C${slot}`, props: DEFAULT_SLOT() })
    }
    this.sessionOpen = false
    this.history = []
  }

  get slot() { return this.slots.get(this.currentSlot) }

  #propValue(code) {
    const bytes = this.slot.props.get(code)
    return bytes ? new DataView(bytes.buffer, bytes.byteOffset).getUint16(0, true) : 0
  }

  #deviceInfo() {
    return concat(
      u16le(100), u32le(0x0000000c), u16le(100), packStr('fujifilm.co.jp: 1.0;'), u16le(0),
      packU16Array([PTPOp.GetDeviceInfo, PTPOp.OpenSession, PTPOp.CloseSession,
        PTPOp.GetDevicePropDesc, PTPOp.GetDevicePropValue, PTPOp.SetDevicePropValue]),
      packU16Array([]),
      packU16Array([SLOT_PROP, NAME_PROP, ...range(FIRST_PRESET_PROP, LAST_PRESET_PROP)]),
      packU16Array([]), packU16Array([]),
      packStr('FUJIFILM'), packStr(this.model), packStr('1.00'), packStr('DEMO0000'),
    )
  }

  async sendCommand(code, params = []) {
    this.history.push({ op: 'cmd', code, params })
    switch (code) {
      case PTPOp.OpenSession:
        this.sessionOpen = true
        return { code: PTPResp.OK, params: [], data: new Uint8Array(0) }
      case PTPOp.CloseSession:
        this.sessionOpen = false
        return { code: PTPResp.OK, params: [], data: new Uint8Array(0) }
      case PTPOp.GetDeviceInfo:
        return { code: PTPResp.OK, params: [], data: this.#deviceInfo() }
      case PTPOp.GetDevicePropValue: {
        const [prop] = params
        if (prop === SLOT_PROP) return ok(u16le(this.currentSlot))
        if (prop === NAME_PROP) return ok(packStr(this.slot.name))
        const bytes = this.slot.props.get(prop)
        if (!bytes) return { code: PTPResp.DevicePropNotSupported, params: [], data: new Uint8Array(0) }
        return ok(bytes)
      }
      case PTPOp.GetDevicePropDesc: {
        const [prop] = params
        if (prop !== SLOT_PROP) return { code: PTPResp.OperationNotSupported, params: [], data: new Uint8Array(0) }
        return ok(concat(
          u16le(SLOT_PROP), u16le(0x0004), new Uint8Array([1]),
          u16le(1), u16le(this.currentSlot),
          new Uint8Array([1]), u16le(1), u16le(this.slotCount), u16le(1),
        ))
      }
      default:
        return { code: PTPResp.OperationNotSupported, params: [], data: new Uint8Array(0) }
    }
  }

  async sendDataCommand(code, params, data) {
    this.history.push({ op: 'data', code, params, data })
    if (code !== PTPOp.SetDevicePropValue) {
      return { code: PTPResp.OperationNotSupported, params: [] }
    }
    const [prop] = params
    const value = data.length >= 2 ? new DataView(data.buffer, data.byteOffset).getUint16(0, true) : data[0]

    if (prop === SLOT_PROP) {
      if (value < 1 || value > this.slotCount) return { code: PTPResp.InvalidDevicePropValue, params: [] }
      this.currentSlot = value
      return { code: PTPResp.OK, params: [] }
    }
    if (prop === NAME_PROP) {
      this.slot.name = unpackPTPString(data)
      return { code: PTPResp.OK, params: [] }
    }
    if (prop < FIRST_PRESET_PROP || prop > LAST_PRESET_PROP) {
      return { code: PTPResp.DevicePropNotSupported, params: [] }
    }

    const mono = MONO_SIMS.has(this.#propValue(0xd192))
    if (prop === 0xd19c && this.#propValue(0xd199) !== WB_COLOR_TEMP) {
      return { code: PTPResp.InvalidDevicePropValue, params: [] } // colour temp needs Colour-temp WB
    }
    if (prop === 0xd19f && mono) return { code: PTPResp.InvalidDevicePropValue, params: [] }
    if ((prop === 0xd193 || prop === 0xd194)) {
      if (!mono || value === 0) return { code: PTPResp.InvalidDevicePropValue, params: [] }
    }
    if (prop === 0xd190 && this.lowIso && value > 100) {
      return { code: PTPResp.InvalidDevicePropValue, params: [] }
    }

    this.slot.props.set(prop, new Uint8Array(data))
    return { code: PTPResp.OK, params: [] }
  }
}

function ok(data) { return { code: PTPResp.OK, params: [], data } }
function range(from, to) {
  const out = []
  for (let i = from; i <= to; i++) out.push(i)
  return out
}
