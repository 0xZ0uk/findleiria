import { MICRO } from "@/components/agenda/layout";
import { useSession } from "@/utils/auth-client";
import { AccountDisclosure } from "./account-disclosure";

/**
 * The account, top right of the page.
 *
 * Signed out it is a plain link to `/entrar`; signed in it is the initial and
 * a panel with the address and the way out (see `AccountDisclosure`).
 */
export function AccountMenu() {
	const { data, isPending } = useSession();
	// A quiet placeholder, so a signed-in reader never sees a flash of "Entrar"
	// while the session is being read.
	if (isPending) {
		return (
			<span
				aria-hidden="true"
				className="size-11 shrink-0 rounded-[4px] border border-border bg-card sm:size-10"
			/>
		);
	}

	const user = data?.user;

	if (!user) {
		return (
			<a
				href="/entrar"
				className="focus-ring inline-flex h-11 shrink-0 items-center rounded-[4px] border border-control bg-card px-3 font-medium text-[15px] hover:border-primary/60 hover:text-primary motion-safe:transition-colors sm:h-10"
			>
				Entrar
			</a>
		);
	}

	const initial = (user.name?.trim() || user.email).slice(0, 1).toUpperCase();

	return (
		<AccountDisclosure
			email={user.email}
			triggerClassName="focus-ring inline-flex h-11 shrink-0 items-center gap-2 rounded-[4px] border border-control bg-card pr-2.5 pl-1.5 hover:border-primary/60 motion-safe:transition-colors sm:h-10"
			panelClassName="absolute right-0 z-30 mt-2 w-64 rounded-[4px] border border-border bg-card p-3 shadow-lg"
			captionClassName={`${MICRO} text-muted-foreground`}
			signOutClassName="focus-ring mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-[4px] border border-control text-[14px] hover:border-primary/60 hover:text-primary motion-safe:transition-colors"
			trigger={() => (
				<>
					<span
						aria-hidden="true"
						className="grid size-7 shrink-0 place-items-center rounded-[2px] bg-primary font-mono font-semibold text-[12px] text-primary-foreground"
					>
						{initial}
					</span>
					<span className="hidden max-w-[14ch] truncate text-[14px] text-muted-foreground sm:inline">
						{user.name?.trim() || user.email}
					</span>
				</>
			)}
		/>
	);
}
