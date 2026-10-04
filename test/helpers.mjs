// Loads the built package (CommonJS in dist/) and fakes the parts of n8n the node uses.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { Honk } = require('../dist/nodes/Honk/Honk.node.js');
export const { HonkApi } = require('../dist/credentials/HonkApi.credentials.js');
export const request = require('../dist/nodes/Honk/request.js');
export const { NodeApiError, NodeOperationError } = require('n8n-workflow');

export const KEY = 'honk_ab12cd34ef56_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

export const accepted = (id = 'msg_1', duplicate = false) => ({
	statusCode: 202,
	headers: { 'content-type': 'application/json' },
	body: { id, status: 'accepted', duplicate, received_at: '2026-10-04T12:20:05.123Z' },
});

export const apiError = (statusCode, code, message = 'nope', extra = {}, headers = {}) => ({
	statusCode,
	headers,
	body: { error: { code, message, request_id: 'req_test', ...extra } },
});

/** An IExecuteFunctions stand-in. `params` is one object per item (or one for all). */
export function fakeContext({ items = [{ json: {} }], params, credentials, responses = [], continueOnFail = false, executionId = '42', nodeId = 'node-1' }) {
	const calls = [];
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name, i, fallback) => {
			const p = Array.isArray(params) ? params[i] : params;
			if (p[name] === undefined) {
				if (fallback === undefined) throw new Error(`missing parameter ${name}`);
				return fallback;
			}
			return p[name];
		},
		getCredentials: async () => credentials ?? { url: 'https://honk.example.com', apiKey: KEY },
		getExecutionId: () => executionId,
		getNode: () => ({ id: nodeId, name: 'Honk', type: 'n8n-nodes-honk.honk', typeVersion: 1, position: [0, 0], parameters: {} }),
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async (credentialName, options) => {
				calls.push({ credentialName, options });
				const next = responses.shift() ?? accepted();
				if (next instanceof Error) throw next;
				return next;
			},
		},
	};
	return { ctx, calls };
}

/** n8n's credential tester for request-based tests: the first matching rule is the error. */
export function credentialVerdict(test, responseBody) {
	const get = (obj, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
	for (const rule of test.rules ?? []) {
		if (rule.type === 'responseSuccessBody' && get(responseBody, rule.properties.key) === rule.properties.value) {
			return { status: 'Error', message: rule.properties.message };
		}
	}
	return { status: 'OK', message: 'Connection successful!' };
}
