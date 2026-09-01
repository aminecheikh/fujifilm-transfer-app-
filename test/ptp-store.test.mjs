import test from 'node:test'
import assert from 'node:assert/strict'

import { packContainer, unpackContainer, ContainerType, PTPOp, respName, PTPResp } from '../js/ptp.js'
import { packPTPString, unpackPTPString, fromHex, toHex } from '../js/binary.js'
import { Library } from '../js/store.js'

function memoryStorage() {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
  }
}

test('command containers pack to the PTP/USB layout', () => {
  const bytes = packContainer({
    type: ContainerType.Command, code: PTPOp.GetDevicePropValue, transactionId: 7, params: [0xd192],
  })
  assert.equal(toHex(bytes), '10 00 00 00 01 00 15 10 07 00 00 00 92 d1 00 00')
  const back = unpackContainer(bytes)
  assert.equal(back.code, PTPOp.GetDevicePropValue)
  assert.equal(back.transactionId, 7)
  assert.deepEqual(back.params, [0xd192])
})

test('data containers carry their payload intact', () => {
  const payload = fromHex('0b 00')
  const bytes = packContainer({ type: ContainerType.Data, code: PTPOp.SetDevicePropValue, transactionId: 3, data: payload })
  const back = unpackContainer(bytes)
  assert.equal(back.type, ContainerType.Data)
  assert.equal(toHex(back.data), '0b 00')
})

test('a short container is rejected rather than misread', () => {
  assert.throws(() => unpackContainer(fromHex('01 02 03')), /too short/)
})

test('response codes get readable names', () => {
  assert.equal(respName(PTPResp.OK), 'OK')
  assert.equal(respName(0x2019), 'DeviceBusy')
  assert.equal(respName(0x1234), '0x1234')
})

test('PTP strings survive a round trip, including empty', () => {
  assert.equal(unpackPTPString(packPTPString('Acros Push')), 'Acros Push')
  assert.equal(unpackPTPString(packPTPString('')), '')
  assert.equal(toHex(packPTPString('')), '00')
})

test('library saves, reloads and deletes recipes', () => {
  const storage = memoryStorage()
  const library = new Library(storage)
  const saved = library.upsert({ name: 'Kodachrome 64', settings: { filmSimulation: 0x0b } })
  assert.ok(saved.id)

  const reloaded = new Library(storage)
  assert.equal(reloaded.recipes.length, 1)
  assert.equal(reloaded.get(saved.id).name, 'Kodachrome 64')

  reloaded.remove(saved.id)
  assert.equal(new Library(storage).recipes.length, 0)
})

test('import is additive and accepts a library, a single recipe or an array', () => {
  const library = new Library(memoryStorage())
  library.upsert({ name: 'Existing', settings: { filmSimulation: 1 } })

  assert.equal(library.importJSON(JSON.stringify({ name: 'Solo', settings: { filmSimulation: 2 } })), 1)
  assert.equal(library.importJSON(JSON.stringify([
    { name: 'A', settings: { filmSimulation: 3 } },
    { name: 'B', raw: { '0xd192': '04 00' } },
  ])), 2)
  assert.equal(library.recipes.length, 4)
  assert.ok(library.recipes.some(r => r.name === 'Existing'), 'import never drops what was there')

  assert.throws(() => library.importJSON('{"nope":true}'), /Unrecognised file/)
  assert.throws(() => library.importJSON('[]'), /No recipes/)
})

test('exported library re-imports into a fresh library', () => {
  const source = new Library(memoryStorage())
  source.upsert({ name: 'Kodachrome 64', settings: { filmSimulation: 0x0b, highlightTone: 1 }, raw: { '0xd1a1': '00 80' } })
  const target = new Library(memoryStorage())
  assert.equal(target.importJSON(source.exportJSON()), 1)
  assert.equal(target.recipes[0].settings.highlightTone, 1)
  assert.equal(target.recipes[0].raw['0xd1a1'], '00 80')
})

test('deleting a recipe clears it from saved sets', () => {
  const library = new Library(memoryStorage())
  const recipe = library.upsert({ name: 'One', settings: { filmSimulation: 1 } })
  library.upsertSet({ name: 'Street', slots: { 1: recipe.id, 2: recipe.id } })
  library.remove(recipe.id)
  assert.deepEqual(library.sets[0].slots, {})
})

test('the bundled example file imports and plans cleanly', async () => {
  const { readFile } = await import('node:fs/promises')
  const { buildWritePlan } = await import('../js/plan.js')
  const library = new Library(memoryStorage())
  const text = await readFile(new URL('../examples/example-recipes.json', import.meta.url), 'utf8')

  assert.equal(library.importJSON(text), 2)
  for (const recipe of library.recipes) {
    const plan = buildWritePlan(recipe)
    assert.ok(plan.steps.length >= 10, `${recipe.name} produced only ${plan.steps.length} writes`)
    assert.ok(plan.steps.every(s => s.bytes.length === 2))
  }
})
