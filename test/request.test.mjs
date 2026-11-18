import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { request } from './helpers.mjs';

const { buildMessage, checkMessage, defaultIdempotencyKey, inputHash, occurredAtUtc, validIdempotencyKey, baseUrl, describeApiError, readWarnings, describeWarnings } = request;

describe('buildMessage', () => {
	test('maps every field to the API names and leaves empty fields out', () => {
		const body = buildMessage({
			message: 'db-1 /var is at 91%\nsecond line',
			title: ' Disk 91% full ',
			severity: 'warning',
			additionalFields: {
				category: 'infrastructure',
				channel: 'ops',
				environment: 'production',
				eventType: 'problem',
				groupKey: 'disk/db-1',
				imageUrl: 'https://grafana.example.com/disk.png',
				metadata: { values: [{ key: 'host', value: 'db-1' }, { key: 'used', value: 91 }, { key: 'ok', value: false }, { key: '', value: 'skipped' }] },
				occurredAt: '2026-10-04T15:20:05.123+03:00',
				priority: 'high',
				source: 'n8n',
				sourceSequence: 1730000000123,
				ttlSeconds: 600,
				url: 'https://grafana.example.com/d/disk',
				actions: { values: [{ title: ' Open runbook ', url: ' https://wiki.example.com/disk ' }, { title: '', url: '' }, { title: 'Call on-call', url: 'tel:+15550134' }] },
			},
		});
		assert.deepEqual(body, {
			message: 'db-1 /var is at 91%\nsecond line',
			title: 'Disk 91% full',
			severity: 'warning',
			priority: 'high',
			category: 'infrastructure',
			source: 'n8n',
			environment: 'production',
			channel: 'ops',
			group_key: 'disk/db-1',
			event_type: 'problem',
			url: 'https://grafana.example.com/d/disk',
			image_url: 'https://grafana.example.com/disk.png',
			occurred_at: '2026-10-04T12:20:05.123Z',
			source_sequence: 1730000000123,
			ttl_seconds: 600,
			metadata: { host: 'db-1', used: 91, ok: false },
			actions: [
				{ title: 'Open runbook', url: 'https://wiki.example.com/disk' },
				{ title: 'Call on-call', url: 'tel:+15550134' },
			],
		});
	});

	test('a minimal message is only the message', () => {
		assert.deepEqual(buildMessage({ message: 'hello', title: '', severity: '', additionalFields: { groupKey: '  ', metadata: { values: [] }, actions: { values: [{ title: ' ', url: '' }] } } }), { message: 'hello' });
		assert.deepEqual(buildMessage({ message: 'hello', additionalFields: { actions: {} } }), { message: 'hello' });
		assert.deepEqual(buildMessage({ message: undefined }), {});
		assert.deepEqual(buildMessage({ message: '  ', title: 'Backup finished' }), { title: 'Backup finished' });
	});

	test('a half-filled action is sent; the server leaves it out with a warning', () => {
		assert.deepEqual(buildMessage({ message: 'm', additionalFields: { actions: { values: [{ title: 'Reply', url: '' }] } } }).actions, [{ title: 'Reply', url: '' }]);
	});

	test('an unparseable date is sent as typed; the server leaves it out with a warning', () => {
		assert.equal(buildMessage({ message: 'm', additionalFields: { occurredAt: 'yesterday' } }).occurred_at, 'yesterday');
	});

	test('TTL Seconds and Source Sequence are sent as numbers; out-of-range values are left to the server', () => {
		const fields = (additionalFields) => buildMessage({ message: 'm', additionalFields });
		assert.deepEqual(fields({ ttlSeconds: 3600, sourceSequence: 0 }), { message: 'm', ttl_seconds: 3600, source_sequence: 0 });
		// The server clamps a TTL to 60…86400 and ignores a negative sequence, each with a warning.
		assert.deepEqual(fields({ ttlSeconds: 10, sourceSequence: -1 }), { message: 'm', ttl_seconds: 10, source_sequence: -1 });
		// From an expression: a text is sent as typed (the server converts an integer in a string).
		assert.deepEqual(fields({ ttlSeconds: ' 120 ', sourceSequence: '42' }), { message: 'm', ttl_seconds: '120', source_sequence: '42' });
		assert.deepEqual(fields({ ttlSeconds: '', sourceSequence: Number.NaN }), { message: 'm' });
		assert.deepEqual(fields({ ttlSeconds: null, sourceSequence: undefined }), { message: 'm' });
	});
});

describe('occurredAtUtc', () => {
	test('a time without an offset is in the workflow timezone', () => {
		assert.equal(occurredAtUtc('2026-01-15T10:00:00', 'Europe/Bucharest'), '2026-01-15T08:00:00.000Z'); // winter, +02:00
		assert.equal(occurredAtUtc('2026-07-15T10:00:00', 'Europe/Bucharest'), '2026-07-15T07:00:00.000Z'); // summer, +03:00
		assert.equal(occurredAtUtc('2026-01-15 10:00', 'America/New_York'), '2026-01-15T15:00:00.000Z');
		assert.equal(occurredAtUtc('2026-01-15T10:00:00.250', 'Asia/Kolkata'), '2026-01-15T04:30:00.250Z');
		assert.equal(occurredAtUtc('2026-01-15', 'Europe/Bucharest'), '2026-01-14T22:00:00.000Z');
		assert.equal(occurredAtUtc('2026-01-15T10:00:00', 'UTC'), '2026-01-15T10:00:00.000Z');
		// Either side of a daylight-saving change in Bucharest (2026-03-29 and 2026-10-25).
		assert.equal(occurredAtUtc('2026-03-29T05:00:00', 'Europe/Bucharest'), '2026-03-29T02:00:00.000Z');
		assert.equal(occurredAtUtc('2026-10-25T05:00:00', 'Europe/Bucharest'), '2026-10-25T03:00:00.000Z');
	});

	test('a time with an offset or Z is that instant, whatever the workflow timezone', () => {
		assert.equal(occurredAtUtc('2026-01-15T10:00:00Z', 'Europe/Bucharest'), '2026-01-15T10:00:00.000Z');
		assert.equal(occurredAtUtc('2026-01-15T10:00:00+05:00', 'Europe/Bucharest'), '2026-01-15T05:00:00.000Z');
		assert.equal(occurredAtUtc(new Date('2026-01-15T10:00:00Z'), 'Europe/Bucharest'), '2026-01-15T10:00:00.000Z');
	});

	test('nothing, an unknown timezone and an unparseable value', () => {
		assert.equal(occurredAtUtc('', 'UTC'), undefined);
		assert.equal(occurredAtUtc(undefined, 'UTC'), undefined);
		assert.equal(occurredAtUtc('2026-01-15T10:00:00Z', 'Not/AZone'), '2026-01-15T10:00:00.000Z');
		assert.equal(occurredAtUtc('soon', 'UTC'), 'soon');
	});

	test('buildMessage reads Occurred At in the timezone it is given', () => {
		const body = buildMessage({ message: 'm', additionalFields: { occurredAt: '2026-01-15T10:00:00' } }, 'Europe/Bucharest');
		assert.equal(body.occurred_at, '2026-01-15T08:00:00.000Z');
	});
});

describe('checkMessage', () => {
	test('a message or a title is required', () => {
		assert.deepEqual(checkMessage({}), [{ field: 'message', code: 'required', message: 'Set a Message or a Title' }]);
		assert.deepEqual(checkMessage({ severity: 'info' }).map((p) => p.field), ['message']);
		assert.deepEqual(checkMessage({ title: 'Backup finished' }), []);
		assert.deepEqual(checkMessage({ message: 'Backup finished' }), []);
	});

	test('field contents are left to the server', () => {
		const body = {
			message: 'x'.repeat(9000),
			title: 't'.repeat(200),
			severity: 'loud',
			priority: 'asap',
			event_type: 'recovery',
			url: 'http://example.com',
			image_url: 'https://example.com/a.png#x',
			metadata: { 'bad key': 'v'.repeat(600) },
			actions: [{ title: '', url: 'javascript:alert(1)' }, { title: 'a', url: 'tel:1' }, { title: 'b', url: 'tel:2' }, { title: 'c', url: 'tel:3' }],
		};
		assert.deepEqual(checkMessage(body), []);
	});

	test('the body size is left to the server (413 payload_too_large)', () => {
		const metadata = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`key${i}`, 'v'.repeat(500)]));
		assert.deepEqual(checkMessage({ message: 'x'.repeat(20000), title: 't'.repeat(160), metadata }), []);
	});
});

describe('warnings', () => {
	const warnings = [
		{ field: 'title', code: 'truncated', message: 'longer than 160 characters; shortened' },
		{ field: 'actions[0].url', code: 'ignored', message: 'not an https, mailto, tel or sms link; left out' },
	];

	test('readWarnings returns the 202 warnings as sent, [] without any', () => {
		assert.deepEqual(readWarnings({ id: 'msg_1', warnings }), warnings);
		assert.deepEqual(readWarnings({ id: 'msg_1', warnings: [] }), []);
		assert.deepEqual(readWarnings({ id: 'msg_1' }), []);
		assert.deepEqual(readWarnings({ id: 'msg_1', warnings: 'junk' }), []);
		assert.deepEqual(readWarnings(undefined), []);
	});

	test('describeWarnings is one line per warning', () => {
		assert.equal(
			describeWarnings(warnings),
			'title truncated: longer than 160 characters; shortened\nactions[0].url ignored: not an https, mailto, tel or sms link; left out',
		);
		assert.equal(describeWarnings([{ field: 'priority', code: 'downgraded', message: '' }]), 'priority downgraded');
	});
});

describe('idempotency keys and URLs', () => {
	test('the default key is stable per execution, node, run and item', () => {
		assert.equal(defaultIdempotencyKey({ executionId: '42', nodeId: 'node-1', runIndex: 0, itemIndex: 0 }), 'n8n-42-node-1-0-0');
		assert.equal(defaultIdempotencyKey({ executionId: '42', nodeId: 'node-1', runIndex: 0, itemIndex: 3 }), 'n8n-42-node-1-0-3');
		assert.equal(defaultIdempotencyKey({ executionId: '42', nodeId: 'node-1', itemIndex: 3 }), 'n8n-42-node-1-0-3');
		assert.equal(defaultIdempotencyKey({ executionId: undefined, nodeId: 'a b', runIndex: 0, itemIndex: 1 }), 'n8n-none-a_b-0-1');
		const long = defaultIdempotencyKey({ executionId: '9'.repeat(200), nodeId: 'n', runIndex: 12, itemIndex: 7 });
		assert.equal(long.length, 128);
		assert.ok(long.endsWith('-12-7'), 'the run and item are never cut off');
		assert.ok(validIdempotencyKey(long));
	});

	test('a second run of the node in the same execution gets a different key', () => {
		const first = defaultIdempotencyKey({ executionId: '42', nodeId: 'node-1', runIndex: 0, itemIndex: 0 });
		const second = defaultIdempotencyKey({ executionId: '42', nodeId: 'node-1', runIndex: 1, itemIndex: 0 });
		assert.equal(second, 'n8n-42-node-1-1-0');
		assert.notEqual(first, second);
	});

	test('a tool call is keyed by its input, not by the run', () => {
		const key = (json, runIndex) => defaultIdempotencyKey({ executionId: '42', nodeId: 'node-1', runIndex, itemIndex: 0, toolInputHash: inputHash(json) });
		assert.match(inputHash({ message: 'a' }), /^[0-9a-f]{8}$/);
		assert.equal(key({ message: 'a' }, 0), `n8n-42-node-1-tool-${inputHash({ message: 'a' })}-0`);
		assert.equal(key({ message: 'a' }, 0), key({ message: 'a' }, 1), 'a retry of the same call keeps its key');
		assert.notEqual(key({ message: 'a' }, 0), key({ message: 'b' }, 0), 'different input, different key');
		assert.equal(inputHash(undefined), inputHash(null));
		const long = defaultIdempotencyKey({ executionId: 'x'.repeat(200), nodeId: 'n', itemIndex: 0, toolInputHash: inputHash({}) });
		assert.ok(validIdempotencyKey(long) && long.endsWith(`-tool-${inputHash({})}-0`));
	});

	test('key format', () => {
		for (const k of ['k', 'request-4812', 'x'.repeat(128)]) assert.ok(validIdempotencyKey(k), k);
		for (const k of ['', 'has space', 'x'.repeat(129), 'café']) assert.ok(!validIdempotencyKey(k), k);
	});

	test('the base URL', () => {
		assert.equal(baseUrl('https://honk-honk.app/'), 'https://honk-honk.app');
		assert.equal(baseUrl(' https://honk.example.com/v1/messages/ '), 'https://honk.example.com');
		assert.equal(baseUrl(''), 'https://honk-honk.app');
		assert.equal(baseUrl(undefined), 'https://honk-honk.app');
	});
});

describe('describeApiError', () => {
	test('readable messages for each answer', () => {
		const err = (code, extra) => ({ error: { code, message: 'server text', request_id: 'req_1', ...extra } });
		const fields = [{ field: 'event_type', code: 'invalid_enum', message: 'must be one of event, problem, recovery' }];
		assert.deepEqual(describeApiError(422, err('validation_failed', { fields })), {
			code: 'validation_failed',
			message: 'Honk! Honk! rejected the message',
			description: 'validation_failed: server text\nevent_type: must be one of event, problem, recovery (request req_1)',
		});
		assert.equal(describeApiError(422, err('unknown_field', { fields: [{ field: 'colour', code: 'not_allowed' }] })).description, 'unknown_field: server text\ncolour: not_allowed (request req_1)');
		assert.match(describeApiError(401, err('invalid_key')).message, /invalid or revoked/);
		assert.match(describeApiError(401, err('invalid_key')).description, /\(request req_1\)$/);
		assert.match(describeApiError(403, err('project_suspended')).description, /project_suspended.*\(request req_1\)$/);
		assert.match(describeApiError(401, { error: { code: 'invalid_key' } }, { 'X-Request-Id': 'req_hdr' }).description, /\(request req_hdr\)$/);
		assert.match(describeApiError(404, err('not_found')).message, /No Honk! Honk! server/);
		assert.match(describeApiError(409, err('idempotency_conflict')).message, /already used/);
		const quota = describeApiError(429, err('quota_exceeded'), { 'retry-after': '3600' });
		assert.match(quota.message, /quota/);
		assert.match(quota.description, /3600 s/);
		assert.match(describeApiError(429, err('rate_limited'), { 'Retry-After': '2' }).description, /2 s/);
		assert.match(describeApiError(503, '<html>Bad gateway</html>').message, /HTTP 503/);
		assert.match(describeApiError(301, '', { location: 'https://x.example' }).description, /redirected to https:\/\/x.example/);
	});
});
