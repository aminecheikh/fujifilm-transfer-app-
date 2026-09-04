#!/usr/bin/env node
/**
 * Does the X-S20 expose its custom-preset properties over Wi-Fi?
 *
 * Connects to the camera over PTP/IP and asks. Read-only apart from one harmless
 * write (the slot selector set to the value it already holds) which is the only
 * way to learn whether writes are permitted at all.
 *
 * Usage:
 *   node tools/wireless-probe.mjs                 discover the camera on the network
 *   node tools/wireless-probe.mjs --ip 192.168.1.24   connect straight to a known address
 *   node tools/wireless-probe.mjs --json out.json     also save the raw dump
 *
 * Options:
 *   --ip <addr>      camera address, skipping discovery
 *   --port <n>       camera command port (default 55740)
 *   --no-advertise   listen for the camera without broadcasting this host
 *   --wait <sec>     how long to wait for the camera (default 180)
 *   --json <file>    write the full property dump to a file
  --scan           with --ip: report which of the camera's ports are open
 */

import { writeFile } from 'node:fs/promises'

import { FujiIpTransport, awaitTetherInvite, scanPorts, CANDIDATE_PORTS, FUJI_CMD_PORT } from './fuji-ip.mjs'
import { FujiCamera, slotToRecipe } from '../js/camera.js'
import { PTPOp, PTPResp, respName } from '../js/ptp.js'
import { toHex } from '../js/binary.js'
import {
  SLOT_PROP, NAME_PROP, FIRST_PRESET_PROP, LAST_PRESET_PROP,
  PROPS_BY_CODE, formatValue, decodeValue,
} from '../js/props.js'
import { summarize } from '../js/plan.js'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const USAGE = `Does this camera expose its custom-preset properties over Wi-Fi?

  node tools/wireless-probe.mjs                      discover the camera on the network
  node tools/wireless-probe.mjs --ip 192.168.1.24    connect straight to a known address

  --ip <addr>      camera address, skipping discovery
  --port <n>       camera command port (default ${FUJI_CMD_PORT})
  --no-advertise   listen for the camera without broadcasting this host
  --wait <sec>     how long to wait for the camera (default 180)
  --json <file>    write the full property dump to a file
  --scan           with --ip: report which of the camera's ports are open

Read-only apart from one harmless write: the slot selector set to the value it
already holds, which is the only way to learn whether writes are permitted.

Exit status: 0 wireless works, 1 not exposed, 2 partial, 3 could not connect.`

if (flag('--help') || flag('-h')) {
  console.log(USAGE)
  process.exit(0)
}

/** CLI flags, overridable by callers (the test suite passes these directly). */
const cliOptions = {
  ip: value('--ip'),
  port: Number(value('--port', FUJI_CMD_PORT)),
  advertise: !flag('--no-advertise'),
  wait: Number(value('--wait', 180)) * 1000,
  json: value('--json'),
  scan: flag('--scan'),
  out: console.log,
}

/** All probe output goes through here so callers (tests) can silence it. */
let out = console.log
const log = message => out(`  ${message}`)
const heading = title => out(`\n${title}\n${'─'.repeat(title.length)}`)

const CHECKLIST = `
On the camera (X-S20 menu names), before running this:
  1. MENU → NETWORK/USB SETTING → NETWORK SETTING → join the same Wi-Fi as this
     computer (SIMPLE SETUP for a WPS router, otherwise MANUAL SETUP).
  2. MENU → NETWORK/USB SETTING → CONNECTION MODE →
     WIRELESS TETHER SHOOTING FIXED.
  3. Set the mode dial to P, A, S or M.

The camera then sits and waits — its indicator lamp flashes amber. There is no
"connect" button to press: the computer is the side that reaches out.

Easier and more reliable than waiting for discovery: read the camera's address
from MENU → NETWORK/USB SETTING → INFORMATION and pass it directly:
  node tools/wireless-probe.mjs --ip <that address>

If your firewall asks whether node may accept incoming connections, say yes —
discovery needs it, though --ip does not.

Second mode worth trying if tether will not connect: PLAYBACK MENU →
WIRELESS COMMUNICATION. There the camera listens on port 55740 directly, which
is how the Fujifilm X App and Camera Remote connect — arguably the more relevant
mode for a phone app anyway.
`

/** Diagnostic for a refused connection: what is this address actually running? */
async function scan(ip) {
  heading(`Scanning ${ip}`)
  log(`trying ${CANDIDATE_PORTS.length} ports the camera might use…`)
  const results = await scanPorts(ip)
  const open = results.filter(r => r.state === 'open')
  console.log()
  for (const { port, state } of results) {
    if (state === 'open') out(`  ${String(port).padStart(5)}  OPEN`)
  }
  if (open.length === 0) {
    const refused = results.filter(r => r.state === 'refused').length
    out(`  nothing open.`)
    out(refused === results.length
      ? `\n  Every port was actively refused, so a device IS at ${ip} — but it is not\n  listening for anything. Either the camera has left its waiting screen, or\n  ${ip} belongs to a different device on your network.`
      : `\n  Most ports did not answer at all, which usually means nothing is at ${ip}\n  any more (addresses change when the camera reconnects). Re-check\n  MENU → NETWORK/USB SETTING → INFORMATION.`)
  } else {
    out(`\n  Try the handshake against an open port:\n    node tools/wireless-probe.mjs --ip ${ip} --port ${open[0].port}`)
  }
  return open
}

async function connect(options) {
  const transport = new FujiIpTransport(log)
  let target

  if (options.ip) {
    target = { ip: options.ip, port: options.port || FUJI_CMD_PORT, model: '' }
    heading('Connecting')
  } else {
    heading('Waiting for the camera')
    out(CHECKLIST)
    target = await awaitTetherInvite({ log, advertise: options.advertise, timeout: options.wait })
  }

  try {
    await transport.connect(target.ip, target.port)
  } catch (err) {
    if (options.ip && /ECONNREFUSED/.test(err.message ?? '')) {
      out(`\n  Nothing is listening on ${target.ip}:${target.port}.`)
      out(`  The address answers, so a device is there — but that port is closed.`)
      await scan(target.ip)
      out(`\n  In WIRELESS TETHER SHOOTING FIXED the camera announces its own port during
  discovery rather than always using ${FUJI_CMD_PORT}. Run the probe without --ip to
  let it discover the camera (allow the firewall prompt):

    node tools/wireless-probe.mjs --json wireless-report.json`)
    }
    throw err
  }
  const name = await transport.handshake('recipe-probe')
  log(`handshake accepted by "${name || '(unnamed)'}"`)
  return { transport, target, name }
}

async function probe(overrides = {}) {
  const options = { ...cliOptions, ...overrides }
  out = options.out ?? console.log

  if (options.scan && options.ip) {
    await scan(options.ip)
    return { verdict: 'scan' }
  }
  const { transport, target, name } = await connect(options)
  const camera = new FujiCamera(transport, log)
  const report = {
    probedAt: new Date().toISOString(),
    transport: 'ptp-ip (wireless tether)',
    camera: { announcedModel: target.model, handshakeName: name, ip: target.ip, port: target.port },
  }

  heading('Session')
  await camera.openSession()
  const info = await camera.getDeviceInfo()
  report.camera.model = info.model
  report.camera.firmware = info.deviceVersion
  report.camera.serial = info.serialNumber
  report.supportedProperties = info.properties.map(code => `0x${code.toString(16)}`)

  const advertised = info.properties.includes(SLOT_PROP)
  log(`0xD18C (slot selector) ${advertised ? 'IS' : 'is NOT'} in the camera's advertised property list`)

  heading('Preset properties over Wi-Fi')
  const slotBytes = await camera.readProp(SLOT_PROP)
  report.slotSelectorReadable = !!slotBytes

  if (!slotBytes) {
    log('GetDevicePropValue(0xD18C) returned nothing.')
    report.verdict = 'no'
    return finish(camera, transport, report, options)
  }

  const currentSlot = await camera.currentSlot()
  log(`current slot: C${currentSlot}`)
  const desc = await camera.describeProp(SLOT_PROP)
  if (desc) {
    report.slotDescriptor = desc
    log(`slot descriptor: datatype 0x${desc.dataType.toString(16)}, ${desc.writable ? 'writable' : 'read-only'}${desc.max ? `, range ${desc.min}–${desc.max}` : ''}`)
  }

  // Read the slot the camera is already on — this does not change anything.
  const slot = await camera.readSlot(currentSlot)
  report.slot = {
    number: currentSlot,
    name: slot.name,
    properties: Object.fromEntries([...slot.props].map(([code, bytes]) => [`0x${code.toString(16)}`, toHex(bytes)])),
  }

  const readable = slot.props.size
  const total = LAST_PRESET_PROP - FIRST_PRESET_PROP + 1
  log(`name: "${slot.name}"`)
  log(`${readable}/${total} preset properties answered`)
  out()
  for (let code = FIRST_PRESET_PROP; code <= LAST_PRESET_PROP; code++) {
    const prop = PROPS_BY_CODE.get(code)
    const bytes = slot.props.get(code)
    const label = (prop?.label ?? `0x${code.toString(16)}`).padEnd(38)
    if (!bytes) { out(`  0x${code.toString(16)}  ${label} not supported`); continue }
    const decoded = prop && prop.kind !== 'raw'
      ? formatValue(prop, decodeValue(prop, bytes))
      : 'raw'
    out(`  0x${code.toString(16)}  ${label} ${String(decoded).padEnd(22)} [${toHex(bytes)}]`)
  }
  out()
  log(`reads as: ${summarize(slotToRecipe(slot, info.model)) || '(nothing decodable)'}`)

  // Writability: set the slot selector to the value it already has. Harmless,
  // and the only way to find out whether writes are accepted in this mode.
  heading('Write permission')
  const { code: writeResp } = await transport.sendDataCommand(
    PTPOp.SetDevicePropValue, [SLOT_PROP], new Uint8Array([currentSlot & 0xff, 0]))
  report.slotSelectorWritable = writeResp === PTPResp.OK
  log(`SetDevicePropValue(0xD18C, ${currentSlot}) → ${respName(writeResp)}${writeResp === PTPResp.OK ? '' : ' (writes appear blocked in this mode)'}`)

  const nameBytes = await camera.readProp(NAME_PROP)
  report.nameReadable = !!nameBytes

  report.readable = readable
  report.verdict = readable >= 15 && report.slotSelectorWritable ? 'yes'
    : readable > 0 ? 'partial' : 'no'
  return finish(camera, transport, report, options)
}

async function finish(camera, transport, report, options) {
  await camera.closeSession().catch(() => {})
  transport.close()

  heading('Verdict')
  if (report.verdict === 'yes') {
    out(`  Wireless recipe writing looks POSSIBLE on this body.
  ${report.readable} preset properties are readable over Wi-Fi and the slot
  selector accepts writes. A wireless transport is worth building: an iOS app
  could push recipes with no cable at all.`)
  } else if (report.verdict === 'partial') {
    out(`  PARTIAL. ${report.readable} preset properties answered over Wi-Fi but
  ${report.slotSelectorWritable ? 'something else is off' : 'the slot selector refused a write'}.
  Worth a closer look before committing to a wireless design — send the JSON dump.`)
  } else {
    out(`  NOT exposed over Wi-Fi in this mode. The custom-preset properties only
  answer over USB (RAW CONV./BACKUP RESTORE), so an iOS app would need the
  ImageCaptureCore USB route and a cable.`)
  }

  const jsonPath = options.json
  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify(report, null, 2))
    out(`\n  Full dump written to ${jsonPath}`)
  }
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const report = await probe()
    process.exit(report.verdict === 'yes' ? 0 : report.verdict === 'partial' ? 2 : 1)
  } catch (err) {
    console.error(`\n  Failed: ${err.message}`)
    process.exit(3)
  }
}

export { probe }
