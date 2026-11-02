// Copilot request normalization adapted from the original Gateway Responses
// handler. Each adjustment is counted so the host can report what it changed.
const unsupportedToolTypes = new Set(['image_generation'])
const unsupportedToolNamespaces = new Set(['image_gen'])
const unsupportedInputFields = ['internal_chat_message_metadata_passthrough']
const imageDetails = new Set(['auto', 'low', 'high'])

export interface RequestNormalization {
  removedTools: string[]
  normalizedImageDetails: number
  omittedImages: number
  removedInputFields: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dataUrlBytes(url: string): number | undefined {
  const match = /^data:[^;,]+;base64,(.*)$/su.exec(url)
  if (!match) return undefined
  const data = match[1].replace(/\s/gu, '')
  const padding =
    data.endsWith('==') ? 2
    : data.endsWith('=') ? 1
    : 0
  return Math.floor((data.length * 3) / 4) - padding
}

function visitImages(
  value: unknown,
  visit: (image: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (Array.isArray(value)) return value.map((item) => visitImages(item, visit))
  if (!isRecord(value)) return value
  if (value.type === 'input_image') return visit(value)
  for (const key of ['content', 'output']) {
    if (Array.isArray(value[key])) value[key] = visitImages(value[key], visit)
  }
  return value
}

export function normalizeCopilotRequest(
  payload: Record<string, unknown>,
  maxImageBytes?: number,
): RequestNormalization {
  const result: RequestNormalization = {
    removedTools: [],
    normalizedImageDetails: 0,
    omittedImages: 0,
    removedInputFields: 0,
  }
  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.filter((tool: unknown) => {
      if (!isRecord(tool) || typeof tool.type !== 'string') return true
      const namespace =
        tool.type === 'namespace' && typeof tool.name === 'string' ?
          tool.name
        : undefined
      if (
        unsupportedToolTypes.has(tool.type)
        || (namespace && unsupportedToolNamespaces.has(namespace))
      ) {
        result.removedTools.push(
          namespace ? `namespace:${namespace}` : tool.type,
        )
        return false
      }
      return true
    })
  }
  if (!Array.isArray(payload.input)) return result
  for (const item of payload.input) {
    if (!isRecord(item)) continue
    for (const field of unsupportedInputFields) {
      if (!Object.hasOwn(item, field)) continue
      delete item[field]
      result.removedInputFields++
    }
  }
  payload.input = visitImages(payload.input, (image) => {
    const url = typeof image.image_url === 'string' ? image.image_url : ''
    const bytes = dataUrlBytes(url)
    if (maxImageBytes && bytes !== undefined && bytes > maxImageBytes) {
      result.omittedImages++
      return {
        type: 'input_text',
        text: `[ModelBridge omitted an image of ${bytes} bytes because this model accepts images up to ${maxImageBytes} bytes.]`,
      }
    }
    if (typeof image.detail === 'string' && !imageDetails.has(image.detail)) {
      result.normalizedImageDetails++
      return { ...image, detail: 'auto' }
    }
    return image
  })
  return result
}
