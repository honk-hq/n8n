// Builds and checks the request for POST /v1/messages. Pure functions with no n8n or network
// access, so they are unit-tested directly (test/request.test.mjs).
//
// The checks are light and mirror the API's rules (required message, lengths, https links,
// metadata shape); the server stays authoritative and reports anything else as field errors.

export const DEFAULT_URL = 'https://honk-me.app';

export const SEVERITIES = ['info', 'success', 'warning', 'error', 'critical'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const EVENT_TYPES = ['event', 'problem', 'recovery'] as const;
export const CATEGORIES = [
	'infrastructure',
	'security',
	'backups',
	'deployments',
	'payments',
	'customers',
	'sales',
	'automation',
	'personal',
	'other',
] as const;

const LIMITS = {
	bodyBytes: 16 * 1024,
	messageBytes: 8192,
	title: 160,
	source: 64,
	environment: 32,
	channel: 64,
	groupKey: 128,
	urlBytes: 2048,
	metadataKeys: 16,
	metadataString: 512,
};

export type MetadataValue = string | number | boolean;

/** The node's parameters for one item, as n8n returns them. */
export interface SendInput {
	message: string;
	title?: string;
	severity?: string;
	additionalFields?: {
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
	message: string;
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
	const body: MessageBody = { message: input.message === undefined || input.message === null ? '' : String(input.message) };
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
		// An unparseable date is sent as typed, so the server reports it on occurred_at.
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
	return body;
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
const chars = (s: string) => Array.from(s).length;
// Control characters (C0, DEL, C1) and the line/paragraph separators, like the server.
// Line breaks and tabs are allowed where `allowBreaks` is set.
function hasControl(value: string, allowBreaks: boolean): boolean {
	for (const ch of value) {
		const c = ch.codePointAt(0) ?? 0;
		if (allowBreaks && (c === 0x09 || c === 0x0a || c === 0x0d)) continue;
		if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
	}
	return false;
}

function httpsUrl(value: string, image: boolean): boolean {
	if (utf8Bytes(value) > LIMITS.urlBytes || /[\s\\]/.test(value) || hasControl(value, false)) return false;
	let u: URL;
	try {
		u = new URL(value);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:' || u.hostname === '' || u.username !== '' || u.password !== '') return false;
	return !(image && value.includes('#'));
}

/** The light checks: every problem at once, in the API's field names. */
export function checkMessage(body: MessageBody): FieldProblem[] {
	const problems: FieldProblem[] = [];
	const add = (field: string, code: string, message: string) => problems.push({ field, code, message });

	if (body.message === '') add('message', 'required', 'Message is required');
	else if (utf8Bytes(body.message) > LIMITS.messageBytes)
		add('message', 'too_long', `Message must be at most ${LIMITS.messageBytes} bytes (got ${utf8Bytes(body.message)})`);
	else if (body.message.trim() === '') add('message', 'too_short', 'Message must not be blank');
	else if (hasControl(body.message, true))
		add('message', 'invalid_format', 'Message must not contain control characters other than line breaks and tabs');

	const short: Array<[keyof MessageBody, string, number]> = [
		['title', 'Title', LIMITS.title],
		['source', 'Source', LIMITS.source],
		['environment', 'Environment', LIMITS.environment],
		['channel', 'Channel', LIMITS.channel],
		['group_key', 'Group Key', LIMITS.groupKey],
	];
	for (const [field, label, max] of short) {
		const v = body[field] as string | undefined;
		if (v === undefined) continue;
		if (chars(v) > max) add(field, 'too_long', `${label} must be at most ${max} characters`);
		else if (hasControl(v, false)) add(field, 'invalid_format', `${label} must be one line without control characters`);
	}
	const enums: Array<[keyof MessageBody, readonly string[]]> = [
		['severity', SEVERITIES],
		['priority', PRIORITIES],
		['event_type', EVENT_TYPES],
		['category', CATEGORIES],
	];
	for (const [field, allowed] of enums) {
		const v = body[field] as string | undefined;
		if (v !== undefined && !allowed.includes(v)) add(field, 'invalid_enum', `Must be one of ${allowed.join(', ')}`);
	}
	if (body.event_type === 'recovery' && body.group_key === undefined)
		add('group_key', 'requires_group_key', 'A recovery needs a Group Key (the group whose problem it closes)');
	if (body.url !== undefined && !httpsUrl(body.url, false))
		add('url', 'invalid_format', 'URL must be an https:// link without credentials, at most 2048 bytes');
	if (body.image_url !== undefined && !httpsUrl(body.image_url, true))
		add('image_url', 'invalid_format', 'Image URL must be an https:// link without credentials or #fragment, at most 2048 bytes');

	const metadata = body.metadata ?? {};
	const keys = Object.keys(metadata);
	if (keys.length > LIMITS.metadataKeys) add('metadata', 'too_long', `At most ${LIMITS.metadataKeys} metadata fields`);
	for (const key of keys) {
		if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) {
			add(`metadata.${key}`, 'invalid_format', 'Metadata names may use letters, digits, _ . and - (at most 64)');
			continue;
		}
		const v = metadata[key];
		if (typeof v === 'string' && (chars(v) > LIMITS.metadataString || hasControl(v, true)))
			add(`metadata.${key}`, 'invalid_format', `Metadata values must be at most ${LIMITS.metadataString} characters`);
		if (typeof v === 'number' && !Number.isFinite(v)) add(`metadata.${key}`, 'invalid_format', 'Numbers must be finite');
	}
	if (problems.length === 0) {
		const size = utf8Bytes(JSON.stringify(body));
		if (size > LIMITS.bodyBytes) add('body', 'too_long', `The message is ${size} bytes as JSON; Honk accepts at most 16 KiB`);
	}
	return problems;
}

/** 1–128 printable ASCII characters (0x21–0x7E). */
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
	const requestId = err.request_id ? ` (request ${err.request_id})` : '';
	const fields = (err.fields ?? []).map((f) => `${f.field ?? '?'}: ${f.message || f.code || 'invalid'}`);

	if ([400, 413, 415, 422].includes(status)) {
		return {
			code: code || 'validation_failed',
			message: 'Honk rejected the message',
			description: (fields.length > 0 ? fields.join('\n') : serverMessage || `HTTP ${status}`) + requestId,
		};
	}
	if (status === 401) {
		return {
			code: code || 'invalid_key',
			message: 'The Honk ingestion key is invalid or revoked',
			description: 'Check the Honk API credential: use a project ingestion key (honk_…) from Project → Keys in Honk.',
		};
	}
	if (status === 403) {
		if (code === 'priority_not_allowed') {
			return {
				code,
				message: 'This ingestion key may not send urgent messages',
				description: 'Choose another priority, or allow urgent for this key in Honk (Project → Keys).',
			};
		}
		return {
			code: code || 'forbidden',
			message: 'Honk does not accept messages for this project right now',
			description: `${serverMessage || 'Forbidden'} (${code || 'HTTP 403'}). Check the project and workspace in Honk.`,
		};
	}
	if (status === 404) {
		return {
			code: code || 'not_found',
			message: 'No Honk server at this URL',
			description: 'Use the base address of your Honk server in the credential, e.g. https://honk-me.app.',
		};
	}
	if (status === 409) {
		return {
			code: code || 'idempotency_conflict',
			message: 'This idempotency key was already used with a different message',
			description:
				'Honk keeps idempotency keys for 24 hours. Send the original message again, or set a new key under Options → Idempotency Key.',
		};
	}
	if (status === 429) {
		const wait = retryAfter ? ` Try again in ${retryAfter} s.` : '';
		if (code === 'quota_exceeded') {
			return { code, message: 'The daily message quota of this Honk workspace is used up', description: `It resets at midnight UTC.${wait}` };
		}
		return {
			code: code || 'rate_limited',
			message: 'Honk asked to slow down',
			description: `${serverMessage || 'Too many requests'}.${wait} Settings → Retry On Fail retries safely with the same idempotency key.`,
		};
	}
	if (status >= 300 && status < 400) {
		const location = header('location');
		return {
			code: code || 'redirect',
			message: 'Honk answered with a redirect',
			description: `Use the final https address of your Honk server in the credential${location ? ` (redirected to ${location})` : ''}.`,
		};
	}
	if (status >= 500) {
		return {
			code: code || 'server_error',
			message: `Honk is temporarily unavailable (HTTP ${status})`,
			description: `${serverMessage || 'Server error'}. Settings → Retry On Fail retries safely with the same idempotency key.${requestId}`,
		};
	}
	return { code, message: `Unexpected answer from Honk (HTTP ${status})`, description: serverMessage + requestId };
}
