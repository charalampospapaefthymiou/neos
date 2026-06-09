export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { client, treatment, daysSince, action } = await req.json();

  if (!client || !action) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let prompt = '';

  if (action === 'reactivation') {
    prompt = `Du bist ein freundlicher Assistent für ein Beauty- und Wellness-Studio.
Schreibe eine kurze, persönliche WhatsApp-Nachricht (max. 2 Sätze) um den Kunden ${client} zurückzugewinnen.
Die letzte Behandlung war: ${treatment}, vor ${daysSince} Tagen.
Ton: warm, persönlich, nicht aufdringlich. Nur die Nachricht, kein Kommentar.`;
  } else if (action === 'recommendation') {
    prompt = `Du bist ein KI-Assistent für ein Beauty-Studio.
Basierend auf dem Kundenprofil: Name: ${client}, Letzte Behandlung: ${treatment}, vor ${daysSince} Tagen.
Gib 1-2 kurze, konkrete Upsell-Empfehlungen auf Deutsch. Nur die Empfehlung, kein Kommentar.`;
  } else {
    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400 });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    return new Response(JSON.stringify({ error: 'AI request failed' }), { status: 500 });
  }

  const data = await response.json();
  const text = data.content[0].text;

  return new Response(JSON.stringify({ result: text }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
