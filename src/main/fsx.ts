import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

let counter = 0

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Atomic JSON write that survives Windows file locking.
 *
 * On Windows, `rename` over a file that another handle is reading (a poller, an
 * indexer, antivirus) fails with EPERM/EBUSY rather than retrying itself. We
 * retry with backoff, then fall back to replace-in-place, so a status poll can
 * never turn a rendering job into a failure.
 */
export async function writeFileAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  counter = (counter + 1) % 100000
  const tmp = `${file}.${process.pid}.${counter}.tmp`
  await fs.writeFile(tmp, data, { encoding: 'utf8', mode })

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        await fs.rm(tmp, { force: true })
        throw error
      }
      await sleep(15 * (attempt + 1))
    }
  }

  // Last resort: clear the destination first, then move into place.
  await fs.rm(file, { force: true })
  await fs.rename(tmp, file)
}

export async function writeJsonAtomic(file: string, value: unknown, mode = 0o600): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2), mode)
}
