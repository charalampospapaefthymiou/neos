export const config = { runtime: 'edge' };

// Privater Kalender-Feed (ICS) pro Salon — für Google/Apple/Outlook-Abos.
// GET mit Authorization (eingeloggt)          → { url } (signierter Feed-Link)
// GET ?s=<salonId>&k=<signatur>               → ICS-Datei
// Signatur = HMAC-SHA256(salonId, SERVICE_KEY), erste 32 Hex-Zeichen — kein DB-Schema nötig.

async function sign(salonId) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(process.env.SUPABASE_SERVICE_ROLE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('ics:' + salonId));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

export default async function handler(req) {
  const u = new URL(req.url);
  try {
    // Modus 1: eingeloggt → Feed-URL zurückgeben
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (token && !u.searchParams.get('s')) {
      const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      });
      if (!userRes.ok) return new Response(JSON.stringify({ error: 'Ungültige Session' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      const user = await userRes.json();
      const k = await sign(user.id);
      const base = process.env.APP_URL || 'https://neos-roan.vercel.app';
      return new Response(JSON.stringify({ url: `${base}/api/ics?s=${user.id}&k=${k}` }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // Modus 2: Feed ausliefern
    const salonId = u.searchParams.get('s'), k = u.searchParams.get('k');
    if (!salonId || !k || k !== await sign(salonId)) return new Response('forbidden', { status: 403 });

    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
    const svcHeaders = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/appointments?salon_id=eq.${salonId}&status=in.(requested,booked,completed)&starts_at=gte.${from}T00:00:00Z&starts_at=lte.${to}T23:59:59Z&select=id,starts_at,ends_at,status,customers(name,phone),treatments(name)&order=starts_at`, { headers: svcHeaders });
    const appts = await res.json();
    if (!res.ok) return new Response('error', { status: 500 });

    // Zeiten sind als naive Salon-Lokalzeit mit Z-Suffix gespeichert → als Europe/Berlin ausgeben
    const fmt = iso => iso.slice(0, 10).replace(/-/g, '') + 'T' + iso.slice(11, 19).replace(/:/g, '');
    const stLabel = { requested: ' (Anfrage!)', booked: '', completed: ' ✓' };
    const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const events = (appts || []).map(a => {
      const end = a.ends_at || new Date(new Date(a.starts_at).getTime() + 3600000).toISOString();
      return [
        'BEGIN:VEVENT',
        `UID:${a.id}@neos`,
        `DTSTAMP:${now}`,
        `DTSTART;TZID=Europe/Berlin:${fmt(a.starts_at)}`,
        `DTEND;TZID=Europe/Berlin:${fmt(end)}`,
        `SUMMARY:${esc((a.customers?.name || 'Termin') + ' — ' + (a.treatments?.name || 'Behandlung') + (stLabel[a.status] || ''))}`,
        a.customers?.phone ? `DESCRIPTION:${esc('Tel: ' + a.customers.phone)}` : null,
        'END:VEVENT',
      ].filter(Boolean).join('\r\n');
    }).join('\r\n');

    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//neos//Termine//DE', 'X-WR-CALNAME:neos Termine', 'X-WR-TIMEZONE:Europe/Berlin', events, 'END:VCALENDAR'].join('\r\n');
    return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' } });
  } catch (e) {
    return new Response('error: ' + e.message, { status: 500 });
  }
}
