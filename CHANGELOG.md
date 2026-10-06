# Changelog

All notable changes to `n8n-nodes-honk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Actions** under Additional Fields: up to three buttons on the message, each a title (up to
  40 characters) and an `https://`, `mailto:`, `tel:` or `sms:` URL, sent as `actions` in the
  order given (contracts/API.md §13). Empty rows are left out. More than three, a missing title
  or URL, or a link Honk refuses (another scheme, a `mailto:` with more than one address or with
  keys other than `subject` and `body`, a phone number with letters or an extension) fail before
  anything is sent. Messages without actions are sent exactly as before.

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
