// The credential test against a real Honk server (HONK_URL, HONK_KEY): the same request n8n's
// "Test" button sends, judged by the same rules. It never stores a message: Honk checks the key
// and then rejects the empty body. Skipped without HONK_URL / HONK_KEY.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HonkApi, credentialVerdict } from './helpers.mjs';

const url = process.env.HONK_URL;
const key = process.env.HONK_KEY;
const skip = !url || !key ? 'HONK_URL / HONK_KEY not set' : false;

async function probe(apiKey) {
	const { request } = new HonkApi().test;
	const res = await fetch(`${url.replace(/\/+$/, '')}${request.url}`, {
		method: request.method,
		headers: { ...request.headers, Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify(request.body),
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body };
}

test('a valid key passes without storing anything (422 message required)', { skip }, async () => {
	const { status, body } = await probe(key);
	assert.equal(status, 422);
	assert.equal(body.error.code, 'validation_failed');
	assert.deepEqual(body.error.fields.map((f) => [f.field, f.code]), [['message', 'required']]);
	assert.equal(credentialVerdict(new HonkApi().test, body).status, 'OK');
});

test('a wrong key fails with a clear message', { skip }, async () => {
	const { status, body } = await probe('honk_000000000000_00000000000000000000000000000000');
	assert.equal(status, 401);
	const verdict = credentialVerdict(new HonkApi().test, body);
	assert.equal(verdict.status, 'Error');
	assert.match(verdict.message, /Invalid or revoked ingestion key/);
});
