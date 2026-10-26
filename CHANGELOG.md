# Changelog

All notable changes to `n8n-nodes-honk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The output of every item has `warnings`: what the server corrected in the accepted message
  (`{ field, code, message }`, e.g. a title shortened or an invalid button left out), `[]` when
  nothing. When there are some, the node also shows a warning hint in the output pane.
- A message can be sent with only a **Title**: **Message** is no longer required, one of the two
  is.

### Changed

- The node no longer checks field contents before sending (lengths, links, buttons, metadata,
  levels, a recovery without a group key). The server now delivers first: it corrects what it
  can, sends the message and returns `warnings`. Only a message without message and title, a
  body over 16 KiB and an invalid idempotency key fail before sending.
- Errors from Honk! Honk! show the server's code and message, every field and the request id in
  the details.
- Removed the special error for `403 priority_not_allowed`: the server now lowers urgent to high
  with a `downgraded` warning. Severity and Priority descriptions say the level alone decides how
  loudly the phone honks.
- **Severity** options show the standard level name with the Honk name in parentheses: Info
  (Light), Success (Beep), Warning (Loud), Error (Long), Critical (Blast), instead of "Light
  (Info)" and so on. The values sent are unchanged.

## [0.2.0] - 2026-10-18

### Added

- **Actions** under Additional Fields: up to three buttons on the message, each a title (up to
  40 characters) and an `https://`, `mailto:`, `tel:` or `sms:` URL, sent as `actions` in the
  order given (contracts/API.md §13). Empty rows are left out. More than three, a missing title
  or URL, or a link Honk! Honk! refuses (another scheme, a `mailto:` with more than one address or with
  keys other than `subject` and `body`, a phone number with letters or an extension) fail before
  anything is sent. Messages without actions are sent exactly as before.

### Changed

- The product is now called Honk! Honk!: the node is **Honk! Honk!**, the credential
  **Honk! Honk! API**, and the descriptions and error messages use the new name. The node
  type (`n8n-nodes-honk.honk`) and the credential type (`honkApi`) are unchanged, so existing
  workflows and credentials keep working.

## [0.1.2] - 2026-10-06

### Changed

- The package's author email is accounts@honk-me.app, the address n8n's creator portal sends
  its ownership check to.

## [0.1.1] - 2026-10-04

### Fixed
- First npm release: the package is published with public access, which npm requires for a
  new package with provenance (0.1.0 was never published).

## [0.1.0] - 2026-10-04

### Added
- **Honk** node with the action **Send message** (`POST /v1/messages`): message, title,
  severity on the Honk scale, priority, group key, event type (event, problem, recovery),
  category, source, environment, channel, URL, image URL, metadata and occurred-at.
- An idempotency key on every message, by default built from the execution ID, the node and the
  item index, so retries never notify twice; or your own key.
- One request per item, Continue On Fail support, readable errors for invalid fields, keys,
  quotas, rate limits and server errors; the output is Honk's answer.
- **Honk API** credential (server URL, default `https://honk-me.app`, and ingestion key) with a
  test that checks the key without storing anything.
