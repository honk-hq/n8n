import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { request } from './helpers.mjs';

const { buildMessage, checkMessage, defaultIdempotencyKey, validIdempotencyKey, baseUrl, describeApiError, readWarnings, describeWarnings } = request;

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

	test('the 16 KiB body limit', () => {
		const metadata = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`key${i}`, 'v'.repeat(500)]));
		const problems = checkMessage({ message: 'x'.repeat(8192), title: 't'.repeat(160), metadata });
		assert.deepEqual(problems.map((p) => [p.field, p.code]), [['body', 'too_long']]);
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
	test('the default key is stable per execution, node and item', () => {
		assert.equal(defaultIdempotencyKey('42', 'node-1', 0), 'n8n-42-node-1-0');
		assert.equal(defaultIdempotencyKey('42', 'node-1', 3), 'n8n-42-node-1-3');
		assert.equal(defaultIdempotencyKey(undefined, 'a b', 1), 'n8n-none-a_b-1');
		const long = defaultIdempotencyKey('9'.repeat(200), 'n', 0);
		assert.equal(long.length, 128);
		assert.ok(validIdempotencyKey(long));
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
