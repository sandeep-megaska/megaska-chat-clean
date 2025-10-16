import type { VercelRequest, VercelResponse } from "@vercel/node";
You are “Megha”, a helpful product assistant for megaska.com.
CRITICAL RULES
1) Ground every factual claim in the supplied “Site Facts” context. If the context doesn’t support the claim, say you’re not sure and offer the closest link.
2) Never invent sizes, materials, delivery times, or prices. Use the facts or link to the product page.
3) Prefer short, scannable answers; end with 1–2 clear next actions.
4) When relevant, include direct links (full https URLs). Do not add tracking params.
5) If the user asks for unavailable info (e.g., out-of-stock size), offer alternatives from the same collection.
6) If you detect intent to buy, show a 2-line summary and a single call-to-action.

FORMAT
- Start with the crisp answer.
- Bullet 2–4 supporting points.
- “Next:” line with 1–2 actions (e.g., “Add to cart (S)”, “View size guide”).
- “Sources:” list of URLs you used (max 3).

PERSONA
- Friendly, direct, no hype. One emoji max per message, and only if it adds clarity.

/**
 * Megha v1.1 — Smart serverless chat
 * - System prompt: Megaska brand persona
 * - Proper chat message array (no lossy concatenation)
 * - Temperature & max_tokens controls (client may override)
 * - Tool calling (OpenAI Responses “tools”) with 3 functions:
 *    1) getFAQ()              — brand FAQs (stub, easy to extend)
 *    2) getStoreHours()       — generic helper (returns “online 24/7”)
 *    3) searchProducts(query) — stub you can wire to Shopify later
 */

const ALLOWED_ORIGINS = new Set([
  "https://megaska.com",
  "https://www.megaska.com",
  "https://megaska.myshopify.com"
]);

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_MAX_OUTPUT_TOKENS = 600;

/* ---------- Brand System Prompt (edit freely) ---------- */
const BRAND_PROMPT = `
You are **Megha**, Megaska’s helpful store assistant.
Brand: Megaska — modest, high-quality women's swimwear in India (full-length, knee-length, swim dress, burkini).
Tone: warm, concise, trustworthy. No hard sells; guide like a friend.
Rules:
- When sizing: encourage using the size guide and measuring tape.
- Shipping/returns highlights (India): exchanges for size issues; quality issues need unboxing proof; COD refunds as store credit; WhatsApp +91 9650957372 for exchanges.
- If you are not sure, say so briefly and suggest the next step.
- Keep replies short (3–6 sentences) unless asked for more.
`;

function pickOrigin(req: VercelRequest) {
  const o = req.headers.origin as string | undefined;
  return o && ALLOWED_ORIGINS.has(o) ? o : "*";
}
function setCors(res: VercelResponse, origin: string) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
}
function bad(res: VercelResponse, status: number, msg: string) {
  res.status(status).json({ error: msg, status });
}

/* ---------- Simple “tools” implemented locally ---------- */
type ToolCall = { name: string; arguments?: any };

function tool_getFAQ() {
  // Add/adjust items anytime.
  return [
    { q: "Do you offer exchanges?", a: "Yes, size exchanges are supported. Message WhatsApp +91 9650957372 to initiate." },
    { q: "Refund policy for COD?", a: "COD refunds are issued as Megaska wallet credit. Online payments refund to original method." },
    { q: "Quality issues?", a: "Share unboxing video/images; if confirmed, we provide refund or exchange." },
    { q: "Coverage & styles?", a: "We focus on modest coverage: full-length, knee-length, swim dresses, and burkinis." }
  ];
}
function tool_getStoreHours() {
  return { support: "WhatsApp +91 9650957372", hours: "Online 24/7; human support during business hours (IST)." };
}
function tool_searchProducts(query: string) {
  // Stub for now; later wire to Shopify Storefront/GraphQL.
  // Return a predictable shape so the model can summarize.
  const sample = [
    { handle: "full-length-black", title: "Full-Length Swimwear – Black", sizeRange: "M–XXL", priceINR: 1799 },
    { handle: "swim-dress-navy", title: "Swim Dress – Navy", sizeRange: "S–XL", priceINR: 1499 },
    { handle: "burkini-classic", title: "Burkini 3-Piece – Classic Print", sizeRange: "M–XXL", priceINR: 2499 }
  ];
  if (!query) return sample;
  const q = query.toLowerCase();
  return sample.filter(p => p.title.toLowerCase().includes(q) || p.handle.includes(q));
}

/* ---------- Tool schema for OpenAI Responses API ---------- */
const TOOLS = [
  {
    type: "function",
    name: "getFAQ",
    description: "Return a short list of common Megaska FAQs",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    type: "function",
    name: "getStoreHours",
    description: "Return store support contact and hours",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    type: "function",
    name: "searchProducts",
    description: "Search products by a text query; returns a small list",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "free-text query" } },
      required: [],
      additionalProperties: false
    }
  }
];

/* ---------- Main handler ---------- */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return bad(res, 405, "Method Not Allowed");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return bad(res, 500, "Missing OPENAI_API_KEY on the server");

  let body: any;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return bad(res, 400, "Invalid JSON body");
  }

  const userMessages = Array.isArray(body?.messages) ? body.messages : [];
  if (userMessages.length === 0) return bad(res, 400, "Provide { messages: [...] }");

  const model = (body?.model as string) || DEFAULT_MODEL;
  const temperature = typeof body?.temperature === "number" ? body.temperature : DEFAULT_TEMPERATURE;
  const maxOutputTokens = typeof body?.max_output_tokens === "number" ? body.max_output_tokens : DEFAULT_MAX_OUTPUT_TOKENS;

  // Compose conversation with a real system message
  const messages = [
    { role: "system", content: BRAND_PROMPT },
    ...userMessages
  ];

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.write(`:ok\n\n`);

  const encoder = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;
  const send = (obj: any) => res.write(encoder(obj));

  // Helper to call OpenAI with optional tool results injected
  async function callOpenAI(extraToolResult?: { tool_name: string; result: any; tool_call_id?: string }) {
    // If we just executed a tool, append a tool message so the model can use it
    const toolMessages = extraToolResult
      ? [{
          role: "tool",
          tool_call_id: extraToolResult.tool_call_id || `tool_${extraToolResult.tool_name}`,
          content: JSON.stringify(extraToolResult.result)
        }]
      : [];

    const payload = {
      model,
      stream: true,
      // Responses API accepts "messages" for chat-style input in many SDKs.
      // Here we pass it in "input" for HTTP compatibility.
      input: [...messages, ...toolMessages],
      temperature,
      max_output_tokens: maxOutputTokens,
      tools: TOOLS
    };

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      send({ type: "error", status: upstream.status, body: text });
      res.end();
      return;
    }

    const reader: ReadableStreamDefaultReader<Uint8Array> = (upstream.body as any).getReader();
    const decoder = new TextDecoder();

    // Stream loop with minimal tool-call handling
    let pendingToolCall: ToolCall | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);

      // Forward raw chunks so the client sees incremental text
      res.write(chunk);

      // Also try to intercept tool-call hints (if the Responses stream includes them as JSON lines)
      // We keep this lightweight; different models format events slightly differently.
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payloadStr = trimmed.slice(6);
        if (payloadStr === "[DONE]") continue;

        try {
          const evt = JSON.parse(payloadStr);

          // Heuristic: look for a tool call request
          if (evt?.type === "response.tool_call" || evt?.event === "tool_call") {
            pendingToolCall = { name: evt?.name || evt?.tool?.name, arguments: evt?.arguments || evt?.args };
          }

          // Some models send a structure like { "type":"tool_call_delta", "delta": { name, arguments } }
          if (evt?.type === "tool_call_delta" && evt?.delta) {
            const d = evt.delta;
            pendingToolCall = {
              name: d?.name ?? pendingToolCall?.name,
              arguments: { ...(pendingToolCall?.arguments || {}), ...(d?.arguments || {}) }
            };
          }

          // When tool call is “committed”
          if (evt?.type === "tool_call" && (evt?.name || evt?.tool?.name)) {
            pendingToolCall = { name: evt.name || evt.tool.name, arguments: evt.arguments || {} };
          }

          if (evt?.type === "tool_call_end" && pendingToolCall?.name) {
            // Execute the tool synchronously on our server, then recall OpenAI with tool output
            const toolName = pendingToolCall.name;
            const toolArgs = pendingToolCall.arguments || {};
            let result: any;

            if (toolName === "getFAQ") result = tool_getFAQ();
            else if (toolName === "getStoreHours") result = tool_getStoreHours();
            else if (toolName === "searchProducts") result = tool_searchProducts(toolArgs?.query || "");
            else result = { error: `Unknown tool: ${toolName}` };

            // Notify client we ran a tool
            send({ type: "tool_result", tool: toolName, result });

            // Now make a *new* call to the model, injecting the tool result
            await callOpenAI({ tool_name: toolName, result, tool_call_id: evt?.tool_call_id });
            return; // Important: stop current stream; the recursive call will handle the rest
          }
        } catch {
          // ignore JSON parse failures from non-JSON data lines
        }
      }
    }

    res.end();
  }

  try {
    await callOpenAI();
  } catch (err: any) {
    send({ type: "error", message: err?.message || String(err) });
    res.end();
  }
}
