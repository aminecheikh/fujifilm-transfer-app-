/**
 * Fujifilm PTP/IP transport — the wireless side of the same protocol the app
 * speaks over USB.
 *
 * Three things make it different from textbook PTP/IP, all confirmed against
 * libfuji (github.com/petabyt/libfuji, MIT) and libpict:
 *
 *  1. The handshake is an ISO PTP/IP InitCommandRequest (type 1) carrying a
 *     Fuji-specific protocol version, but everything after it is *USB-style*
 *     PTP containers on the same TCP socket — so packContainer/unpackContainer
 *     from js/ptp.js apply verbatim.
 *  2. OpenSession starts at transaction id 1, not 0.
 *  3. In WIRELESS TETHER SHOOTING FIXED the camera is the one that connects:
 *     the host advertises itself over UDP broadcast and listens on TCP 51560,
 *     the camera dials in and announces its own address, and only then does the
 *     host open the command socket to the camera.
 */

import net from 'node:net'
import dgram from 'node:dgram'
import os from 'node:os'

import { packContainer, unpackContainer, ContainerType } from '../js/ptp.js'

export const FUJI_CMD_PORT = 55740      // command socket on the camera
export const FUJI_TETHER_PORT = 51560   // the camera dials this on the host
export const FUJI_PCSS_BROADCAST = 51562 // where the host advertises itself
export const FUJI_PROTOCOL_VERSION = 0x8f53e4f2

const PTPIP_INIT_COMMAND_REQ = 1
const PTPIP_INIT_COMMAND_ACK = 2
const PTPIP_INIT_FAIL = 5

/** Reads an exact number of bytes at a time off a socket. */
class ByteReader {
  constructor(socket) {
    this.chunks = Buffer.alloc(0)
    this.pending = null
    this.closed = null
    socket.on('data', chunk => {
      this.chunks = Buffer.concat([this.chunks, chunk])
      this.#serve()
    })
    socket.on('close', () => { this.closed = new Error('camera closed the connection'); this.#serve() })
    socket.on('error', err => { this.closed = err; this.#serve() })
  }

  #serve() {
    if (!this.pending) return
    if (this.chunks.length >= this.pending.want) {
      const { want, resolve } = this.pending
      this.pending = null
      const out = this.chunks.subarray(0, want)
      this.chunks = this.chunks.subarray(want)
      resolve(new Uint8Array(out))
      this.#serve()
      return
    }
    if (this.closed) {
      const { reject } = this.pending
      this.pending = null
      reject(this.closed)
    }
  }

  readExact(want, timeoutMs) {
    if (this.pending) return Promise.reject(new Error('concurrent read'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error(`timed out waiting for ${want} bytes from the camera`))
      }, timeoutMs)
      this.pending = {
        want,
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: err => { clearTimeout(timer); reject(err) },
      }
      this.#serve()
    })
  }
}

const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** UTF-16LE, NUL-terminated, padded to `size` bytes. */
function unicodeField(text, size) {
  const out = Buffer.alloc(size)
  Buffer.from(`${text}\0`, 'utf16le').copy(out, 0, 0, Math.min(size, (text.length + 1) * 2))
  return out
}

function readUnicode(bytes, offset) {
  let end = offset
  while (end + 1 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0)) end += 2
  return Buffer.from(bytes.subarray(offset, end)).toString('utf16le')
}

/**
 * Transport with the same surface as the app's WebUsbTransport, so FujiCamera
 * and everything above it work unchanged over Wi-Fi.
 */
export class FujiIpTransport {
  constructor(log = () => {}, timeout = 10000) {
    this.log = log
    this.timeout = timeout
    this.socket = null
    this.reader = null
    this.transactionId = 0
    this.cameraName = ''
  }

  async connect(ip, port = FUJI_CMD_PORT) {
    this.socket = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: ip, port }, () => resolve(socket))
      socket.setNoDelay(true)
      socket.once('error', reject)
      setTimeout(() => reject(new Error(`could not reach ${ip}:${port}`)), this.timeout).unref?.()
    })
    this.socket.removeAllListeners('error')
    this.socket.on('error', err => this.log(`socket error: ${err.message}`))
    this.reader = new ByteReader(this.socket)
    this.log(`TCP connected to ${ip}:${port}`)
  }

  /** InitCommandRequest / InitCommandAck. Returns the camera's own name. */
  async handshake(clientName = 'recipe-probe') {
    const packet = Buffer.concat([
      u32(0x52), u32(PTPIP_INIT_COMMAND_REQ), u32(FUJI_PROTOCOL_VERSION),
      // Any client GUID works; these are libfuji's, which cameras are used to.
      u32(0x5d48a5ad), u32(0x0b7fb287), u32(0xd0ded5d3), u32(0x00000000),
      unicodeField(clientName, 54),
    ])
    this.socket.write(packet)

    const head = await this.reader.readExact(4, this.timeout)
    const length = new DataView(head.buffer, head.byteOffset).getUint32(0, true)
    if (length < 8 || length > 4096) throw new Error(`implausible init response length ${length}`)
    const rest = await this.reader.readExact(length - 4, this.timeout)
    const ack = new Uint8Array([...head, ...rest])
    const type = new DataView(ack.buffer, ack.byteOffset).getUint32(4, true)

    if (type === PTPIP_INIT_FAIL) {
      const err = new Error('camera answered InitFail')
      err.initFail = true
      throw err
    }
    if (type !== PTPIP_INIT_COMMAND_ACK) this.log(`unexpected init response type ${type}`)

    // libpict places the payload 12 bytes in; the camera name is a unicode
    // string after four words. Fall back to scanning if that offset misses.
    this.cameraName = readUnicode(ack, 28) || readUnicode(ack, 24) || readUnicode(ack, 8)
    this.initAck = ack
    return this.cameraName
  }

  nextTransactionId() { return ++this.transactionId }

  async #recvContainer() {
    const head = await this.reader.readExact(4, this.timeout)
    const length = new DataView(head.buffer, head.byteOffset).getUint32(0, true)
    if (length < 12) throw new Error(`bad container length ${length}`)
    const rest = await this.reader.readExact(length - 4, this.timeout)
    return unpackContainer(new Uint8Array([...head, ...rest]))
  }

  async sendCommand(code, params = []) {
    const transactionId = this.nextTransactionId()
    this.socket.write(Buffer.from(packContainer({ type: ContainerType.Command, code, transactionId, params })))
    let container = await this.#recvContainer()
    let data = new Uint8Array(0)
    if (container.type === ContainerType.Data) {
      data = container.data
      container = await this.#recvContainer()
    }
    if (container.type !== ContainerType.Response) throw new Error(`expected a response, got type ${container.type}`)
    return { code: container.code, params: container.params, data }
  }

  async sendDataCommand(code, params, data) {
    const transactionId = this.nextTransactionId()
    this.socket.write(Buffer.from(packContainer({ type: ContainerType.Command, code, transactionId, params })))
    this.socket.write(Buffer.from(packContainer({ type: ContainerType.Data, code, transactionId, data })))
    const container = await this.#recvContainer()
    if (container.type !== ContainerType.Response) throw new Error(`expected a response, got type ${container.type}`)
    return { code: container.code, params: container.params }
  }

  close() {
    this.socket?.destroy()
    this.socket = null
  }
}

/**
 * Connect and handshake the way libfuji does, which is to say patiently.
 *
 * A Fujifilm camera routinely answers the first InitCommandRequest with InitFail
 * and accepts the next one — libfuji's own wireless-tether setup retries up to
 * four times, waits a second after discovery before dialling, and pauses 50ms
 * after the ack because "the camera is thinking". The camera may also be showing
 * a confirmation prompt that has to be accepted before it will say yes.
 */
export async function connectWithRetries(ip, port, {
  log = () => {}, clientName = 'recipe-probe', attempts = 4, settleMs = 0, retryMs = 700,
} = {}) {
  if (settleMs) {
    log(`giving the camera ${settleMs}ms to settle before dialling`)
    await sleep(settleMs)
  }

  let transport = new FujiIpTransport(log)
  await transport.connect(ip, port)

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const name = await transport.handshake(clientName)
      await sleep(50) // the camera needs a beat before OpenSession
      return { transport, name }
    } catch (err) {
      if (!err.initFail && !/closed|timed out/i.test(err.message) || attempt === attempts) {
        transport.close()
        throw err
      }
      log(`attempt ${attempt}/${attempts}: ${err.message} — retrying${attempt === 1 ? ' (this is normal; press OK if the camera is asking)' : ''}`)
      await sleep(retryMs)
      if (!transport.socket || transport.socket.destroyed) {
        transport.close()
        transport = new FujiIpTransport(log)
        await transport.connect(ip, port)
      }
    }
  }
  throw new Error('handshake never accepted')
}

/**
 * Which of the camera's TCP ports are open.
 *
 * Worth knowing when a direct connect is refused: in wireless tether mode the
 * camera announces its command port during discovery rather than always sitting
 * on 55740, and in some modes it listens on nothing until a client discovers it.
 */
export async function scanPorts(ip, ports = CANDIDATE_PORTS, timeoutMs = 800) {
  const probeOne = port => new Promise(resolve => {
    const socket = net.createConnection({ host: ip, port })
    const done = state => { socket.destroy(); resolve({ port, state }) }
    socket.setTimeout(timeoutMs, () => done('no answer'))
    socket.once('connect', () => done('open'))
    socket.once('error', err => done(err.code === 'ECONNREFUSED' ? 'refused' : err.code ?? 'error'))
  })
  return Promise.all(ports.map(probeOne))
}

export const CANDIDATE_PORTS = [
  80, 443, 8080,      // the camera's own web services, if any
  15740,              // standard PTP/IP
  51540, 51541, 51542, // PC AutoSave
  51560, 51562,       // wireless tether handshake / discovery
  55740, 55741, 55742, 55743, // Fuji command, event, liveview
]

/** Every IPv4 broadcast address this machine can reach, plus the global one. */
export function broadcastAddresses() {
  const found = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.netmask) continue
      const ip = entry.address.split('.').map(Number)
      const mask = entry.netmask.split('.').map(Number)
      found.push({
        local: entry.address,
        broadcast: ip.map((octet, i) => (octet & mask[i]) | (~mask[i] & 0xff)).join('.'),
      })
    }
  }
  found.push({ local: found[0]?.local ?? '0.0.0.0', broadcast: '255.255.255.255' })
  return found
}

/**
 * Wait for a camera in WIRELESS TETHER SHOOTING FIXED to dial in.
 *
 * Advertises this host over UDP (the PCSS discovery datagram X Acquire sends) and
 * listens on TCP 51560, where the camera announces `DSC`, `CAMERANAME` and
 * `DSCPORT`. Resolves with the camera's address.
 */
export function awaitTetherInvite({ log = () => {}, timeout = 180000, advertise = true } = {}) {
  return new Promise((resolve, reject) => {
    const interfaces = broadcastAddresses()
    const server = net.createServer()
    let udp = null
    let beacon = null
    let timer = null

    const cleanup = () => {
      clearTimeout(timer)
      clearInterval(beacon)
      try { udp?.close() } catch { /* already closed */ }
      server.close()
    }

    server.on('error', err => { cleanup(); reject(err) })

    server.on('connection', socket => {
      let text = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        text += chunk
        const fields = Object.fromEntries(
          text.split(/\r?\n/)
            .map(line => line.split(/:\s*/))
            .filter(parts => parts.length >= 2)
            .map(([key, value]) => [key.trim().toUpperCase(), value.trim()]),
        )
        if (!fields.DSC) return
        socket.write('HTTP/1.1 200 OK\r\n')
        socket.end()
        cleanup()
        log(`camera dialled in: ${fields.CAMERANAME ?? 'unknown model'} at ${fields.DSC}:${fields.DSCPORT ?? FUJI_CMD_PORT}`)
        resolve({
          ip: fields.DSC,
          port: Number(fields.DSCPORT ?? FUJI_CMD_PORT) || FUJI_CMD_PORT,
          model: fields.CAMERANAME ?? '',
          raw: text,
        })
      })
      socket.on('error', () => {})
    })

    server.listen(FUJI_TETHER_PORT, '0.0.0.0', () => {
      log(`listening on TCP ${FUJI_TETHER_PORT} for the camera`)
      if (!advertise) return
      udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      udp.bind(() => {
        udp.setBroadcast(true)
        const send = () => {
          for (const { local, broadcast } of interfaces) {
            const datagram = Buffer.from(
              `DISCOVERY * HTTP/1.1\r\nHOST: ${local}\r\nMX: 5\r\nSERVICE: PCSS/1.0\r\n`)
            udp.send(datagram, FUJI_PCSS_BROADCAST, broadcast, () => {})
          }
        }
        send()
        beacon = setInterval(send, 2000)
        log(`advertising this host on UDP ${FUJI_PCSS_BROADCAST} (${interfaces.map(i => i.broadcast).join(', ')})`)
      })
    })

    timer = setTimeout(() => {
      cleanup()
      reject(new Error('no camera dialled in — see the checklist above'))
    }, timeout)
  })
}
