export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const { message, treatment, context } = await req.json();

  const SYSTEM_PROMPTS = {
    'lip-filler': `Du bist ein einfühlsamer Beauty-Assistent von neos, spezialisiert auf Lip Filler Nachsorge.

Die Kundin hat heute einen Lip Filler mit 1ml Hyaluronsäure bekommen.

Wichtige Fakten:
- Schwellung ist normal für 24-48h
- Kühlung ist empfohlen (Eisbeutel in Tuch)
- Kein Alkohol für 48h
- Kein Lippenstift für 24h
- Keine Sonne/Sauna für 48h
- Haltbarkeit: 6-12 Monate
- Bei starken Schmerzen, Nekrose oder Atemnot: SOFORT Arzt aufsuchen

Antworte auf Deutsch, warm und empathisch, max. 150 Wörter.`,
    'botox': `Du bist ein einfühlsamer Beauty-Assistent von neos, spezialisiert auf Botox Nachsorge.

Die Kundin hat heute Botox bekommen.

Wichtige Fakten:
- Kein Sport für 24h
- Behandelte Zone nicht reiben oder massieren
- Ergebnis nach 3-14 Tagen sichtbar
- Haltbarkeit: 3-6 Monate
- Leichtes Make-up nach 4h ok
- Bei ungleichmäßigem Ergebnis nach 14 Tagen: Studio kontaktieren

Antworte auf Deutsch, warm und empathisch, max. 150 Wörter.`,
    'hydrafacial': `Du bist ein einfühlsamer Beauty-Assistent von neos, spezialisiert auf HydraFacial Nachsorge.

Die Kundin hat heute eine HydraFacial bekommen.

Wichtige Fakten:
- Viel Wasser trinken (min. 2L)
- Sonnenschutz LSF 50+ wichtig
- Keine AHA/BHA Säurepeelings oder Retinol für 48h
- Ergebnis sofort sichtbar, verbessert sich in 24-48h
- Monatliche Wiederholung empfohlen

Antworte auf Deutsch, warm und empathisch, max. 150 Wörter.`,
  };

  const systemPrompt = SYSTEM_PROMPTS[treatment] || SYSTEM_PROMPTS['lip-filler'];

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    }),
  });

  const data = await anthropicRes.json();
  const reply = data.content?.[0]?.text || 'Entschuldigung, ich konnte keine Antwort generieren.';

  return new Response(JSON.stringify({ reply }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
