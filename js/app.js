/** UI wiring: library on the left, camera slots on the right, log underneath. */

import { WebUsbTransport } from './ptp.js'
import { FujiCamera, slotToRecipe, DEFAULT_SLOT_COUNT } from './camera.js'
import { MockCameraTransport } from './mock-camera.js'
import { Library, safeStorage } from './store.js'
import { buildWritePlan, summarize } from './plan.js'
import { PRESET_PROPS, GROUP_LABELS, skipReason } from './props.js'

const $ = id => document.getElementById(id)
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props)
  for (const child of children.flat()) {
    if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)))
  }
  return node
}

const state = {
  library: new Library(),
  transport: null,
  camera: null,
  mode: 'idle',
  slotCount: DEFAULT_SLOT_COUNT,
  cameraSlots: new Map(), // slot number -> { name, props }
  assignment: {},         // slot number -> recipe id
  editing: null,          // draft recipe being edited
  backupTaken: false,
  busy: false,
}

// -- logging ---------------------------------------------------------------

function log(message, kind = '') {
  const stamp = new Date().toLocaleTimeString()
  const line = el('div', { className: kind }, `${stamp}  ${message}\n`)
  $('log').append(line)
  $('log').scrollTop = $('log').scrollHeight
}

function fail(err) {
  log(err?.message ?? String(err), 'bad')
  console.error(err)
}

// -- connection ------------------------------------------------------------

function setStatus(text, kind) {
  $('status').textContent = text
  $('status').className = `pill ${kind}`
}

async function withBusy(label, fn) {
  if (state.busy) { log('busy — wait for the current operation to finish', 'warn'); return }
  state.busy = true
  document.querySelectorAll('button').forEach(b => { b.dataset.wasDisabled = b.disabled ? '1' : ''; b.disabled = true })
  try {
    return await fn()
  } catch (err) {
    fail(err)
  } finally {
    state.busy = false
    document.querySelectorAll('button').forEach(b => { b.disabled = b.dataset.wasDisabled === '1' })
    renderAll()
    if (label) log(`${label} finished`)
  }
}

async function startSession(transport, mode) {
  state.transport = transport
  state.camera = new FujiCamera(transport, msg => log(msg))
  await state.camera.openSession()
  await state.camera.getDeviceInfo()
  if (!state.camera.supportsPresets()) {
    log('This camera does not advertise the custom-preset properties (0xD18C). Recipe writing will not work on it.', 'bad')
  }
  state.slotCount = await state.camera.detectSlotCount()
  state.mode = mode
  setStatus(mode === 'demo' ? `Demo — ${state.camera.info.model}` : `Connected — ${state.camera.info.model}`,
    mode === 'demo' ? 'pill-demo' : 'pill-live')
  $('disconnect').hidden = false
  renderAll()
}

async function connect() {
  await withBusy(null, async () => {
    const transport = new WebUsbTransport(msg => log(msg))
    await transport.connect()
    await startSession(transport, 'usb')
    log('Ready. Read the slots first if you want a backup of what is on the camera now.')
  })
}

async function demo() {
  await withBusy(null, async () => {
    await startSession(new MockCameraTransport(), 'demo')
    log('Demo mode: a simulated X-S20 with four slots. Nothing touches real hardware.', 'warn')
  })
}

async function disconnect() {
  await withBusy(null, async () => {
    await state.camera?.closeSession()
    if (state.transport?.close) await state.transport.close()
    state.camera = null
    state.transport = null
    state.mode = 'idle'
    state.cameraSlots.clear()
    state.backupTaken = false
    setStatus('Not connected', 'pill-idle')
    $('disconnect').hidden = true
  })
}

function requireCamera() {
  if (!state.camera) throw new Error('Connect a camera first (or try Demo mode)')
  return state.camera
}

// -- camera operations -----------------------------------------------------

async function readSlots() {
  await withBusy('Read', async () => {
    const camera = requireCamera()
    const slots = await camera.readAllSlots(state.slotCount)
    state.cameraSlots = new Map(slots.map(s => [s.slot, s]))
    for (const slot of slots) log(`C${slot.slot}: "${slot.name}" — ${describeSlot(slot)}`)
    if (!state.backupTaken) {
      safeStorage().setItem('fujifilm-recipe-transfer/last-backup', JSON.stringify(backupPayload(slots)))
      state.backupTaken = true
      log('Kept a backup of these slots in this browser. "Back up to file" saves a copy you can keep.')
    }
  })
}

function describeSlot(slot) {
  const recipe = slotToRecipe(slot)
  return summarize(recipe) || 'no readable settings'
}

function backupPayload(slots) {
  return {
    format: 'fujifilm-recipe-library',
    version: 1,
    exportedAt: new Date().toISOString(),
    model: state.camera?.info?.model ?? '',
    recipes: slots.map(slot => ({
      ...slotToRecipe(slot, state.camera?.info?.model ?? ''),
      name: `${slot.name || `C${slot.slot}`} (C${slot.slot} backup)`,
    })),
  }
}

async function backupToFile() {
  await withBusy('Backup', async () => {
    const camera = requireCamera()
    const slots = state.cameraSlots.size === state.slotCount
      ? [...state.cameraSlots.values()]
      : await camera.readAllSlots(state.slotCount)
    state.cameraSlots = new Map(slots.map(s => [s.slot, s]))
    state.backupTaken = true
    const model = (camera.info?.model ?? 'camera').replace(/\W+/g, '-')
    download(`${model}-slots-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(backupPayload(slots), null, 2))
    log(`Backed up C1–C${state.slotCount} to a file.`)
  })
}

async function writeSlot(slotNumber, recipe) {
  const camera = requireCamera()
  const plan = buildWritePlan(recipe, { includeAdvanced: $('include-advanced').checked })
  if (plan.steps.length === 0) throw new Error(`"${recipe.name}" has no settings to write`)

  for (const skip of plan.skipped) log(`C${slotNumber}: skipped ${skip.label} — ${skip.reason}`, 'muted')
  const result = await camera.writeSlot(slotNumber, plan)

  for (const r of result.results) {
    if (!r.ok) log(`C${slotNumber}: ${r.label} rejected by the camera (${r.display})`, 'bad')
    else if (r.verified === false) log(`C${slotNumber}: ${r.label} accepted but read back as ${r.readBack}`, 'warn')
  }
  const verdict = result.rejected === 0 && result.mismatched === 0 ? 'ok' : 'warn'
  log(`C${slotNumber} ← "${recipe.name}": ${result.written} written, ${result.rejected} rejected, ${result.mismatched} unverified`, verdict)

  const slot = await camera.readSlot(slotNumber)
  state.cameraSlots.set(slotNumber, slot)
  return result
}

async function ensureBackup() {
  if (state.backupTaken || !state.camera) return
  log('Reading the current slots first, so this is reversible…')
  const slots = await state.camera.readAllSlots(state.slotCount)
  state.cameraSlots = new Map(slots.map(s => [s.slot, s]))
  safeStorage().setItem('fujifilm-recipe-transfer/last-backup', JSON.stringify(backupPayload(slots)))
  state.backupTaken = true
}

async function writeOne(slotNumber) {
  const recipe = state.library.get(state.assignment[slotNumber])
  if (!recipe) { log(`Assign a recipe to C${slotNumber} first`, 'warn'); return }
  await withBusy('Write', async () => {
    await ensureBackup()
    await writeSlot(slotNumber, recipe)
  })
}

async function writeAll() {
  const pairs = Object.entries(state.assignment)
    .map(([slot, id]) => [Number(slot), state.library.get(id)])
    .filter(([, recipe]) => recipe)
  if (pairs.length === 0) { log('Nothing assigned to write', 'warn'); return }
  if (!confirm(`Overwrite ${pairs.length} custom slot(s) on the camera?`)) return

  await withBusy('Write all', async () => {
    await ensureBackup()
    for (const [slotNumber, recipe] of pairs.sort((a, b) => a[0] - b[0])) {
      await writeSlot(slotNumber, recipe)
    }
  })
}

async function captureSlot(slotNumber) {
  await withBusy('Capture', async () => {
    const camera = requireCamera()
    const slot = await camera.readSlot(slotNumber)
    state.cameraSlots.set(slotNumber, slot)
    const recipe = state.library.upsert(slotToRecipe(slot, camera.info?.model ?? ''))
    state.assignment[slotNumber] = recipe.id
    log(`Saved C${slotNumber} to the library as "${recipe.name}"`)
  })
}

// -- rendering -------------------------------------------------------------

function renderAll() {
  renderSlots()
  renderLibrary()
  renderSets()
}

function renderSlots() {
  const host = $('slots')
  host.replaceChildren()
  const connected = !!state.camera

  for (let slot = 1; slot <= state.slotCount; slot++) {
    const current = state.cameraSlots.get(slot)
    const select = el('select')
    select.append(el('option', { value: '' }, '— leave alone —'))
    for (const recipe of state.library.recipes) {
      select.append(el('option', { value: recipe.id, selected: state.assignment[slot] === recipe.id }, recipe.name))
    }
    select.onchange = () => {
      if (select.value) state.assignment[slot] = select.value
      else delete state.assignment[slot]
    }

    host.append(el('div', { className: 'slot' },
      el('div', { className: 'slot-name' }, `C${slot}`,
        el('span', { className: 'slot-current' }, current ? (current.name || '(unnamed)') : 'not read yet')),
      select,
      el('div', { className: 'actions' },
        el('button', { className: 'tiny', disabled: !connected, onclick: () => writeOne(slot) }, 'Write'),
        el('button', { className: 'tiny ghost', disabled: !connected, onclick: () => captureSlot(slot) }, 'Save to library')),
    ))
  }
}

function renderLibrary() {
  const host = $('library')
  const query = $('search').value.trim().toLowerCase()
  const recipes = state.library.recipes
    .filter(r => !query || `${r.name} ${r.notes ?? ''}`.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name))

  $('count').textContent = state.library.recipes.length ? `(${state.library.recipes.length})` : ''
  host.replaceChildren()

  if (recipes.length === 0) {
    host.append(el('p', { className: 'empty' }, state.library.recipes.length
      ? 'No recipe matches that search.'
      : 'No recipes yet. Create one, import a file, or read the slots off the camera and save them here.'))
    return
  }

  for (const recipe of recipes) {
    host.append(el('div', { className: 'recipe' },
      el('div', { className: 'recipe-top' },
        el('span', { className: 'recipe-name' }, recipe.name),
        recipe.model ? el('span', { className: 'muted small' }, recipe.model) : null),
      el('div', { className: 'recipe-sum' }, summarize(recipe) || 'raw capture'),
      recipe.notes ? el('div', { className: 'recipe-sum' }, recipe.notes) : null,
      el('div', { className: 'recipe-actions' },
        el('button', { className: 'tiny', onclick: () => openEditor(recipe) }, 'Edit'),
        el('button', { className: 'tiny', onclick: () => { state.library.duplicate(recipe.id); renderAll() } }, 'Duplicate'),
        el('button', {
          className: 'tiny',
          onclick: () => download(`${recipe.name.replace(/\W+/g, '-')}.json`, state.library.exportRecipe(recipe.id)),
        }, 'Export'),
        el('button', {
          className: 'tiny danger-ghost',
          onclick: () => { if (confirm(`Delete "${recipe.name}"?`)) { state.library.remove(recipe.id); renderAll() } },
        }, 'Delete')),
    ))
  }
}

function renderSets() {
  const select = $('set-select')
  const chosen = select.value
  select.replaceChildren(el('option', { value: '' }, '— none —'))
  for (const set of state.library.sets) {
    select.append(el('option', { value: set.id, selected: set.id === chosen }, set.name))
  }
}

// -- editor ----------------------------------------------------------------

function blankRecipe() {
  return {
    name: 'New recipe',
    notes: '',
    model: state.camera?.info?.model ?? '',
    settings: {
      filmSimulation: 0x0b, dynamicRange: 100, whiteBalance: 0x0002,
      wbShiftRed: 0, wbShiftBlue: 0, highlightTone: 0, shadowTone: 0,
      color: 0, sharpness: 0, clarity: 0, grain: 1,
      colorChrome: 1, colorChromeFxBlue: 1, smoothSkin: 1,
    },
    raw: {},
    source: 'manual',
  }
}

function openEditor(recipe) {
  state.editing = structuredClone(recipe)
  $('editor-title').textContent = recipe.id ? `Edit — ${recipe.name}` : 'New recipe'
  $('editor-panel').hidden = false
  renderEditor()
  $('editor-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function closeEditor() {
  state.editing = null
  $('editor-panel').hidden = true
}

function renderEditor() {
  const draft = state.editing
  const host = $('editor-fields')
  host.replaceChildren()

  const meta = el('div', { className: 'field-group' }, el('h3', {}, 'Recipe'))
  meta.append(field('Name (16 characters reach the camera)',
    el('input', { type: 'text', value: draft.name, maxLength: 64, oninput: e => { draft.name = e.target.value } })))
  meta.append(field('Notes',
    el('input', { type: 'text', value: draft.notes ?? '', oninput: e => { draft.notes = e.target.value } })))
  host.append(meta)

  for (const [group, label] of Object.entries(GROUP_LABELS)) {
    const props = PRESET_PROPS.filter(p => p.group === group)
    if (props.length === 0) continue
    const box = el('div', { className: 'field-group' }, el('h3', {}, label))

    for (const prop of props) {
      if (prop.kind === 'raw') {
        const hex = draft.raw?.[`0x${prop.code.toString(16)}`]
        box.append(field(prop.label,
          el('input', { type: 'text', value: hex ?? '', placeholder: 'not captured', readOnly: true }),
          prop.note, !prop.confirmed))
        continue
      }

      const value = draft.settings[prop.key]
      let input
      if (prop.kind === 'enum') {
        input = el('select')
        input.append(el('option', { value: '' }, '— leave alone —'))
        for (const [raw, text] of Object.entries(prop.options)) {
          input.append(el('option', { value: raw, selected: String(value) === raw }, text))
        }
      } else {
        input = el('input', {
          type: 'number', value: value ?? '', min: prop.min, max: prop.max, step: prop.step ?? 1,
          placeholder: 'leave alone',
        })
      }
      input.oninput = e => {
        const raw = e.target.value
        if (raw === '') delete draft.settings[prop.key]
        else draft.settings[prop.key] = Number(raw)
        if (prop.key === 'filmSimulation' || prop.key === 'whiteBalance') renderEditor()
      }

      const skip = skipReason(prop, draft.settings)
      const hint = [prop.note, skip ? `Will be skipped: ${skip}.` : ''].filter(Boolean).join(' ')
      box.append(field(prop.label, input, hint, !prop.confirmed))
    }
    host.append(box)
  }
}

function field(label, control, hint, unverified) {
  return el('div', { className: 'field' },
    el('label', {}, label, unverified ? el('span', { className: 'tag' }, 'unverified') : null),
    control,
    hint ? el('span', { className: 'hint' }, hint) : null)
}

function saveEditor() {
  const draft = state.editing
  if (!draft) return
  draft.name = (draft.name || 'Untitled').trim()
  const saved = state.library.upsert(draft)
  log(`Saved "${saved.name}" to the library`)
  closeEditor()
  renderAll()
}

// -- sets ------------------------------------------------------------------

function applySet() {
  const set = state.library.sets.find(s => s.id === $('set-select').value)
  if (!set) return
  state.assignment = {}
  for (const [slot, recipeId] of Object.entries(set.slots ?? {})) {
    if (state.library.get(recipeId)) state.assignment[Number(slot)] = recipeId
  }
  renderSlots()
  log(`Loaded set "${set.name}" into the slot assignments — press "Write all assigned" to send it.`)
}

function saveSet() {
  const name = prompt('Name this set (for example "Street" or "Travel")')
  if (!name) return
  const set = state.library.upsertSet({ name: name.trim(), slots: { ...state.assignment } })
  renderSets()
  $('set-select').value = set.id
  log(`Saved set "${set.name}"`)
}

function deleteSet() {
  const set = state.library.sets.find(s => s.id === $('set-select').value)
  if (!set || !confirm(`Delete the set "${set.name}"? Recipes are not deleted.`)) return
  state.library.removeSet(set.id)
  renderSets()
}

// -- import / export -------------------------------------------------------

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = el('a', { href: url, download: filename })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function importFile(file) {
  try {
    const added = state.library.importJSON(await file.text())
    log(`Imported ${added} recipe(s) from ${file.name}`)
    renderAll()
  } catch (err) {
    fail(err)
  }
}

// -- boot ------------------------------------------------------------------

function checkEnvironment() {
  const notice = $('insecure')
  if (!WebUsbTransport.isSupported()) {
    notice.hidden = false
    notice.textContent = window.isSecureContext
      ? 'This browser has no WebUSB. Use Chrome, Edge or Brave (desktop or Android) to talk to the camera — Demo mode works anywhere.'
      : 'WebUSB needs a secure context. Open this page over https, or serve it locally with "python3 -m http.server" and visit http://localhost:8000.'
    $('connect').disabled = true
  }
}

function wire() {
  $('connect').onclick = connect
  $('demo').onclick = demo
  $('disconnect').onclick = disconnect
  $('read-slots').onclick = readSlots
  $('backup-slots').onclick = backupToFile
  $('write-all').onclick = writeAll
  $('new-recipe').onclick = () => openEditor(blankRecipe())
  $('save-recipe').onclick = saveEditor
  $('cancel-edit').onclick = closeEditor
  $('search').oninput = renderLibrary
  $('export').onclick = () => download('fujifilm-recipes.json', state.library.exportJSON())
  $('import').onclick = () => $('import-file').click()
  $('import-file').onchange = e => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = '' }
  $('apply-set').onclick = applySet
  $('save-set').onclick = saveSet
  $('delete-set').onclick = deleteSet
  $('copy-log').onclick = () => navigator.clipboard?.writeText($('log').textContent)
  $('clear-log').onclick = () => $('log').replaceChildren()
  window.addEventListener('beforeunload', () => { state.camera?.closeSession() })
}

checkEnvironment()
wire()
renderAll()
log('Ready. Connect the camera in USB RAW CONV./BACKUP RESTORE mode, or press Demo mode to look around.')
