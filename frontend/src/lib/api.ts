/**
 * Centralised API client for the petritype-server control plane.
 *
 * Every request includes `credentials: 'include'` so the httponly
 * session cookie (`petritype_session`) is sent automatically.
 */

import { env } from '$env/dynamic/public';

export const API_URL = env.PUBLIC_API_URL || 'http://localhost:8000';

const jsonHeaders = { 'Content-Type': 'application/json' };

// -- helpers --

/**
 * Extract a human-readable error message from an API error response.
 * Handles both simple string `detail` and Pydantic validation error arrays.
 */
function extractErrorMessage(data: unknown, fallback: string): string {
	if (!data || typeof data !== 'object') return fallback;
	const detail = (data as Record<string, unknown>).detail;
	if (typeof detail === 'string') return detail;
	if (Array.isArray(detail) && detail.length > 0) {
		// Pydantic validation error format: [{loc: [...], msg: "...", type: "..."}]
		const first = detail[0];
		if (first && typeof first === 'object' && 'msg' in first) {
			return String(first.msg);
		}
	}
	return fallback;
}

async function get(path: string): Promise<Response> {
	return fetch(`${API_URL}${path}`, { credentials: 'include' });
}

async function post(path: string, body?: unknown): Promise<Response> {
	return fetch(`${API_URL}${path}`, {
		method: 'POST',
		credentials: 'include',
		headers: body !== undefined ? jsonHeaders : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

async function patch(path: string, body: unknown): Promise<Response> {
	return fetch(`${API_URL}${path}`, {
		method: 'PATCH',
		credentials: 'include',
		headers: jsonHeaders,
		body: JSON.stringify(body),
	});
}

async function del(path: string): Promise<Response> {
	return fetch(`${API_URL}${path}`, {
		method: 'DELETE',
		credentials: 'include',
	});
}

// -- auth --

export interface AuthUser {
	id: string;
	email: string;
}

export async function register(email: string, password: string): Promise<AuthUser> {
	const res = await post('/api/auth/register', { email, password });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Registration failed'));
	return res.json();
}

export async function login(email: string, password: string): Promise<AuthUser> {
	const res = await post('/api/auth/login', { email, password });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Login failed'));
	return res.json();
}

export async function logout(): Promise<void> {
	await post('/api/auth/logout');
}

export async function getMe(): Promise<AuthUser | null> {
	const res = await get('/api/auth/me');
	if (!res.ok) return null;
	return res.json();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
	const res = await post('/api/auth/change-password', {
		current_password: currentPassword,
		new_password: newPassword,
	});
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to change password'));
}

export async function forgotPassword(email: string): Promise<void> {
	const res = await post('/api/auth/forgot-password', { email });
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to send reset email'));
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
	const res = await post('/api/auth/reset-password', {
		token,
		new_password: newPassword,
	});
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to reset password'));
}

// -- nets --

export interface Net {
	id: string;
	name: string;
	entry_module: string;
	entry_function: string;
	execution_mode: string;
	image_tag: string | null;
	worker_id: string | null;
	created_at: string;
	updated_at: string;
}

export async function listNets(): Promise<Net[]> {
	const res = await get('/api/nets');
	if (!res.ok) throw new Error('Failed to list nets');
	return res.json();
}

export async function getNet(netId: string): Promise<Net> {
	const res = await get(`/api/nets/${netId}`);
	if (!res.ok) throw new Error('Failed to get net');
	return res.json();
}

export async function createNet(body: {
	name: string;
	entry_module: string;
	entry_function?: string;
	worker_id?: string;
}): Promise<Net> {
	const res = await post('/api/nets', body);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to create net'));
	return res.json();
}

export async function patchNet(
	netId: string,
	body: Partial<Pick<Net, 'name' | 'entry_module' | 'entry_function' | 'worker_id'>>,
): Promise<Net> {
	const res = await patch(`/api/nets/${netId}`, body);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to update net'));
	return res.json();
}

export async function deleteNet(netId: string): Promise<void> {
	const res = await del(`/api/nets/${netId}`);
	if (!res.ok) throw new Error('Failed to delete net');
}

export async function loadNet(netId: string): Promise<{ status: string; worker_ip: string }> {
	const res = await post(`/api/nets/${netId}/load`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to load net'));
	return res.json();
}

export async function unloadNet(netId: string): Promise<void> {
	const res = await post(`/api/nets/${netId}/unload`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to unload net'));
}

// -- execution (proxied through control plane to worker) --

export async function getExecutionState(netId: string): Promise<any> {
	const res = await get(`/api/nets/${netId}/execution/state`);
	if (!res.ok) throw new Error('Failed to get execution state');
	return res.json();
}

export async function executionStep(netId: string): Promise<{ fired: number; transition_name: string | null }> {
	const res = await post(`/api/nets/${netId}/execution/step`);
	if (!res.ok) throw new Error('Failed to step');
	return res.json();
}

export async function executionStart(netId: string): Promise<void> {
	await post(`/api/nets/${netId}/execution/start`);
}

export async function executionStop(netId: string): Promise<void> {
	await post(`/api/nets/${netId}/execution/stop`);
}

export async function executionReset(netId: string): Promise<void> {
	await post(`/api/nets/${netId}/execution/reset`);
}

// -- workers --

export interface Worker {
	id: string;
	name: string;
	worker_type: string;
	sprite_name: string | null;
	fly_machine_id: string | null;
	status: string;
	url: string | null;
	created_at: string;
	updated_at: string;
}

export interface WorkerDetail extends Worker {
	assigned_nets: Array<{ id: string; name: string; entry_module: string; entry_function: string }>;
}

export async function listWorkers(): Promise<Worker[]> {
	const res = await get('/api/workers');
	if (!res.ok) throw new Error('Failed to list workers');
	return res.json();
}

export async function getWorker(workerId: string): Promise<WorkerDetail> {
	const res = await get(`/api/workers/${workerId}`);
	if (!res.ok) throw new Error('Failed to get worker');
	return res.json();
}

export async function createWorker(body: {
	name: string;
	worker_type?: string;
}): Promise<Worker> {
	const res = await post('/api/workers', body);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to create worker'));
	return res.json();
}

export async function deleteWorker(workerId: string): Promise<void> {
	const res = await del(`/api/workers/${workerId}`);
	if (!res.ok) throw new Error('Failed to delete worker');
}

export async function provisionWorker(workerId: string): Promise<{ status: string; url: string }> {
	const res = await post(`/api/workers/${workerId}/provision`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to provision worker'));
	return res.json();
}

export async function destroyWorkerResource(workerId: string): Promise<void> {
	const res = await post(`/api/workers/${workerId}/destroy`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to destroy resource'));
}

export async function startWorker(workerId: string): Promise<void> {
	const res = await post(`/api/workers/${workerId}/start`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to start worker'));
}

export async function stopWorker(workerId: string): Promise<void> {
	const res = await post(`/api/workers/${workerId}/stop`);
	if (!res.ok) throw new Error(extractErrorMessage(await res.json(), 'Failed to stop worker'));
}
