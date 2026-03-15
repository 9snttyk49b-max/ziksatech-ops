// Vercel serverless function — proxies to Anthropic API (avoids CORS)
// 10MB body limit supports PDF base64 uploads; PDF beta header enables native PDF reading

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key-override');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const ANTHROPIC_API_KEY = req.headers['x-api-key-override'] || process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'No API key configured. Add ANTHROPIC_API_KEY to Vercel env vars.' });
  }

  const { messages, system, model = 'claude-sonnet-4-20250514', max_tokens = 4000, stream = false } = req.body;

  // Detect PDF document in messages — requires beta header
  const hasPDF = messages?.some(m =>
    Array.isArray(m.content) && m.content.some(c => c.type === 'document')
  );

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        ...(hasPDF ? { 'anthropic-beta': 'pdfs-2024-09-25' } : {}),
      },
      body: JSON.stringify({ model, max_tokens, messages, system, stream }),
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value));
      }
      res.end();
    } else {
      const data = await response.json();
      res.status(response.status).json(data);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
