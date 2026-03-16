// Vercel serverless function — relays webhook to Teams/Slack/Power Automate bypassing CORS
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { url, payload } = req.body || {};
  if (!url || !payload) { res.status(400).json({ error: 'Missing url or payload' }); return; }

  // Allow known webhook domains
  const allowed = [
    'outlook.office.com',
    'outlook.office365.com', 
    'hooks.slack.com',
    'discord.com/api/webhooks',
    'powerplatform.com',         // Microsoft Power Automate Workflows
    'logic.azure.com',           // Azure Logic Apps
    'environment.api.powerplatform.com', // Teams Workflows (new)
  ];
  const isAllowed = allowed.some(domain => url.includes(domain));
  if (!isAllowed) { res.status(403).json({ error: 'Webhook URL domain not allowed: ' + url.slice(0, 60) }); return; }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text().catch(() => '');
    // Power Automate returns 202 Accepted on success (no body)
    // Teams old connector returns "1"
    // Slack returns "ok"
    const ok = resp.status === 200 || resp.status === 202 || resp.status === 204 || text === '1' || text === 'ok';
    res.status(200).json({ ok, status: resp.status, body: text.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
