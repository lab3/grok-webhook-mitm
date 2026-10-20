import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// Test vector from GitHub's docs on validating webhook deliveries:
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
const SECRET = "It's a Secret to Everybody";
const BODY = "Hello, World!";
const VALID_SIGNATURE =
  "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

const env: Env = {
  GITHUB_WEBHOOK_SECRET: SECRET,
  GROK_WEBHOOK_URL: "https://grok.example/hooks/abc",
  GROK_WEBHOOK_KEY: "grok-key-123",
};

function githubDelivery(
  headers: Record<string, string>,
  { method = "POST", body = BODY }: { method?: string; body?: string } = {},
): Request {
  return new Request("https://grok-webhook-mitm.workarea.io/", {
    method,
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      ...headers,
    },
    body: method === "GET" ? undefined : body,
  });
}

// Replaces global fetch so no request leaves the test; records what the
// Worker sent to Grok.
function stubGrok(respond: () => Promise<Response>): Request[] {
  const sent: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input, init));
    return respond();
  });
  return sent;
}

const grokAccepts = async () => new Response("queued", { status: 202 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requests that fail checks are not forwarded", () => {
  it("rejects GET with 405", async () => {
    const sent = stubGrok(grokAccepts);
    const res = await worker.fetch(
      githubDelivery({ "x-hub-signature-256": VALID_SIGNATURE }, { method: "GET" }),
      env,
    );
    expect(res.status).toBe(405);
    expect(sent).toHaveLength(0);
  });

  it("rejects a delivery with no signature header with 401", async () => {
    const sent = stubGrok(grokAccepts);
    const res = await worker.fetch(githubDelivery({}), env);
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("rejects a signature that was computed over a different body with 401", async () => {
    const sent = stubGrok(grokAccepts);
    const res = await worker.fetch(
      githubDelivery({ "x-hub-signature-256": VALID_SIGNATURE }, { body: "Hello, World?" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ["sha1 prefix", "sha1=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"],
    ["no prefix", "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"],
    ["non-hex digest", "sha256=zz7107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"],
    ["odd-length digest", "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e1"],
    ["empty digest", "sha256="],
  ])("rejects a malformed signature header (%s) with 401", async (_, header) => {
    const sent = stubGrok(grokAccepts);
    const res = await worker.fetch(githubDelivery({ "x-hub-signature-256": header }), env);
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });
});

describe("signed deliveries", () => {
  it("forwards the exact body to Grok with the bearer key and GitHub headers", async () => {
    const sent = stubGrok(grokAccepts);
    await worker.fetch(githubDelivery({ "x-hub-signature-256": VALID_SIGNATURE }), env);

    expect(sent).toHaveLength(1);
    const forwarded = sent[0];
    expect(forwarded.url).toBe("https://grok.example/hooks/abc");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("authorization")).toBe("Bearer grok-key-123");
    expect(forwarded.headers.get("content-type")).toBe("application/json");
    expect(forwarded.headers.get("x-github-event")).toBe("push");
    expect(forwarded.headers.get("x-github-delivery")).toBe(
      "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    );
    expect(await forwarded.text()).toBe("Hello, World!");
  });

  it("returns Grok's status and body to GitHub", async () => {
    stubGrok(async () => new Response("grok exploded", { status: 500 }));
    const res = await worker.fetch(
      githubDelivery({ "x-hub-signature-256": VALID_SIGNATURE }),
      env,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("grok exploded");
  });

  it("answers GitHub's ping event itself without calling Grok", async () => {
    const sent = stubGrok(grokAccepts);
    const res = await worker.fetch(
      githubDelivery({ "x-hub-signature-256": VALID_SIGNATURE, "x-github-event": "ping" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("returns 502 when Grok cannot be reached", async () => {
    stubGrok(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await worker.fetch(
      githubDelivery({ "x-hub-signature-256": VALID_SIGNATURE }),
      env,
    );
    expect(res.status).toBe(502);
  });
});

const CARECISE_URL = "https://carecise.example/hooks/routine";
const CARECISE_KEY = "carecise-key-456";

const careciseEnv: Env = {
  ...env,
  CARECISE_ROUTINE_URL: CARECISE_URL,
  CARECISE_ROUTINE_KEY: CARECISE_KEY,
};

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function signedJson(payload: unknown, signature?: string): Promise<{ request: Request; body: string }> {
  const body = JSON.stringify(payload);
  const request = githubDelivery(
    { "x-hub-signature-256": signature ?? (await sign(body)) },
    { body },
  );
  return { request, body };
}

describe("Carecise routing", () => {
  it.each([
    ["repository owner", { repository: { owner: { login: "Carecise" } } }],
    ["organization", { organization: { login: "CARECISE" } }],
    ["installation account", { installation: { account: { login: "carecise" } } }],
  ])("routes a Carecise event detected by %s to the Carecise routine", async (_how, payload) => {
    const sent = stubGrok(grokAccepts);
    const { request, body } = await signedJson(payload);
    const res = await worker.fetch(request, careciseEnv);

    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(CARECISE_URL);
    expect(sent[0].method).toBe("POST");
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${CARECISE_KEY}`);
    expect(sent[0].headers.get("x-github-event")).toBe("push");
    expect(await sent[0].text()).toBe(body);
  });

  it("does not route by installation id when the logins are not Carecise", async () => {
    const sent = stubGrok(grokAccepts);
    const { request } = await signedJson({
      installation: { id: 168716427, account: { login: "renamed" } },
      repository: { owner: { login: "renamed" } },
      organization: { login: "renamed" },
    });
    const res = await worker.fetch(request, careciseEnv);

    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(env.GROK_WEBHOOK_URL);
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${env.GROK_WEBHOOK_KEY}`);
  });

  it("routes a non-Carecise event to the default Grok webhook", async () => {
    const sent = stubGrok(grokAccepts);
    const { request, body } = await signedJson({
      installation: { id: 42, account: { login: "acme" } },
      repository: { owner: { login: "acme" } },
      organization: { login: "acme" },
    });
    const res = await worker.fetch(request, careciseEnv);

    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(env.GROK_WEBHOOK_URL);
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${env.GROK_WEBHOOK_KEY}`);
    expect(await sent[0].text()).toBe(body);
  });

  it("falls back to the default webhook when Carecise vars are unset", async () => {
    const sent = stubGrok(grokAccepts);
    const { request } = await signedJson({ repository: { owner: { login: "Carecise" } } });
    const res = await worker.fetch(request, env);

    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(env.GROK_WEBHOOK_URL);
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${env.GROK_WEBHOOK_KEY}`);
  });

  it.each([
    ["only the URL is set", { CARECISE_ROUTINE_URL: CARECISE_URL }],
    ["only the key is set", { CARECISE_ROUTINE_KEY: CARECISE_KEY }],
  ])("falls back to the default webhook when %s", async (_how, partial) => {
    const sent = stubGrok(grokAccepts);
    const { request } = await signedJson({ organization: { login: "carecise" } });
    const res = await worker.fetch(request, { ...env, ...partial });

    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(env.GROK_WEBHOOK_URL);
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${env.GROK_WEBHOOK_KEY}`);
  });

  it("rejects a bad signature without forwarding", async () => {
    const sent = stubGrok(grokAccepts);
    const { request } = await signedJson(
      { repository: { owner: { login: "Carecise" } } },
      "sha256=" + "ab".repeat(32),
    );
    const res = await worker.fetch(request, careciseEnv);

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Invalid signature");
    expect(sent).toHaveLength(0);
  });
});
