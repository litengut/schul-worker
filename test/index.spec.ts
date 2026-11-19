import { env, createExecutionContext, SELF } from 'cloudflare:test';
import { afterEach, describe, it, expect, vi } from 'vitest';
import worker from '../src/index';
import fetchLogin from '../src/login';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
afterEach(() => vi.restoreAllMocks());

async function requestCalendar() {
	return worker.fetch(new IncomingRequest('https://example.com/?username=test&password=secret'), env, createExecutionContext());
}

describe('Calendar login', () => {
	it('requires credentials', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Missing username or password');
	});

	it('accepts profiles without unused fields and safely serializes credentials', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
			jwt: 'token', user: { associatedStudent: { id: 42 }, birthday: null },
		}));
		const password = 'quotes" and backslash\\ and newline\n';
		await expect(fetchLogin('test', password)).resolves.toEqual({ jwt: 'token', user: { associatedStudent: { id: 42 } } });
		expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).password).toBe(password);
	});

	it.each([401, 403])('handles rejected credentials (%s) before parsing the body', async (status) => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Unauthorized', { status }));
		const response = await requestCalendar();
		expect(response.status).toBe(401);
		expect(await response.text()).toBe('Login failed');
	});

	it.each([
		{ jwt: 'token', user: { associatedStudent: { id: '42' } } },
		{ jwt: '', user: {} },
		{ error: 'Unexpected login result' },
	])('rejects invalid required data with safe diagnostics', async (data) => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(data));
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const response = await requestCalendar();
		expect(response.status).toBe(502);
		expect(log).toHaveBeenCalledWith('Invalid login response schema', expect.arrayContaining([
			expect.objectContaining({ path: expect.any(Array), code: expect.any(String) }),
		]));
		expect(JSON.stringify(log.mock.calls)).not.toContain('token');
	});

	it.each([new Response('Down', { status: 503 }), new Response('<html>Unavailable</html>')])(
		'handles upstream HTTP and invalid JSON failures', async (upstream) => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream);
			vi.spyOn(console, 'error').mockImplementation(() => {});
			expect((await requestCalendar()).status).toBe(502);
		},
	);

	it('handles network failures', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network failure'));
		expect((await requestCalendar()).status).toBe(502);
	});

	it('handles accounts without an associated student', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ jwt: 'token', user: {} }));
		const response = await requestCalendar();
		expect(await response.text()).toBe('Student ID not found');
	});
});
