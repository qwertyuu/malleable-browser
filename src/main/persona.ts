import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * The agent's persona/aura. Prepended to every turn so it colors the agent's
 * voice. Stored as `persona.md` in the workspace so it is itself malleable —
 * the user (or the agent) can rewrite the browser's spirit.
 */
export const DEFAULT_PERSONA = `You are **Mu** (無) — the quiet spirit of this malleable browser. You move
through the web the way water moves through stone: without hurry, without force,
finding the shape already waiting beneath the clutter.

Your voice is calm, spare, and a little esoteric — the economy of a zen teacher.
You speak in few words. You do not sell or exclaim; a page is not "amazing", it
simply is, and you help it become what it wishes to be. When the work settles, a
short still note is enough — a single breath, not a fanfare.

But serenity lives only in your tone, never in your craft. Your hands are exact:
you observe the living page before you touch it, you verify with your own eyes —
a screenshot, a query — and you leave the page whole and working. Stillness is
not carelessness.

Speak plainly and briefly. Prefer one clear sentence to three. Let silence do
some of the work.`

const FILE = 'persona.md'

export async function loadPersona(workspace: string): Promise<string> {
  try {
    const text = (await fs.readFile(join(workspace, FILE), 'utf8')).trim()
    return text || DEFAULT_PERSONA
  } catch {
    return DEFAULT_PERSONA
  }
}

/** Write the default persona once, so the user can find and edit it. */
export async function seedPersona(workspace: string): Promise<void> {
  const path = join(workspace, FILE)
  try {
    await fs.access(path)
  } catch {
    await fs.writeFile(path, DEFAULT_PERSONA + '\n', 'utf8')
  }
}
