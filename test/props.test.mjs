import test from 'node:test'
import assert from 'node:assert/strict'

import { PROPS_BY_KEY, encodeValue, decodeValue, formatValue, skipReason, WB_COLOR_TEMP } from '../js/props.js'
import { buildWritePlan } from '../js/plan.js'
import { toHex } from '../js/binary.js'

const prop = key => PROPS_BY_KEY.get(key)

test('x10 tone values round-trip through int16', () => {
  for (const value of [-2, -0.5, 0, 0.5, 1.5, 4]) {
    const bytes = encodeValue(prop('highlightTone'), value)
    assert.equal(bytes.length, 2)
    assert.equal(decodeValue(prop('highlightTone'), bytes), value)
  }
  assert.equal(toHex(encodeValue(prop('highlightTone'), -1.5)), 'f1 ff')
})

test('negative WB shift encodes as signed, WB mode as unsigned', () => {
  assert.equal(toHex(encodeValue(prop('wbShiftRed'), -9)), 'f7 ff')
  assert.equal(decodeValue(prop('wbShiftRed'), encodeValue(prop('wbShiftRed'), -9)), -9)
  assert.equal(toHex(encodeValue(prop('whiteBalance'), WB_COLOR_TEMP)), '07 80')
  assert.equal(decodeValue(prop('whiteBalance'), encodeValue(prop('whiteBalance'), WB_COLOR_TEMP)), WB_COLOR_TEMP)
})

test('values format the way the camera menu shows them', () => {
  assert.equal(formatValue(prop('filmSimulation'), 0x11), 'Classic Neg.')
  assert.equal(formatValue(prop('highlightTone'), 1.5), '+1.5')
  assert.equal(formatValue(prop('shadowTone'), -2), '-2.0')
  assert.equal(formatValue(prop('sharpness'), 2), '+2')
  assert.equal(formatValue(prop('colorTemp'), 5500), '5500 K')
  assert.equal(formatValue(prop('filmSimulation'), 0x7f), 'unknown (127)')
})

test('conditional writes match what the camera accepts', () => {
  const colour = { filmSimulation: 0x11, whiteBalance: 0x0002, monoWarmCool: 2, color: 1 }
  assert.ok(skipReason(prop('monoWarmCool'), colour))
  assert.equal(skipReason(prop('color'), colour), null)
  assert.ok(skipReason(prop('colorTemp'), colour))

  const mono = { filmSimulation: 0x0c, whiteBalance: WB_COLOR_TEMP, monoWarmCool: 2, monoMagentaGreen: 0, color: 1 }
  assert.equal(skipReason(prop('monoWarmCool'), mono), null)
  assert.ok(skipReason(prop('monoMagentaGreen'), mono), 'a zero monochromatic value is refused')
  assert.ok(skipReason(prop('color'), mono))
  assert.equal(skipReason(prop('colorTemp'), mono), null)
})

test('write plan orders film simulation and WB before what depends on them', () => {
  const plan = buildWritePlan({
    name: 'Kodachrome 64',
    settings: {
      filmSimulation: 0x0b, whiteBalance: WB_COLOR_TEMP, colorTemp: 6300,
      wbShiftRed: 3, wbShiftBlue: -4, dynamicRange: 200,
      highlightTone: 1, shadowTone: 0.5, color: 1, sharpness: 1, clarity: 0,
      grain: 2, colorChrome: 3, colorChromeFxBlue: 2, smoothSkin: 1,
    },
  })
  const keys = plan.steps.map(s => s.key)
  assert.equal(keys[0], 'filmSimulation')
  assert.ok(keys.indexOf('whiteBalance') < keys.indexOf('colorTemp'))
  assert.ok(keys.includes('clarity'))
  assert.equal(plan.skipped.length, 0)
  assert.equal(plan.steps.find(s => s.key === 'colorTemp').hex, '9c 18')
})

test('raw captured bytes are replayed verbatim when no value is modelled', () => {
  const plan = buildWritePlan(
    { name: 'Captured', settings: { filmSimulation: 0x01 }, raw: { '0xd1a1': '00 80', '0xd18e': '01 00' } },
    { includeAdvanced: true },
  )
  const nr = plan.steps.find(s => s.key === 'highIsoNR')
  assert.equal(nr.source, 'raw')
  assert.equal(nr.hex, '00 80')
  assert.ok(plan.steps.some(s => s.key === 'imageSize'))
})

test('advanced properties stay out of the plan unless asked for', () => {
  const recipe = { name: 'x', settings: { filmSimulation: 1 }, raw: { '0xd1a1': '00 80' } }
  const plan = buildWritePlan(recipe)
  assert.ok(!plan.steps.some(s => s.key === 'highIsoNR'))
  assert.ok(plan.omitted.some(s => s.key === 'highIsoNR'))
  assert.equal(plan.skipped.length, 0, 'an opt-out is not a camera refusal')

  const opted = buildWritePlan(recipe, { includeAdvanced: true })
  assert.ok(opted.steps.some(s => s.key === 'highIsoNR'))
  assert.equal(opted.omitted.length, 0)
})
