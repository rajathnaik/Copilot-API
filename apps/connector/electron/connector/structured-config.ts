import { createHash } from 'node:crypto'
import { getStaticJSONValue, parseJSON, type AST } from 'jsonc-eslint-parser'
import { isMap, isNode, parseDocument, type Document } from 'yaml'

export type ConfigKey = readonly string[]
type Edit = { start: number; end: number; text: string }

function propertyName(property: AST.JSONProperty): string {
  return property.key.type === 'JSONIdentifier' ?
      property.key.name
    : String(property.key.value)
}

function validateKeys(node: AST.JSONExpression): void {
  if (node.type === 'JSONObjectExpression') {
    const names = node.properties.map(propertyName)
    if (new Set(names).size !== names.length)
      throw new Error(
        'Configuration contains duplicate keys. Remove the ambiguity before connecting.',
      )
    for (const property of node.properties) validateKeys(property.value)
  } else if (node.type === 'JSONArrayExpression') {
    for (const item of node.elements) if (item) validateKeys(item)
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    )
  return value
}

export class StructuredConfig {
  private text: string
  private readonly yaml?: Document.Parsed

  constructor(
    text: string,
    readonly format: 'json' | 'jsonc' | 'json5' | 'yaml',
  ) {
    this.text =
      text.trim() ? text
      : format === 'yaml' ? ''
      : '{}\n'
    if (format === 'yaml') {
      this.yaml = parseDocument(this.text, { uniqueKeys: true })
      if (this.yaml.errors.length)
        throw new Error(
          `Invalid YAML configuration: ${this.yaml.errors[0].message}`,
        )
      if (this.yaml.contents !== null && !isMap(this.yaml.contents))
        throw new Error('The harness configuration must be an object.')
    } else {
      this.json()
    }
  }

  private json() {
    const program = parseJSON(this.text, {
      jsonSyntax:
        this.format === 'json5' ? 'JSON5'
        : this.format === 'jsonc' ? 'JSONC'
        : 'JSON',
    })
    const root = program.body[0].expression
    if (root.type !== 'JSONObjectExpression')
      throw new Error('The harness configuration must be an object.')
    validateKeys(root)
    return { program, root }
  }

  private node(key: ConfigKey): AST.JSONExpression | undefined {
    let node: AST.JSONExpression = this.json().root
    for (const part of key) {
      if (node.type !== 'JSONObjectExpression') return undefined
      const property: AST.JSONProperty | undefined = node.properties.find(
        (item) => propertyName(item) === part,
      )
      if (!property) return undefined
      node = property.value
    }
    return node
  }

  has(key: ConfigKey): boolean {
    return this.yaml ? this.yaml.hasIn(key) : this.node(key) !== undefined
  }

  get(key: ConfigKey): unknown {
    if (this.yaml) {
      const node = this.yaml.getIn(key, true)
      return isNode(node) ? node.toJSON() : node
    }
    const node = this.node(key)
    return node ? getStaticJSONValue(node) : undefined
  }

  private edit(edits: Edit[]): void {
    for (const edit of edits.sort((left, right) => right.start - left.start))
      this.text =
        this.text.slice(0, edit.start) + edit.text + this.text.slice(edit.end)
    this.json()
  }

  private setJson(key: ConfigKey, raw: string): void {
    const existing = this.node(key)
    if (existing) {
      this.edit([
        { start: existing.range[0], end: existing.range[1], text: raw },
      ])
      return
    }
    const { program, root } = this.json()
    let parent = root
    let index = 0
    for (; index < key.length - 1; index += 1) {
      if (parent.properties.some((item) => propertyName(item) === '$include'))
        throw new Error(
          'Included settings cannot be safely managed here. Move the connector settings into this file first.',
        )
      const property = parent.properties.find(
        (item) => propertyName(item) === key[index],
      )
      if (!property) break
      if (property.value.type !== 'JSONObjectExpression')
        throw new Error(
          `Configuration field ${key.slice(0, index + 1).join('.')} must be an object.`,
        )
      parent = property.value
    }
    let value = raw
    for (let nested = key.length - 1; nested > index; nested -= 1)
      value = `{${JSON.stringify(key[nested])}: ${value}}`
    const last = parent.properties[parent.properties.length - 1]
    const trailingComma =
      last
      && program.tokens.some(
        (token) =>
          token.value === ','
          && token.range[0] >= last.range[1]
          && token.range[1] < parent.range[1],
      )
    const lineStart = this.text.lastIndexOf('\n', parent.range[0]) + 1
    const indent =
      this.text.slice(lineStart, parent.range[0]).match(/^[ \t]*/u)?.[0] ?? ''
    const newline = this.text.includes('\r\n') ? '\r\n' : '\n'
    const edits: Edit[] = [
      {
        start: parent.range[1] - 1,
        end: parent.range[1] - 1,
        text: `${newline}${indent}  ${JSON.stringify(key[index])}: ${value}${newline}${indent}`,
      },
    ]
    if (last && !trailingComma)
      edits.push({ start: last.range[1], end: last.range[1], text: ',' })
    this.edit(edits)
  }

  set(key: ConfigKey, value: unknown): void {
    if (value === undefined) {
      this.remove(key)
      return
    }
    if (this.yaml) {
      for (let index = 1; index < key.length; index += 1) {
        const parent = this.yaml.getIn(key.slice(0, index), true)
        if (parent !== undefined && !isMap(parent))
          throw new Error(
            `Configuration field ${key.slice(0, index).join('.')} must be a mapping, not an alias or scalar.`,
          )
      }
      this.yaml.setIn(key, value)
    } else {
      this.setJson(key, JSON.stringify(value))
    }
  }

  remove(key: ConfigKey): void {
    if (this.yaml) {
      this.yaml.deleteIn(key)
      return
    }
    const { program } = this.json()
    const parent = this.node(key.slice(0, -1))
    if (!parent || parent.type !== 'JSONObjectExpression') return
    const property = parent.properties.find(
      (item) => propertyName(item) === key[key.length - 1],
    )
    if (!property) return
    const commaAfter = program.tokens.find(
      (token) =>
        token.value === ','
        && token.range[0] >= property.range[1]
        && token.range[1] < parent.range[1],
    )
    const next = parent.properties.find(
      (item) => item.range[0] > property.range[1],
    )
    const comma =
      commaAfter && (!next || commaAfter.range[0] < next.range[0]) ?
        commaAfter
      : [...program.tokens]
          .reverse()
          .find(
            (token) =>
              token.value === ','
              && token.range[1] <= property.range[0]
              && token.range[0] > parent.range[0],
          )
    this.edit([
      { start: property.range[0], end: property.range[1], text: '' },
      ...(comma ?
        [{ start: comma.range[0], end: comma.range[1], text: '' }]
      : []),
    ])
  }

  restore(key: ConfigKey, original: StructuredConfig): void {
    if (!original.has(key)) this.remove(key)
    else if (this.yaml && original.yaml) {
      const value = original.yaml.getIn(key, true)
      this.yaml.setIn(key, isNode(value) ? value.clone() : value)
    } else {
      const node = original.node(key)
      if (node)
        this.setJson(key, original.text.slice(node.range[0], node.range[1]))
    }
    for (let length = key.length - 1; length > 0; length -= 1) {
      const parent = key.slice(0, length)
      const value = this.get(parent)
      if (
        !original.has(parent)
        && value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.keys(value).length === 0
      )
        this.remove(parent)
    }
  }

  fingerprint(keys: readonly ConfigKey[], projection?: unknown): string {
    const hash = createHash('sha256').update(
      JSON.stringify(
        keys.map((key) => ({
          key,
          present: this.has(key),
          value: stableValue(this.get(key)),
        })),
      ),
    )
    if (projection !== undefined)
      hash.update(JSON.stringify(stableValue(projection)))
    return hash.digest('hex')
  }

  empty(): boolean {
    if (this.yaml)
      return (
        !this.yaml.comment
        && !this.yaml.commentBefore
        && (this.yaml.contents === null
          || (isMap(this.yaml.contents)
            && !this.yaml.contents.items.length
            && !this.yaml.contents.comment
            && !this.yaml.contents.commentBefore))
      )
    const { root, program } = this.json()
    return root.properties.length === 0 && program.comments.length === 0
  }

  toString(): string {
    return this.yaml ? this.yaml.toString() : this.text
  }
}
