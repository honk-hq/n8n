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
		assert.deepEqual(
			severity.options.map((o) => [o.value, o.name]),
			[
				['critical', 'Critical (Blast)'],
				['error', 'Error (Long)'],
				['info', 'Info (Light)'],
				['success', 'Success (Beep)'],
				['warning', 'Warning (Loud)'],
			],
		);
		assert.equal(severity.default, 'info');
		const fields = d.properties.find((p) => p.name === 'additionalFields').options;
		const actions = fields.find((o) => o.name === 'actions');
		assert.equal(actions.type, 'fixedCollection');
		assert.equal(actions.typeOptions.multipleValues, true);
		assert.deepEqual(actions.options[0].values.map((v) => v.name), ['title', 'url']);
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
		// The output is the API's answer, with `warnings` always present, linked to its input item.
		assert.deepEqual(out, [
			{ json: { ...accepted('msg_1').body, warnings: [] }, pairedItem: { item: 0 } },
			{ json: { ...accepted('msg_2', true).body, warnings: [] }, pairedItem: { item: 1 } },
		]);
	});

	test('actions are sent in the order given', async () => {
		const actions = { values: [{ title: 'Reply', url: 'mailto:ana@example.com?subject=Your%20quote' }, { title: 'Call Ana', url: 'tel:+40712345678' }] };
		const { calls, result } = run({ params: { ...base, additionalFields: { actions } } });
		await result;
		assert.deepEqual(calls[0].options.body.actions, [
			{ title: 'Reply', url: 'mailto:ana@example.com?subject=Your%20quote' },
			{ title: 'Call Ana', url: 'tel:+40712345678' },
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

	test('only a missing message and title, or a bad idempotency key, fail before any request', async () => {
		const { calls, result } = run({ params: { ...base, message: ' ', title: '' } });
		await assert.rejects(result, (err) => {
			assert.ok(err instanceof NodeOperationError);
			assert.match(err.message, /Invalid message: Set a Message or a Title/);
			return true;
		});
		assert.equal(calls.length, 0);
		const bad = run({ params: { ...base, options: { idempotencyKey: 'has space' } } });
		await assert.rejects(bad.result, /idempotency key must be 1–128/);
	});

	test('field contents go to the server as given; a title alone is enough', async () => {
		const additionalFields = { url: 'http://insecure.example', actions: { values: [{ title: 'Open', url: 'javascript:alert(1)' }] } };
		const { calls, result } = run({ params: { ...base, message: '', title: 'Disk 91% full', additionalFields } });
		await result;
		assert.deepEqual(calls[0].options.body, {
			title: 'Disk 91% full',
			severity: 'warning',
			url: 'http://insecure.example',
			actions: [{ title: 'Open', url: 'javascript:alert(1)' }],
		});
	});

	test('the server warnings are in the output and shown as an execution hint', async () => {
		const warnings = [
			{ field: 'url', code: 'ignored', message: 'must be an https link; left out' },
			{ field: 'actions[0].url', code: 'ignored', message: 'not an https, mailto, tel or sms link; left out' },
		];
		const items = [{ json: {} }, { json: {} }];
		const { ctx, calls } = fakeContext({ items, params: base, responses: [{ ...accepted('msg_1'), body: { ...accepted('msg_1').body, warnings } }, accepted('msg_2')] });
		const hints = [];
		ctx.addExecutionHints = (...h) => hints.push(...h);
		const [out] = await new Honk().execute.call(ctx);
		assert.equal(calls.length, 2);
		assert.deepEqual(out[0].json.warnings, warnings);
		assert.equal(out[0].json.id, 'msg_1');
		assert.deepEqual(out[1].json.warnings, []);
		assert.deepEqual(hints, [
			{
				type: 'warning',
				location: 'outputPane',
				message:
					'Honk! Honk! accepted item 1 and corrected it:\nurl ignored: must be an https link; left out\nactions[0].url ignored: not an https, mailto, tel or sms link; left out',
			},
		]);
	});

	test('without execution hints (older n8n), the warnings are still in the output', async () => {
		const warnings = [{ field: 'title', code: 'truncated', message: 'shortened' }];
		const { result } = run({ params: base, responses: [{ ...accepted('msg_1'), body: { ...accepted('msg_1').body, warnings } }] });
		const [out] = await result;
		assert.deepEqual(out[0].json.warnings, warnings);
	});

	for (const [response, message, httpCode] of [
		[apiError(422, 'validation_failed', 'Invalid', { fields: [{ field: 'event_type', code: 'invalid_enum', message: 'must be one of event, problem, recovery' }] }), 'Honk! Honk! rejected the message', '422'],
		[apiError(401, 'invalid_key'), 'The Honk! Honk! ingestion key is invalid or revoked', '401'],
		[apiError(403, 'workspace_suspended'), 'Honk! Honk! does not accept messages for this project right now', '403'],
		[apiError(404, 'not_found'), 'No Honk! Honk! server at this URL', '404'],
		[apiError(409, 'idempotency_conflict'), 'This idempotency key was already used with a different message', '409'],
		[apiError(429, 'quota_exceeded', 'quota', {}, { 'retry-after': '3600' }), 'The daily message quota of this Honk! Honk! workspace is used up', '429'],
		[{ statusCode: 502, headers: {}, body: '<html>Bad gateway</html>' }, 'Honk! Honk! is temporarily unavailable (HTTP 502)', '502'],
	]) {
		test(`HTTP ${response.statusCode} ${response.body.error?.code ?? ''} becomes a readable NodeApiError`, async () => {
			const { result } = run({ params: base, responses: [response] });
			await assert.rejects(result, (err) => {
				assert.ok(err instanceof NodeApiError, String(err));
				assert.equal(err.message, message);
				assert.equal(err.httpCode, httpCode);
				if (httpCode === '422') assert.equal(err.description, 'validation_failed: Invalid\nevent_type: must be one of event, problem, recovery (request req_test)');
				if (httpCode !== '502') assert.match(err.description, /\(request req_test\)$/);
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
				assert.match(err.message, /Could not reach Honk! Honk!|refused the connection/);
				assert.match(err.description, /Check the server URL in the Honk! Honk! API credential/);
				return true;
			});
		}
	});

	test('Continue On Fail turns a failed item into an error item and goes on', async () => {
		const items = [{ json: {} }, { json: {} }, { json: {} }];
		const params = [base, { ...base, message: '', title: '' }, base];
		const { calls, result } = run({ items, params, continueOnFail: true, responses: [apiError(401, 'invalid_key'), accepted('msg_3')] });
		const [out] = await result;
		assert.equal(calls.length, 2, 'the invalid item sends nothing');
		assert.equal(out.length, 3);
		assert.equal(out[0].json.error, 'The Honk! Honk! ingestion key is invalid or revoked');
		assert.equal(out[0].json.httpCode, '401');
		assert.equal(out[0].json.idempotencyKey, 'n8n-42-node-1-0');
		assert.match(out[1].json.error, /Set a Message or a Title/);
		assert.deepEqual(out[2], { json: { ...accepted('msg_3').body, warnings: [] }, pairedItem: { item: 2 } });
		assert.deepEqual(out.map((o) => o.pairedItem), [{ item: 0 }, { item: 1 }, { item: 2 }]);
	});
});
