// Local stand-in for a video provider, used to exercise the whole desktop
// pipeline without spending anyone's credits.
//   node scripts/mock-provider.mjs <port> <clip.mp4>
// Serves Runway-shaped endpoints and the clip bytes.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const port = Number(process.argv[2] ?? 8791)
const clipPath = process.argv[3]
let media = Buffer.alloc(0)

if (clipPath) media = await readFile(clipPath)

const base = `http://127.0.0.1:${port}`
let polls = 0

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', base)
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type })
    res.end(body)
  }

  if (req.method === 'POST' && url.pathname === '/v1/text_to_video') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const id = `task-${Date.now()}`
      console.log(`[mock] submitted ${url.pathname} -> ${id}`)
      send(200, JSON.stringify({ id }))
    })
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/v1/tasks/')) {
    polls += 1
    // Pretend to work for a couple of polls so the UI shows progress.
    if (polls % 3 !== 0) {
      send(200, JSON.stringify({ status: 'RUNNING', progress: 0.4 }))
      return
    }
    send(200, JSON.stringify({ status: 'SUCCEEDED', progress: 1, output: [`${base}/media/clip.mp4`] }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/media/clip.mp4') {
    console.log(`[mock] serving clip ${media.length}b`)
    send(200, media, 'video/mp4')
    return
  }

  if (req.method === 'GET' && url.pathname === '/v1/organization') {
    send(200, JSON.stringify({ id: 'org-mock' }))
    return
  }

  send(404, '{}')
})

server.listen(port, '127.0.0.1', () => console.log(`[mock] listening on ${base}`))
