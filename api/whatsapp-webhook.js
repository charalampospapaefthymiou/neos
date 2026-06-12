export const config = { runtime: 'edge' };
import { sendWhatsApp } from './whatsapp.js';

// Eingehende WhatsApp-Nachrichten (360dialog → Cloud-API-Format).
// Kundin schreibt → KI antwortet mit Salon-Kontext (Kartei, Behandlungen, Nachsorge)
// → bei Warnzeichen wird eskaliert (flagged) und auf den Salon/Arzt verwiesen.

const svc = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
});
const rest = async (path, opts = {}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...svc(), ...(opts.headers || {}) } });
  const t = await res.text();
  return t ? JSON.parse(t) : null;
};

export default async function handler(req) {
  // Verifizierung (Meta-Style Echo)
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const challenge = u.searchParams.get('hub.challenge');
    if (challenge) return new Response(challenge, { status: 200 });
    return new Response('ok', { status: 200 });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const payload = await req.json();
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg || msg.type !== 'text') return new Response('ignored', { status: 200 });

    const fromDigits = (msg.from || '').replace(/[^0-9]/g, '').slice(-9);
    const text = msg.text?.body?.slice(0, 1000) || '';
    if (!fromDigits || !text) return new Response('ignored', { status: 200 });

    // Kundin über Telefonnummer finden (inkl. Salon-Zuordnung)
    const cands = await rest(`customers?phone=not.is.null&select=id,salon_id,name,phone&limit=5000`);
    const customer = (cands || []).find(c => (c.phone || '').replace(/[^0-9]/g, '').endsWith(fromDigits));
    if (!customer) return new Response('unknown sender', { status: 200 });

    // Kontext laden: Termine, Kartei-Notizen, Behandlungs-Nachsorge, Studio-Name, letzte Chat-Nachrichten
    const [appts, notes, profile, history] = await Promise.all([
      rest(`appointments?customer_id=eq.${customer.id}&select=starts_at,status,treatments(name,aftercare_text,aftercare_video_url,prep_text)&order=starts_at.desc&limit=5`),
      rest(`notes?customer_id=eq.${customer.id}&select=created_at,structured&order=created_at.desc&limit=3`),
      rest(`profiles?id=eq.${customer.salon_id}&select=studio_name`),
      rest(`wa_messages?customer_id=eq.${customer.id}&select=direction,body&order=created_at.desc&limit=6`),
    ]);
    const studioName = profile?.[0]?.studio_name || 'dein Studio';

    // Eingehende Nachricht loggen
    await rest('wa_messages', { method: 'POST', body: JSON.stringify({ salon_id: customer.salon_id, customer_id: customer.id, direction: 'in', body: text }) });

    // KI-Antwort
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `Du bist der freundliche WhatsApp-Assistent des Beauty-Studios "${studioName}". Du hilfst Kundinnen bei Fragen zu Terminen, Behandlungen und Nachsorge.

REGELN:
- Antworte kurz, warm, per Du, auf Deutsch. Wie eine nette Studio-Mitarbeiterin, keine Aufzählungslisten.
- Nutze die Kundendaten unten (Behandlungshistorie, Nachsorge-Hinweise des Studios).
- KEINE medizinischen Diagnosen oder Medikamenten-Empfehlungen. Bei normalen, erwartbaren Reaktionen (leichte Rötung/Schwellung direkt nach üblichen Behandlungen) darfst du die Nachsorge-Hinweise des Studios wiedergeben und beruhigen.
- Bei Warnzeichen (starke/zunehmende Schmerzen, Fieber, Eiter, Atemnot, Sehstörungen, allergische Reaktion, Symptome die länger als erwartet anhalten) oder wenn du unsicher bist: empfehle ärztliche Abklärung und sage, dass sich das Studio persönlich meldet. Setze dann escalate=true.
- Terminwünsche: nimm sie freundlich auf und sage, dass das Studio den Termin bestätigt. escalate=true.
- Antworte AUSSCHLIESSLICH mit JSON: {"reply":"...","escalate":true|false}`,
        messages: [{
          role: 'user',
          content: `KUNDIN: ${customer.name}
LETZTE TERMINE: ${JSON.stringify(appts || [])}
KARTEI-NOTIZEN: ${JSON.stringify((notes || []).map(n => n.structured))}
LETZTE CHAT-NACHRICHTEN (neueste zuerst): ${JSON.stringify(history || [])}

NEUE NACHRICHT DER KUNDIN: ${text}`,
        }],
      }),
    });
    const aiJson = await aiRes.json();
    let out = { reply: 'Danke für deine Nachricht! Wir melden uns gleich persönlich bei dir. 💜', escalate: true };
    try {
      out = JSON.parse(aiJson.content[0].text.trim().replace(/^```json?\s*|\s*```$/g, ''));
    } catch (e) { /* Fallback bleibt */ }

    await sendWhatsApp({ to: customer.phone, text: out.reply });
    await rest('wa_messages', { method: 'POST', body: JSON.stringify({ salon_id: customer.salon_id, customer_id: customer.id, direction: 'out', body: out.reply, flagged: !!out.escalate }) });

    return new Response('ok', { status: 200 });
  } catch (e) {
    // Webhooks sollten 200 liefern, sonst spammt der Provider Retries
    return new Response('error: ' + e.message, { status: 200 });
  }
}
