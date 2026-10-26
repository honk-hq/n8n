# n8n-nodes-honk

[![CI](https://github.com/honk-hq/n8n/actions/workflows/ci.yml/badge.svg)](https://github.com/honk-hq/n8n/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/n8n-nodes-honk)](https://www.npmjs.com/package/n8n-nodes-honk)

An [n8n](https://n8n.io) community node for [Honk! Honk!](https://honk-honk.app), the inbox that turns
events from your apps, scripts, cron jobs and workflows into calm, grouped push notifications
on your phone. Add a **Honk! Honk!** node to any workflow to send a message: a new customer request,
a failed backup, a finished import.

- One action, **Send message**, with every field of the Honk! Honk! ingestion API.
- Retries never notify twice: every message carries an idempotency key, by default built from
  the execution, the node and the item.
- The server delivers first: what does not fit is shortened or left out, the message is sent
  anyway, and each correction comes back in the output's `warnings`.
- Clear errors for a refused message, a wrong key, quotas and rate limits.
- No runtime dependencies.

[Installation](#installation) · [Credentials](#credentials) · [Usage](#usage) ·
[Example workflow](#example-workflow) · [Errors](#errors) · [Compatibility](#compatibility)

## Installation

**Self-hosted n8n:** Settings → **Community Nodes** → **Install** → enter `n8n-nodes-honk` →
confirm → **Install**. The **Honk! Honk!** node then appears in the nodes panel.

Without the UI (Docker or npm installs), in the n8n user folder:

```sh
cd ~/.n8n/nodes && npm install n8n-nodes-honk
# then restart n8n
```

See n8n's [community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/)
for queue mode and other setups.

## Credentials

Create a **Honk! Honk! API** credential:

| Field | Value |
|---|---|
| Server URL | `https://honk-honk.app` (the default), or the base address of your own Honk! Honk! server |
| Ingestion Key | a project ingestion key (`honk_…`): in Honk! Honk!, open the project → **Keys** → create a key |

**Test** checks the key without sending anything to your phone: it posts an empty message,
which Honk! Honk! rejects after accepting the key (`422 message is required`). Nothing is stored.

The ingestion key can only send messages into its project. Treat it as a secret.

## Usage

Add the **Honk! Honk!** node and choose **Message → Send**.

The essentials:

| Parameter | Notes |
|---|---|
| Message | the text, line breaks kept. A message needs a Message, a Title or both |
| Title | one line; empty uses the first line of the message |
| Severity | the level: Info (Light), Success (Beep), Warning (Loud), Error (Long), Critical (Blast), the standard name with the Honk name in parentheses; sent as `info`, `success`, `warning`, `error`, `critical`. The level alone decides how loudly the phone honks |
| Additional Fields → Group Key | messages with the same key form one group: the first pushes, repeats update it calmly. Use one key per request (`requests/{{ $json.id }}`), a shared key only for repeats of the same problem. Without a key, messages group by their title |
| Additional Fields → Event Type | Event, Problem (opens an incident for the group), Recovery (closes it) |
| Options → Idempotency Key | see below |

Also under Additional Fields: Priority, Category, Source, Environment, Channel, URL (shown as
"Open link"), Image URL, Actions (up to 3 buttons, each a title and an `https://`, `mailto:`,
`tel:` or `sms:` URL; Honk! Honk! opens a link only when you tap its button), Metadata and
Occurred At.

The node checks only that a message or a title is set (and the 16 KiB size limit). Everything
else goes to Honk! Honk! as you entered it, and the server delivers first: what is too long is
shortened, an invalid optional value (an `http://` link, a fourth button) is left out, and the
message is still sent. The node sends one request per input item and outputs the server's
answer for each, with what it corrected:

```json
{
  "id": "msg_01k6…",
  "status": "accepted",
  "duplicate": false,
  "received_at": "2026-10-04T12:20:05.123Z",
  "warnings": [{ "field": "actions[1].url", "code": "ignored", "message": "…; left out" }]
}
```

`warnings` is `[]` when nothing was corrected. When it is not, the node also shows a warning
hint in the output pane. `accepted` means Honk! Honk! has stored the message; it then groups it
and pushes it to your phone.

### Idempotency: retries never notify twice

Every message carries an idempotency key. Honk! Honk! accepts a key once in 24 hours: sending the same
message with the same key again returns the original `id` with `duplicate: true` and nothing is
pushed twice.

- **Default:** `n8n-<execution id>-<node id>-<item index>`. The node's **Settings → Retry On
  Fail** and any retry within the same execution reuse it.
- **Your own key** (Options → Idempotency Key) when the same event can arrive in different
  executions, e.g. a webhook that is delivered twice: `request-{{ $json.body.id }}`.

The same key with a different message is rejected as a conflict.

## Example workflow

[`examples/quote-request.json`](examples/quote-request.json): a webhook receives a quote request
and Honk! Honk! pushes it to your phone, one group and one idempotency key per request. Import it with
**Workflows → Import from File**, pick your Honk! Honk! API credential in the Honk! Honk! node, and send:

```sh
curl -X POST https://your-n8n.example.com/webhook/quote-request \
  -H 'Content-Type: application/json' \
  -d '{"id": 4812, "name": "Maria", "email": "maria@example.com", "summary": "3 rooms, 2 bathrooms"}'
```

## Errors

| Server answer | n8n error | What to do |
|---|---|---|
| no message and no title (checked before sending), or a `4xx` such as `422 validation_failed` | "Invalid message: …" / "Honk! Honk! rejected the message"; the details list the server's code and message, every field and the request id | fix the parameters |
| `401 invalid_key` | "The Honk! Honk! ingestion key is invalid or revoked" | fix the credential |
| `409 idempotency_conflict` | "This idempotency key was already used with a different message" | a new key, or the original message |
| `429 quota_exceeded` | "The daily message quota … is used up" (resets at midnight UTC) | wait, or a bigger plan |
| `429 rate_limited`, `5xx`, network | "Honk! Honk! asked to slow down" / "Honk! Honk! is temporarily unavailable" | enable **Retry On Fail** (safe: same key) |

With **Settings → On Error → Continue**, a failed item becomes an output item with `error`,
`description`, `httpCode` and `idempotencyKey`, and the other items are still sent.

## Compatibility

n8n 1.x and 2.x (Node API version 1). Tested with `n8n-workflow` 2.41 and `@n8n/node-cli` 0.50.

## Development

```sh
npm ci
npm run lint     # n8n's community-node rules
npm test         # build, then unit tests (no network)
npm run dev      # n8n with this node, on http://localhost:5678
HONK_URL=… HONK_KEY=… npm run test:integration   # the credential test against a real server (sends nothing)
```

Releases: push a tag `vX.Y.Z` matching `package.json`; the release workflow publishes to npm
from GitHub Actions with provenance (see `CHANGELOG.md`).

## Links

- [honk-honk.app](https://honk-honk.app): the Honk! Honk! inbox (web, iPhone).
- Honk! Honk! SDKs: [Node.js](https://github.com/honk-hq/node), [PHP / Laravel](https://github.com/honk-hq/php),
  [Go + CLI](https://github.com/honk-hq/go), [Swift](https://github.com/honk-hq/honk-swift),
  [Kotlin / Java](https://github.com/honk-hq/kotlin), [Rust](https://github.com/honk-hq/rust).

MIT License.
