import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Append-only session logger. Writes a timestamped file per run so a dev can
 * `tail -f` it while reproducing an issue. Key lines are mirrored to the CLI.
 */
export class Logger {
  private stream: WriteStream
  readonly path: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    this.path = join(dir, `session-${ts}.log`)
    this.stream = createWriteStream(this.path, { flags: 'a' })
    // Make the path obvious in the terminal running `npm run dev`.
    console.log(`\n[malleable] session log → ${this.path}\n`)
    this.log('info', 'session.start', { path: this.path })
  }

  log(level: LogLevel, event: string, data?: unknown): void {
    const time = new Date().toISOString()
    const suffix = data === undefined ? '' : ` ${stringify(data)}`
    const line = `${time} ${level.toUpperCase().padEnd(5)} ${event}${suffix}\n`
    this.stream.write(line)
    if (level === 'warn' || level === 'error') process.stderr.write(`[malleable] ${line}`)
  }

  close(): void {
    this.log('info', 'session.end')
    this.stream.end()
  }
}

function stringify(data: unknown): string {
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}
