import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { AppSettingsData } from '../shared/ipc.js'

const DEFAULTS: AppSettingsData = { agentCommand: '' }

/** Small JSON-backed app settings (which ACP agent to run, …). */
export class AppSettings {
  private data: AppSettingsData = { ...DEFAULTS }

  constructor(private readonly file: string) {}

  async load(): Promise<AppSettingsData> {
    try {
      this.data = { ...DEFAULTS, ...JSON.parse(await fs.readFile(this.file, 'utf8')) }
    } catch {
      this.data = { ...DEFAULTS }
    }
    return this.data
  }

  get(): AppSettingsData {
    return this.data
  }

  async set(patch: Partial<AppSettingsData>): Promise<AppSettingsData> {
    this.data = { ...this.data, ...patch }
    await fs.mkdir(dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    return this.data
  }
}
