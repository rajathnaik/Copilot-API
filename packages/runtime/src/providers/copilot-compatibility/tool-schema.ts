// Anthropic Messages tools require an object `input_schema` without anyOf,
// oneOf or allOf at the top level. Codex and MCP tools may use those
// combinators, so the alternatives are merged into one object schema: allOf
// branches all apply, while anyOf/oneOf branches only require the fields
// every alternative requires. Nested combinators are left untouched.
type Schema = Record<string, unknown>

const combinators = ['allOf', 'anyOf', 'oneOf'] as const

function isRecord(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ?
      value.filter((item): item is string => typeof item === 'string')
    : []
}

function localReference(schema: Schema, reference: unknown) {
  if (typeof reference !== 'string') return undefined
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/u.exec(reference)
  if (!match) return undefined
  const definitions = schema[match[1]]
  if (!isRecord(definitions)) return undefined
  const target =
    definitions[match[2].replaceAll('~1', '/').replaceAll('~0', '~')]
  return isRecord(target) ? target : undefined
}

function mergeProperty(existing: unknown, next: unknown) {
  if (existing === undefined) return next
  if (JSON.stringify(existing) === JSON.stringify(next)) return existing
  const alternatives: unknown[] =
    isRecord(existing) && Array.isArray(existing.anyOf) ?
      existing.anyOf
    : [existing]
  return { anyOf: [...alternatives, next] }
}

function flatten(schema: Schema, root: Schema, depth: number): Schema {
  if (depth > 8) return { type: 'object', properties: {} }
  const referenced =
    '$ref' in schema ? localReference(root, schema.$ref) : undefined
  const { $ref: _reference, ...base } = schema
  const source =
    referenced ? { ...flatten(referenced, root, depth + 1), ...base } : base
  const properties: Schema = {}
  const required = new Set<string>()
  const addProperties = (value: unknown) => {
    if (!isRecord(value)) return
    for (const [name, property] of Object.entries(value))
      properties[name] = mergeProperty(properties[name], property)
  }
  addProperties(source.properties)
  for (const name of strings(source.required)) required.add(name)
  const definitions: Record<'$defs' | 'definitions', Schema> = {
    $defs: {},
    definitions: {},
  }
  const notes: string[] = []
  for (const combinator of combinators) {
    const branches = Array.isArray(source[combinator]) ? source[combinator] : []
    const objects = branches
      .filter(isRecord)
      .map((branch) => flatten(branch, root, depth + 1))
    if (!objects.length) continue
    for (const branch of objects) {
      addProperties(branch.properties)
      for (const key of ['$defs', 'definitions'] as const)
        if (isRecord(branch[key])) Object.assign(definitions[key], branch[key])
    }
    const branchRequired = objects.map((branch) => strings(branch.required))
    const applied =
      combinator === 'allOf' ?
        branchRequired.flat()
      : branchRequired.reduce((common, names) =>
          common.filter((name) => names.includes(name)),
        )
    for (const name of applied) required.add(name)
    if (combinator !== 'allOf' && objects.length > 1) {
      const shapes = objects.map((branch) => {
        const fields = strings(branch.required)
        const label =
          typeof branch.title === 'string' ? branch.title
          : typeof branch.description === 'string' ? branch.description
          : null
        return (
          (label ? `${label}: ` : '')
          + (fields.length ? fields.join(', ') : 'no required fields')
        )
      })
      notes.push(
        `Provide arguments for exactly one of these shapes (required fields): ${shapes.join(' | ')}.`,
      )
    }
  }
  const result: Schema = { ...source }
  for (const combinator of combinators) delete result[combinator]
  for (const key of ['$defs', 'definitions'] as const) {
    const merged = {
      ...definitions[key],
      ...(isRecord(source[key]) ? source[key] : {}),
    }
    if (Object.keys(merged).length) result[key] = merged
  }
  result.type = 'object'
  result.properties = properties
  if (required.size) result.required = [...required]
  else delete result.required
  if (notes.length)
    result.description = [
      typeof source.description === 'string' ? source.description : '',
      ...notes,
    ]
      .filter(Boolean)
      .join(' ')
  return result
}

export function toMessagesInputSchema(schema: unknown): Schema {
  if (!isRecord(schema)) return { type: 'object', properties: {} }
  const needsFlattening =
    combinators.some((key) => key in schema)
    || '$ref' in schema
    || schema.type !== 'object'
    || !isRecord(schema.properties)
  return needsFlattening ? flatten(schema, schema, 0) : schema
}
