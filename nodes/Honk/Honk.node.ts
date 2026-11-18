import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	baseUrl,
	buildMessage,
	checkMessage,
	defaultIdempotencyKey,
	describeApiError,
	describeWarnings,
	inputHash,
	readWarnings,
	type SendInput,
	validIdempotencyKey,
} from './request';

/** Which run of this node in the execution (0 for the first; loops run a node again). */
function currentRunIndex(ctx: IExecuteFunctions): number {
	// n8n's execute context has it as a public property; otherwise the data proxy's $runIndex.
	const own = (ctx as unknown as { runIndex?: unknown }).runIndex;
	if (typeof own === 'number') return own;
	try {
		const proxied = ctx.getWorkflowDataProxy(0).$runIndex as unknown;
		if (typeof proxied === 'number') return proxied;
	} catch {
		// No data proxy here: the first run.
	}
	return 0;
}

interface FullResponse {
	statusCode: number;
	headers?: Record<string, unknown>;
	body: unknown;
}

export class Honk implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Honk! Honk!',
		name: 'honk',
		icon: { light: 'file:../../icons/honk.svg', dark: 'file:../../icons/honk.dark.svg' },
		group: ['output'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send messages to your Honk! Honk! inbox and phone',
		defaults: {
			name: 'Honk! Honk!',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'honkApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Message', value: 'message' }],
				default: 'message',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{
						name: 'Send',
						value: 'send',
						action: 'Send message',
						description: 'Send a message to your Honk! Honk! inbox; it pushes to your phone',
					},
				],
				default: 'send',
			},
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				placeholder: 'e.g. Maria asked for a quote: 3 rooms, 2 bathrooms',
				description: 'The text of the message. Line breaks are kept. A message needs a Message, a Title or both.',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
			},
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				placeholder: 'e.g. New quote request',
				description: 'One line. Leave empty to use the first line of the message.',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
			},
			{
				displayName: 'Severity',
				name: 'severity',
				type: 'options',
				options: [
					{ name: 'Critical (Blast)', value: 'critical', description: 'Act now' },
					{ name: 'Error (Long)', value: 'error', description: 'Something failed' },
					{ name: 'Info (Light)', value: 'info', description: 'A quiet note' },
					{ name: 'Success (Beep)', value: 'success', description: 'Something finished well' },
					{ name: 'Warning (Loud)', value: 'warning', description: 'Needs attention soon' },
				],
				default: 'info',
				description: 'How serious the event is; the level alone decides how loudly the phone honks. Each level shows its Honk name in parentheses.',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
				options: [
					{
						displayName: 'Actions',
						name: 'actions',
						type: 'fixedCollection',
						typeOptions: { multipleValues: true },
						placeholder: 'Add Action',
						default: {},
						description:
							'Up to 3 buttons on the message, in this order; the first is the main one. Honk! Honk! opens a link only when you tap its button.',
						options: [
							{
								displayName: 'Action',
								name: 'values',
								values: [
									{
										displayName: 'Title',
										name: 'title',
										type: 'string',
										default: '',
										placeholder: 'e.g. Reply',
										description: 'The button label: one line, up to 40 characters',
									},
									{
										displayName: 'URL',
										name: 'url',
										type: 'string',
										default: '',
										placeholder: 'e.g. mailto:maria@example.com',
										description:
											'What the button opens: an https:// link, mailto: one email address (optionally with ?subject= and &body=), or tel: or sms: a phone number such as +15550134. No spaces.',
									},
								],
							},
						],
					},
					{
						displayName: 'Category',
						name: 'category',
						type: 'options',
						options: [
							{ name: 'Automation', value: 'automation' },
							{ name: 'Backups', value: 'backups' },
							{ name: 'Customers', value: 'customers' },
							{ name: 'Deployments', value: 'deployments' },
							{ name: 'Infrastructure', value: 'infrastructure' },
							{ name: 'Other', value: 'other' },
							{ name: 'Payments', value: 'payments' },
							{ name: 'Personal', value: 'personal' },
							{ name: 'Sales', value: 'sales' },
							{ name: 'Security', value: 'security' },
						],
						default: 'other',
					},
					{
						displayName: 'Channel',
						name: 'channel',
						type: 'string',
						default: '',
						placeholder: 'e.g. payments',
						description: 'Up to 64 characters. Default: general.',
					},
					{
						displayName: 'Environment',
						name: 'environment',
						type: 'string',
						default: '',
						placeholder: 'e.g. production',
						description: 'Up to 32 characters. Default: default.',
					},
					{
						displayName: 'Event Type',
						name: 'eventType',
						type: 'options',
						options: [
							{ name: 'Event', value: 'event', description: 'Something happened' },
							{ name: 'Problem', value: 'problem', description: 'Opens or continues an incident for the group' },
							{ name: 'Recovery', value: 'recovery', description: 'Closes the open incident of the group' },
						],
						default: 'event',
						description: 'A problem opens an incident for its group, a recovery closes it',
					},
					{
						displayName: 'Group Key',
						name: 'groupKey',
						type: 'string',
						default: '',
						placeholder: 'e.g. requests/4812',
						description:
							'Messages with the same group key form one group: the first one pushes, repeats update it calmly. Use one key per request, a shared key only for repeats of the same problem. Without a key, messages group by their title.',
					},
					{
						displayName: 'Image URL',
						name: 'imageUrl',
						type: 'string',
						default: '',
						placeholder: 'e.g. https://example.com/image.png',
						description: 'An https image that Honk! Honk! shows with the notification',
					},
					{
						displayName: 'Metadata',
						name: 'metadata',
						type: 'fixedCollection',
						typeOptions: { multipleValues: true },
						placeholder: 'Add Metadata Field',
						default: {},
						description: 'Up to 16 fields shown with the message',
						options: [
							{
								displayName: 'Field',
								name: 'values',
								values: [
									{
										displayName: 'Name',
										name: 'key',
										type: 'string',
										default: '',
										placeholder: 'e.g. order_id',
										description: 'Letters, digits, _ . and - (up to 64).',
									},
									{
										displayName: 'Value',
										name: 'value',
										type: 'string',
										default: '',
										description: 'Up to 512 characters. Numbers and booleans from expressions are kept as they are.',
									},
								],
							},
						],
					},
					{
						displayName: 'Occurred At',
						name: 'occurredAt',
						type: 'dateTime',
						default: '',
						description: 'When it happened at the source (informational)',
					},
					{
						displayName: 'Priority',
						name: 'priority',
						type: 'options',
						options: [
							{ name: 'High', value: 'high' },
							{ name: 'Low', value: 'low' },
							{ name: 'Normal', value: 'normal' },
							{ name: 'Urgent', value: 'urgent', description: 'Sent as High unless the key allows urgent' },
						],
						default: 'normal',
					},
					{
						displayName: 'Source',
						name: 'source',
						type: 'string',
						default: '',
						placeholder: 'e.g. n8n',
						description: 'Up to 64 characters. Default: api.',
					},
					{
						displayName: 'Source Sequence',
						name: 'sourceSequence',
						type: 'number',
						typeOptions: { minValue: 0, numberPrecision: 0 },
						default: 0,
						description:
							'A number that grows with each message of the same source stream (0 to 2^53−1), e.g. a check counter or a timestamp in milliseconds. An older recovery then never closes a newer problem.',
					},
					{
						displayName: 'TTL Seconds',
						name: 'ttlSeconds',
						type: 'number',
						typeOptions: { minValue: 60, maxValue: 86400, numberPrecision: 0 },
						default: 3600,
						description:
							'How long the push may wait for an offline phone, in seconds: 60 to 86400, default 3600. It does not change how long the message stays in the inbox.',
					},
					{
						displayName: 'URL',
						name: 'url',
						type: 'string',
						default: '',
						placeholder: 'e.g. https://example.com/admin/requests/4812',
						description: 'An https link shown as "Open link" on the message',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
				options: [
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						placeholder: 'e.g. request-4812',
						description:
							'A stable key for this event (1–128 printable ASCII characters). Honk! Honk! accepts a key once in 24 hours, so a repeated run never notifies twice. Default: built from the execution ID, this node, its run and the item; for an AI-agent tool call, from the input of the tool call instead of the run.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('honkApi');
		const endpoint = `${baseUrl(credentials.url)}/v1/messages`;
		const runIndex = currentRunIndex(this);
		const isToolCall = typeof this.isToolExecution === 'function' && this.isToolExecution();
		const timezone = typeof this.getTimezone === 'function' ? this.getTimezone() : undefined;

		for (let i = 0; i < items.length; i++) {
			const options = this.getNodeParameter('options', i, {}) as IDataObject;
			const customKey = typeof options.idempotencyKey === 'string' ? options.idempotencyKey.trim() : '';
			const idempotencyKey =
				customKey ||
				defaultIdempotencyKey({
					executionId: this.getExecutionId(),
					nodeId: this.getNode().id,
					runIndex,
					itemIndex: i,
					toolInputHash: isToolCall ? inputHash(items[i]?.json) : undefined,
				});
			try {
				const input: SendInput = {
					message: this.getNodeParameter('message', i) as string,
					title: this.getNodeParameter('title', i, '') as string,
					severity: this.getNodeParameter('severity', i, 'info') as string,
					additionalFields: this.getNodeParameter('additionalFields', i, {}) as SendInput['additionalFields'],
				};
				const body = buildMessage(input, timezone);
				const problems = checkMessage(body);
				if (!validIdempotencyKey(idempotencyKey)) {
					problems.push({
						field: 'Idempotency-Key',
						code: 'invalid_format',
						message: 'The idempotency key must be 1–128 printable ASCII characters without spaces',
					});
				}
				if (problems.length > 0) {
					throw new NodeOperationError(this.getNode(), `Invalid message: ${problems[0].message}`, {
						itemIndex: i,
						description: problems.map((p) => `${p.field}: ${p.message}`).join('\n'),
					});
				}

				const request: IHttpRequestOptions = {
					method: 'POST',
					url: endpoint,
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json',
						'Idempotency-Key': idempotencyKey,
					},
					body,
					json: true,
					returnFullResponse: true,
					ignoreHttpStatusErrors: true,
				};
				let response: FullResponse;
				try {
					response = (await this.helpers.httpRequestWithAuthentication.call(this, 'honkApi', request)) as FullResponse;
				} catch (error) {
					throw new NodeApiError(this.getNode(), error as JsonObject, {
						itemIndex: i,
						message: 'Could not reach Honk! Honk!',
						description: `${(error as Error).message}. Check the server URL in the Honk! Honk! API credential.`,
					});
				}
				if (response.statusCode < 200 || response.statusCode >= 300) {
					const described = describeApiError(response.statusCode, response.body, response.headers);
					throw new NodeApiError(this.getNode(), (response.body ?? {}) as JsonObject, {
						itemIndex: i,
						httpCode: String(response.statusCode),
						message: described.message,
						description: described.description,
					});
				}
				// The API's answer, with `warnings` always present: what the server corrected.
				const warnings = readWarnings(response.body);
				if (warnings.length > 0 && typeof this.addExecutionHints === 'function') {
					this.addExecutionHints({
						type: 'warning',
						location: 'outputPane',
						message: `Honk! Honk! accepted item ${i + 1} and corrected it:\n${describeWarnings(warnings)}`,
					});
				}
				returnData.push({
					json: { ...(response.body as IDataObject), warnings: warnings as unknown as IDataObject[] },
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: (error as Error).message,
							description: (error as NodeApiError).description ?? null,
							httpCode: (error as NodeApiError).httpCode ?? null,
							idempotencyKey,
						},
						pairedItem: { item: i },
					});
					continue;
				}
				// Always an n8n error: ours as they are, anything unexpected wrapped.
				const failure =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				throw failure;
			}
		}
		return [returnData];
	}
}
