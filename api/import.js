export const config = { runtime: 'edge' };

// KI-Spalten-Mapping für Kundenimport: bekommt Header + Beispielzeilen
// aus einem beliebigen Export (Treatwell, Fresha, Planity, Excel...)
// und liefert zurück, welche Spalte was ist.
export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'Nicht eingeloggt' }, 401);
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: 'Ungültige Session' }, 401);

    const { headers, sampleRows } = await req.json();
    if (!headers || !headers.length) return json({ error: 'Keine Spalten erkannt' }, 400);

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: `Du ordnest Spalten aus einem Kundendaten-Export (Beauty-Salon-Software wie Treatwell, Fresha, Planity, oder Excel-Listen) unserem Schema zu. Antworte AUSSCHLIESSLICH mit validem JSON ohne Markdown:
{
 "name": <Spaltenindex oder null>,
 "vorname": <Index oder null, falls Vor-/Nachname getrennt>,
 "nachname": <Index oder null>,
 "phone": <Index oder null>,
 "email": <Index oder null>,
 "birthday": <Index oder null>,
 "last_visit": <Index des letzten Besuchs/Termins oder null>,
 "treatment": <Index der letzten Behandlung/Leistung oder null>,
 "date_format": "z.B. DD.MM.YYYY oder YYYY-MM-DD oder null"
}
Indizes sind 0-basiert und beziehen sich auf die Reihenfolge der Header. Wenn name fehlt aber vorname/nachname existieren, setze name auf null.`,
        messages: [{ role: 'user', content: `Header: ${JSON.stringify(headers)}\nBeispielzeilen: ${JSON.stringify(sampleRows || [])}` }],
      }),
    });

    const aiJson = await aiRes.json();
    if (!aiRes.ok) return json({ error: aiJson?.error?.message || 'KI-Fehler' }, 502);

    let mapping;
    try {
      mapping = JSON.parse(aiJson.content[0].text.trim().replace(/^```json?\s*|\s*```$/g, ''));
    } catch (e) {
      return json({ error: 'KI-Antwort nicht lesbar' }, 502);
    }
    return json({ mapping });
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
