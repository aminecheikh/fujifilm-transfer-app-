/**
 * PTP over WebUSB.
 *
 * Container layout (ISO 15740, USB binding):
 *   [0-3]  uint32 total length      [4-5]  uint16 container type
 *   [6-7]  uint16 op/response code  [8-11] uint32 transaction id
 *   [12+]  up to 5 uint32 params (command) or raw payload (data)
 */

import { u16le, u32le, concat } from './binary.js'

export const PTPOp = {
  GetDeviceInfo: 0x1001,
  OpenSession: 0x1002,
  CloseSession: 0x1003,
  GetDevicePropDesc: 0x1014,
  GetDevicePropValue: 0x1015,
  SetDevicePropValue: 0x1016,
}

export const PTPResp = {
  OK: 0x2001,
  GeneralError: 0x2002,
  SessionNotOpen: 0x2003,
  InvalidTransactionID: 0x2004,
  OperationNotSupported: 0x2005,
  ParameterNotSupported: 0x2006,
  InvalidDevicePropFormat: 0x2012,
  InvalidDevicePropValue: 0x200B,
  DevicePropNotSupported: 0x200A,
  AccessDenied: 0x200F,
  DeviceBusy: 0x2019,
  SessionAlreadyOpen: 0x201E,
}

export const ContainerType = { Command: 1, Data: 2, Response: 3, Event: 4 }

const RESP_NAMES = Object.fromEntries(Object.entries(PTPResp).map(([k, v]) => [v, k]))

export function respName(code) {
  return RESP_NAMES[code] ?? `0x${code.toString(16).toUpperCase().padStart(4, '0')}`
}

const HEADER = 12

export function packContainer({ type, code, transactionId, params = [], data = new Uint8Array(0) }) {
  const paramBytes = params.slice(0, 5).map(u32le)
  const length = HEADER + paramBytes.reduce((n, p) => n + p.length, 0) + data.length
  return concat(u32le(length), u16le(type), u16le(code), u32le(transactionId), ...paramBytes, data)
}

export function unpackContainer(raw) {
  if (raw.length < HEADER) throw new Error(`PTP container too short (${raw.length} bytes)`)
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const type = view.getUint16(4, true)
  const rest = raw.slice(HEADER)
  const container = {
    type,
    code: view.getUint16(6, true),
    transactionId: view.getUint32(8, true),
    params: [],
    data: new Uint8Array(0),
  }
  if (type === ContainerType.Data) {
    container.data = rest
  } else {
    const restView = new DataView(rest.buffer, rest.byteOffset, rest.byteLength)
    for (let at = 0; at + 4 <= rest.length && container.params.length < 5; at += 4) {
      container.params.push(restView.getUint32(at, true))
    }
  }
  return container
}

function declaredLength(raw) {
  if (raw.length < 4) return 0
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, true)
}

export const FUJI_VENDOR_ID = 0x04cb
const PTP_INTERFACE_CLASS = 6 // still image
const READ_CHUNK = 64 * 1024
const DEFAULT_TIMEOUT = 8000

/** WebUSB transport. Requires a secure context (https or localhost) and a user gesture to connect. */
export class WebUsbTransport {
  constructor(log = () => {}) {
    this.log = log
    this.device = null
    this.interfaceNumber = 0
    this.epIn = 0
    this.epOut = 0
    this.transactionId = 0
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.usb
  }

  get connected() { return !!this.device?.opened }

  /** Prompt for a camera and claim its PTP interface. Must run inside a click handler. */
  async connect() {
    if (!WebUsbTransport.isSupported()) {
      throw new Error('WebUSB is unavailable. Use Chrome, Edge or Brave (desktop or Android).')
    }
    this.device = await navigator.usb.requestDevice({
      filters: [{ vendorId: FUJI_VENDOR_ID }, { classCode: PTP_INTERFACE_CLASS }],
    })
    this.log(`selected ${this.device.productName || 'camera'} (VID 0x${this.device.vendorId.toString(16)}, PID 0x${this.device.productId.toString(16)})`)
    await this.open()
  }

  async open() {
    await this.device.open()
    if (!this.device.configuration) await this.device.selectConfiguration(1)
    const intf = this.device.configuration.interfaces.find(
      i => i.alternate.interfaceClass === PTP_INTERFACE_CLASS,
    ) ?? this.device.configuration.interfaces[0]
    this.interfaceNumber = intf.interfaceNumber
    await this.device.claimInterface(this.interfaceNumber)
    this.epIn = 0
    this.epOut = 0
    for (const ep of intf.alternate.endpoints) {
      if (ep.type !== 'bulk') continue
      if (ep.direction === 'in') this.epIn = ep.endpointNumber
      if (ep.direction === 'out') this.epOut = ep.endpointNumber
    }
    if (!this.epIn || !this.epOut) throw new Error('No bulk endpoints on the PTP interface')
    this.transactionId = 0
    this.log(`claimed interface ${this.interfaceNumber} (bulk in ${this.epIn} / out ${this.epOut})`)
  }

  async close() {
    if (!this.device) return
    try { await this.device.releaseInterface(this.interfaceNumber) } catch { /* already gone */ }
    try { await this.device.close() } catch { /* already closed */ }
    this.log('closed USB device')
  }

  /** Release and re-claim the interface — clears a desynced PTP stream. */
  async reset() {
    if (!this.device) throw new Error('Not connected')
    try { await this.device.releaseInterface(this.interfaceNumber) } catch { /* ignore */ }
    try { await this.device.close() } catch { /* ignore */ }
    await this.open()
  }

  nextTransactionId() { return ++this.transactionId }

  async #write(bytes) {
    const result = await this.device.transferOut(this.epOut, bytes)
    if (result.status !== 'ok') throw new Error(`USB write ${result.status}`)
  }

  async #read(timeout) {
    const transfer = this.device.transferIn(this.epIn, READ_CHUNK)
    const expiry = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`USB read timed out after ${timeout}ms`)), timeout))
    const result = await Promise.race([transfer, expiry])
    if (result.status !== 'ok') throw new Error(`USB read ${result.status}`)
    return new Uint8Array(result.data.buffer)
  }

  async #recv(timeout) {
    let bytes = await this.#read(timeout)
    const total = declaredLength(bytes)
    while (bytes.length < total) bytes = concat(bytes, await this.#read(timeout))
    return unpackContainer(bytes)
  }

  /** Command with an optional camera-to-host data phase. */
  async sendCommand(code, params = [], timeout = DEFAULT_TIMEOUT) {
    const transactionId = this.nextTransactionId()
    await this.#write(packContainer({ type: ContainerType.Command, code, transactionId, params }))
    let container = await this.#recv(timeout)
    let data = new Uint8Array(0)
    if (container.type === ContainerType.Data) {
      data = container.data
      container = await this.#recv(timeout)
    }
    if (container.type !== ContainerType.Response) {
      throw new Error(`Expected a response container, got type ${container.type}`)
    }
    return { code: container.code, params: container.params, data }
  }

  /** Command with a host-to-camera data phase (SetDevicePropValue and friends). */
  async sendDataCommand(code, params, data, timeout = DEFAULT_TIMEOUT) {
    const transactionId = this.nextTransactionId()
    await this.#write(packContainer({ type: ContainerType.Command, code, transactionId, params }))
    await this.#write(packContainer({ type: ContainerType.Data, code, transactionId, data }))
    const container = await this.#recv(timeout)
    if (container.type !== ContainerType.Response) {
      throw new Error(`Expected a response container, got type ${container.type}`)
    }
    return { code: container.code, params: container.params }
  }
}
