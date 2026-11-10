const { Entry } = require('@napi-rs/keyring')
const accounts = ['provider:custom', 'provider:runway', 'provider:luma', 'provider:fal', 'provider:replicate', 'provider:heygen', 'provider:openai']
for (const account of accounts) {
  try {
    const entry = new Entry('FrameForge Studio', account)
    entry.deletePassword()
    console.log('deleted', account)
  } catch (error) {
    console.log('skip', account, String(error.message || error).slice(0, 60))
  }
}
