import { z } from 'zod'

export interface CommandResult {
  code: number
  output: string
}
export type TunnelCommand = (args: string[]) => Promise<CommandResult>

const tunnelSchema = z.object({
  tunnel: z.object({
    tunnelId: z.string().min(1),
    ports: z
      .array(
        z.object({ portNumber: z.number(), portUri: z.string().optional() }),
      )
      .default([]),
    accessControl: z
      .array(z.object({ type: z.string(), scopes: z.array(z.string()) }))
      .default([]),
  }),
})

export function validateTunnelUrl(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:'
    || !url.hostname.endsWith('.devtunnels.ms')
    || url.username
    || url.password
    || url.search
    || url.hash
  )
    throw new Error('Microsoft returned an invalid Dev Tunnels URL.')
  return url.origin
}

export class DevTunnels {
  constructor(
    private readonly id: string,
    private readonly command: TunnelCommand,
  ) {
    if (!/^modelbridge-[a-f0-9]{32}$/u.test(id))
      throw new Error(
        'ModelBridge requires an installation-owned tunnel identity.',
      )
  }

  private async run(args: string[]): Promise<string> {
    const result = await this.command(args)
    if (result.code !== 0)
      throw new Error(`Dev Tunnels ${args[0]} failed: ${result.output.trim()}`)
    return result.output
  }

  private parse(output: string) {
    const start = output.indexOf('{')
    if (start === -1)
      throw new Error('Dev Tunnels did not return tunnel metadata.')
    return tunnelSchema.parse(JSON.parse(output.slice(start))).tunnel
  }

  async provision(port: number): Promise<{ id: string; url: string }> {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('A valid sharing port is required.')
    let shown = await this.command(['show', this.id, '-j'])
    if (shown.code !== 0) {
      if (!/Tunnel not found/iu.test(shown.output))
        throw new Error(
          'Cannot inspect the owned tunnel. Sign in or check network access; no new tunnel was created.',
        )
      await this.run(['create', this.id, '--allow-anonymous'])
      shown = { code: 0, output: await this.run(['show', this.id, '-j']) }
    }
    let info = this.parse(shown.output)
    if (info.tunnelId !== this.id && !info.tunnelId.startsWith(`${this.id}.`))
      throw new Error(
        'Microsoft returned a different tunnel identity. No resource was modified.',
      )
    if (
      !info.accessControl.some(
        (entry) =>
          entry.type === 'Anonymous' && entry.scopes.includes('connect'),
      )
    )
      await this.run(['access', 'create', info.tunnelId, '--anonymous'])
    if (!info.ports.some((entry) => entry.portNumber === port))
      await this.run([
        'port',
        'create',
        info.tunnelId,
        '-p',
        String(port),
        '--protocol',
        'http',
      ])
    info = this.parse(await this.run(['show', this.id, '-j']))
    if (info.tunnelId !== this.id && !info.tunnelId.startsWith(`${this.id}.`))
      throw new Error(
        'Microsoft returned a different tunnel identity after provisioning.',
      )
    if (
      !info.accessControl.some(
        (entry) =>
          entry.type === 'Anonymous' && entry.scopes.includes('connect'),
      )
    )
      throw new Error(
        'Microsoft did not confirm anonymous transport access for this tunnel.',
      )
    const uri = info.ports.find((entry) => entry.portNumber === port)?.portUri
    if (!uri)
      throw new Error('Microsoft did not return a URL for the sharing port.')
    return { id: info.tunnelId, url: validateTunnelUrl(uri) }
  }
}
