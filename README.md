# n8n-nodes-honk

[![CI](https://github.com/honk-me/honk-n8n/actions/workflows/ci.yml/badge.svg)](https://github.com/honk-me/honk-n8n/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/n8n-nodes-honk)](https://www.npmjs.com/package/n8n-nodes-honk)

An [n8n](https://n8n.io) community node for [Honk](https://honk-me.app), the inbox that turns
events from your apps, scripts, cron jobs and workflows into calm, grouped push notifications
on your phone. Add a **Honk** node to any workflow to send a message: a new customer request,
a failed backup, a finished import.

- One action, **Send message**, with every field of the Honk ingestion API.
- Retries never notify twice: every message carries an idempotency key, by default built from
  the execution, the node and the item.
- Clear errors for invalid fields, a wrong key, quotas and rate limits.
- No runtime dependencies.

[Installation](#installation) · [Credentials](#credentials) · [Usage](#usage) ·
[Example workflow](#example-workflow) · [Errors](#errors) · [Compatibility](#compatibility)

## Installation

**Self-hosted n8n:** Settings → **Community Nodes** → **Install** → enter `n8n-nodes-honk` →
confirm → **Install**. The **Honk** node then appears in the nodes panel.

Without the UI (Docker or npm installs), in the n8n user folder:

```sh
cd ~/.n8n/nodes && npm install n8n-nodes-honk
# then restart n8n
```

See n8n's [community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/)
for queue mode and other setups.

## Credentials

Create a **Honk API** credential:

| Field | Value |
|---|---|
| Server URL | `https://honk-me.app` (the default), or the base address of your own Honk server |
| Ingestion Key | a project ingestion key (`honk_…`): in Honk, open the project → **Keys** → create a key |

**Test** checks the key without sending anything to your phone: it posts an empty message,
which Honk rejects after accepting the key (`422 message is required`). Nothing is stored.

The ingestion key can only send messages into its project. Treat it as a secret.

## Usage

Add the **Honk** node and choose **Message → Send**.

| Parameter | Notes |
|---|---|
| Message | required; up to 8192 bytes, line breaks kept |
| Title | one line, up to 160 characters; empty uses the first line of the message |
| Severity | the Honk scale: Light Honk (Info), Beep-Beep (Success), Loud Honk (Warning), Long Honk (Error), Blast (Critical). Error and critical push at least as high priority |
| Additional Fields → Priority | Low, Normal, High, Urgent (urgent needs a key that allows it) |
| Additional Fields → Group Key | messages with the same key form one group: the first pushes, repeats update it calmly. Use one key per request (`requests/{{ $json.id }}`), a shared key only for repeats of the same problem |
| Additional Fields → Event Type | Event, Problem (opens an incident for the group), Recovery (closes it; needs a group key) |
| Additional Fields → Category | Automation, Backups, Customers, Deployments, Infrastructure, Other, Payments, Personal, Sales, Security |
| Additional Fields → Source, Environment, Channel | up to 64, 32 and 64 characters; defaults `api`, `default`, `general` |
| Additional Fields → URL | an https link shown as "Open link" |
| Additional Fields → Image URL | an https image shown with the notification |
| Additional Fields → Metadata | up to 16 name/value fields |
| Additional Fields → Occurred At | when it happened at the source |
| Options → Idempotency Key | see below |

The node sends one request per input item and outputs Honk's answer for each:

```json
{ "id": "msg_01k6…", "status": "accepted", "duplicate": false, "received_at": "2026-10-04T12:20:05.123Z" }
```

`accepted` means Honk has stored the message; it then groups it and pushes it to your phone.

### Idempotency: retries never notify twice

Every message carries an idempotency key. Honk accepts a key once in 24 hours: sending the same
message with the same key again returns the original `id` with `duplicate: true` and nothing is
pushed twice.

- **Default:** `n8n-<execution id>-<node id>-<item index>`. The node's **Settings → Retry On
  Fail** and any retry within the same execution reuse it.
- **Your own key** (Options → Idempotency Key) when the same event can arrive in different
  executions, e.g. a webhook that is delivered twice: `request-{{ $json.body.id }}`.

The same key with a different message is rejected as a conflict.

## Example workflow

[`examples/quote-request.json`](examples/quote-request.json): a webhook receives a quote request
and Honk pushes it to your phone, one group and one idempotency key per request. Import it with
**Workflows → Import from File**, pick your Honk API credential in the Honk node, and send:

```sh
curl -X POST https://your-n8n.example.com/webhook/quote-request \
  -H 'Content-Type: application/json' \
  -d '{"id": 4812, "name": "Ana", "email": "ana@example.com", "summary": "3 rooms, 2 bathrooms"}'
```

## Errors

| Honk answer | n8n error | What to do |
|---|---|---|
| invalid fields (checked before sending, or `422` from Honk) | "Invalid message: …" / "Honk rejected the message", every field in the details | fix the parameters |
| `401 invalid_key` | "The Honk ingestion key is invalid or revoked" | fix the credential |
| `403 priority_not_allowed` | "This ingestion key may not send urgent messages" | another priority, or allow urgent for the key |
| `409 idempotency_conflict` | "This idempotency key was already used with a different message" | a new key, or the original message |
| `429 quota_exceeded` | "The daily message quota … is used up" (resets at midnight UTC) | wait, or a bigger plan |
| `429 rate_limited`, `5xx`, network | "Honk asked to slow down" / "Honk is temporarily unavailable" | enable **Retry On Fail** (safe: same key) |

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

- [honk-me.app](https://honk-me.app): the Honk inbox (web, iPhone).
- Honk SDKs: [Node.js](https://github.com/honk-me/honk-node), [PHP / Laravel](https://github.com/honk-me/honk-php),
  [Go + CLI](https://github.com/honk-me/honk-go), [Swift](https://github.com/honk-me/honk-swift),
  [Kotlin / Java](https://github.com/honk-me/honk-kotlin), [Rust](https://github.com/honk-me/honk-rust).

MIT License.
