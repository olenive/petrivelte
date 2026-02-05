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
	if (!res.ok) throw new Error((await res.json()).detail ?? 'Registration failed');
	return res.json();
}

export async function login(email: string, password: string): Promise<AuthUser> {
	const res = await post('/api/auth/login', { email, password });
	if (!res.ok) throw new Error((await res.json()).detail ?? 'Login failed');
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
	if (!res.ok) throw new Error((await res.json()).detail ?? 'Failed to create net');
	return res.json();
}

export async function patchNet(
	netId: string,
	body: Partial<Pick<Net, 'name' | 'entry_module' | 'entry_function' | 'worker_id'>>,
): Promise<Net> {
	const res = await patch(`/api/nets/${netId}`, body);
	if (!res.ok) throw new Error((await res.json()).detail ?? 'Failed to update net');
	return res.json();
}

export async function deleteNet(netId: string): Promise<void> {
	const res = await del(`/api/nets/${netId}`);
	if (!res.ok) throw new Error('Failed to delete net');
}

export async function loadNet(netId: string): Promise<{ status: string; worker_ip: string }> {
	const res = await post(`/api/nets/${netId}/load`);
	if (!res.ok) throw new Error((await res.json()).detail ?? 'Failed to load net');
	return res.json();
}

export async function unloadNet(netId: string): Promise<void> {
	const res = await post(`/api/nets/${netId}/unload`);
	if (!res.ok) throw new Error((await res.json()).detail ?? 'Failed to unload net');
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
	cpu_kind: string;
	cpus: number;
	memory_mb: number;
	fly_machine_id: string | null;
	machine_status: string;
	private_ip: string | null;
	created_at: string;
	updated_at: string;
}

export interface WorkerDetail extends Worker {
	assigned_nets: Array<{ id: string; name: string }>;
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
	cpu_kind?: string;
	cpus?: number;
	memory_mb?: number;
}): Promise<Worker> {
	const res = await post('/api/workers', body);
	if (!res.ok) throw new Error((await res.json()).detail ?? 'Failed to create worker');
	return res.json();
}

export async function deleteWorker(workerId: string): Promise<void> {
	const res = await del(`/api/workers/${workerId}`);
	if (!res.ok) throw new Error('Failed to delete worker');
}

export async function startFlyMachine(workerId: string): Promise<void> {
	const res = await post(`/api/workers/${workerId}/fly_machine/start`);
	if (!res.ok) throw new Error((await res.json()).detail ?? 'Failed to start machine');
}

export async function stopFlyMachine(workerId: string): Promise<void> {
	const res = await post(`/api/workers/${workerId}/fly_machine/stop`);
	if (!res.ok) throw new Error((await res.json()).detail ?? 'Failed to stop machine');
}
