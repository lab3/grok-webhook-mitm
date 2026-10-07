// Relays GitHub webhook deliveries to a Grok webhook. GitHub signs each
// delivery with HMAC-SHA256 but cannot send a custom Authorization header, so
// this Worker checks the signature and adds the bearer key Grok expects.

const SIGNATURE_PREFIX = "sha256=";
const FORWARDED_HEADERS = ["content-type", "x-github-event", "x-github-delivery"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }

    const body = await request.arrayBuffer();
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature || !(await isValidSignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
      return new Response("Invalid signature", { status: 401 });
    }

    // GitHub sends a ping when the webhook is created; Grok has no use for it.
    if (request.headers.get("x-github-event") === "ping") {
      return new Response("pong");
    }

    const headers = new Headers({ authorization: `Bearer ${env.GROK_WEBHOOK_KEY}` });
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }

    try {
      return await fetch(env.GROK_WEBHOOK_URL, { method: "POST", headers, body });
    } catch (err) {
      console.error("Forwarding to Grok failed:", err instanceof Error ? err.message : err);
      return new Response("Bad Gateway", { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;

async function isValidSignature(secret: string, body: ArrayBuffer, header: string): Promise<boolean> {
  if (!header.startsWith(SIGNATURE_PREFIX)) return false;
  const digest = parseSha256Hex(header.slice(SIGNATURE_PREFIX.length));
  if (!digest) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // verify() compares in constant time, so the check leaks no timing signal.
  return crypto.subtle.verify("HMAC", key, digest, body);
}

function parseSha256Hex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
