import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CheckpointInfo } from '../shared/ipc.js'

const exec = promisify(execFile)

/**
 * Git-backed safety net for the malleability loop. Before Claude edits the
 * browser's own source we take a checkpoint commit; "revert last adaptation"
 * is simply `git reset --hard` back to that commit. All operations are scoped
 * to `projectRoot` (the app's own repo, which is also Claude's ACP cwd).
 */
export class Checkpoints {
  constructor(private readonly projectRoot: string) {}

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return exec('git', args, { cwd: this.projectRoot, maxBuffer: 16 * 1024 * 1024 })
  }

  /** Working-tree status (porcelain); used to detect whether a turn changed anything. */
  async status(): Promise<string> {
    if (!(await this.isRepo())) return ''
    try {
      const { stdout } = await this.git(['status', '--porcelain'])
      return stdout
    } catch {
      return ''
    }
  }

  async isRepo(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--is-inside-work-tree'])
      return true
    } catch {
      return false
    }
  }

  /** Make the workspace a git repo (with an initial commit) so revert has a base. */
  async ensureRepo(): Promise<void> {
    if (await this.isRepo()) return
    try {
      await this.git(['init'])
      await this.git(['add', '-A'])
      await this.git([
        '-c',
        'user.name=malleable-browser',
        '-c',
        'user.email=malleable@localhost',
        'commit',
        '--no-verify',
        '--allow-empty',
        '-m',
        'init workspace'
      ])
    } catch {
      /* git unavailable — checkpoints simply no-op */
    }
  }

  /**
   * Commit the current working tree as a checkpoint so the upcoming adaptation
   * can be reverted. Returns the short sha, or null if there was nothing to
   * commit / not a repo.
   */
  /**
   * Commit the changes a turn produced, as a checkpoint. Called AFTER the agent
   * runs, so a turn that changed nothing (e.g. a question) produces no commit.
   * Returns the short sha, or null if there was nothing to commit / not a repo.
   */
  async commitArtifacts(label: string): Promise<string | null> {
    if (!(await this.isRepo())) return null
    try {
      await this.git(['add', '-A'])
      const { stdout: status } = await this.git(['status', '--porcelain'])
      if (status.trim().length === 0) return null // nothing changed this turn
      await this.git([
        '-c',
        'user.name=malleable-browser',
        '-c',
        'user.email=malleable@localhost',
        'commit',
        '--no-verify',
        '-m',
        `adapt: ${label}`
      ])
      const { stdout } = await this.git(['rev-parse', '--short', 'HEAD'])
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  /** Hard-reset the working tree back to a checkpoint sha. */
  async revertTo(sha: string): Promise<void> {
    await this.git(['reset', '--hard', sha])
  }

  /** Revert to the parent of HEAD (undo the most recent committed adaptation). */
  async revertLast(): Promise<CheckpointInfo | null> {
    if (!(await this.isRepo())) return null
    try {
      const { stdout: parent } = await this.git(['rev-parse', '--short', 'HEAD~1'])
      const sha = parent.trim()
      const { stdout: subject } = await this.git(['log', '-1', '--format=%s', 'HEAD~1'])
      await this.revertTo(sha)
      return { sha, subject: subject.trim() }
    } catch {
      return null
    }
  }

  async list(limit = 20): Promise<CheckpointInfo[]> {
    if (!(await this.isRepo())) return []
    try {
      const { stdout } = await this.git([
        'log',
        `-${limit}`,
        '--format=%h%s'
      ])
      return stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [sha, ...rest] = l.split('')
          return { sha, subject: rest.join('') }
        })
    } catch {
      return []
    }
  }
}
