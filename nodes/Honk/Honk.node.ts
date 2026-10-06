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
	type SendInput,
	validIdempotencyKey,
} from './request';

interface FullResponse {
	statusCode: number;
	headers?: Record<string, unknown>;
	body: unknown;
}

export class Honk implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Honk',
		name: 'honk',
		icon: { light: 'file:../../icons/honk.svg', dark: 'file:../../icons/honk.dark.svg' },
		group: ['output'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send messages to your Honk inbox and phone',
		defaults: {
			name: 'Honk',
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
						description: 'Send a message to your Honk inbox; it pushes to your phone',
					},
				],
				default: 'send',
			},
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				required: true,
				typeOptions: { rows: 4 },
				default: '',
				placeholder: 'e.g. Ana asked for a quote: 3 rooms, 2 bathrooms',
				description: 'The text of the message, up to 8192 bytes. Line breaks are kept.',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
			},
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				placeholder: 'e.g. New quote request',
				description: 'One line, up to 160 characters. Leave empty to use the first line of the message.',
				displayOptions: { show: { resource: ['message'], operation: ['send'] } },
			},
			{
				displayName: 'Severity',
				name: 'severity',
				type: 'options',
				options: [
					{ name: 'Beep-Beep (Success)', value: 'success', description: 'Something finished well' },
					{ name: 'Blast (Critical)', value: 'critical', description: 'Act now; pushes at least as high priority' },
					{ name: 'Light Honk (Info)', value: 'info', description: 'A quiet note' },
					{ name: 'Long Honk (Error)', value: 'error', description: 'Something failed; pushes at least as high priority' },
					{ name: 'Loud Honk (Warning)', value: 'warning', description: 'Needs attention soon' },
				],
				default: 'info',
				description: 'How serious the event is, on the Honk scale',
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
							'Up to 3 buttons on the message, in this order; the first is the main one. Honk opens a link only when you tap its button.',
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
										placeholder: 'e.g. mailto:ana@example.com',
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
						description: 'Problems and recoveries need a group key',
					},
					{
						displayName: 'Group Key',
						name: 'groupKey',
						type: 'string',
						default: '',
						placeholder: 'e.g. requests/4812',
						description:
							'Messages with the same group key form one group: the first one pushes, repeats update it calmly. Use one key per request, a shared key only for repeats of the same problem. Up to 128 characters.',
					},
					{
						displayName: 'Image URL',
						name: 'imageUrl',
						type: 'string',
						default: '',
						placeholder: 'e.g. https://example.com/image.png',
						description: 'An https image Honk shows with the notification',
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
							{ name: 'Urgent', value: 'urgent', description: 'Needs a key that allows urgent' },
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
							'A stable key for this event (1–128 printable ASCII characters). Honk accepts a key once in 24 hours, so a repeated run never notifies twice. Default: built from the execution ID, this node and the item.',
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

		for (let i = 0; i < items.length; i++) {
			const options = this.getNodeParameter('options', i, {}) as IDataObject;
			const customKey = typeof options.idempotencyKey === 'string' ? options.idempotencyKey.trim() : '';
			const idempotencyKey = customKey || defaultIdempotencyKey(this.getExecutionId(), this.getNode().id, i);
			try {
				const input: SendInput = {
					message: this.getNodeParameter('message', i) as string,
					title: this.getNodeParameter('title', i, '') as string,
					severity: this.getNodeParameter('severity', i, 'info') as string,
					additionalFields: this.getNodeParameter('additionalFields', i, {}) as SendInput['additionalFields'],
				};
				const body = buildMessage(input);
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
						message: 'Could not reach Honk',
						description: `${(error as Error).message}. Check the server URL in the Honk API credential.`,
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
				returnData.push({ json: response.body as IDataObject, pairedItem: { item: i } });
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
