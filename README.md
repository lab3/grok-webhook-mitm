# grok-webhook-mitm

A Cloudflare Worker that relays GitHub webhook deliveries to a Grok webhook.
GitHub can sign a delivery but can't add an `Authorization` header. This Worker
checks GitHub's `X-Hub-Signature-256`, adds `Authorization: Bearer <key>` and
forwards the delivery to Grok.

It runs at `https://grok-webhook-mitm.workarea.io/`.

## Behaviour

The Worker checks `X-Hub-Signature-256` before it forwards anything.

| Request | Response | Forwarded |
| --- | --- | --- |
| Any method other than POST | 405 | No |
| Missing, malformed or wrong signature | 401 | No |
| Valid signature, `X-GitHub-Event: ping` | 200 `pong` | No |
| Valid signature, Carecise event, both Carecise secrets set | Carecise routine's status and body | `CARECISE_ROUTINE_URL` |
| Valid signature, any other event | Default Grok status and body | `GROK_WEBHOOK_URL` |
| Valid signature, chosen target unreachable | 502 | Attempted |

A delivery counts as Carecise when `installation.account.login`, `repository.owner.login`, or `organization.login` is `carecise` (any case). Installation id is not used.

If either Carecise secret is unset, or the body is not valid JSON, the delivery uses the default Grok webhook.
The body is forwarded byte for byte, with `Content-Type`, `X-GitHub-Event`
and `X-GitHub-Delivery`, plus `Authorization: Bearer <key>` for the target
that was chosen.

GitHub gives up on a delivery after 10 seconds. If the target takes longer to
respond, GitHub records a failure even though the target received the event.

## Secrets

| Name | Value |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | The secret you enter in GitHub's webhook settings |
| `GROK_WEBHOOK_URL` | The default Grok webhook URL |
| `GROK_WEBHOOK_KEY` | The default Grok webhook key, without the `Bearer ` prefix |
| `CARECISE_ROUTINE_URL` | Optional. Carecise routine URL. Used only when this and `CARECISE_ROUTINE_KEY` are both set |
| `CARECISE_ROUTINE_KEY` | Optional. Carecise routine key, without the `Bearer ` prefix |

Set each one with `npx wrangler secret put <NAME>`, which prompts for the
value. `wrangler deploy` refuses to run until the three required secrets
(`GITHUB_WEBHOOK_SECRET`, `GROK_WEBHOOK_URL`, `GROK_WEBHOOK_KEY`) are set.
The Carecise pair is optional. Setting only one of them leaves Carecise
events on the default webhook.

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

The Worker forwards every event except `ping`. Carecise events go to the
Carecise routine when that pair of secrets is set. Everything else goes to
the default Grok webhook.

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
