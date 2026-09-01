/** Recipe library and slot sets, persisted as one JSON blob. */

const KEY = 'fujifilm-recipe-transfer/v1'
export const LIBRARY_FORMAT = 'fujifilm-recipe-library'
export const RECIPE_FORMAT = 'fujifilm-recipe'
export const FORMAT_VERSION = 1

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** localStorage can throw (private mode, blocked site data) — fall back to memory. */
export function safeStorage() {
  try {
    const probe = '__probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return localStorage
  } catch {
    const map = new Map()
    return {
      getItem: k => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
      removeItem: k => map.delete(k),
    }
  }
}

export class Library {
  constructor(storage = safeStorage()) {
    this.storage = storage
    this.recipes = []
    this.sets = []
    this.load()
  }

  load() {
    let parsed = null
    try { parsed = JSON.parse(this.storage.getItem(KEY) ?? 'null') } catch { parsed = null }
    this.recipes = Array.isArray(parsed?.recipes) ? parsed.recipes : []
    this.sets = Array.isArray(parsed?.sets) ? parsed.sets : []
  }

  save() {
    this.storage.setItem(KEY, JSON.stringify({
      format: LIBRARY_FORMAT, version: FORMAT_VERSION,
      recipes: this.recipes, sets: this.sets,
    }))
  }

  get(id) { return this.recipes.find(r => r.id === id) ?? null }

  upsert(recipe) {
    const now = new Date().toISOString()
    if (recipe.id) {
      const at = this.recipes.findIndex(r => r.id === recipe.id)
      const merged = { ...recipe, updatedAt: now }
      if (at >= 0) this.recipes[at] = merged
      else this.recipes.push(merged)
      this.save()
      return merged
    }
    const created = { ...recipe, id: newId(), createdAt: now, updatedAt: now }
    this.recipes.push(created)
    this.save()
    return created
  }

  remove(id) {
    this.recipes = this.recipes.filter(r => r.id !== id)
    for (const set of this.sets) {
      for (const [slot, recipeId] of Object.entries(set.slots ?? {})) {
        if (recipeId === id) delete set.slots[slot]
      }
    }
    this.save()
  }

  duplicate(id) {
    const source = this.get(id)
    if (!source) return null
    const { id: _drop, createdAt: _c, updatedAt: _u, ...rest } = source
    return this.upsert({ ...rest, name: `${source.name} copy` })
  }

  upsertSet(set) {
    if (set.id) {
      const at = this.sets.findIndex(s => s.id === set.id)
      if (at >= 0) this.sets[at] = set
      else this.sets.push(set)
    } else {
      set = { ...set, id: newId() }
      this.sets.push(set)
    }
    this.save()
    return set
  }

  removeSet(id) {
    this.sets = this.sets.filter(s => s.id !== id)
    this.save()
  }

  exportJSON() {
    return JSON.stringify({
      format: LIBRARY_FORMAT, version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      recipes: this.recipes, sets: this.sets,
    }, null, 2)
  }

  /**
   * Import a library export, a single recipe, or a bare array of recipes.
   * Always additive — nothing already in the library is replaced or dropped.
   */
  importJSON(text) {
    const parsed = JSON.parse(text)
    const incoming = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.recipes) ? parsed.recipes
      : parsed.settings || parsed.raw ? [parsed]
      : null
    if (!incoming) throw new Error('Unrecognised file: expected a recipe or a library export')

    let added = 0
    for (const candidate of incoming) {
      if (!candidate || typeof candidate !== 'object') continue
      if (!candidate.settings && !candidate.raw) continue
      const { id: _drop, ...rest } = candidate
      this.upsert({
        name: String(rest.name ?? 'Imported recipe').slice(0, 64),
        notes: String(rest.notes ?? ''),
        model: String(rest.model ?? ''),
        settings: rest.settings ?? {},
        raw: rest.raw ?? {},
        source: rest.source ?? 'import',
      })
      added++
    }
    if (Array.isArray(parsed.sets)) {
      for (const set of parsed.sets) {
        if (set && typeof set === 'object' && set.slots) this.upsertSet({ name: set.name ?? 'Imported set', slots: set.slots })
      }
    }
    if (added === 0) throw new Error('No recipes found in that file')
    return added
  }

  /** One recipe on its own, for sharing a single look. */
  exportRecipe(id) {
    const recipe = this.get(id)
    if (!recipe) throw new Error('No such recipe')
    const { id: _drop, ...rest } = recipe
    return JSON.stringify({ format: RECIPE_FORMAT, version: FORMAT_VERSION, ...rest }, null, 2)
  }
}
