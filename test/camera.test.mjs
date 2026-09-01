import test from 'node:test'
import assert from 'node:assert/strict'

import { FujiCamera, slotToRecipe } from '../js/camera.js'
import { MockCameraTransport } from '../js/mock-camera.js'
import { buildWritePlan } from '../js/plan.js'
import { WB_COLOR_TEMP } from '../js/props.js'

async function connected(options) {
  const transport = new MockCameraTransport(options)
  const camera = new FujiCamera(transport)
  await camera.openSession()
  await camera.getDeviceInfo()
  await camera.detectSlotCount()
  return { transport, camera }
}

const RECIPE = {
  name: 'Kodachrome 64',
  settings: {
    filmSimulation: 0x0b, whiteBalance: WB_COLOR_TEMP, colorTemp: 6300,
    wbShiftRed: 3, wbShiftBlue: -4, dynamicRange: 200,
    highlightTone: 1, shadowTone: 0.5, color: 1, sharpness: 1, clarity: 0,
    grain: 2, colorChrome: 3, colorChromeFxBlue: 2, smoothSkin: 1,
  },
}

test('device info and slot count come from the camera', async () => {
  const { camera } = await connected()
  assert.equal(camera.info.model, 'X-S20 (demo)')
  assert.equal(camera.slotCount, 4)
  assert.ok(camera.supportsPresets())
})

test('a recipe written to a slot verifies byte-for-byte', async () => {
  const { camera } = await connected()
  const result = await camera.writeSlot(2, buildWritePlan(RECIPE))

  assert.equal(result.rejected, 0, JSON.stringify(result.results.filter(r => !r.ok)))
  assert.equal(result.mismatched, 0)
  assert.ok(result.results.every(r => r.verified !== false))

  const slot = await camera.readSlot(2)
  assert.equal(slot.name, 'Kodachrome 64')
  const back = slotToRecipe(slot, 'X-S20 (demo)')
  for (const [key, value] of Object.entries(RECIPE.settings)) {
    assert.equal(back.settings[key], value, `${key} did not survive the round trip`)
  }
})

test('other slots are left untouched', async () => {
  const { camera } = await connected()
  await camera.writeSlot(1, buildWritePlan(RECIPE))
  const untouched = await camera.readSlot(3)
  assert.equal(untouched.name, 'C3')
  assert.equal(slotToRecipe(untouched).settings.filmSimulation, 0x01)
})

test('capture from camera, then write it back unchanged', async () => {
  const { camera } = await connected()
  await camera.writeSlot(4, buildWritePlan(RECIPE))
  const captured = slotToRecipe(await camera.readSlot(4), 'X-S20 (demo)')

  const replay = await camera.writeSlot(1, buildWritePlan(captured, { includeAdvanced: true }))
  assert.equal(replay.mismatched, 0)
  const slot1 = await camera.readSlot(1)
  assert.equal(slot1.name, captured.name)
  assert.equal(slotToRecipe(slot1).settings.filmSimulation, 0x0b)
})

test('a monochrome recipe skips colour and writes monochromatic colour', async () => {
  const { camera } = await connected()
  const mono = {
    name: 'Acros Push',
    settings: {
      filmSimulation: 0x0c, whiteBalance: 0x0002, color: 2,
      monoWarmCool: 2, monoMagentaGreen: -1, grain: 4,
      highlightTone: 1.5, shadowTone: 2, sharpness: 0, clarity: 2,
    },
  }
  const plan = buildWritePlan(mono)
  assert.ok(plan.skipped.some(s => s.key === 'color'))

  const result = await camera.writeSlot(3, plan)
  assert.equal(result.rejected, 0, JSON.stringify(result.results.filter(r => !r.ok)))
  const settings = slotToRecipe(await camera.readSlot(3)).settings
  assert.equal(settings.monoWarmCool, 2)
  assert.equal(settings.monoMagentaGreen, -1)
  assert.equal(settings.color, 0, 'colour was left alone on a black-and-white simulation')
})

test('a camera refusal is reported per property, not fatal', async () => {
  const { camera } = await connected({ lowIso: true }) // this body refuses DR200 at the current ISO
  const result = await camera.writeSlot(1, buildWritePlan(RECIPE))

  const dr = result.results.find(r => r.key === 'dynamicRange')
  assert.equal(dr.ok, false)
  assert.equal(result.rejected, 1)
  assert.ok(result.written > 10, 'the rest of the recipe still went in')
  assert.equal(slotToRecipe(await camera.readSlot(1)).settings.filmSimulation, 0x0b)
})

test('writing all four slots leaves each with its own recipe', async () => {
  const { camera } = await connected()
  const names = ['Reggies Portra', 'Acros Push', 'Kodachrome 64', 'Eterna Soft']
  for (let slot = 1; slot <= 4; slot++) {
    await camera.writeSlot(slot, buildWritePlan({ ...RECIPE, name: names[slot - 1] }))
  }
  const slots = await camera.readAllSlots()
  assert.deepEqual(slots.map(s => s.name), names)
})

test('the slot the camera was on is reported and selectable', async () => {
  const { camera } = await connected()
  await camera.selectSlot(3)
  assert.equal(await camera.currentSlot(), 3)
})
