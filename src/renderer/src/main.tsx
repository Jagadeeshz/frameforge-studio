import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@hyperframes/studio/styles.css'
import './styles.css'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('Root container missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
