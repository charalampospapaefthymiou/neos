export const config = { runtime: 'edge' };

// Zentraler WhatsApp-Versand über 360dialog (Cloud API v2).
// Wartet auf env WHATSAPP_API_KEY — ohne Key antwortet er ehrlich mit 503.
// POST { to, text }  oder  { to, video_url, caption }  oder  { to, template, params: [] }
// Auth: Supabase-Token des Salons ODER interner Aufruf mit CRON_SECRET.

export async function sendWhatsApp({ to, text, video_url, caption, template, params }) {
  if (!process.env.WHATSAPP_API_KEY) throw new Error('WHATSAPP_NOT_CONFIGURED');
  const phone = to.replace(/[^0-9]/g, '');
  let payload;
  if (template) {
    payload = {
      to: phone, type: 'template',
      template: {
        name: template, language: { code: 'de' },
        components: params && params.length ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }] : [],
      },
    };
  } else if (video_url) {
    payload = { to: phone, type: 'video', video: { link: video_url, caption: caption || '' } };
  } else {
    payload = { to: phone, type: 'text', text: { body: text } };
  }
  const res = await fetch('https://waba-v2.360dialog.io/messages', {
    method: 'POST',
    headers: { 'D360-API-KEY': process.env.WHATSAPP_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('WhatsApp-Versand: ' + (json?.error?.message || res.status));
  return json;
}

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
    if (!process.env.WHATSAPP_API_KEY) {
      return json({ error: 'WhatsApp ist noch nicht verbunden. 360dialog-Key in Vercel als WHATSAPP_API_KEY hinterlegen.' }, 503);
    }
    // Auth: Salon-Token verifizieren
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'Nicht eingeloggt' }, 401);
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: 'Ungültige Session' }, 401);
    const user = await userRes.json();

    const body = await req.json();
    if (!body.to) return json({ error: 'Empfänger fehlt' }, 400);
    const result = await sendWhatsApp(body);

    // Loggen (Service Role)
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/wa_messages`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        salon_id: user.id,
        customer_id: body.customer_id || null,
        direction: 'out',
        body: body.text || body.caption || ('[Template: ' + (body.template || 'video') + ']'),
        kind: body.kind || 'chat',
      }),
    });

    return json({ ok: true, id: result?.messages?.[0]?.id });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
