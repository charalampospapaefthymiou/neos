export const config = { runtime: 'edge' };

// Öffentliche Buchungs-API (Service Role — RLS-geschützt bleibt alles andere).
// GET  ?slug=X                        → Salon-Info + Behandlungen
// GET  ?slug=X&date=YYYY-MM-DD&treatment=ID → freie Slots
// POST {slug,treatment_id,date,time,name,phone} → Anfrage/Buchung anlegen
// Zeiten werden als "naive" Salon-Lokalzeit gespeichert (T..:..:00Z-Konvention der App).

const SB = () => ({
  url: process.env.SUPABASE_URL,
  headers: {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  },
});

async function rest(path, opts = {}) {
  const { url, headers } = SB();
  const res = await fetch(`${url}/rest/v1/${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`DB ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getSalon(slug) {
  const rows = await rest(`profiles?booking_slug=eq.${encodeURIComponent(slug)}&select=id,studio_name,booking`);
  return rows[0] || null;
}

function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function toHHMM(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }

async function computeSlots(salon, date, treatmentId) {
  const b = salon.booking || {};
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  const hours = (b.hours || {})[String(weekday)];
  if (!hours) return [];
  const slotMin = b.slot_min || 30;
  const treatments = await rest(`treatments?id=eq.${treatmentId}&salon_id=eq.${salon.id}&select=duration_min`);
  const dur = treatments[0]?.duration_min || 60;
  const appts = await rest(`appointments?salon_id=eq.${salon.id}&status=in.(requested,booked,completed)&starts_at=gte.${date}T00:00:00Z&starts_at=lte.${date}T23:59:59Z&select=starts_at,ends_at,treatments(duration_min)`);
  const busy = appts.map(a => {
    const s = toMin(a.starts_at.slice(11, 16));
    const e = a.ends_at ? toMin(a.ends_at.slice(11, 16)) : s + (a.treatments?.duration_min || 60);
    return [s, e];
  });
  const open = toMin(hours[0]), close = toMin(hours[1]);
  // heute: vergangene Slots ausblenden (Salon-Zeit ≈ Europe/Berlin)
  const now = new Date(Date.now() + 2 * 3600 * 1000); // UTC+2 Näherung
  const isToday = now.toISOString().slice(0, 10) === date;
  const nowMin = isToday ? now.getUTCHours() * 60 + now.getUTCMinutes() : -1;
  const slots = [];
  for (let t = open; t + dur <= close; t += slotMin) {
    if (t <= nowMin) continue;
    const conflict = busy.some(([s, e]) => t < e && t + dur > s);
    if (!conflict) slots.push(toHHMM(t));
  }
  return slots;
}

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    if (req.method === 'GET') {
      const u = new URL(req.url);
      const slug = u.searchParams.get('slug');
      if (!slug) return json({ error: 'slug fehlt' }, 400);
      const salon = await getSalon(slug);
      if (!salon || !salon.booking || salon.booking.mode === 'off') return json({ error: 'Online-Buchung nicht verfügbar' }, 404);
      const date = u.searchParams.get('date');
      const treatment = u.searchParams.get('treatment');
      if (date && treatment) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'Ungültiges Datum' }, 400);
        return json({ slots: await computeSlots(salon, date, treatment) });
      }
      const treatments = await rest(`treatments?salon_id=eq.${salon.id}&active=eq.true&select=id,name,price,duration_min&order=name`);
      return json({
        salon: { name: salon.studio_name || slug, mode: salon.booking.mode, hours: salon.booking.hours || {} },
        treatments,
      });
    }

    if (req.method === 'POST') {
      const { slug, treatment_id, date, time, name, phone, opt_in } = await req.json();
      if (!slug || !treatment_id || !date || !time || !name || !phone) return json({ error: 'Bitte alle Felder ausfüllen' }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return json({ error: 'Ungültige Eingabe' }, 400);
      const OPT_IN_TEXT = 'Die Kundin hat bei der Online-Buchung eingewilligt, Terminerinnerungen, Nachsorge-Hinweise und gelegentliche persönliche Nachrichten per WhatsApp zu erhalten. Widerruf jederzeit möglich.';
      const optInFields = opt_in ? { whatsapp_opt_in: true, opt_in_at: new Date().toISOString(), opt_in_source: 'booking_widget', opt_in_text: OPT_IN_TEXT, opt_in_revoked_at: null } : {};
      const salon = await getSalon(slug);
      if (!salon || !salon.booking || salon.booking.mode === 'off') return json({ error: 'Online-Buchung nicht verfügbar' }, 404);
      // Slot nochmal validieren (Race-Schutz)
      const free = await computeSlots(salon, date, treatment_id);
      if (!free.includes(time)) return json({ error: 'Dieser Termin ist leider gerade vergeben worden. Bitte wähle einen anderen.' }, 409);
      // Kundin finden oder anlegen (Telefon-Match, normalisiert — Formatierung egal)
      const digits = phone.replace(/[^0-9]/g, '').slice(-9);
      let customer = null;
      if (digits.length >= 6) {
        const cands = await rest(`customers?salon_id=eq.${salon.id}&phone=not.is.null&select=id,name,phone&limit=2000`);
        customer = cands.find(c => (c.phone || '').replace(/[^0-9]/g, '').endsWith(digits)) || null;
      }
      if (!customer) {
        const ins = await rest('customers', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ salon_id: salon.id, name: name.slice(0, 120), phone: phone.slice(0, 40), ...optInFields }),
        });
        customer = ins[0];
      } else if (opt_in) {
        // Bestehende Kundin: Einwilligung dokumentieren/erneuern
        await rest(`customers?id=eq.${customer.id}`, { method: 'PATCH', body: JSON.stringify(optInFields) });
      }
      const tr = await rest(`treatments?id=eq.${treatment_id}&salon_id=eq.${salon.id}&select=duration_min`);
      const dur = tr[0]?.duration_min || 60;
      const endMin = toMin(time) + dur;
      const status = salon.booking.mode === 'direct' ? 'booked' : 'requested';
      await rest('appointments', {
        method: 'POST',
        body: JSON.stringify({
          salon_id: salon.id, customer_id: customer.id, treatment_id,
          starts_at: `${date}T${time}:00Z`, ends_at: `${date}T${toHHMM(endMin)}:00Z`, status,
        }),
      });
      return json({ ok: true, status });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
