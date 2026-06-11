export const config = { runtime: 'edge' };

// v1.0.1 — Erstellt einen Stripe-Zahlungslink für eine Termin-Anzahlung.
// Auth: Supabase-Token des Salons. Termin muss dem Salon gehören.
export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'Nicht eingeloggt' }, 401);
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: 'Ungültige Session' }, 401);
    const user = await userRes.json();

    const { appointment_id, amount_eur } = await req.json();
    if (!appointment_id || !amount_eur || amount_eur < 1 || amount_eur > 500) return json({ error: 'Ungültige Anfrage' }, 400);

    // Termin prüfen (Service Role) — gehört er diesem Salon?
    const svc = {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    };
    const apptRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/appointments?id=eq.${appointment_id}&select=id,salon_id,starts_at,customers(name),treatments(name)`, { headers: svc });
    const appts = await apptRes.json();
    const appt = appts[0];
    if (!appt || appt.salon_id !== user.id) return json({ error: 'Termin nicht gefunden' }, 404);

    const treatName = appt.treatments?.name || 'Behandlung';
    const dateStr = appt.starts_at.slice(0, 10).split('-').reverse().join('.') + ' ' + appt.starts_at.slice(11, 16);

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'eur',
        'line_items[0][price_data][unit_amount]': String(Math.round(amount_eur * 100)),
        'line_items[0][price_data][product_data][name]': `Anzahlung: ${treatName} am ${dateStr}`,
        success_url: `${process.env.APP_URL || 'https://neos-roan.vercel.app'}/book/danke`,
        cancel_url: `${process.env.APP_URL || 'https://neos-roan.vercel.app'}/book/danke`,
        'metadata[appointment_id]': appointment_id,
        'metadata[type]': 'deposit',
      }),
    });
    const stripeJson = await stripeRes.json();
    if (!stripeRes.ok) return json({ error: stripeJson?.error?.message || 'Stripe-Fehler' }, 502);

    return json({ url: stripeJson.url });
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
