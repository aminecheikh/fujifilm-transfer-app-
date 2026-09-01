/** High-level camera session: slots in, slots out. */

import { PTPOp, PTPResp, respName } from './ptp.js'
import { u16le, PTPReader, bytesEqual, toHex, typeWidth } from './binary.js'
import {
  SLOT_PROP, NAME_PROP, FIRST_PRESET_PROP, LAST_PRESET_PROP,
  PROPS_BY_CODE, encodeName, decodeName, decodeValue,
} from './props.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export const DEFAULT_SLOT_COUNT = 4 // the X-S20 has C1–C4

export class FujiCamera {
  constructor(transport, log = () => {}) {
    this.transport = transport
    this.log = log
    this.sessionOpen = false
    this.info = null
    this.slotCount = DEFAULT_SLOT_COUNT
    this.descCache = new Map()
  }

  async openSession() {
    const { code } = await this.transport.sendCommand(PTPOp.OpenSession, [1])
    if (code !== PTPResp.OK && code !== PTPResp.SessionAlreadyOpen) {
      throw new Error(`OpenSession failed: ${respName(code)}`)
    }
    this.sessionOpen = true
    this.log('PTP session open')
  }

  async closeSession() {
    if (!this.sessionOpen) return
    try { await this.transport.sendCommand(PTPOp.CloseSession) } catch { /* going away anyway */ }
    this.sessionOpen = false
  }

  async getDeviceInfo() {
    const { code, data } = await this.transport.sendCommand(PTPOp.GetDeviceInfo)
    if (code !== PTPResp.OK) throw new Error(`GetDeviceInfo failed: ${respName(code)}`)
    const r = new PTPReader(data)
    r.u16(); r.u32(); r.u16(); r.str(); r.u16()
    const operations = r.u16array()
    r.u16array()
    const properties = r.u16array()
    r.u16array(); r.u16array()
    const manufacturer = r.str()
    const model = r.str()
    const deviceVersion = r.str()
    const serialNumber = r.str()
    this.info = { manufacturer, model, deviceVersion, serialNumber, operations, properties }
    this.log(`${manufacturer} ${model} — firmware ${deviceVersion}, ${properties.length} properties`)
    return this.info
  }

  supportsPresets() {
    if (!this.info) return true // unknown until we ask; let the read attempt decide
    return this.info.properties.includes(SLOT_PROP)
  }

  /** GetDevicePropDesc — datatype plus the camera's own allowed values, when it answers. */
  async describeProp(code) {
    if (this.descCache.has(code)) return this.descCache.get(code)
    let desc = null
    try {
      const res = await this.transport.sendCommand(PTPOp.GetDevicePropDesc, [code])
      if (res.code === PTPResp.OK && res.data.length >= 5) {
        const r = new PTPReader(res.data)
        const propCode = r.u16()
        const dataType = r.u16()
        const getSet = r.u8()
        r.byType(dataType) // factory default
        const current = r.byType(dataType)
        desc = { code: propCode, dataType, writable: getSet === 1, current, width: typeWidth(dataType) }
        if (r.remaining >= 1) {
          const form = r.u8()
          if (form === 1) {
            desc.min = r.byType(dataType)
            desc.max = r.byType(dataType)
            desc.step = r.byType(dataType)
          } else if (form === 2) {
            const count = r.u16()
            desc.values = []
            for (let i = 0; i < count && r.remaining >= desc.width; i++) desc.values.push(r.byType(dataType))
          }
        }
      }
    } catch (err) {
      this.log(`GetDevicePropDesc(${toCode(code)}) failed: ${err.message}`)
    }
    this.descCache.set(code, desc)
    return desc
  }

  /** How many custom slots this body exposes — asked of the camera, with a safe default. */
  async detectSlotCount() {
    const desc = await this.describeProp(SLOT_PROP)
    if (desc?.values?.length) this.slotCount = desc.values.length
    else if (typeof desc?.max === 'number' && desc.max >= 1 && desc.max <= 16) this.slotCount = desc.max
    else this.slotCount = DEFAULT_SLOT_COUNT
    this.log(`custom slots: C1–C${this.slotCount}`)
    return this.slotCount
  }

  async readProp(code) {
    try {
      const { code: resp, data } = await this.transport.sendCommand(PTPOp.GetDevicePropValue, [code])
      if (resp !== PTPResp.OK || data.length === 0) return null
      return data
    } catch (err) {
      this.log(`read ${toCode(code)} failed: ${err.message}`)
      return null
    }
  }

  async writeProp(code, bytes) {
    const { code: resp } = await this.transport.sendDataCommand(PTPOp.SetDevicePropValue, [code], bytes)
    return { ok: resp === PTPResp.OK, resp }
  }

  async selectSlot(slot) {
    const { ok, resp } = await this.writeProp(SLOT_PROP, u16le(slot))
    if (!ok) throw new Error(`Could not select slot C${slot}: ${respName(resp)}`)
    await sleep(120) // the camera needs a beat before the slot's values are readable
  }

  async currentSlot() {
    const bytes = await this.readProp(SLOT_PROP)
    return bytes && bytes.length >= 2 ? new DataView(bytes.buffer, bytes.byteOffset).getUint16(0, true) : null
  }

  /** Read one slot: its name plus every preset property, as raw bytes. */
  async readSlot(slot) {
    await this.selectSlot(slot)
    const nameBytes = await this.readProp(NAME_PROP)
    const props = new Map()
    for (let code = FIRST_PRESET_PROP; code <= LAST_PRESET_PROP; code++) {
      const bytes = await this.readProp(code)
      if (bytes) props.set(code, bytes)
    }
    return { slot, name: nameBytes ? decodeName(nameBytes) : '', props }
  }

  async readAllSlots(count = this.slotCount) {
    const slots = []
    for (let slot = 1; slot <= count; slot++) slots.push(await this.readSlot(slot))
    return slots
  }

  /**
   * Write one plan into one slot, then read every write back to prove it landed.
   * Individual property refusals are reported, not thrown — the camera legitimately
   * rejects some combinations, and the rest of the recipe should still go in.
   */
  async writeSlot(slot, plan, { writeName = true } = {}) {
    await this.selectSlot(slot)
    const results = []

    if (writeName && plan.name) {
      const { ok, resp } = await this.writeProp(NAME_PROP, encodeName(plan.name.slice(0, 16)))
      results.push({ key: 'name', label: 'Preset name', ok, resp, display: plan.name })
      if (!ok) this.log(`C${slot}: name write rejected (${respName(resp)})`)
    }

    for (const step of plan.steps) {
      let ok = false
      let resp = 0
      try {
        ({ ok, resp } = await this.writeProp(step.code, step.bytes))
      } catch (err) {
        this.log(`C${slot}: ${step.label} write errored: ${err.message}`)
      }
      results.push({ key: step.key, code: step.code, label: step.label, ok, resp, display: step.display })
    }

    // Verification pass — read back only what the camera accepted.
    for (const result of results) {
      if (!result.ok || result.key === 'name') continue
      const bytes = await this.readProp(result.code)
      const step = plan.steps.find(s => s.key === result.key)
      result.verified = !!bytes && bytesEqual(bytes, step.bytes)
      if (bytes && !result.verified) result.readBack = toHex(bytes)
    }

    if (writeName && plan.name) {
      const bytes = await this.readProp(NAME_PROP)
      const nameResult = results.find(r => r.key === 'name')
      if (nameResult && bytes) nameResult.verified = decodeName(bytes) === plan.name.slice(0, 16)
    }

    const written = results.filter(r => r.ok).length
    const mismatched = results.filter(r => r.verified === false).length
    this.log(`C${slot}: ${written}/${results.length} properties accepted${mismatched ? `, ${mismatched} did not verify` : ''}`)
    return { slot, results, written, rejected: results.length - written, mismatched }
  }
}

/** A camera-read slot turned into a storable recipe. */
export function slotToRecipe(slotData, model = '') {
  const settings = {}
  const raw = {}
  for (const [code, bytes] of slotData.props) {
    raw[`0x${code.toString(16).padStart(4, '0')}`] = toHex(bytes)
    const prop = PROPS_BY_CODE.get(code)
    if (!prop || prop.kind === 'raw') continue
    const value = decodeValue(prop, bytes)
    if (value !== null) settings[prop.key] = value
  }
  return {
    name: slotData.name || `C${slotData.slot}`,
    notes: `Captured from C${slotData.slot}${model ? ` on ${model}` : ''}`,
    model,
    settings,
    raw,
    source: 'camera',
  }
}

function toCode(code) { return `0x${code.toString(16).padStart(4, '0')}` }
