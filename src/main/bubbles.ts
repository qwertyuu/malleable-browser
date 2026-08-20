import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Bubble, BubbleEditRef } from '../shared/ipc.js'

/**
 * Bubbles: named groups of sites whose edits may exchange data with each other,
 * and with nothing outside.
 *
 *   bubbles/<id>.json   { id, name, hosts: [...], edits: [{host, editId}], ... }
 *
 * Two invariants carry the whole authorization story:
 *
 *   - A HOST may belong to many bubbles.
 *   - An EDIT belongs to exactly ONE bubble (or none).
 *
 * The second is the load-bearing one: an edit in two bubbles would be a bridge
 * between them, which is precisely what the model exists to prevent. So default-
 * deny is structural rather than a policy check — an edit with no bubble has no
 * cross-tab reach at all, and the runtime check is a single comparison.
 *
 * The bubble file is the single source of truth for membership; nothing is stored
 * on the edit itself, so old edits load unchanged and deleting a bubble revokes
 * everything it granted at once.
 */
export class Bubbles {
  private readonly root: string

  constructor(projectRoot: string) {
    this.root = join(projectRoot, 'bubbles')
  }

  idFor(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return slug || 'bubble'
  }

  private fileFor(id: string): string {
    return join(this.root, `${id}.json`)
  }

  async list(): Promise<Bubble[]> {
    let names: string[]
    try {
      names = (await fs.readdir(this.root)).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    const out: Bubble[] = []
    for (const n of names) {
      const b = await this.get(n.replace(/\.json$/, ''))
      if (b) out.push(b)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async get(id: string): Promise<Bubble | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.fileFor(id), 'utf8'))
      return {
        id,
        name: String(raw.name ?? id),
        hosts: Array.isArray(raw.hosts) ? raw.hosts.map(String) : [],
        edits: Array.isArray(raw.edits)
          ? raw.edits
              .filter((e: unknown) => e && typeof e === 'object')
              .map((e: { host?: unknown; editId?: unknown }) => ({
                host: String(e.host ?? ''),
                editId: String(e.editId ?? '')
              }))
              .filter((e: BubbleEditRef) => e.host && e.editId)
          : [],
        createdAt: Number(raw.createdAt ?? 0),
        updatedAt: Number(raw.updatedAt ?? 0)
      }
    } catch {
      return null
    }
  }

  /**
   * Create or update a bubble. Adding a host or creating a bubble is the ONE
   * point where the user is asked to consent, so callers must gate on that
   * before calling this — see `hostsAddedBy`.
   */
  async save(input: {
    id?: string
    name: string
    hosts: string[]
    edits?: BubbleEditRef[]
  }): Promise<Bubble> {
    const id = input.id ?? this.idFor(input.name)
    const existing = await this.get(id)
    // Hosts are stored as adaptation slugs (bare hostnames), deduped.
    const hosts = [...new Set(input.hosts.map((h) => h.trim()).filter(Boolean))]
    const edits = input.edits ?? existing?.edits ?? []

    for (const e of edits) {
      const owner = await this.bubbleForEdit(e.host, e.editId)
      if (owner && owner.id !== id) {
        throw new Error(
          `Edit "${e.editId}" on ${e.host} already belongs to bubble "${owner.name}". ` +
            'An edit can only be in one bubble — write a second edit instead.'
        )
      }
    }

    const now = Date.now()
    const bubble: Bubble = {
      id,
      name: input.name,
      hosts,
      edits,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await fs.mkdir(this.root, { recursive: true })
    await fs.writeFile(this.fileFor(id), JSON.stringify(bubble, null, 2), 'utf8')
    return bubble
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.fileFor(id), { force: true })
  }

  /** Which hosts in `hosts` are NOT already members — i.e. what needs consent. */
  async hostsAddedBy(id: string | undefined, hosts: string[]): Promise<string[]> {
    const existing = id ? await this.get(id) : null
    const known = new Set(existing?.hosts ?? [])
    return [...new Set(hosts.map((h) => h.trim()).filter(Boolean))].filter((h) => !known.has(h))
  }

  /** The bubble owning one edit, if any. This is the authorization lookup. */
  async bubbleForEdit(host: string, editId: string): Promise<Bubble | null> {
    for (const b of await this.list()) {
      if (b.edits.some((e) => e.host === host && e.editId === editId)) return b
    }
    return null
  }

  /** Every bubble that includes this host (a host may be in many). */
  async bubblesForHost(host: string): Promise<Bubble[]> {
    return (await this.list()).filter((b) => b.hosts.includes(host))
  }

  /** Add an edit to a bubble, enforcing the one-bubble-per-edit invariant. */
  async addEdit(id: string, ref: BubbleEditRef): Promise<Bubble> {
    const b = await this.get(id)
    if (!b) throw new Error(`No such bubble: ${id}`)
    if (b.edits.some((e) => e.host === ref.host && e.editId === ref.editId)) return b
    return this.save({ id, name: b.name, hosts: b.hosts, edits: [...b.edits, ref] })
  }

  async removeEdit(id: string, ref: BubbleEditRef): Promise<Bubble | null> {
    const b = await this.get(id)
    if (!b) return null
    return this.save({
      id,
      name: b.name,
      hosts: b.hosts,
      edits: b.edits.filter((e) => !(e.host === ref.host && e.editId === ref.editId))
    })
  }

  /** Drop every reference to a deleted edit, across all bubbles. */
  async forgetEdit(host: string, editId: string): Promise<void> {
    for (const b of await this.list()) {
      if (b.edits.some((e) => e.host === host && e.editId === editId)) {
        await this.removeEdit(b.id, { host, editId })
      }
    }
  }
}
