export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const sig = req.headers.get('stripe-signature');
  const body = await req.text();

  // Verify Stripe webhook signature
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sig) {
    return new Response('Missing signature', { status: 400 });
  }

  try {
    // Edge-compatible HMAC verification
    const sigParts = sig.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      if (!acc[k]) acc[k] = [];
      acc[k].push(v);
      return acc;
    }, {});

    const timestamp = sigParts.t?.[0];
    const signatures = sigParts.v1 || [];

    if (!timestamp) {
      return new Response('Invalid signature format', { status: 400 });
    }

    const payload = `${timestamp}.${body}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const msgData = encoder.encode(payload);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    const expectedSig = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const isValid = signatures.some(s => s === expectedSig);
    if (!isValid) {
      return new Response('Signature mismatch', { status: 400 });
    }

    const event = JSON.parse(body);

    // Handle subscription events
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const priceId = session.line_items?.data?.[0]?.price?.id;

      let plan = 'starter';
      if (priceId === process.env.STRIPE_PRICE_GROWTH) plan = 'growth';
      if (priceId === process.env.STRIPE_PRICE_PRO) plan = 'pro';

      // Update user plan in Supabase
      const supaRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify({
          plan,
          stripe_customer_id: session.customer,
          subscription_id: session.subscription,
          trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
        })
      });

      if (!supaRes.ok) {
        console.error('Supabase update failed:', await supaRes.text());
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?stripe_customer_id=eq.${sub.customer}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify({ plan: 'free' })
      });
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
