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
