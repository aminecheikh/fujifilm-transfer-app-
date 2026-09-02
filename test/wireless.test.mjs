import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { startMockIpCamera } from '../tools/mock-ip-camera.mjs'
import { probe } from '../tools/wireless-probe.mjs'
import { FujiIpTransport, awaitTetherInvite, FUJI_TETHER_PORT, FUJI_PROTOCOL_VERSION } from '../tools/fuji-ip.mjs'
import { FujiCamera, slotToRecipe } from '../js/camera.js'
import { buildWritePlan } from '../js/plan.js'
import { WB_COLOR_TEMP } from '../js/props.js'

// The probe prints a report; silence it here rather than in the TAP stream.
const silent = { out: () => {} }

test('the PTP/IP handshake sends the packet a Fuji camera expects', async () => {
  const seen = []
  const server = net.createServer(socket => {
    socket.on('data', chunk => {
      seen.push(chunk)
      const ack = Buffer.alloc(82)
      ack.writeUInt32LE(82, 0)
      ack.writeUInt32LE(2, 4) // InitCommandAck
      Buffer.from('X-S20\0', 'utf16le').copy(ack, 28)
      socket.write(ack)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  const transport = new FujiIpTransport()
  await transport.connect('127.0.0.1', server.address().port)
  const name = await transport.handshake('probe-test')

  const packet = seen[0]
  assert.equal(packet.length, 0x52, 'the init packet is 82 bytes')
  assert.equal(packet.readUInt32LE(0), 0x52)
  assert.equal(packet.readUInt32LE(4), 1, 'InitCommandRequest')
  assert.equal(packet.readUInt32LE(8), FUJI_PROTOCOL_VERSION)
  assert.equal(packet.subarray(28).toString('utf16le').replace(/\0.*$/, ''), 'probe-test')
  assert.equal(name, 'X-S20', 'the camera name is read back out of the ack')

  transport.close()
  server.close()
})

test('OpenSession starts at transaction id 1, as Fuji requires', async () => {
  const { server, port } = await startMockIpCamera()
  const transport = new FujiIpTransport()
  await transport.connect('127.0.0.1', port)
  await transport.handshake('probe-test')
  assert.equal(transport.transactionId, 0, 'the handshake does not consume a transaction id')

  const camera = new FujiCamera(transport)
  await camera.openSession()
  assert.equal(transport.transactionId, 1)

  transport.close()
  server.close()
})

test('probe reports wireless as possible when the camera answers', async () => {
  const { server, port } = await startMockIpCamera()
  const report = await probe({ ip: '127.0.0.1', port, ...silent })

  assert.equal(report.verdict, 'yes')
  assert.equal(report.readable, 24)
  assert.equal(report.slotSelectorReadable, true)
  assert.equal(report.slotSelectorWritable, true)
  assert.equal(report.camera.model, 'X-S20 (mock over IP)')
  assert.equal(report.slotDescriptor.max, 4, 'four custom slots')
  assert.equal(report.slot.properties['0xd192'], '01 00')

  server.close()
})

test('probe reports wireless as unavailable when the properties are absent', async () => {
  const { server, port } = await startMockIpCamera({ presets: false })
  const report = await probe({ ip: '127.0.0.1', port, ...silent })

  assert.equal(report.verdict, 'no')
  assert.equal(report.slotSelectorReadable, false)

  server.close()
})

test('probe fails cleanly when nothing is listening', async () => {
  await assert.rejects(
    () => probe({ ip: '127.0.0.1', port: 1, ...silent }),
    /could not reach|ECONNREFUSED/,
  )
})

test('the tether invite is parsed the way the camera sends it', async () => {
  const waiting = awaitTetherInvite({ advertise: false, timeout: 5000 })
  await new Promise(resolve => setTimeout(resolve, 100))

  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: FUJI_TETHER_PORT }, () => {
      socket.write('CONNECT * HTTP/1.1\r\nDSC: 192.168.1.24\r\nCAMERANAME: X-S20\r\nDSCPORT: 55740\r\n\r\n')
    })
    socket.on('data', data => {
      assert.match(data.toString(), /200 OK/)
      socket.end()
      resolve()
    })
    socket.on('error', reject)
  })

  const invite = await waiting
  assert.equal(invite.ip, '192.168.1.24')
  assert.equal(invite.port, 55740)
  assert.equal(invite.model, 'X-S20')
})

test('a recipe can be written and verified over the IP transport', async () => {
  const { server, port } = await startMockIpCamera()
  const transport = new FujiIpTransport()
  await transport.connect('127.0.0.1', port)
  await transport.handshake('probe-test')

  const camera = new FujiCamera(transport)
  await camera.openSession()
  await camera.detectSlotCount()

  const plan = buildWritePlan({
    name: 'Wireless Test',
    settings: {
      filmSimulation: 0x0b, whiteBalance: WB_COLOR_TEMP, colorTemp: 6300,
      highlightTone: 1, shadowTone: 0.5, color: 1, sharpness: 1, grain: 2,
      colorChrome: 3, colorChromeFxBlue: 2, smoothSkin: 1, dynamicRange: 200,
      wbShiftRed: 3, wbShiftBlue: -4, clarity: 0,
    },
  })
  const result = await camera.writeSlot(2, plan)
  assert.equal(result.rejected, 0)
  assert.equal(result.mismatched, 0)

  const back = slotToRecipe(await camera.readSlot(2))
  assert.equal(back.name, 'Wireless Test')
  assert.equal(back.settings.colorTemp, 6300)
  assert.equal(back.settings.wbShiftBlue, -4)

  transport.close()
  server.close()
})
