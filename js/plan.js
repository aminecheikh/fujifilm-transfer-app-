/** Turning a saved recipe into an ordered list of property writes. */

import {
  PROPS_BY_KEY, WRITE_ORDER, skipReason, encodeValue, formatValue,
} from './props.js'
import { fromHex, toHex } from './binary.js'

export const codeKey = code => `0x${code.toString(16).padStart(4, '0')}`

/**
 * Build the write plan for one recipe.
 *
 * A property is written when the recipe defines a value for it (re-encoded), or
 * when the recipe carries raw bytes captured from a camera (replayed verbatim —
 * this is what keeps round-tripping exact for properties whose encoding is not
 * fully understood). Everything the camera would refuse is skipped with a reason
 * rather than sent and left to fail.
 */
export function buildWritePlan(recipe, { includeAdvanced = false } = {}) {
  const settings = recipe.settings ?? {}
  const raw = recipe.raw ?? {}
  const steps = []
  const skipped = []   // the camera would refuse these
  const omitted = []   // advanced properties the user has not opted into

  for (const key of WRITE_ORDER) {
    const prop = PROPS_BY_KEY.get(key)
    if (!prop) continue

    const hasValue = prop.kind !== 'raw' && settings[key] !== undefined && settings[key] !== null
    const rawHex = raw[codeKey(prop.code)]
    const hasRaw = typeof rawHex === 'string' && rawHex.length > 0
    if (!hasValue && !hasRaw) continue
    if (!prop.writeByDefault && !includeAdvanced) {
      omitted.push({ key, label: prop.label })
      continue
    }

    const reason = skipReason(prop, settings)
    if (reason) {
      skipped.push({ key, label: prop.label, reason })
      continue
    }

    let bytes
    let source
    if (hasValue) {
      bytes = encodeValue(prop, settings[key])
      source = 'value'
    } else {
      bytes = fromHex(rawHex)
      source = 'raw'
    }

    steps.push({
      key,
      code: prop.code,
      label: prop.label,
      bytes,
      hex: toHex(bytes),
      source,
      display: hasValue ? formatValue(prop, settings[key]) : `raw ${rawHex}`,
    })
  }

  return { name: recipe.name ?? '', steps, skipped, omitted }
}

/** Human-readable summary of a recipe's look, for list rows. */
export function summarize(recipe) {
  const s = recipe.settings ?? {}
  const bits = []
  const film = PROPS_BY_KEY.get('filmSimulation')
  if (s.filmSimulation !== undefined) bits.push(formatValue(film, s.filmSimulation))
  for (const key of ['dynamicRange', 'grain', 'whiteBalance']) {
    const prop = PROPS_BY_KEY.get(key)
    if (s[key] !== undefined) bits.push(formatValue(prop, s[key]))
  }
  return bits.join(' · ')
}
