/// <reference types="vite/client" />
import type { NoteWizeApi } from '../shared/ipc.js';

declare global {
  interface Window {
    notewize: NoteWizeApi;
  }
}

export {};
