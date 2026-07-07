export const config = { runtime: 'edge' };

// Öffentliche Zertifikats-Prüfung (Token-basiert, Service Role).
// GET ?token= → Zertifikatsdaten, nur wenn ausgestellt (cert_issued_at gesetzt).
// Jedes Zertifikat ist damit fälschungssicher verifizierbar: /cert/:token

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const token = new URL(req.url).searchParams.get('token');
    if (!token || !UUID.test(token)) return json({ error: 'Ungültig' }, 404);
    const rows = await rest(`enrollments?cert_token=eq.${token}&select=name,status,cert_issued_at,courses(title,starts_at,duration_label,is_online),profiles(studio_name,logo_url,brand_color,address,instagram_url,website_url)`);
    const r = rows?.[0];
    if (!r || !r.cert_issued_at || r.status !== 'absolviert') return json({ error: 'Kein gültiges Zertifikat' }, 404);
    return json({
      participant: r.name,
      courseTitle: r.courses?.title || 'Schulung',
      courseDate: r.courses?.starts_at ? r.courses.starts_at.slice(0, 10) : null,
      durationLabel: r.courses?.duration_label || null,
      isOnline: !!r.courses?.is_online,
      issuedAt: r.cert_issued_at.slice(0, 10),
      certNo: 'NEOS-' + token.replace(/-/g, '').slice(0, 10).toUpperCase(),
      studioName: r.profiles?.studio_name || 'Academy',
      logoUrl: r.profiles?.logo_url || null,
      brandColor: r.profiles?.brand_color || null,
      studioAddress: r.profiles?.address || null,
      studioWebsite: r.profiles?.website_url || r.profiles?.instagram_url || null,
    });
  } catch (e) {
    return json({ error: 'Serverfehler: ' + e.message }, 500);
  }
}
