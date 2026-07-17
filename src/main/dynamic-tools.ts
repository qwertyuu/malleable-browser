import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z, type ZodRawShape } from 'zod'

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean'
  description?: string
  required?: boolean
}

export type ToolScope = 'global' | 'site'

export interface DynamicToolDef {
  name: string
  description: string
  /** param name -> spec */
  inputSchema: Record<string, ParamSpec>
  /** JS body run in the page with `args` in scope; use `return` to produce output. */
  code: string
  createdAt: number
  /** 'site' tools only load on their host; 'global' tools load everywhere. */
  scope: ToolScope
  /** host for site-scoped tools (slugified hostname). */
  host?: string
}

const NAME_RE = /^[a-z][a-z0-9_]{1,48}$/
/** Names reserved by the static toolset. */
const RESERVED = new Set([
  'dom_query',
  'run_js',
  'get_console',
  'get_network',
  'screenshot',
  'fetch_image',
  'define_tool',
  'remove_tool',
  'list_tools',
  'save_adaptation',
  'list_adaptations',
  'get_adaptation',
  'set_adaptation_enabled',
  'delete_adaptation'
])

/**
 * Registry of agent-authored tools persisted on disk, in two tiers:
 *   tools/global/<name>.json        — available on every site
 *   tools/sites/<host>/<name>.json  — only loaded while on that host
 * This is the substrate for emergent behavior: the agent grows a durable harness,
 * per-site by default so its toolset stays relevant to the page.
 */
export class DynamicTools {
  private readonly root: string

  constructor(projectRoot: string) {
    this.root = join(projectRoot, 'tools')
  }

  private globalDir(): string {
    return join(this.root, 'global')
  }
  private siteDir(host: string): string {
    return join(this.root, 'sites', host)
  }
  private dirFor(def: Pick<DynamicToolDef, 'scope' | 'host'>): string {
    return def.scope === 'site' && def.host ? this.siteDir(def.host) : this.globalDir()
  }

  validateName(name: string): void {
    if (!NAME_RE.test(name)) {
      throw new Error(`Invalid tool name "${name}" (use lowercase letters, digits, underscore)`)
    }
    if (RESERVED.has(name)) throw new Error(`"${name}" is a reserved tool name`)
  }

  static toZodShape(spec: Record<string, ParamSpec>): ZodRawShape {
    const shape: ZodRawShape = {}
    for (const [key, p] of Object.entries(spec ?? {})) {
      let field =
        p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : z.string()
      if (p.description) field = field.describe(p.description) as any
      shape[key] = p.required ? field : field.optional()
    }
    return shape
  }

  private async readDir(dir: string): Promise<DynamicToolDef[]> {
    let names: string[]
    try {
      names = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const out: DynamicToolDef[] = []
    for (const f of names) {
      try {
        out.push(JSON.parse(await fs.readFile(join(dir, f), 'utf8')))
      } catch {
        /* skip malformed */
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  listGlobal(): Promise<DynamicToolDef[]> {
    return this.readDir(this.globalDir())
  }
  listSite(host: string): Promise<DynamicToolDef[]> {
    return this.readDir(this.siteDir(host))
  }

  /** All site tools, grouped by host (for the library view). */
  async listAllSites(): Promise<Record<string, DynamicToolDef[]>> {
    let hosts: string[]
    try {
      hosts = (await fs.readdir(join(this.root, 'sites'), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return {}
    }
    const out: Record<string, DynamicToolDef[]> = {}
    for (const host of hosts.sort()) {
      const tools = await this.listSite(host)
      if (tools.length) out[host] = tools
    }
    return out
  }

  async save(def: DynamicToolDef): Promise<void> {
    this.validateName(def.name)
    const dir = this.dirFor(def)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, `${def.name}.json`), JSON.stringify(def, null, 2), 'utf8')
  }

  async remove(name: string, scope: ToolScope, host?: string): Promise<void> {
    await fs.rm(join(this.dirFor({ scope, host }), `${name}.json`), { force: true })
  }

  /**
   * One-time migration of the old flat `tools/*.json` layout into `tools/global/`.
   * Existing tools carry no host, so global is the safe default; site-specific
   * ones can be re-scoped afterward.
   */
  async migrate(): Promise<void> {
    let entries: { name: string; isFile: boolean }[]
    try {
      entries = (await fs.readdir(this.root, { withFileTypes: true })).map((e) => ({
        name: e.name,
        isFile: e.isFile()
      }))
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isFile || !e.name.endsWith('.json')) continue
      const src = join(this.root, e.name)
      try {
        const def = JSON.parse(await fs.readFile(src, 'utf8')) as DynamicToolDef
        def.scope = 'global'
        delete def.host
        await fs.mkdir(this.globalDir(), { recursive: true })
        await fs.writeFile(join(this.globalDir(), e.name), JSON.stringify(def, null, 2), 'utf8')
        await fs.rm(src, { force: true })
      } catch {
        /* skip */
      }
    }
  }
}
