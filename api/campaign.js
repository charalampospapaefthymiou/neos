export const config = { runtime: 'edge' };

// Generiert eine persönliche Reaktivierungs-Nachricht für eine überfällige Kundin.
// Kontext kommt vom Client (RLS-geprüft), Auth via Supabase-Token.
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

    const { customerName, treatment, daysSince, rhythm, notes, studioName, bookingUrl } = await req.json();
    if (!customerName) return json({ error: 'Kundin fehlt' }, 400);

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: `Du schreibst WhatsApp-Reaktivierungs-Nachrichten für das Beauty-Studio "${studioName || 'unser Studio'}".

REGELN:
- Per Du, warm, persönlich, wie von der Inhaberin selbst geschrieben. 2-4 kurze Sätze + max. 1-2 passende Emojis.
- Beziehe dich KONKRET auf die letzte Behandlung und die vergangene Zeit (z.B. "dein Balayage von vor 8 Wochen wächst langsam raus").
- Nutze persönliche Details aus den Kartei-Notizen, wenn vorhanden (z.B. bevorstehende Hochzeit) — aber dezent, nicht aufdringlich.
- KEIN Marketing-Sprech ("exklusives Angebot", "nur diese Woche"), KEINE Rabatte erfinden.
- Ende mit einer weichen Einladung. ${bookingUrl ? 'Häng den Buchungslink ans Ende: ' + bookingUrl : 'Frag, wann es ihr passen würde.'}
- Antworte NUR mit dem Nachrichtentext, ohne Anführungszeichen, ohne Erklärung.`,
        messages: [{
          role: 'user',
          content: `Kundin: ${customerName}\nLetzte Behandlung: ${treatment || 'unbekannt'} vor ${daysSince} Tagen\nÜblicher Rhythmus: ${rhythm ? 'alle ' + rhythm + ' Tage' : 'unbekannt'}\nKartei-Notizen: ${JSON.stringify(notes || [])}`,
        }],
      }),
    });
    const aiJson = await aiRes.json();
    if (!aiRes.ok) return json({ error: aiJson?.error?.message || 'KI-Fehler' }, 502);
    return json({ message: aiJson.content[0].text.trim() });
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
