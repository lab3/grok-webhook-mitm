# grok-webhook-mitm

A Cloudflare Worker that relays GitHub webhook deliveries to a Grok webhook.
GitHub can sign a delivery but can't add an `Authorization` header. This Worker
checks GitHub's `X-Hub-Signature-256`, adds `Authorization: Bearer <key>` and
forwards the delivery to Grok.

It runs at `https://grok-webhook-mitm.workarea.io/`.

## Behaviour

| Request | Response | Forwarded to Grok |
| --- | --- | --- |
| Any method other than POST | 405 | No |
| Missing, malformed or wrong signature | 401 | No |
| Valid signature, `X-GitHub-Event: ping` | 200 `pong` | No |
| Valid signature, any other event | Grok's status and body | Yes |
| Valid signature, Grok unreachable | 502 | Attempted |

The Worker forwards the body byte for byte, along with `Content-Type`,
`X-GitHub-Event` and `X-GitHub-Delivery`.

GitHub gives up on a delivery after 10 seconds. If Grok takes longer to
respond, GitHub records a failure even though Grok received the event.

## Secrets

| Name | Value |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | The secret you enter in GitHub's webhook settings |
| `GROK_WEBHOOK_URL` | The Grok webhook URL |
| `GROK_WEBHOOK_KEY` | The Grok webhook key, without the `Bearer ` prefix |

Set each one with `npx wrangler secret put <NAME>`, which prompts for the
value. `wrangler deploy` refuses to run until all three are set.

Run `wrangler secret put` from this directory. Wrangler reads the Worker name
from `wrangler.jsonc`, and from anywhere else the secret doesn't reach this
Worker. Each successful change takes effect within seconds and shows up as a
"Secret Change" entry in `npx wrangler versions list`.

To generate a GitHub secret, run `openssl rand -hex 32`.

## GitHub webhook settings

The webhook can belong to a GitHub App or to a single repository. The secret
lives in a different place for each:

- GitHub App: Settings → Developer settings → GitHub Apps → your app →
  General → Webhook. Subscribe to events under Permissions & events.
  Deliveries are under Advanced → Recent Deliveries.
- Repository: the repository's Settings → Webhooks. Set content type to
  `application/json` and pick events there. Deliveries are under the
  webhook's Recent Deliveries tab.

For either kind:

- Webhook URL: `https://grok-webhook-mitm.workarea.io/`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- SSL verification: enabled

The Worker forwards every event except `ping`, so the events you subscribe to
are the events Grok receives.

A new repository webhook gets a ping, and a 200 `pong` confirms the secret
matches. After changing the secret, trigger a fresh event to test it. A
redelivery may still carry the old signature.

## Troubleshooting

A 401 `Invalid signature` means the delivery arrived with a signature, but
GitHub and the Worker hold different secrets. Set the same value in both
places. Run `npx wrangler tail` to watch deliveries arrive.

## Development

```sh
npm install
npm test            # vitest
npm run typecheck
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

To run locally, copy `.dev.vars.example` to `.dev.vars`, fill it in, then run
`npm run dev`.

## Deploy

```sh
npm run deploy
```

The first deploy creates the `grok-webhook-mitm.workarea.io` DNS record and
certificate. The `workers.dev` URL and preview URLs are turned off.
