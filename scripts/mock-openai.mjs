// Minimal OpenAI-compatible endpoint for exercising the universal provider.
//   node scripts/mock-openai.mjs <port>
// Requires an Authorization header, so a missing key fails loudly.
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8794)
const base = `http://127.0.0.1:${port}`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', base)
  const auth = req.headers.authorization ?? ''
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (!auth.startsWith('Bearer ')) {
    console.log('[mock-openai] rejected: missing bearer token')
    send(401, { error: { message: 'Missing API key' } })
    return
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    send(200, { data: [{ id: 'smoke-model' }] })
    return
  }

  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        send(400, { error: { message: 'bad json' } })
        return
      }
      const messages = Array.isArray(body.messages) ? body.messages : []
      const system = String(messages.find((m) => m.role === 'system')?.content ?? '')
      const user = String(messages.find((m) => m.role === 'user')?.content ?? '')

      if (system.includes('production brief')) {
        console.log('[mock-openai] wrote a storyboard brief')
        send(200, {
          choices: [
            {
              message: {
                content:
                  '## Objective\nIntroduce the Q4 launch in 12 seconds.\n\n## Audience\nAgency prospects.\n\n## Visual direction\nWarm, tactile, studio-lit.\n\n## Shot list\nAs supplied.\n\n## On-screen copy\nSmoke Render.\n\n## Delivery checklist\nReview the MP4, confirm the deck.'
              }
            }
          ]
        })
        return
      }

      const original = user.split('Original: ')[1] ?? user.slice(0, 60)
      console.log('[mock-openai] enhanced a shot prompt')
      send(200, {
        choices: [
          {
            message: {
              content: `A slow dolly reveals ${original.trim().slice(0, 80)}, industrial concrete set, soft volumetric light, warm neutral grade, 35mm film grain.`
            }
          }
        ]
      })
    })
    return
  }

  send(404, { error: { message: 'not found' } })
})

server.listen(port, '127.0.0.1', () => console.log(`[mock-openai] listening on ${base}/v1`))
