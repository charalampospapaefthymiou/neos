export const config = { runtime: 'edge' };

// Öffentliche Academy-API (Service Role — RLS-geschützt bleibt alles andere).
// GET  ?slug=X                              → Studio-Info + aktive kommende Kurse (inkl. freie Plätze)
// POST {slug,course_id,name,phone,email}    → Anmeldung anlegen (voll → Warteliste)

const svc = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
});
const rest = async (path, opts = {}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...svc(), ...(opts.headers || {}) } });
  const t = await res.text();
  if (!res.ok) throw new Error(`DB ${res.status}: ${t}`);
  return t ? JSON.parse(t) : null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Plätze zählen: storniert + warteliste zählen nicht als belegt
const TAKEN = 'status=in.(angemeldet,bezahlt,absolviert)';

async function getSalon(slug) {
  const rows = await rest(`profiles?booking_slug=eq.${encodeURIComponent(slug)}&academy_enabled=eq.true&select=id,studio_name,logo_url,brand_color,studio_description,address,instagram_url,whatsapp_number`);
  return rows?.[0] || null;
}

async function seatsTaken(courseIds) {
  if (!courseIds.length) return {};
  const rows = await rest(`enrollments?course_id=in.(${courseIds.join(',')})&${TAKEN}&select=course_id`);
  const map = {};
  for (const r of rows) map[r.course_id] = (map[r.course_id] || 0) + 1;
  return map;
}

export default async function handler(req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    if (req.method === 'GET') {
      const slug = new URL(req.url).searchParams.get('slug');
      if (!slug) return json({ error: 'slug fehlt' }, 400);
      const salon = await getSalon(slug);
      if (!salon) return json({ error: 'Academy nicht verfügbar' }, 404);
      // Kurse: aktiv und (ohne Datum oder in der Zukunft, Toleranz bis Vortag)
      const today = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      let courses;
      try {
        courses = await rest(`courses?salon_id=eq.${salon.id}&active=eq.true&or=(starts_at.is.null,starts_at.gte.${today}T00:00:00Z)&select=id,title,description,starts_at,duration_label,price,seats,location,is_online,modules,allow_installments&order=starts_at.asc.nullslast`);
      } catch (e) {
        // Fallback: Migration 014 noch nicht ausgeführt → ohne neue Spalten laden
        courses = await rest(`courses?salon_id=eq.${salon.id}&active=eq.true&or=(starts_at.is.null,starts_at.gte.${today}T00:00:00Z)&select=id,title,description,starts_at,duration_label,price,seats,location,is_online&order=starts_at.asc.nullslast`);
        courses = courses.map(c => ({ ...c, modules: [], allow_installments: false }));
      }
      const taken = await seatsTaken(courses.map(c => c.id));
      return json({
        salon: {
          name: salon.studio_name || slug,
          logoUrl: salon.logo_url || null, brandColor: salon.brand_color || null,
          description: salon.studio_description || null, address: salon.address || null,
          instagram: salon.instagram_url || null,
        },
        courses: courses.map(c => ({ ...c, seats_taken: taken[c.id] || 0, seats_free: Math.max(0, c.seats - (taken[c.id] || 0)) })),
      });
    }

    if (req.method === 'POST') {
      const { slug, course_id, name, phone, email } = await req.json();
      if (!slug || !course_id || !UUID.test(course_id)) return json({ error: 'Ungültige Anfrage' }, 400);
      if (!name || !phone || phone.replace(/[^0-9]/g, '').length < 6) return json({ error: 'Bitte Name und Handynummer angeben' }, 400);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Ungültige E-Mail-Adresse' }, 400);
      const salon = await getSalon(slug);
      if (!salon) return json({ error: 'Academy nicht verfügbar' }, 404);
      const courses = await rest(`courses?id=eq.${course_id}&salon_id=eq.${salon.id}&active=eq.true&select=id,title,seats`);
      const course = courses?.[0];
      if (!course) return json({ error: 'Kurs nicht gefunden' }, 404);

      // Doppel-Anmeldung verhindern (gleiche Nummer, gleicher Kurs)
      const digits = phone.replace(/[^0-9]/g, '').slice(-9);
      const existing = await rest(`enrollments?course_id=eq.${course.id}&status=neq.storniert&select=phone`);
      if (existing.some(e => (e.phone || '').replace(/[^0-9]/g, '').endsWith(digits)))
        return json({ error: 'Du bist für diesen Kurs bereits angemeldet.' }, 409);

      const takenRows = await rest(`enrollments?course_id=eq.${course.id}&${TAKEN}&select=id`);
      const status = takenRows.length >= course.seats ? 'warteliste' : 'angemeldet';
      await rest('enrollments', {
        method: 'POST',
        body: JSON.stringify({
          course_id: course.id, salon_id: salon.id,
          name: name.slice(0, 120), phone: phone.slice(0, 40), email: (email || '').slice(0, 200) || null,
          status,
        }),
      });
      return json({ ok: true, status, courseTitle: course.title });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
