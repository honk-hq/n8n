import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class HonkApi implements ICredentialType {
	name = 'honkApi';

	displayName = 'Honk API';

	icon: Icon = { light: 'file:../icons/honk.svg', dark: 'file:../icons/honk.dark.svg' };

	documentationUrl = 'https://github.com/honk-me/honk-n8n#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'url',
			type: 'string',
			default: 'https://honk-me.app',
			required: true,
			placeholder: 'e.g. https://honk-me.app',
			description: 'The base address of your Honk server',
		},
		{
			displayName: 'Ingestion Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'A project ingestion key (honk_…) from Project → Keys in Honk',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// An ingestion key may only call POST /v1/messages, so the test posts an empty object.
	// Honk checks the key first and then rejects the empty body (422 validation_failed,
	// "message is required"), so a valid key is proven and nothing is ever stored. The answer
	// is read whatever its status; these rules turn the other answers into clear errors.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.url}}',
			url: '/v1/messages',
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: {},
			json: true,
			ignoreHttpStatusErrors: true,
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'error.code',
					value: 'invalid_key',
					message: 'Invalid or revoked ingestion key. Create one under Project → Keys in Honk.',
				},
			},
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'error.code',
					value: 'project_suspended',
					message: 'The key is valid, but ingestion is suspended for its project.',
				},
			},
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'error.code',
					value: 'workspace_suspended',
					message: 'The key is valid, but its workspace is suspended.',
				},
			},
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'error.code',
					value: 'not_found',
					message: 'No Honk server at this URL. Use the base address, e.g. https://honk-me.app.',
				},
			},
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'error.code',
					value: 'unavailable',
					message: 'Honk is temporarily unavailable. Try again in a minute.',
				},
			},
			{
				// No Honk error envelope at all: not a Honk server (or a proxy page).
				type: 'responseSuccessBody',
				properties: {
					key: 'error.code',
					value: undefined,
					message: 'This URL did not answer like a Honk server. Use the base address, e.g. https://honk-me.app.',
				},
			},
		],
	};
}
