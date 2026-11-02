import { describe, expect, test } from 'bun:test'

import { translateResponsesToMessages } from '../src/providers/copilot-compatibility/messages-translation'
import { toMessagesInputSchema } from '../src/providers/copilot-compatibility/tool-schema'
import { translateToOpenAI } from '../src/providers/copilot-compatibility/chat-translation'

const combinators = ['anyOf', 'oneOf', 'allOf']

describe('Messages tool input schemas', () => {
  test('flattens top-level anyOf alternatives into one object schema', () => {
    const schema = toMessagesInputSchema({
      description: 'Edit a file.',
      anyOf: [
        {
          title: 'Replace',
          type: 'object',
          properties: { path: { type: 'string' }, text: { type: 'string' } },
          required: ['path', 'text'],
        },
        {
          title: 'Delete',
          type: 'object',
          properties: { path: { type: 'string' }, remove: { type: 'boolean' } },
          required: ['path', 'remove'],
        },
      ],
    })
    for (const key of combinators) expect(schema).not.toHaveProperty(key)
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties as object).sort()).toEqual([
      'path',
      'remove',
      'text',
    ])
    expect(schema.required).toEqual(['path'])
    expect(schema.description).toBe(
      'Edit a file. Provide arguments for exactly one of these shapes (required fields): Replace: path, text | Delete: path, remove.',
    )
  })

  test('applies every allOf branch and keeps conflicting properties as nested alternatives', () => {
    const schema = toMessagesInputSchema({
      allOf: [
        {
          properties: { mode: { type: 'string' } },
          required: ['mode'],
          $defs: { Shared: { type: 'string' } },
        },
        {
          properties: { mode: { type: 'integer' }, id: { type: 'string' } },
          required: ['id'],
        },
      ],
      oneOf: [{ type: 'string' }, { properties: {}, description: 'Empty' }],
    })
    for (const key of combinators) expect(schema).not.toHaveProperty(key)
    expect(schema.required).toEqual(['mode', 'id'])
    expect(schema.properties).toEqual({
      mode: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      id: { type: 'string' },
    })
    expect(schema.$defs).toEqual({ Shared: { type: 'string' } })
    expect(schema.description).toContain('Empty: no required fields')
  })

  test('resolves a top-level local $ref and keeps definitions for nested references', () => {
    const schema = toMessagesInputSchema({
      $ref: '#/definitions/Args',
      definitions: {
        Args: {
          type: 'object',
          properties: { item: { $ref: '#/definitions/Item' } },
          required: ['item'],
        },
        Item: { type: 'string' },
      },
    })
    expect(schema).not.toHaveProperty('$ref')
    expect(schema.properties).toEqual({
      item: { $ref: '#/definitions/Item' },
    })
    expect(schema.required).toEqual(['item'])
    expect(schema.definitions).toHaveProperty('Item')
  })

  test('returns valid object schemas for missing, non-object and unresolvable input', () => {
    expect(toMessagesInputSchema(null)).toEqual({
      type: 'object',
      properties: {},
    })
    expect(toMessagesInputSchema({ type: ['object', 'null'] })).toEqual({
      type: 'object',
      properties: {},
    })
    expect(toMessagesInputSchema({ $ref: 'https://example.test/x' })).toEqual({
      type: 'object',
      properties: {},
    })
    const nested = { anyOf: [{ anyOf: [{ anyOf: [] }] }] }
    let deep: Record<string, unknown> = nested
    for (let index = 0; index < 12; index++) deep = { anyOf: [deep] }
    expect(toMessagesInputSchema(deep).type).toBe('object')
    const valid = {
      type: 'object',
      properties: { a: { anyOf: [{ type: 'string' }] } },
    }
    expect(toMessagesInputSchema(valid)).toBe(valid)
  })

  test('Codex function tools with top-level combinators reach Claude and chat models as object schemas', () => {
    const translation = translateResponsesToMessages(
      {
        model: 'claude-opus-5.5',
        input: 'Use the tool.',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            parameters: {
              oneOf: [
                {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
                },
                {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name'],
                },
              ],
            },
          },
        ],
      },
      { model: 'claude-opus-5.5' },
    )
    const tool = translation.messagesPayload.tools?.find(
      (item) => item.name === 'lookup',
    )
    expect(tool?.input_schema.type).toBe('object')
    for (const key of combinators)
      expect(tool?.input_schema).not.toHaveProperty(key)
    const chat = translateToOpenAI(translation.messagesPayload, {})
    const parameters = (
      chat.tools as Array<{ function: { parameters: Record<string, unknown> } }>
    )[0].function.parameters
    for (const key of combinators) expect(parameters).not.toHaveProperty(key)
  })
})
