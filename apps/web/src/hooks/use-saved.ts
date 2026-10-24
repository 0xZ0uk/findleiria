import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useSession } from "@/utils/auth-client";
import { ApiError, listSaved, setSaved } from "@/utils/saved-client";

/** The slug list. Its root differs from `["saved-events", …]` on purpose. */
const SAVED_KEY = ["saved-slugs"] as const;

/**
 * The saved-events slice, driven by react-query.
 *
 * The slug list is one query, enabled only when a session exists (a signed-out
 * reader has nothing to save). Saving is one mutation with an optimistic
 * write: the toggle flips the cache immediately, and a failed request rolls
 * the list back. A 401 — a session that died mid-use — asks the session store
 * to refetch instead of retrying the doomed write.
 */
export function useSaved() {
	const session = useSession();
	const signedIn = Boolean(session.data?.user);
	const ready = !session.isPending;

	const queryClient = useQueryClient();

	const savedQuery = useQuery({
		queryKey: SAVED_KEY,
		queryFn: listSaved,
		enabled: signedIn,
	});

	// The cache hands back a stable array reference, so the Set stays stable
	// until the list actually changes — isSaved can be read cheaply any render.
	const slugs = useMemo(
		() => new Set(savedQuery.data ?? []),
		[savedQuery.data],
	);

	const mutation = useMutation({
		mutationFn: ({ slug, saved }: { slug: string; saved: boolean }) =>
			setSaved(slug, saved),
		onMutate: async ({ slug, saved }) => {
			// Drop any in-flight read so the optimistic write isn't clobbered.
			await queryClient.cancelQueries({ queryKey: SAVED_KEY });
			const previous = queryClient.getQueryData<string[]>(SAVED_KEY);
			queryClient.setQueryData<string[]>(SAVED_KEY, (current = []) =>
				saved
					? [...new Set([...current, slug])]
					: current.filter((existing) => existing !== slug),
			);
			return { previous };
		},
		onError: (error, _variables, context) => {
			if (context?.previous) {
				queryClient.setQueryData<string[]>(SAVED_KEY, context.previous);
			}
			// The mutation is not worth retrying: a 401 means the session is
			// gone, and refetching it is what surfaces the signed-out state.
			if (error instanceof ApiError && error.status === 401) {
				void session.refetch();
			}
		},
	});

	return {
		slugs,
		isSaved: (slug: string) => slugs.has(slug),
		pending: mutation.isPending,
		toggle: (slug: string) => {
			mutation.mutate({ slug, saved: !slugs.has(slug) });
		},
		signedIn,
		ready,
	};
}

export type Saved = ReturnType<typeof useSaved>;
