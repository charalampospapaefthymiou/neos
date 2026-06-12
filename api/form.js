export const config = { runtime: 'edge' };

// Öffentlicher Anamnese-Endpoint (Token-basiert, Service Role).
// GET  ?token=  → Formular-Status + Anzeigenamen
// POST {token, data, signature} → Bogen speichern (nur einmal)

const svc = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
});
const rest = async (path, opts = {}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...svc(), ...(opts.headers || {}) } });
  const t = await res.text();
  if (!res.ok) throw new Error(`DB ${res.status}`);
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
      const rows = await rest(`forms?token=eq.${token}&select=signed_at,customers(name),profiles(studio_name)`);
      const f = rows?.[0];
      if (!f) return json({ error: 'Nicht gefunden' }, 404);
      return json({
        customerName: (f.customers?.name || '').split(' ')[0],
        studioName: f.profiles?.studio_name || 'dein Studio',
        signed: !!f.signed_at,
      });
    }

    if (req.method === 'POST') {
      const { token, data, signature } = await req.json();
      if (!token || !UUID.test(token) || !data || !signature) return json({ error: 'Unvollständig' }, 400);
      if (String(signature).length > 200000) return json({ error: 'Unterschrift zu groß' }, 400);
      const rows = await rest(`forms?token=eq.${token}&select=id,signed_at`);
      const f = rows?.[0];
      if (!f) return json({ error: 'Nicht gefunden' }, 404);
      if (f.signed_at) return json({ error: 'Bogen wurde bereits ausgefüllt' }, 409);
      await rest(`forms?id=eq.${f.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ data, signature, signed_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
