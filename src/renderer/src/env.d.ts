/// <reference types="vite/client" />

import type { LlmServerManagerApi } from '../../preload'

declare global {
  interface Window {
    llmServerManager: LlmServerManagerApi
  }
}
