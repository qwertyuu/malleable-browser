import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionMeta } from '../shared/ipc.js'

/**
 * Tracks coding sessions so the user can switch between them. Persisted to disk
 * so the list survives restarts (the adapter can resume the underlying session).
 */
export class SessionStore {
  private readonly file: string
  private sessions: SessionMeta[] = []
  currentId: string | null = null

  constructor(projectRoot: string) {
    this.file = join(projectRoot, '.malleable', 'sessions.json')
  }

  async load(): Promise<void> {
    try {
      this.sessions = JSON.parse(await fs.readFile(this.file, 'utf8'))
    } catch {
      this.sessions = []
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.sessions, null, 2), 'utf8')
  }

  async add(id: string, title: string, createdAt: number): Promise<void> {
    if (!this.sessions.find((s) => s.id === id)) {
      this.sessions.unshift({ id, title, createdAt })
    }
    this.currentId = id
    await this.save()
  }

  setCurrent(id: string): void {
    this.currentId = id
  }

  /** Name a session after its first request (only if still unnamed). */
  async setTitleIfDefault(id: string, title: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id)
    if (s && (!s.title || s.title === 'New session')) {
      s.title = title.length > 60 ? title.slice(0, 60) + '…' : title
      await this.save()
    }
  }

  async remove(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id)
    if (this.currentId === id) this.currentId = this.sessions[0]?.id ?? null
    await this.save()
  }

  list(): { sessions: SessionMeta[]; currentId: string | null } {
    return { sessions: this.sessions, currentId: this.currentId }
  }
}
