import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Honk, NodeApiError, NodeOperationError, accepted, apiError, fakeContext } from './helpers.mjs';

const run = (opts) => {
	const { ctx, calls } = fakeContext(opts);
	return { calls, result: new Honk().execute.call(ctx) };
};

const base = { message: 'db-1 /var is at 91%', title: 'Disk 91% full', severity: 'warning', additionalFields: {}, options: {} };

describe('description', () => {
	test('one resource, one operation, usable as a tool, needs the credential', () => {
		const d = new Honk().description;
		assert.equal(d.name, 'honk');
		assert.equal(d.usableAsTool, true);
		assert.deepEqual(d.credentials, [{ name: 'honkApi', required: true }]);
		const op = d.properties.find((p) => p.name === 'operation');
		assert.deepEqual(op.options.map((o) => [o.value, o.action]), [['send', 'Send message']]);
		const severity = d.properties.find((p) => p.name === 'severity');
		assert.deepEqual(severity.options.map((o) => o.value).sort(), ['critical', 'error', 'info', 'success', 'warning']);
		assert.equal(severity.default, 'info');
	});
});

describe('execute', () => {
	test('one request per item, with the body, headers and endpoint', async () => {
		const items = [{ json: {} }, { json: {} }];
		const params = [
			{ ...base, additionalFields: { groupKey: 'disk/db-1', metadata: { values: [{ key: 'host', value: 'db-1' }] } } },
			{ ...base, message: 'second', title: '', severity: 'info', options: { idempotencyKey: 'custom-7' } },
		];
		const { calls, result } = run({ items, params, credentials: { url: 'https://honk.example.com/', apiKey: 'k' }, responses: [accepted('msg_1'), accepted('msg_2', true)] });
		const [out] = await result;
		assert.equal(calls.length, 2);
		assert.equal(calls[0].credentialName, 'honkApi');
		assert.deepEqual(calls[0].options, {
			method: 'POST',
			url: 'https://honk.example.com/v1/messages',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': 'n8n-42-node-1-0' },
			body: { message: 'db-1 /var is at 91%', title: 'Disk 91% full', severity: 'warning', group_key: 'disk/db-1', metadata: { host: 'db-1' } },
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		});
		assert.deepEqual(calls[1].options.body, { message: 'second', severity: 'info' });
		assert.equal(calls[1].options.headers['Idempotency-Key'], 'custom-7');
		// The output is the API's answer, linked to its input item.
		assert.deepEqual(out, [
			{ json: accepted('msg_1').body, pairedItem: { item: 0 } },
			{ json: accepted('msg_2', true).body, pairedItem: { item: 1 } },
		]);
	});

	test('the same execution, node and item always give the same key', async () => {
		const first = run({ params: base, executionId: '7', nodeId: 'abc' });
		const again = run({ params: base, executionId: '7', nodeId: 'abc' });
		await first.result;
		await again.result;
		assert.equal(first.calls[0].options.headers['Idempotency-Key'], 'n8n-7-abc-0');
		assert.equal(again.calls[0].options.headers['Idempotency-Key'], 'n8n-7-abc-0');
	});

	test('invalid input fails before any request', async () => {
		const { calls, result } = run({ params: { ...base, message: ' ', additionalFields: { url: 'http://insecure.example' } } });
		await assert.rejects(result, (err) => {
			assert.ok(err instanceof NodeOperationError);
			assert.match(err.message, /Invalid message: Message must not be blank/);
			assert.match(err.description, /url: URL must be an https:\/\/ link/);
			return true;
		});
		assert.equal(calls.length, 0);
		const bad = run({ params: { ...base, options: { idempotencyKey: 'has space' } } });
		await assert.rejects(bad.result, /idempotency key must be 1–128/);
	});

	for (const [response, message, httpCode] of [
		[apiError(422, 'validation_failed', 'Invalid', { fields: [{ field: 'occurred_at', code: 'invalid_format', message: 'must be RFC 3339' }] }), 'Honk rejected the message', '422'],
		[apiError(401, 'invalid_key'), 'The Honk ingestion key is invalid or revoked', '401'],
		[apiError(403, 'priority_not_allowed'), 'This ingestion key may not send urgent messages', '403'],
		[apiError(404, 'not_found'), 'No Honk server at this URL', '404'],
		[apiError(409, 'idempotency_conflict'), 'This idempotency key was already used with a different message', '409'],
		[apiError(429, 'quota_exceeded', 'quota', {}, { 'retry-after': '3600' }), 'The daily message quota of this Honk workspace is used up', '429'],
		[{ statusCode: 502, headers: {}, body: '<html>Bad gateway</html>' }, 'Honk is temporarily unavailable (HTTP 502)', '502'],
	]) {
		test(`HTTP ${response.statusCode} ${response.body.error?.code ?? ''} becomes a readable NodeApiError`, async () => {
			const { result } = run({ params: base, responses: [response] });
			await assert.rejects(result, (err) => {
				assert.ok(err instanceof NodeApiError, String(err));
				assert.equal(err.message, message);
				assert.equal(err.httpCode, httpCode);
				if (httpCode === '422') assert.match(err.description, /occurred_at: must be RFC 3339/);
				if (httpCode === '429') assert.match(err.description, /3600 s/);
				return true;
			});
		});
	}

	test('a network error is a NodeApiError that points at the server URL', async () => {
		for (const thrown of [
			Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }), // n8n's own wording for known codes
			new Error('getaddrinfo ENOTFOUND honk.example'),
		]) {
			const { result } = run({ params: base, responses: [thrown] });
			await assert.rejects(result, (err) => {
				assert.ok(err instanceof NodeApiError);
				assert.match(err.message, /Could not reach Honk|refused the connection/);
				assert.match(err.description, /Check the server URL in the Honk API credential/);
				return true;
			});
		}
	});

	test('Continue On Fail turns a failed item into an error item and goes on', async () => {
		const items = [{ json: {} }, { json: {} }, { json: {} }];
		const params = [base, { ...base, message: '' }, base];
		const { calls, result } = run({ items, params, continueOnFail: true, responses: [apiError(401, 'invalid_key'), accepted('msg_3')] });
		const [out] = await result;
		assert.equal(calls.length, 2, 'the invalid item sends nothing');
		assert.equal(out.length, 3);
		assert.equal(out[0].json.error, 'The Honk ingestion key is invalid or revoked');
		assert.equal(out[0].json.httpCode, '401');
		assert.equal(out[0].json.idempotencyKey, 'n8n-42-node-1-0');
		assert.match(out[1].json.error, /Message is required/);
		assert.deepEqual(out[2], { json: accepted('msg_3').body, pairedItem: { item: 2 } });
		assert.deepEqual(out.map((o) => o.pairedItem), [{ item: 0 }, { item: 1 }, { item: 2 }]);
	});
});
