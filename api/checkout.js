export const config = { runtime: 'edge' };

// Stripe-Checkout: Plan + Abrechnungsintervall (yearly = Standard).
// Preise werden über lookup_keys aufgelöst (neos_<plan>_<interval>),
// Fallback auf die alten env-Preise, falls die neuen noch nicht angelegt sind.
export default async function handler(req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const { plan, interval, userId, userEmail } = await req.json();
    if (!['starter', 'growth', 'pro'].includes(plan)) return json({ error: 'Ungültiger Plan' }, 400);
    const iv = interval === 'monthly' ? 'monthly' : 'yearly';

    // Preis über lookup_key finden
    let priceId = null;
    const lookupRes = await fetch(`https://api.stripe.com/v1/prices?lookup_keys[]=neos_${plan}_${iv}&active=true&limit=1`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    const lookupJson = await lookupRes.json();
    if (lookupRes.ok && lookupJson.data && lookupJson.data[0]) priceId = lookupJson.data[0].id;

    // Fallback: alte env-Preise (monatlich)
    if (!priceId) {
      const LEGACY = { starter: process.env.STRIPE_PRICE_STARTER, growth: process.env.STRIPE_PRICE_GROWTH, pro: process.env.STRIPE_PRICE_PRO };
      priceId = LEGACY[plan];
    }
    if (!priceId) return json({ error: 'Preis nicht gefunden' }, 500);

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        mode: 'subscription',
        'payment_method_types[]': 'card',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        customer_email: userEmail,
        client_reference_id: userId,
        success_url: `${process.env.APP_URL || 'https://neos-roan.vercel.app'}/app?upgraded=true`,
        cancel_url: `${process.env.APP_URL || 'https://neos-roan.vercel.app'}/app?upgrade=cancelled`,
        'metadata[userId]': userId,
        'metadata[plan]': plan,
        'metadata[interval]': iv,
      }).toString(),
    });

    const session = await res.json();
    if (session.error) return json({ error: session.error.message }, 400);
    return json({ url: session.url });
  } catch (err) {
    return json({ error: 'Server-Fehler: ' + err.message }, 500);
  }
}
