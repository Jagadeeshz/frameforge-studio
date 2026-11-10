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

      if (system.includes('motion designer')) {
        console.log('[mock-openai] wrote a motion storyboard')
        const scene = (heading, sub, hue) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#08080c;
    font-family:"Segoe UI",Helvetica,Arial,sans-serif;color:#f5f5f7}
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:9%}
  .bg{position:absolute;inset:-20%;background:
    radial-gradient(45% 45% at 25% 20%, hsla(${hue},90%,60%,.55), transparent 70%),
    radial-gradient(50% 50% at 80% 85%, hsla(${hue + 60},90%,55%,.35), transparent 72%);
    filter:blur(24px);opacity:0;animation:fade 2s ease-out both}
  h1{position:relative;margin:0;font-size:132px;line-height:.95;letter-spacing:-.04em;
    opacity:0;transform:translateY(40px);animation:rise 1.2s cubic-bezier(.22,1,.36,1) .15s both}
  p{position:relative;margin:26px 0 0;font-size:30px;color:rgba(245,245,247,.62);
    opacity:0;animation:rise 1.1s cubic-bezier(.22,1,.36,1) .45s both}
  .bar{position:relative;margin-top:44px;height:6px;width:0;border-radius:99px;
    background:linear-gradient(90deg, hsl(${hue},90%,62%), rgba(255,255,255,.9));
    animation:grow 1.6s cubic-bezier(.22,1,.36,1) .5s both}
  .grid{position:absolute;inset:0;opacity:0;animation:fade 1.4s ease-out both;
    background-image:linear-gradient(to right,rgba(255,255,255,.05) 1px,transparent 1px),
      linear-gradient(to bottom,rgba(255,255,255,.05) 1px,transparent 1px);
    background-size:96px 96px}
  @keyframes rise{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:none}}
  @keyframes fade{from{opacity:0}to{opacity:.9}}
  @keyframes grow{from{width:0}to{width:420px}}
</style></head>
<body><div class="bg"></div><div class="grid"></div>
<div class="wrap"><h1>${heading}</h1><p>${sub}</p><div class="bar"></div></div></body></html>`

        send(200, {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  scenes: [
                    { title: 'Open', durationSeconds: 4, html: scene('Built for the<br>next launch', 'Quantocos · Q4 2026', 262) },
                    { title: 'Momentum', durationSeconds: 4, html: scene('Ship.<br>Measure.<br>Repeat.', 'One loop, three moves', 200) },
                    { title: 'Close', durationSeconds: 4, html: scene('Start now', 'quantocos.com', 160) }
                  ]
                })
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
