import { z } from 'zod';

// Validate only fields consumed by the calendar. Other profile fields can vary
// between account types and upstream API versions.
const UserSchema = z.object({
	associatedStudent: z.object({ id: z.number().int().positive() }).nullish(),
});
const LoginResponseSchema = z.object({
	user: UserSchema,
	jwt: z.string().min(1),
});

export type User = z.infer<typeof UserSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export class LoginError extends Error {
	constructor(message: string, public readonly status: number) {
		super(message);
		this.name = 'LoginError';
	}
}

export default async function fetchLogin(username: string, password: string): Promise<LoginResponse> {
	let response: Response;
	try {
		response = await fetch('https://login.schulmanager-online.de/api/login', {
			method: 'POST',
			headers: {
				accept: 'application/json, text/plain, */*',
				'content-type': 'application/json',
				origin: 'https://login.schulmanager-online.de',
				referer: 'https://login.schulmanager-online.de/',
			},
			body: JSON.stringify({ emailOrUsername: username, password, mobileApp: false, institutionId: null }),
		});
	} catch {
		throw new LoginError('Login service unavailable', 502);
	}

	if (response.status === 401 || response.status === 403) {
		throw new LoginError('Login failed', 401);
	}
	if (!response.ok) {
		console.error('Login service returned an HTTP error', { status: response.status });
		throw new LoginError('Login service unavailable', 502);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new LoginError('Invalid response from login service', 502);
	}
	const result = LoginResponseSchema.safeParse(data);
	if (!result.success) {
		// Log schema paths and codes, never credentials, tokens, or response values.
		console.error('Invalid login response schema', result.error.issues.map(({ path, code }) => ({ path, code })));
		throw new LoginError('Invalid response from login service', 502);
	}
	return result.data;
}
