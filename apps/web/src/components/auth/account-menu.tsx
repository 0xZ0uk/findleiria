import { BUTTON, CAPTION } from "@/components/agenda/layout";
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
				className="h-11 w-[5.5rem] shrink-0 rounded-full border border-border bg-card sm:h-10"
			/>
		);
	}

	const user = data?.user;

	if (!user) {
		return (
			<a href="/entrar" className={BUTTON}>
				Entrar
			</a>
		);
	}

	const initial = (user.name?.trim() || user.email).slice(0, 1).toUpperCase();

	return (
		<AccountDisclosure
			email={user.email}
			triggerClassName="focus-ring inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-control bg-background pr-4 pl-1.5 hover:bg-card motion-safe:transition-colors sm:h-10"
			panelClassName="absolute right-0 z-30 mt-2 w-64 rounded-2xl border border-border bg-popover p-4 shadow-[0_12px_32px_-12px_rgb(23_34_27/0.25)]"
			captionClassName={`${CAPTION} text-muted-foreground`}
			signOutClassName="focus-ring mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-full border border-control font-medium text-[14px] hover:bg-card motion-safe:transition-colors"
			trigger={() => (
				<>
					<span
						aria-hidden="true"
						className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-surface font-semibold text-[13px] text-primary sm:size-7"
					>
						{initial}
					</span>
					<span className="hidden max-w-[14ch] truncate font-medium text-[14px] sm:inline">
						{user.name?.trim() || user.email}
					</span>
				</>
			)}
		/>
	);
}
