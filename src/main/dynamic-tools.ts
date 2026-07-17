import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z, type ZodRawShape } from 'zod'

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean'
  description?: string
  required?: boolean
}

export interface DynamicToolDef {
  name: string
  description: string
  /** param name -> spec */
  inputSchema: Record<string, ParamSpec>
  /** JS body run in the page with `args` in scope; use `return` to produce output. */
  code: string
  createdAt: number
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
  'list_tools'
])

/**
 * Registry of agent-authored tools persisted on disk. This is the substrate for
 * emergent behavior: the agent writes new tools that expand its own action space,
 * and they survive restarts (a growing harness over the web).
 */
export class DynamicTools {
  private readonly dir: string

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, 'tools')
  }

  validateName(name: string): void {
    if (!NAME_RE.test(name)) {
      throw new Error(`Invalid tool name "${name}" (use lowercase letters, digits, underscore)`)
    }
    if (RESERVED.has(name)) throw new Error(`"${name}" is a reserved tool name`)
  }

  /** Convert a simple param spec map into a zod raw shape for MCP registerTool. */
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

  async list(): Promise<DynamicToolDef[]> {
    let names: string[]
    try {
      names = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const out: DynamicToolDef[] = []
    for (const f of names) {
      try {
        out.push(JSON.parse(await fs.readFile(join(this.dir, f), 'utf8')))
      } catch {
        /* skip malformed */
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async save(def: DynamicToolDef): Promise<void> {
    this.validateName(def.name)
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(join(this.dir, `${def.name}.json`), JSON.stringify(def, null, 2), 'utf8')
  }

  async remove(name: string): Promise<void> {
    await fs.rm(join(this.dir, `${name}.json`), { force: true })
  }
}
