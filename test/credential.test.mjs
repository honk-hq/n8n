import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { HonkApi, credentialVerdict } from './helpers.mjs';

describe('Honk API credential', () => {
	const cred = new HonkApi();

	test('fields: server URL with a default, the key as a password', () => {
		assert.equal(cred.name, 'honkApi');
		const url = cred.properties.find((p) => p.name === 'url');
		const key = cred.properties.find((p) => p.name === 'apiKey');
		assert.equal(url.default, 'https://honk-me.app');
		assert.deepEqual(key.typeOptions, { password: true });
		assert.deepEqual(cred.authenticate.properties.headers, { Authorization: '=Bearer {{$credentials.apiKey}}' });
	});

	test('the test posts an empty object to the ingestion endpoint and reads any status', () => {
		assert.deepEqual(cred.test.request, {
			baseURL: '={{$credentials.url}}',
			url: '/v1/messages',
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: {},
			json: true,
			ignoreHttpStatusErrors: true,
		});
	});

	test('a valid key (422 "message is required") passes; nothing else does', () => {
		const answer = (code, extra = {}) => ({ error: { code, message: 'x', ...extra } });
		const ok = [
			answer('validation_failed', { fields: [{ field: 'message', code: 'required' }] }),
			answer('rate_limited'), // checked after the key: the key is valid
			answer('overloaded'),
		];
		for (const body of ok) assert.equal(credentialVerdict(cred.test, body).status, 'OK', JSON.stringify(body));
		const failing = [
			[answer('invalid_key'), /Invalid or revoked ingestion key/],
			[answer('project_suspended'), /suspended for its project/],
			[answer('workspace_suspended'), /workspace is suspended/],
			[answer('not_found'), /No Honk server at this URL/],
			[answer('unavailable'), /temporarily unavailable/],
			['<!doctype html><title>Some other site</title>', /did not answer like a Honk server/],
			[{ status: 'ok' }, /did not answer like a Honk server/],
		];
		for (const [body, message] of failing) {
			const verdict = credentialVerdict(cred.test, body);
			assert.equal(verdict.status, 'Error', JSON.stringify(body));
			assert.match(verdict.message, message);
		}
	});
});
