import { SHELL } from "@/components/agenda/layout";
import { Wordmark } from "@/components/agenda/wordmark";
import { AccountMenu } from "@/components/auth/account-menu";
import { BottomNav, TopNav } from "@/components/nav/nav-bar";

/**
 * The chrome every route wears: the wordmark row on top, plus the
 * device-appropriate navigation.
 *
 * Two shapes, one header. From `sm` up the routes sit in a segmented pill
 * beside the wordmark and the account sits on the right. Below `sm` the same
 * routes become a fixed tab bar at the bottom, where a thumb can reach them,
 * and the header keeps only the wordmark — so the brand stays on top on a phone
 * exactly as it does on a desktop. `AccountMenu` travels down with the routes,
 * into the Conta tab's sheet.
 *
 * Rendered once by the app shell rather than by each page, so the header does
 * not re-mount when the reader moves between the agenda, an event and their
 * saved list.
 */
export function AppChrome() {
	return (
		<>
			<header className="border-border border-b">
				<div className={`${SHELL} flex h-16 items-center gap-8 sm:h-[76px]`}>
					<a
						href="/"
						aria-label="FindLeiria, agenda"
						className="focus-ring -mx-1 rounded-lg px-1"
					>
						<Wordmark />
					</a>
					<TopNav />
					<div className="ml-auto hidden sm:block">
						<AccountMenu />
					</div>
				</div>
			</header>
			<BottomNav />
		</>
	);
}
