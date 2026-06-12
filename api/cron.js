export const config = { runtime: 'edge' };
import { sendWhatsApp } from './whatsapp.js';

// Täglicher Automatik-Lauf (Vercel Cron, 07:00 UTC):
// 1. Terminerinnerung: Termine morgen → Erinnerung mit prep_text der Behandlung
// 2. Nachsorge: gestern abgeschlossene Termine → aftercare_text + optional Video
// Läuft pro Salon nur, wenn WhatsApp konfiguriert ist. Doppelversand wird über wa_messages-Log verhindert.

const svc = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
});
const rest = async (path, opts = {}) => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...svc(), ...(opts.headers || {}) } });
  const t = await res.text();
  if (!res.ok) throw new Error(`DB ${res.status}: ${t}`);
  return t ? JSON.parse(t) : null;
};
const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function alreadySent(customerId, kind, sinceIso) {
  const rows = await rest(`wa_messages?customer_id=eq.${customerId}&kind=eq.${kind}&created_at=gte.${sinceIso}&select=id&limit=1`);
  return rows && rows.length > 0;
}

export default async function handler(req) {
  // Nur Vercel-Cron oder mit Secret
  const auth = req.headers.get('authorization') || '';
  const isCron = !!req.headers.get('x-vercel-cron') || (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`);
  if (!isCron) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });

  const report = { reminders: 0, aftercare: 0, skipped: 0, errors: [] };
  if (!process.env.WHATSAPP_API_KEY) {
    return new Response(JSON.stringify({ ...report, note: 'WhatsApp nicht konfiguriert — nichts versendet' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const today = day(0);

    // 1. Erinnerungen für Termine MORGEN
    const tomorrow = day(1);
    const upcoming = await rest(`appointments?status=eq.booked&starts_at=gte.${tomorrow}T00:00:00Z&starts_at=lte.${tomorrow}T23:59:59Z&select=id,salon_id,starts_at,customers(id,name,phone,whatsapp_opt_in),treatments(name,prep_text),profiles(studio_name,automation)`);
    for (const a of upcoming || []) {
      try {
        const c = a.customers;
        if (!c?.phone) { report.skipped++; continue; }
        if (a.profiles?.automation && a.profiles.automation.reminders === false) { report.skipped++; continue; }
        if (await alreadySent(c.id, 'reminder', today + 'T00:00:00Z')) { report.skipped++; continue; }
        const time = a.starts_at.slice(11, 16);
        const studio = a.profiles?.studio_name || 'dein Studio';
        let msg = `Hallo ${c.name.split(' ')[0]}! Kurze Erinnerung: Morgen um ${time} Uhr hast du deinen Termin (${a.treatments?.name || 'Behandlung'}) bei ${studio}.`;
        if (a.treatments?.prep_text) msg += `\n\n${a.treatments.prep_text}`;
        msg += '\n\nBis morgen! 💜';
        await sendWhatsApp({ to: c.phone, text: msg });
        await rest('wa_messages', { method: 'POST', body: JSON.stringify({ salon_id: a.salon_id, customer_id: c.id, direction: 'out', body: msg, kind: 'reminder' }) });
        report.reminders++;
      } catch (e) { report.errors.push('reminder: ' + e.message); }
    }

    // 2. Nachsorge für Termine GESTERN (completed oder booked = stattgefunden)
    const yesterday = day(-1);
    const past = await rest(`appointments?status=in.(completed,booked)&starts_at=gte.${yesterday}T00:00:00Z&starts_at=lte.${yesterday}T23:59:59Z&select=id,salon_id,starts_at,customers(id,name,phone),treatments(name,aftercare_text,aftercare_video_url),profiles(studio_name,automation)`);
    for (const a of past || []) {
      try {
        const c = a.customers;
        if (!c?.phone || !a.treatments?.aftercare_text) { report.skipped++; continue; }
        if (a.profiles?.automation && a.profiles.automation.aftercare === false) { report.skipped++; continue; }
        if (await alreadySent(c.id, 'aftercare', today + 'T00:00:00Z')) { report.skipped++; continue; }
        const msg = `Hallo ${c.name.split(' ')[0]}! Wir hoffen, du bist glücklich mit deiner ${a.treatments.name} von gestern. 🌸\n\n${a.treatments.aftercare_text}\n\nBei Fragen — schreib uns einfach hier!`;
        await sendWhatsApp({ to: c.phone, text: msg });
        if (a.treatments.aftercare_video_url) {
          await sendWhatsApp({ to: c.phone, video_url: a.treatments.aftercare_video_url, caption: 'Dein Pflege-Tutorial 🎬' });
        }
        await rest('wa_messages', { method: 'POST', body: JSON.stringify({ salon_id: a.salon_id, customer_id: c.id, direction: 'out', body: msg, kind: 'aftercare' }) });
        report.aftercare++;
      } catch (e) { report.errors.push('aftercare: ' + e.message); }
    }
  } catch (e) {
    report.errors.push(e.message);
  }

  return new Response(JSON.stringify(report), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
