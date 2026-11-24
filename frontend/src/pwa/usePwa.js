import { useCallback, useEffect, useRef, useState } from 'react';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim(), publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// navigator.onLine only says a network interface exists. Probe the Supabase host
// (opaque no-cors request: resolves when reachable, rejects when not). Uses the public GoTrue health endpoint; no-cors requests can't send headers, so the public key goes in the query string.
export async function probeSupabase(timeoutMs = 6000) {
  if (!navigator.onLine) return false;
  if (!supabaseUrl) return true;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try { await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/health?apikey=${encodeURIComponent(publishableKey || '')}`, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal }); return true; }
  catch { return false; }
  finally { clearTimeout(timer); }
}

/** status: 'online' | 'offline' | 'unreachable' (browser online but Supabase cannot be reached) | 'reconnected' (transient) */
export function useConnectivity(onReconnect) {
  const [status, setStatus] = useState(navigator.onLine ? 'online' : 'offline');
  const last = useRef(status), cb = useRef(onReconnect);
  cb.current = onReconnect;
  const check = useCallback(async () => {
    const ok = await probeSupabase();
    const next = ok ? 'online' : navigator.onLine ? 'unreachable' : 'offline';
    const wasDown = last.current !== 'online' && last.current !== 'reconnected';
    last.current = next;
    if (ok && wasDown) { setStatus('reconnected'); cb.current?.(); } else setStatus(next);
  }, []);
  useEffect(() => {
    const down = () => { last.current = 'offline'; setStatus('offline'); };
    window.addEventListener('online', check); window.addEventListener('offline', down);
    const poll = setInterval(() => { if (last.current === 'unreachable' || last.current === 'offline') check(); }, 15000);
    if (navigator.onLine) check();
    return () => { window.removeEventListener('online', check); window.removeEventListener('offline', down); clearInterval(poll); };
  }, [check]);
  useEffect(() => {
    if (status !== 'reconnected') return;
    const t = setTimeout(() => { last.current = 'online'; setStatus('online'); }, 4000);
    return () => clearTimeout(t);
  }, [status]);
  return { status, recheck: check };
}

export function useInstall() {
  const [prompt, setPrompt] = useState(null), [installed, setInstalled] = useState(standalone());
  useEffect(() => {
    const before = (e) => { e.preventDefault(); setPrompt(e); };
    const done = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener('beforeinstallprompt', before); window.addEventListener('appinstalled', done);
    return () => { window.removeEventListener('beforeinstallprompt', before); window.removeEventListener('appinstalled', done); };
  }, []);
  const install = useCallback(async () => {
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') setInstalled(true);
    setPrompt(null);
  }, [prompt]);
  // 'native' = browser prompt available; 'ios' = show Add to Home Screen steps; 'none' = installed or unsupported
  const mode = installed ? 'none' : prompt ? 'native' : isIos() ? 'ios' : 'none';
  return { mode, install, installed };
}

export function useServiceWorkerUpdate() {
  const [waiting, setWaiting] = useState(null);
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let refreshing = false, timer;
    const track = (reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => { if (sw.state === 'installed' && navigator.serviceWorker.controller) setWaiting(sw); });
      });
    };
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then((reg) => {
      track(reg);
      timer = setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch((e) => console.warn('Service worker registration failed', e));
    const reload = () => { if (!refreshing) { refreshing = true; window.location.reload(); } };
    navigator.serviceWorker.addEventListener('controllerchange', reload);
    return () => { clearInterval(timer); navigator.serviceWorker.removeEventListener('controllerchange', reload); };
  }, []);
  const applyUpdate = useCallback(() => waiting?.postMessage({ type: 'SKIP_WAITING' }), [waiting]);
  return { updateAvailable: !!waiting, applyUpdate };
}
