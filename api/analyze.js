export const config = { runtime: 'edge' };

// KI-Beauty-Analyse: Foto + Kategorie → strukturiertes kosmetisches Ergebnis (Claude Vision).
// Kategorien: haut | wimpern | naegel | brauen
// Auth: Supabase Access Token im Authorization-Header (wie api/note.js).
// WICHTIG: rein kosmetische Einschätzung, KEINE medizinische Diagnose (DSGVO Art. 9 / HWG).

const CATEGORY_PROMPTS = {
  haut: `Kategorie: HAUT (Gesichtshaut).
Beurteile rein kosmetisch: Hauttyp-Tendenz (eher trocken/ölig/Mischhaut/normal), sichtbare Merkmale wie Trockenheitslinien, Glanz/Talg, vergrößerte Poren, Unreinheiten, Rötungen, ungleichmäßiger Teint, Pigmentverschiebungen, erste Linien/Fältchen.`,
  wimpern: `Kategorie: WIMPERN.
Beurteile rein kosmetisch: Dichte und Länge der Naturwimpern, Wuchsrichtung (gerade/abfallend), Zustand (kräftig/fein/lückig), ob Extensions oder ein Lifting sichtbar vorhanden sind (dann: Auswuchs-/Refill-Bedarf einschätzen), Eignung für Wimpernlifting vs. Extensions vs. Färben.`,
  naegel: `Kategorie: NÄGEL (Hände).
Beurteile rein kosmetisch: Nagelzustand (brüchig, splitternd, Rillen, kurz gekaut), Nagelhaut (trocken, eingerissen), ob eine Modellage/Gel/Shellac sichtbar vorhanden ist (dann: Auswuchs-/Refill-Bedarf), Nagelform, Eignung für Gel/Shellac/Naturnagelverstärkung/Maniküre.`,
  brauen: `Kategorie: AUGENBRAUEN.
Beurteile rein kosmetisch: Form und Bogen, Dichte, Symmetrie, Lücken im Wuchs, Wuchsrichtung, Farbe im Verhältnis zum Typ, Eignung für Browlifting/Lamination, Färben, Formkorrektur (Zupfen/Waxing) oder Härchenzeichnung.`,
};

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // 1. Token gegen Supabase verifizieren
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'Nicht eingeloggt' }, 401);
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: 'Ungültige Session' }, 401);

    const { category, imageBase64, mediaType, customerName, treatments } = await req.json();
    if (!CATEGORY_PROMPTS[category]) return json({ error: 'Unbekannte Kategorie' }, 400);
    if (!imageBase64 || imageBase64.length < 1000) return json({ error: 'Kein Foto übermittelt' }, 400);
    if (imageBase64.length > 3_500_000) return json({ error: 'Foto zu groß — bitte erneut versuchen' }, 400);

    const treatmentList = Array.isArray(treatments) && treatments.length
      ? `Behandlungsangebot dieses Studios (bevorzuge Empfehlungen HIERAUS, exakte Namen übernehmen): ${treatments.slice(0, 40).join(' | ')}`
      : `Das Studio hat keine Behandlungsliste hinterlegt — empfiehl allgemein übliche Kosmetik-Behandlungen.`;

    const system = `Du bist die KI-Beauty-Analyse einer Software für Kosmetikstudios. Eine Fachkraft im Studio fotografiert mit Einwilligung der Kundin und du lieferst eine KOSMETISCHE Einschätzung als Gesprächs- und Beratungsgrundlage.

STRIKTE REGELN:
- Rein kosmetische Sprache. NIEMALS medizinische Diagnosen, Krankheitsnamen oder Heilversprechen (keine "Akne", "Ekzem", "Rosazea", "Nagelpilz" etc.).
- Fällt dir etwas auf, das ärztlich abgeklärt gehören könnte, formuliere neutral in "hinweis_fachperson" (z.B. "Eine auffällige Stelle an X sollte sicherheitshalber dermatologisch angeschaut werden"), ohne Benennung einer Krankheit.
- Wertschätzender, professioneller Ton wie eine erfahrene Kosmetikerin: ehrlich, aber nie abwertend.
- Erfinde nichts, was auf dem Foto nicht erkennbar ist. Bei schlechter Bildqualität oder falschem Motiv: bild_ok=false + bild_problem, restliche Felder leer/null.
- Antworte AUSSCHLIESSLICH mit validem JSON, ohne Markdown, ohne Erklärung.

${CATEGORY_PROMPTS[category]}

${treatmentList}

Schema:
{
 "bild_ok": true/false,
 "bild_problem": "null oder warum das Bild nicht auswertbar ist (unscharf, falsches Motiv, zu dunkel...)",
 "eindruck": "2-3 Sätze kosmetischer Gesamteindruck",
 "beobachtungen": [{"punkt":"konkrete Beobachtung","auspraegung":"leicht|mittel|deutlich"}],
 "empfehlungen": [{"behandlung":"Behandlungsname (wenn möglich exakt aus dem Studio-Angebot)","warum":"1 Satz Begründung fürs Beratungsgespräch"}],
 "pflege_zuhause": ["2-4 kurze Heimpflege-Tipps"],
 "hinweis_fachperson": "null oder neutraler Hinweis auf ärztliche Abklärung"
}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: `Kundin/Kunde: ${customerName || 'unbekannt'}. Bitte analysiere das Foto gemäß Kategorie.` },
          ],
        }],
      }),
    });

    const aiJson = await aiRes.json();
    if (!aiRes.ok) return json({ error: aiJson?.error?.message || 'KI-Fehler' }, 502);

    let result;
    try {
      const text = aiJson.content[0].text.trim().replace(/^```json?\s*|\s*```$/g, '');
      result = JSON.parse(text);
    } catch (e) {
      return json({ error: 'KI-Antwort nicht lesbar' }, 502);
    }

    return json({ result });
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
