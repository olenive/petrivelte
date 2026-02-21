import { redirect } from '@sveltejs/kit';
import { getMe } from '$lib/api';
import type { LayoutLoad } from './$types';

export const ssr = false;

export const load: LayoutLoad = async () => {
	const user = await getMe();
	if (!user) {
		throw redirect(302, '/login');
	}
	return { user };
};
