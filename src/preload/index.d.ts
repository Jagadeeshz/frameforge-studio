import type { FrameForgeBridge } from '../shared/bridge'

declare global {
  interface Window {
    frameforge: FrameForgeBridge
  }
}

export {}
