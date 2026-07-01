export const config = { runtime: 'edge' };

// Öffentlicher Bewertungs-Endpoint (Token-basiert, Service Role).
// Wichtig: KEIN Review-Gating — jede Kundin bekommt dieselbe Einladung
// (Google-Bewertungslink), unabhängig von privatem Feedback/Sternen.
// GET  ?token=  → Studio-Name + Google-Link + Status
// POST {token, event:'google_click'}              → Klick auf Google-Button protokollieren
// POST {token, rating, feedback_text}              → privates Feedback speichern (einmalig)

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

export default async function handler(req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    if (req.method === 'GET') {
      const token = new URL(req.url).searchParams.get('token');
      if (!token || !UUID.test(token)) return json({ error: 'Ungültig' }, 404);
      const rows = await rest(`reviews?token=eq.${token}&select=responded_at,customers(name),profiles(studio_name,google_review_link,logo_url,brand_color)`);
      const r = rows?.[0];
      if (!r) return json({ error: 'Nicht gefunden' }, 404);
      if (!r.profiles?.google_review_link) return json({ error: 'Bewertungslink nicht konfiguriert' }, 404);
      return json({
        customerName: (r.customers?.name || '').split(' ')[0],
        studioName: r.profiles?.studio_name || 'dein Studio',
        googleLink: r.profiles.google_review_link,
        logoUrl: r.profiles.logo_url || null,
        brandColor: r.profiles.brand_color || null,
        responded: !!r.responded_at,
      });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { token } = body;
      if (!token || !UUID.test(token)) return json({ error: 'Ungültig' }, 400);
      const rows = await rest(`reviews?token=eq.${token}&select=id,responded_at`);
      const r = rows?.[0];
      if (!r) return json({ error: 'Nicht gefunden' }, 404);

      if (body.event === 'google_click') {
        await rest(`reviews?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ google_clicked_at: new Date().toISOString() }) });
        return json({ ok: true });
      }

      if (r.responded_at) return json({ error: 'Feedback wurde bereits gesendet' }, 409);
      const rating = Number(body.rating) || null;
      if (rating !== null && (rating < 1 || rating > 5)) return json({ error: 'Ungültige Bewertung' }, 400);
      const feedback = (body.feedback_text || '').slice(0, 2000).trim();
      if (!rating && !feedback) return json({ error: 'Bitte Sterne oder Text angeben' }, 400);
      await rest(`reviews?id=eq.${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ rating, feedback_text: feedback || null, responded_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
