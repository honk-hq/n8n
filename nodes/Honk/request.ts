// Builds the request for POST /v1/messages and reads the answer. Pure functions with no n8n or
// network access, so they are unit-tested directly (test/request.test.mjs).
//
// Field contents are not checked here: the server delivers first, corrects what it can and
// lists each correction in the 202's `warnings`, which the node outputs. Only what the server
// would refuse outright and is cheap to see is checked before sending: a message or a title,
// and the 16 KiB body.

export const DEFAULT_URL = 'https://honk-honk.app';

const MAX_BODY_BYTES = 16 * 1024;

export type MetadataValue = string | number | boolean;

/** A button on the message (contracts/API.md §13). */
export interface Action {
	title: string;
	url: string;
}

/** The node's parameters for one item, as n8n returns them. */
export interface SendInput {
	message: string;
	title?: string;
	severity?: string;
	additionalFields?: {
		actions?: { values?: Array<{ title?: unknown; url?: unknown }> };
		category?: string;
		channel?: string;
		environment?: string;
		eventType?: string;
		groupKey?: string;
		imageUrl?: string;
		metadata?: { values?: Array<{ key?: string; value?: unknown }> };
		occurredAt?: string;
		priority?: string;
		source?: string;
		url?: string;
	};
}

/** The JSON body of POST /v1/messages (snake_case, as in contracts/openapi.yaml). */
export interface MessageBody {
	message?: string;
	title?: string;
	severity?: string;
	priority?: string;
	category?: string;
	source?: string;
	environment?: string;
	channel?: string;
	group_key?: string;
	event_type?: string;
	occurred_at?: string;
	url?: string;
	image_url?: string;
	metadata?: Record<string, MetadataValue>;
	actions?: Action[];
}

export interface FieldProblem {
	field: string;
	code: string;
	message: string;
}

function text(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s === '' ? undefined : s;
}

function metadataValue(value: unknown): MetadataValue {
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	return value === undefined || value === null ? '' : String(value);
}

/**
 * The request body for one item. Empty optional fields are left out, so the server defaults
 * apply (severity info, priority normal, source "api", environment "default", channel
 * "general"). The message text is kept as typed (line breaks matter); other text is trimmed.
 */
export function buildMessage(input: SendInput): MessageBody {
	const f = input.additionalFields ?? {};
	const body: MessageBody = {};
	const message = input.message === undefined || input.message === null ? '' : String(input.message);
	if (message.trim() !== '') body.message = message;
	const set = (key: keyof MessageBody, value: unknown) => {
		const v = text(value);
		if (v !== undefined) (body as unknown as Record<string, unknown>)[key] = v;
	};
	set('title', input.title);
	set('severity', input.severity);
	set('priority', f.priority);
	set('category', f.category);
	set('source', f.source);
	set('environment', f.environment);
	set('channel', f.channel);
	set('group_key', f.groupKey);
	set('event_type', f.eventType);
	set('url', f.url);
	set('image_url', f.imageUrl);
	const occurredAt = text(f.occurredAt);
	if (occurredAt !== undefined) {
		const t = new Date(occurredAt);
		// An unparseable date is sent as typed; the server leaves it out with a warning.
		body.occurred_at = Number.isNaN(t.getTime()) ? occurredAt : t.toISOString();
	}
	const entries = f.metadata?.values ?? [];
	if (entries.length > 0) {
		const metadata: Record<string, MetadataValue> = {};
		for (const entry of entries) {
			const key = text(entry.key);
			if (key !== undefined) metadata[key] = metadataValue(entry.value);
		}
		if (Object.keys(metadata).length > 0) body.metadata = metadata;
	}
	// Rows left completely empty are skipped; the server leaves out a half-filled one with a warning.
	const actions: Action[] = [];
	for (const entry of f.actions?.values ?? []) {
		const title = text(entry.title) ?? '';
		const url = text(entry.url) ?? '';
		if (title !== '' || url !== '') actions.push({ title, url });
	}
	if (actions.length > 0) body.actions = actions;
	return body;
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** What the server would refuse outright: no message and no title, or a body over 16 KiB. */
export function checkMessage(body: MessageBody): FieldProblem[] {
	if (body.message === undefined && body.title === undefined) {
		return [{ field: 'message', code: 'required', message: 'Set a Message or a Title' }];
	}
	const size = utf8Bytes(JSON.stringify(body));
	if (size > MAX_BODY_BYTES) {
		return [{ field: 'body', code: 'too_long', message: `The message is ${size} bytes as JSON; Honk! Honk! accepts at most 16 KiB` }];
	}
	return [];
}

/** 1–128 printable ASCII characters (0x21–0x7E): a header the HTTP client can send and the server accepts. */
export function validIdempotencyKey(key: string): boolean {
	return /^[\x21-\x7e]{1,128}$/.test(key);
}

/**
 * The default Idempotency-Key: the same execution, node and item always give the same key, so
 * n8n's Retry On Fail (and any retry of this request) never notifies twice. A different node or
 * item gives a different key.
 */
export function defaultIdempotencyKey(executionId: string | undefined, nodeId: string | undefined, itemIndex: number): string {
	const clean = (s: string | undefined) => (s ?? '').replace(/[^\x21-\x7e]/g, '_') || 'none';
	return `n8n-${clean(executionId)}-${clean(nodeId)}-${itemIndex}`.slice(0, 128);
}

/** The credential's server URL as a base address (no trailing slash or /v1/messages). */
export function baseUrl(url: unknown): string {
	let u = text(url) ?? DEFAULT_URL;
	u = u.replace(/\/+$/, '');
	if (u.endsWith('/v1/messages')) u = u.slice(0, -'/v1/messages'.length);
	return u.replace(/\/+$/, '');
}

export interface ApiErrorBody {
	error?: {
		code?: string;
		message?: string;
		request_id?: string;
		fields?: Array<{ field?: string; code?: string; message?: string }>;
	};
}

/** A readable message and description for a non-2xx answer from Honk. */
export function describeApiError(
	status: number,
	body: unknown,
	headers: Record<string, unknown> = {},
): { message: string; description: string; code: string } {
	const err = (typeof body === 'object' && body !== null ? (body as ApiErrorBody).error : undefined) ?? {};
	const code = err.code ?? '';
	const serverMessage = err.message ?? (typeof body === 'string' ? body.trim().slice(0, 200) : '');
	const header = (name: string) => {
		const found = Object.keys(headers).find((k) => k.toLowerCase() === name);
		const v = found === undefined ? undefined : headers[found];
		return Array.isArray(v) ? String(v[0]) : v === undefined || v === null ? undefined : String(v);
	};
	const retryAfter = header('retry-after');
	const id = err.request_id ?? header('x-request-id');
	const requestId = id ? ` (request ${id})` : '';
	const fields = (err.fields ?? []).map((f) => `${f.field ?? '?'}: ${f.message || f.code || 'invalid'}`);

	if ([400, 413, 415, 422].includes(status)) {
		const lines = [`${code || 'validation_failed'}: ${serverMessage || `HTTP ${status}`}`, ...fields];
		return {
			code: code || 'validation_failed',
			message: 'Honk! Honk! rejected the message',
			description: lines.join('\n') + requestId,
		};
	}
	if (status === 401) {
		return {
			code: code || 'invalid_key',
			message: 'The Honk! Honk! ingestion key is invalid or revoked',
			description: `Check the Honk! Honk! API credential: use a project ingestion key (honk_…) from Project → Keys in Honk! Honk!${requestId}`,
		};
	}
	if (status === 403) {
		return {
			code: code || 'forbidden',
			message: 'Honk! Honk! does not accept messages for this project right now',
			description: `${serverMessage || 'Forbidden'} (${code || 'HTTP 403'}). Check the project and workspace in Honk! Honk!${requestId}`,
		};
	}
	if (status === 404) {
		return {
			code: code || 'not_found',
			message: 'No Honk! Honk! server at this URL',
			description: `Use the base address of your Honk! Honk! server in the credential, e.g. https://honk-honk.app.${requestId}`,
		};
	}
	if (status === 409) {
		return {
			code: code || 'idempotency_conflict',
			message: 'This idempotency key was already used with a different message',
			description:
				`Honk! Honk! keeps idempotency keys for 24 hours. Send the original message again, or set a new key under Options → Idempotency Key.${requestId}`,
		};
	}
	if (status === 429) {
		const wait = retryAfter ? ` Try again in ${retryAfter} s.` : '';
		if (code === 'quota_exceeded') {
			return { code, message: 'The daily message quota of this Honk! Honk! workspace is used up', description: `It resets at midnight UTC.${wait}${requestId}` };
		}
		return {
			code: code || 'rate_limited',
			message: 'Honk! Honk! asked to slow down',
			description: `${serverMessage || 'Too many requests'}.${wait} Settings → Retry On Fail retries safely with the same idempotency key.${requestId}`,
		};
	}
	if (status >= 300 && status < 400) {
		const location = header('location');
		return {
			code: code || 'redirect',
			message: 'Honk! Honk! answered with a redirect',
			description: `Use the final https address of your Honk! Honk! server in the credential${location ? ` (redirected to ${location})` : ''}.`,
		};
	}
	if (status >= 500) {
		return {
			code: code || 'server_error',
			message: `Honk! Honk! is temporarily unavailable (HTTP ${status})`,
			description: `${serverMessage || 'Server error'}. Settings → Retry On Fail retries safely with the same idempotency key.${requestId}`,
		};
	}
	return { code, message: `Unexpected answer from Honk! Honk! (HTTP ${status})`, description: serverMessage + requestId };
}

/** One correction the server made to an accepted message (the 202's `warnings`). */
export interface Warning {
	field: string;
	code: string;
	message: string;
}

/** The `warnings` of a 202, as sent; [] when there are none or the server is older. */
export function readWarnings(body: unknown): Warning[] {
	const raw = typeof body === 'object' && body !== null ? (body as { warnings?: unknown }).warnings : undefined;
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null)
		.map((w) => ({ field: String(w.field ?? ''), code: String(w.code ?? ''), message: String(w.message ?? '') }));
}

/** One line per warning, for the execution hint: "title truncated: longer than 160 characters". */
export function describeWarnings(warnings: Warning[]): string {
	return warnings.map((w) => `${w.field} ${w.code}${w.message ? `: ${w.message}` : ''}`).join('\n');
}
