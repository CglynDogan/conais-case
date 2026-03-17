// WS event names live in shared/events.js — import from there.
export { WS_EVENTS } from '@shared/events';

export const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

export const RECONNECT_DELAY_MS = 2000;
export const MAX_RECONNECT_ATTEMPTS = 10;
