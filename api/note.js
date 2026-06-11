export const config = { runtime: 'edge' };

// Strukturiert eine Sprachnotiz (Transkript) per Claude in Kartei-Felder.
// Auth: Supabase Access Token im Authorization-Header (verhindert Fremdnutzung des Anthropic-Keys).
export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  try {
    // 1. Token gegen Supabase verifizieren
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return new Response(JSON.stringify({ error: 'Nicht eingeloggt' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });

    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return new Response(JSON.stringify({ error: 'Ungültige Session' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });

    const { transcript, customerName } = await req.json();
    if (!transcript || transcript.trim().length < 5) {
      return new Response(JSON.stringify({ error: 'Transkript zu kurz' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // 2. Claude strukturiert die Notiz
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `Du strukturierst Sprachnotizen aus Beauty-Salons (Friseur, Kosmetik, Aesthetik) in JSON für die Kundenkartei. Antworte AUSSCHLIESSLICH mit validem JSON, ohne Markdown, ohne Erklärung. Schema:
{
 "behandlung": "durchgeführte Behandlung oder null",
 "farbformel": "exakte Farb-/Produktformel oder null",
 "produkte": ["verwendete Produkte"] oder [],
 "hinweise": "medizinisch/technisch Wichtiges (Allergien, Hautreaktionen, Empfindlichkeiten) oder null",
 "persoenliches": "persönliche Infos für Smalltalk & Bindung (Urlaub, Hochzeit, Kinder...) oder null",
 "naechster_besuch_empfehlung": "empfohlener Zeitpunkt/Behandlung für Folgetermin oder null",
 "zusammenfassung": "1 Satz Kurzfassung"
}
Erfinde nichts. Was nicht in der Notiz steht, ist null.`,
        messages: [{ role: 'user', content: `Kundin/Kunde: ${customerName || 'unbekannt'}\nSprachnotiz: ${transcript}` }],
      }),
    });

    const aiJson = await aiRes.json();
    if (!aiRes.ok) {
      return new Response(JSON.stringify({ error: aiJson?.error?.message || 'KI-Fehler' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    let structured;
    try {
      const text = aiJson.content[0].text.trim().replace(/^```json?\s*|\s*```$/g, '');
      structured = JSON.parse(text);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'KI-Antwort nicht lesbar' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ structured }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Serverfehler: ' + e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
}
