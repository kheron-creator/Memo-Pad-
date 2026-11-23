// Listening time that follows your account: each device keeps its own count per day
// and sends it up; every device then shows its own count plus what the others sent.
import { supabase } from './cloud.js';

const TABLE = 'memopad_listen_time';
export const dayOf = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
export function deviceId() {
  let d = localStorage.getItem('mp.device');
  if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); localStorage.setItem('mp.device', d); }
  return d;
}
let ok = true;
// send this device's seconds for the given days ({ 'YYYY-MM-DD': seconds })
export async function pushDays(uid, source, days) {
  if (!ok || !supabase || !uid || !navigator.onLine) return;
  const dev = deviceId(), now = new Date().toISOString();
  const rows = Object.entries(days).filter(([, s]) => s > 0).map(([day, s]) => ({ user_id: uid, device_id: dev, source, day, seconds: Math.round(s), updated_at: now }));
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(TABLE).upsert(rows.slice(i, i + 500));
    if (error) { ok = false; return; }
  }
}
// seconds per day from your other devices, or null if the table isn't there yet
export async function otherDays(uid, source) {
  if (!supabase || !uid || !navigator.onLine) return null;
  const { data, error } = await supabase.from(TABLE).select('day,seconds').eq('user_id', uid).eq('source', source).neq('device_id', deviceId());
  if (error || !Array.isArray(data)) { ok = false; return null; }
  ok = true; const out = {};
  data.forEach(r => { out[r.day] = (out[r.day] || 0) + (r.seconds || 0); });
  return out;
}
