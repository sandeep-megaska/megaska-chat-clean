import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALLOWED_ORIGINS = new Set([
  'https://megaska.com',
  'https://www.megaska.com',
  'https://megaska.myshopify.com'
]);
const DEFAULT_MODEL = 'gpt-4o-mini';

function pickOrigin(req: VercelRequest) {
  const o = req.headers.origin as string | undefined;
  return o && ALLOWED_ORIGINS.has(o) ? o : '*';
}

function setCors(res: VercelResponse, origin: string) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
}

function bad(res: VercelResponse, status: number, msg: string) {
  res.status(status).json({ error: msg, status });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return bad(res, 405, 'Method Not Allowed');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return bad(res, 500, 'Missing OPENAI_API_KEY on the server');

  let body: any;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return bad(res, 400, 'Invalid JSON body');
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const model = (body?.model as string) || DEFAULT_MODEL;
  if (messages.length === 0) return bad(res, 400, 'Provide { messages: [...] }');

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.write(`:ok\n\n`);

  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        input: messages.map((m: any) => `${m.role.toUpperCase()}: ${m.content}`).join('\n')
      })
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      res.write(`event: error\ndata: ${JSON.stringify({ status: upstream.status, body: text })}\n\n`);
      return res.end();
    }

    const reader = (upstream.body as any).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
    res.end();
  } catch (err: any) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err?.message || String(err) })}\n\n`);
    res.end();
  }
}
