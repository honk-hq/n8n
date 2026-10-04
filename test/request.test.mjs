import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { request } from './helpers.mjs';

const { buildMessage, checkMessage, defaultIdempotencyKey, validIdempotencyKey, baseUrl, describeApiError } = request;

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
		});
	});

	test('a minimal message is only the message', () => {
		assert.deepEqual(buildMessage({ message: 'hello', title: '', severity: '', additionalFields: { groupKey: '  ', metadata: { values: [] } } }), { message: 'hello' });
		assert.deepEqual(buildMessage({ message: undefined }), { message: '' });
	});

	test('an unparseable date is sent as typed so the server names the field', () => {
		assert.equal(buildMessage({ message: 'm', additionalFields: { occurredAt: 'yesterday' } }).occurred_at, 'yesterday');
	});
});

describe('checkMessage', () => {
	const one = (body) => {
		const problems = checkMessage(body);
		assert.equal(problems.length, 1, JSON.stringify(problems));
		return [problems[0].field, problems[0].code];
	};

	test('each rule', () => {
		const s = (n) => 'x'.repeat(n);
		const cases = [
			[{ message: '' }, 'message', 'required'],
			[{ message: s(8193) }, 'message', 'too_long'],
			[{ message: 'é'.repeat(4097) }, 'message', 'too_long'],
			[{ message: '  \n ' }, 'message', 'too_short'],
			[{ message: 'bell\u0007' }, 'message', 'invalid_format'],
			[{ message: 'm', title: s(161) }, 'title', 'too_long'],
			[{ message: 'm', title: 'two\nlines' }, 'title', 'invalid_format'],
			[{ message: 'm', source: s(65) }, 'source', 'too_long'],
			[{ message: 'm', environment: s(33) }, 'environment', 'too_long'],
			[{ message: 'm', channel: s(65) }, 'channel', 'too_long'],
			[{ message: 'm', group_key: s(129) }, 'group_key', 'too_long'],
			[{ message: 'm', severity: 'loud' }, 'severity', 'invalid_enum'],
			[{ message: 'm', priority: 'asap' }, 'priority', 'invalid_enum'],
			[{ message: 'm', event_type: 'recovery' }, 'group_key', 'requires_group_key'],
			[{ message: 'm', url: 'http://example.com' }, 'url', 'invalid_format'],
			[{ message: 'm', url: 'https://user:pw@example.com' }, 'url', 'invalid_format'],
			[{ message: 'm', image_url: 'https://example.com/a.png#x' }, 'image_url', 'invalid_format'],
			[{ message: 'm', metadata: { 'bad key': 1 } }, 'metadata.bad key', 'invalid_format'],
			[{ message: 'm', metadata: { long: s(513) } }, 'metadata.long', 'invalid_format'],
		];
		for (const [body, field, code] of cases) assert.deepEqual(one(body), [field, code], `${field} ${code}`);
		const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]));
		assert.deepEqual(one({ message: 'm', metadata: many }), ['metadata', 'too_long']);
	});

	test('every problem at once, and edge cases that pass', () => {
		const fields = checkMessage({ message: '', title: 't'.repeat(200), url: 'ftp://x', event_type: 'recovery' }).map((p) => p.field);
		assert.deepEqual(fields, ['message', 'title', 'group_key', 'url']);
		const ok = [
			{ message: 'x'.repeat(8192) },
			{ message: 'é'.repeat(4096) },
			{ message: 'tabs\tand\r\nbreaks', title: 'é'.repeat(160), group_key: 'g'.repeat(128) },
			{ message: 'm', url: 'https://example.com:8443/a?b=c#d', image_url: 'https://example.com/a.png?x=1' },
			{ message: 'm', event_type: 'recovery', group_key: 'g', severity: 'critical', priority: 'urgent', category: 'sales' },
		];
		for (const body of ok) assert.deepEqual(checkMessage(body), [], JSON.stringify(body).slice(0, 60));
	});

	test('the 16 KiB body limit', () => {
		const metadata = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`key${i}`, 'v'.repeat(500)]));
		const problems = checkMessage({ message: 'x'.repeat(8192), title: 't'.repeat(160), metadata });
		assert.deepEqual(problems.map((p) => [p.field, p.code]), [['body', 'too_long']]);
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
		assert.equal(baseUrl('https://honk-me.app/'), 'https://honk-me.app');
		assert.equal(baseUrl(' https://honk.example.com/v1/messages/ '), 'https://honk.example.com');
		assert.equal(baseUrl(''), 'https://honk-me.app');
		assert.equal(baseUrl(undefined), 'https://honk-me.app');
	});
});

describe('describeApiError', () => {
	test('readable messages for each answer', () => {
		const err = (code, extra) => ({ error: { code, message: 'server text', request_id: 'req_1', ...extra } });
		const fields = [{ field: 'group_key', code: 'requires_group_key', message: 'recovery events require group_key' }];
		assert.deepEqual(describeApiError(422, err('validation_failed', { fields })), {
			code: 'validation_failed',
			message: 'Honk rejected the message',
			description: 'group_key: recovery events require group_key (request req_1)',
		});
		assert.match(describeApiError(401, err('invalid_key')).message, /invalid or revoked/);
		assert.match(describeApiError(403, err('priority_not_allowed')).message, /urgent/);
		assert.match(describeApiError(403, err('project_suspended')).description, /project_suspended/);
		assert.match(describeApiError(404, err('not_found')).message, /No Honk server/);
		assert.match(describeApiError(409, err('idempotency_conflict')).message, /already used/);
		const quota = describeApiError(429, err('quota_exceeded'), { 'retry-after': '3600' });
		assert.match(quota.message, /quota/);
		assert.match(quota.description, /3600 s/);
		assert.match(describeApiError(429, err('rate_limited'), { 'Retry-After': '2' }).description, /2 s/);
		assert.match(describeApiError(503, '<html>Bad gateway</html>').message, /HTTP 503/);
		assert.match(describeApiError(301, '', { location: 'https://x.example' }).description, /redirected to https:\/\/x.example/);
	});
});
