/**
 * A TCP server that impersonates a Fujifilm camera in wireless tether mode:
 * the PTP/IP handshake, then USB-style containers backed by MockCameraTransport.
 *
 * This exists so the wireless probe is exercised end to end before it is pointed
 * at real hardware. Run standalone with:  node tools/mock-ip-camera.mjs [port]
 */

import net from 'node:net'

import { unpackContainer, packContainer, ContainerType, PTPResp } from '../js/ptp.js'
import { MockCameraTransport } from '../js/mock-camera.js'

const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b }

export function startMockIpCamera({ port = 0, model = 'X-S20 (mock over IP)', presets = true } = {}) {
  const server = net.createServer(socket => {
    const camera = new MockCameraTransport({ model })
    let buffer = Buffer.alloc(0)
    let handshakeDone = false
    let pendingData = null // a command awaiting its host-to-camera data phase

    socket.setNoDelay(true)
    socket.on('error', () => {})

    const reply = container => socket.write(Buffer.from(packContainer(container)))

    socket.on('data', async chunk => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 4) return
        const length = buffer.readUInt32LE(0)
        if (length < 8 || buffer.length < length) return
        const packet = buffer.subarray(0, length)
        buffer = buffer.subarray(length)

        if (!handshakeDone) {
          // InitCommandRequest -> InitCommandAck, camera name 12 bytes into the payload
          const name = Buffer.alloc(54)
          Buffer.from(`${model}\0`, 'utf16le').copy(name)
          const body = Buffer.concat([u32(1), u32(0), u32(0), u32(0), name])
          const ack = Buffer.concat([u32(8 + 4 + body.length), u32(2), u32(0), body])
          ack.writeUInt32LE(ack.length, 0)
          socket.write(ack)
          handshakeDone = true
          continue
        }

        const container = unpackContainer(new Uint8Array(packet))
        if (container.type === ContainerType.Command) {
          if (!presets && container.params[0] >= 0xd18c) {
            reply({ type: ContainerType.Response, code: PTPResp.DevicePropNotSupported, transactionId: container.transactionId })
            continue
          }
          // SetDevicePropValue arrives as command then data; hold it until the data lands.
          if (container.code === 0x1016) {
            pendingData = container
            continue
          }
          const result = await camera.sendCommand(container.code, container.params)
          if (result.data?.length) {
            reply({ type: ContainerType.Data, code: container.code, transactionId: container.transactionId, data: result.data })
          }
          reply({ type: ContainerType.Response, code: result.code, transactionId: container.transactionId, params: result.params })
        } else if (container.type === ContainerType.Data && pendingData) {
          const result = await camera.sendDataCommand(pendingData.code, pendingData.params, container.data)
          reply({ type: ContainerType.Response, code: result.code, transactionId: pendingData.transactionId })
          pendingData = null
        }
      }
    })
  })

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMockIpCamera({ port: Number(process.argv[2]) || 55740 })
  console.log(`mock Fujifilm camera listening on 127.0.0.1:${port}`)
}
