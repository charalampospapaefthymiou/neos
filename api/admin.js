export const config = { runtime: 'edge' };

// Founder-Cockpit-API — NUR für den Admin-Account.
// GET  → Salon-Liste + KPIs (Service-Role-Aggregation über alle Salons)
// POST {salon_id, plan} → Plan umstellen
// Admin = env ADMIN_USER_ID, Fallback: Carlos' Account.

const ADMIN_ID = () => process.env.ADMIN_USER_ID || '31d7c0d6-770e-4439-94aa-02cc098320e6';

const svc = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
});
const rest = async (path, opts = {}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...svc(), ...(opts.headers || {}) } });
  const t = await res.text();
  if (!res.ok) throw new Error(`DB ${res.status}: ${t.slice(0, 100)}`);
  return t ? JSON.parse(t) : null;
};

export default async function handler(req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    // Admin-Check
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'Nicht eingeloggt' }, 401);
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: 'Ungültige Session' }, 401);
    const user = await userRes.json();
    if (user.id !== ADMIN_ID()) return json({ error: 'Kein Zugriff' }, 403);

    if (req.method === 'POST') {
      const body = await req.json();

      // ── CRM: Leads (action-basiert) ──
      if (body.action === 'lead_create') {
        const l = body.lead || {};
        if (!l.name) return json({ error: 'Name fehlt' }, 400);
        const allowed = ['name','studio','city','phone','email','instagram','source','status','notes','next_action','next_action_at','salon_id'];
        const row = {}; allowed.forEach(k => { if (l[k] !== undefined && l[k] !== '') row[k] = l[k]; });
        const created = await rest('leads', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        return json({ ok: true, lead: created[0] });
      }
      if (body.action === 'lead_update') {
        if (!body.id) return json({ error: 'id fehlt' }, 400);
        const allowed = ['name','studio','city','phone','email','instagram','source','status','notes','next_action','next_action_at','salon_id'];
        const row = { updated_at: new Date().toISOString() };
        allowed.forEach(k => { if (body.fields && body.fields[k] !== undefined) row[k] = body.fields[k] === '' ? null : body.fields[k]; });
        await rest(`leads?id=eq.${body.id}`, { method: 'PATCH', body: JSON.stringify(row) });
        return json({ ok: true });
      }
      if (body.action === 'lead_delete') {
        if (!body.id) return json({ error: 'id fehlt' }, 400);
        await rest(`leads?id=eq.${body.id}`, { method: 'DELETE' });
        return json({ ok: true });
      }

      // ── Bestand: Plan umstellen ──
      const { salon_id, plan } = body;
      if (!['trial', 'starter', 'growth', 'pro'].includes(plan)) return json({ error: 'Ungültiger Plan' }, 400);
      await rest(`profiles?id=eq.${salon_id}`, { method: 'PATCH', body: JSON.stringify({ plan, plan_updated_at: new Date().toISOString() }) });
      return json({ ok: true });
    }

    // ── CRM: Leads laden (GET ?resource=leads) ──
    const url = new URL(req.url);
    if (url.searchParams.get('resource') === 'leads') {
      const leads = await rest('leads?select=*&order=created_at.desc&limit=1000');

      // Auto-Verknüpfung: Leads mit E-Mail gegen registrierte Accounts matchen
      const unlinked = (leads || []).filter(l => !l.salon_id && l.email);
      if (unlinked.length) {
        try {
          const usersRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers: svc() });
          if (usersRes.ok) {
            const { users } = await usersRes.json();
            const byEmail = {}; (users || []).forEach(u => { if (u.email) byEmail[u.email.toLowerCase()] = u.id; });
            for (const l of unlinked) {
              const uid = byEmail[l.email.toLowerCase()];
              if (uid) {
                l.salon_id = uid;
                await rest(`leads?id=eq.${l.id}`, { method: 'PATCH', body: JSON.stringify({ salon_id: uid }) });
              }
            }
          }
        } catch (e) { /* Verknüpfung ist Komfort, kein Blocker */ }
      }

      // Aktivitätsdaten der verknüpften Salons anreichern
      const ids = [...new Set((leads || []).filter(l => l.salon_id).map(l => l.salon_id))];
      let salonInfo = {};
      if (ids.length) {
        const profs = await rest(`profiles?select=id,studio_name,plan,created_at&id=in.(${ids.join(',')})`);
        (profs || []).forEach(p => { salonInfo[p.id] = p; });
      }
      return json({ leads: leads || [], salonInfo });
    }

    // GET: alles einsammeln (Pilot-Maßstab — bewusst simpel)
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const [profiles, customers, appts, msgs, notes] = await Promise.all([
      rest('profiles?select=id,studio_name,plan,created_at,booking_slug&order=created_at.desc&limit=500'),
      rest('customers?select=salon_id&limit=10000'),
      rest('appointments?select=salon_id,created_at,status&order=created_at.desc&limit=5000'),
      rest(`wa_messages?select=salon_id,created_at,kind&order=created_at.desc&limit=5000`),
      rest('notes?select=salon_id,created_at&order=created_at.desc&limit=5000'),
    ]);

    const by = (rows, fn) => { const m = {}; (rows || []).forEach(r => { const k = r.salon_id; m[k] = fn(m[k], r); }); return m; };
    const custCount = by(customers, (acc) => (acc || 0) + 1);
    const apptCount = by(appts, (acc) => (acc || 0) + 1);
    const msg30 = by((msgs || []).filter(m => m.created_at >= since30), (acc) => (acc || 0) + 1);
    const campTotal = by((msgs || []).filter(m => m.kind === 'campaign'), (acc) => (acc || 0) + 1);
    const lastAct = {};
    [appts, msgs, notes].forEach(rows => (rows || []).forEach(r => {
      if (!lastAct[r.salon_id] || r.created_at > lastAct[r.salon_id]) lastAct[r.salon_id] = r.created_at;
    }));

    const PRICE = { trial: 0, starter: 49, growth: 99, pro: 199 };
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
    const salons = (profiles || []).map(p => ({
      id: p.id,
      name: p.studio_name || p.booking_slug || p.id.slice(0, 8),
      plan: p.plan || 'trial',
      created_at: p.created_at,
      customers: custCount[p.id] || 0,
      appointments: apptCount[p.id] || 0,
      messages30d: msg30[p.id] || 0,
      campaigns: campTotal[p.id] || 0,
      last_active: lastAct[p.id] || null,
    }));

    const kpis = {
      salons: salons.length,
      active7d: salons.filter(s => s.last_active && s.last_active >= since7).length,
      mrr: salons.reduce((sum, s) => sum + (PRICE[s.plan] || 0), 0),
      campaigns: salons.reduce((sum, s) => sum + s.campaigns, 0),
      customers: salons.reduce((sum, s) => sum + s.customers, 0),
    };

    return json({ kpis, salons });
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
