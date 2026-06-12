export const config = { runtime: 'edge' };

// Einmaliges, idempotentes Setup: legt die 6 neuen Stripe-Preise an
// (3 Pläne × jährlich/monatlich) mit lookup_keys neos_<plan>_<interval>.
// Nutzt die bestehenden Produkte der alten env-Preise. Auth: eingeloggter Salon.

const PLANS = {
  starter: { envPrice: 'STRIPE_PRICE_STARTER', yearly: 58800, monthly: 5900 },
  growth:  { envPrice: 'STRIPE_PRICE_GROWTH',  yearly: 118800, monthly: 12900 },
  pro:     { envPrice: 'STRIPE_PRICE_PRO',     yearly: 238800, monthly: 24900 },
};

const stripe = (path, opts = {}) => fetch(`https://api.stripe.com/v1/${path}`, {
  ...opts,
  headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
});

export default async function handler(req) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 1), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'Nicht eingeloggt' }, 401);
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: 'Ungültige Session' }, 401);

    const result = {};
    for (const [plan, cfg] of Object.entries(PLANS)) {
      // Produkt-ID aus altem Preis holen
      const oldPriceRes = await stripe(`prices/${process.env[cfg.envPrice]}`);
      const oldPrice = await oldPriceRes.json();
      if (!oldPriceRes.ok) { result[plan] = 'Fehler: ' + (oldPrice.error?.message || 'alter Preis nicht gefunden'); continue; }
      const productId = oldPrice.product;

      for (const iv of ['yearly', 'monthly']) {
        const key = `neos_${plan}_${iv}`;
        // existiert schon?
        const exRes = await stripe(`prices?lookup_keys[]=${key}&active=true&limit=1`);
        const ex = await exRes.json();
        if (ex.data && ex.data[0]) { result[key] = ex.data[0].id + ' (bestand schon)'; continue; }
        const createRes = await stripe('prices', {
          method: 'POST',
          body: new URLSearchParams({
            product: productId,
            currency: 'eur',
            unit_amount: String(cfg[iv]),
            'recurring[interval]': iv === 'yearly' ? 'year' : 'month',
            lookup_key: key,
            nickname: `neos ${plan} ${iv === 'yearly' ? 'jährlich' : 'monatlich'}`,
          }).toString(),
        });
        const created = await createRes.json();
        result[key] = createRes.ok ? created.id : 'Fehler: ' + (created.error?.message || createRes.status);
      }
    }
    return json({ ok: true, prices: result });
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
