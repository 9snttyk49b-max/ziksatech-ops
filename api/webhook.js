// Vercel serverless function — relays webhook to Teams/Slack bypassing CORS
export default async function handler(req, res) {
  // CORS headers so browser can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { url, payload } = req.body;
  if (!url || !payload) { res.status(400).json({ error: 'Missing url or payload' }); return; }

  // Validate URL is a known webhook domain (security)
  const allowed = ['outlook.office.com', 'outlook.office365.com', 'hooks.slack.com', 'discord.com/api/webhooks'];
  const isAllowed = allowed.some(domain => url.includes(domain));
  if (!isAllowed) { res.status(403).json({ error: 'Webhook URL domain not allowed' }); return; }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    res.status(resp.status).json({ ok: resp.ok, status: resp.status, body: text.slice(0, 500) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
