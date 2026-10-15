import { ClientMsg, SeatInfo, ServerMsg } from './protocol';

export interface Session { url: string; code: string; token: string }

export interface NetState {
  ws: WebSocket | null;
  url: string;
  code: string;
  token: string;
  seat: number;
  seats: SeatInfo[];
  inGame: boolean;
  online: boolean;   // socket currently open
}

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export const defaultServerUrl = (): string => {
  const saved = store.get('serverUrl');
  if (saved) return saved;
  const env = (import.meta as any).env?.VITE_SERVER_URL as string | undefined;
  if (env) return env;
  const { protocol, hostname, host } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return `ws://${hostname}:8787`;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}`;
};
export const saveServerUrl = (u: string) => store.set('serverUrl', u);

/** Accepts "my-app.onrender.com", "https://…" or "wss://…" and returns a ws(s):// URL. */
export function normalizeUrl(u: string): string {
  let s = u.trim();
  if (!s) return defaultServerUrl();
  if (/^https?:\/\//.test(s)) s = s.replace(/^http/, 'ws');
  else if (!/^wss?:\/\//.test(s)) s = (/^(localhost|127\.|192\.168\.)/.test(s) ? 'ws://' : 'wss://') + s;
  return s.replace(/\/+$/, '');
}

export const loadSession = (): Session | null => {
  try { const s = JSON.parse(store.get('session') ?? 'null'); return s && s.code && s.token && s.url ? s : null; } catch { return null; }
};
export const saveSession = (s: Session) => store.set('session', JSON.stringify(s));
export const clearSession = () => store.del('session');

/** Opens a socket; calls onOpen when ready, onMsg for each server message, onClose if it drops. */
export function openSocket(url: string, handlers: { onOpen: () => void; onMsg: (m: ServerMsg) => void; onClose: () => void }): WebSocket {
  const ws = new WebSocket(url);
  ws.onopen = handlers.onOpen;
  ws.onmessage = (e) => { try { handlers.onMsg(JSON.parse(String(e.data))); } catch { /* ignore */ } };
  ws.onclose = handlers.onClose;
  return ws;
}

export const sendMsg = (ws: WebSocket | null, m: ClientMsg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
