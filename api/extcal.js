export const config = { runtime: 'edge' };

// Externer Kalender-Import (Treatwell/Google/beliebige ICS-URL).
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD  (Auth: Supabase Access Token)
// → [{start:"YYYY-MM-DDTHH:MM", end:"...", summary, allDay}] in Europe/Berlin-Lokalzeit
// (passt zur App-Konvention "naive Lokalzeit").

const TZ = 'Europe/Berlin';

// UTC-Date → "YYYY-MM-DDTHH:MM" in Europe/Berlin
function toBerlin(d) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return s.replace(' ', 'T');
}

// ICS-Zeitwert parsen → {local:"YYYY-MM-DDTHH:MM", allDay}
function parseIcsTime(val) {
  if (!val) return null;
  val = val.trim();
  if (/^\d{8}$/.test(val)) {
    return { local: `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}T00:00`, allDay: true };
  }
  const m = val.match(/^(\d{8})T(\d{4})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, d, hm, , z] = m;
  if (z) {
    const utc = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${hm.slice(0, 2)}:${hm.slice(2, 4)}:00Z`);
    return { local: toBerlin(utc), allDay: false };
  }
  // TZID/floating → als Lokalzeit übernehmen (Treatwell/Google liefern i.d.R. TZID=Europe/Berlin)
  return { local: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${hm.slice(0, 2)}:${hm.slice(2, 4)}`, allDay: false };
}

function parseIcs(text, fromIso, toIso) {
  // Zeilen entfalten (RFC 5545: Fortsetzungszeilen beginnen mit Space/Tab)
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start) {
        if (!cur.end) cur.end = cur.allDay ? cur.start : null;
        const day = cur.start.slice(0, 10);
        if (day >= fromIso && day <= toIso) events.push(cur);
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const keyFull = line.slice(0, idx), val = line.slice(idx + 1);
    const key = keyFull.split(';')[0];
    if (key === 'DTSTART') { const t = parseIcsTime(val); if (t) { cur.start = t.local; cur.allDay = t.allDay; } }
    else if (key === 'DTEND') { const t = parseIcsTime(val); if (t) cur.end = t.local; }
    else if (key === 'SUMMARY') cur.summary = val.replace(/\\,/g, ',').replace(/\\n/g, ' ').slice(0, 80);
    else if (key === 'STATUS' && val === 'CANCELLED') cur.cancelled = true;
  }
  return events.filter(e => !e.cancelled).slice(0, 500);
}

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  try {
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'Nicht eingeloggt' }, 401);
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: 'Ungültige Session' }, 401);
    const user = await userRes.json();

    const url = new URL(req.url);
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return json({ error: 'from/to fehlt' }, 400);

    const profRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=external_ics_url`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    const prof = (await profRes.json())?.[0];
    const icsUrl = prof?.external_ics_url;
    if (!icsUrl) return json({ events: [], configured: false });
    if (!/^https:\/\//i.test(icsUrl)) return json({ error: 'ICS-URL muss mit https:// beginnen' }, 400);

    const icsRes = await fetch(icsUrl, { headers: { 'User-Agent': 'neos-calendar-sync/1.0' } });
    if (!icsRes.ok) return json({ error: `Kalender-Feed nicht erreichbar (${icsRes.status})` }, 502);
    const text = await icsRes.text();
    if (!text.includes('BEGIN:VCALENDAR')) return json({ error: 'Die URL liefert keinen gültigen Kalender (ICS)' }, 400);

    return json({ events: parseIcs(text, from, to), configured: true });
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
