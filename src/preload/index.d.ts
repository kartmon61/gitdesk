import type { GitdeskBridge } from '@shared/api'

declare global {
  interface Window {
    gitdesk: GitdeskBridge
  }
}
