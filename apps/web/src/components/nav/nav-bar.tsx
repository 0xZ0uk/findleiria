import { Bookmark, CalendarDays, type LucideIcon, User } from "lucide-react";
import { AccountDisclosure } from "@/components/auth/account-disclosure";
import { useSession } from "@/utils/auth-client";
import { savedHref } from "@/utils/route";

/** The path we are on right now; safe for the prerender step, no window there. */
function currentPath(): string {
	return typeof window === "undefined" ? "/" : window.location.pathname;
}

const TAB_LABEL = "text-[12px] font-medium leading-none";

/** The pill behind a tab's icon: tinted when the tab is the current page. */
const TAB_PILL =
	"grid h-8 w-14 place-items-center rounded-full motion-safe:transition-colors";

type TabSpec = { href: string; label: string; icon: LucideIcon };

/** One segment of the desktop nav. The current page sits raised on white. */
function DeskNavLink({ href, label }: { href: string; label: string }) {
	const active =
		currentPath() === href || (href !== "/" && currentPath().startsWith(href));
	return (
		<a
			href={href}
			aria-current={active ? "page" : undefined}
			className={`focus-ring inline-flex h-9 items-center rounded-full px-4 font-medium text-[14px] motion-safe:transition-colors ${
				active
					? "bg-background text-foreground shadow-[0_1px_3px_rgb(23_34_27/0.12)]"
					: "text-muted-foreground hover:text-foreground"
			}`}
		>
			{label}
		</a>
	);
}

/**
 * The top navigation — the condensed route set as one segmented pill, next to
 * the wordmark, desktop only. Hidden below `sm`, where the bottom tab bar takes
 * over.
 */
export function TopNav() {
	return (
		<nav aria-label="Principal" className="hidden sm:block">
			<div className="flex items-center gap-1 rounded-full border border-border bg-card p-1">
				<DeskNavLink href="/" label="Agenda" />
				<DeskNavLink href={savedHref()} label="Guardados" />
			</div>
		</nav>
	);
}

/**
 * One mobile tab in the bottom bar. The active tab reads in green with a
 * tinted pill behind its icon, so the state never rests on colour alone.
 * Targets ≥44px.
 */
function Tab({
	href,
	label,
	icon: Icon,
	active,
}: TabSpec & { active: boolean }) {
	return (
		<a
			href={href}
			aria-current={active ? "page" : undefined}
			className={`focus-ring inline-flex min-h-[60px] flex-col items-center justify-center gap-1 rounded-2xl motion-safe:transition-colors ${
				active ? "text-primary" : "text-muted-foreground"
			}`}
		>
			<span className={`${TAB_PILL} ${active ? "bg-primary-surface" : ""}`}>
				<Icon aria-hidden="true" strokeWidth={1.75} className="size-5" />
			</span>
			<span
				className={`${TAB_LABEL} ${active ? "text-primary" : "text-muted-foreground"}`}
			>
				{label}
			</span>
		</a>
	);
}

/**
 * The Conta tab: a link to `/entrar` when signed out; when signed in it opens
 * a small sheet above the bar with the account and the way out. Shares its
 * behaviour with the desktop AccountMenu through `AccountDisclosure`.
 */
function ContaTab({ active }: { active: boolean }) {
	const { data: session } = useSession();
	const user = session?.user ?? null;
	// Signed out, Conta is the way in.
	if (!user) {
		return (
			<a
				href="/entrar"
				aria-current={active ? "page" : undefined}
				className={`focus-ring inline-flex min-h-[60px] flex-col items-center justify-center gap-1 rounded-2xl motion-safe:transition-colors ${
					active ? "text-primary" : "text-muted-foreground"
				}`}
			>
				<span className={`${TAB_PILL} ${active ? "bg-primary-surface" : ""}`}>
					<User aria-hidden="true" strokeWidth={1.75} className="size-5" />
				</span>
				<span
					className={`${TAB_LABEL} ${active ? "text-primary" : "text-muted-foreground"}`}
				>
					Conta
				</span>
			</a>
		);
	}

	// The tab reads "Conta" either way; the sheet carries the email.
	return (
		<AccountDisclosure
			email={user.email}
			triggerClassName="focus-ring inline-flex min-h-[60px] w-full flex-col items-center justify-center gap-1 rounded-2xl motion-safe:transition-colors aria-expanded:text-primary text-muted-foreground"
			panelClassName="absolute bottom-full left-1/2 z-30 mb-2 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-2xl border border-border bg-popover p-4 shadow-[0_12px_32px_-12px_rgb(23_34_27/0.25)] sm:hidden"
			captionClassName={`${TAB_LABEL} text-muted-foreground`}
			signOutClassName="focus-ring mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border border-control font-medium text-[14px] hover:bg-card motion-safe:transition-colors"
			trigger={(open) => (
				<>
					<span className={`${TAB_PILL} ${open ? "bg-primary-surface" : ""}`}>
						<User aria-hidden="true" strokeWidth={1.75} className="size-5" />
					</span>
					<span className={TAB_LABEL}>Conta</span>
				</>
			)}
		/>
	);
}

/**
 * The mobile tab bar, fixed to the bottom.
 *
 * `sm:hidden`: desktop uses the top row. Safe-area padding sits on the grid,
 * so the bar clears the iPhone home indicator without the tiles shrinking.
 * The app shell carries a matching bottom pad so no content hides behind it.
 */
export function BottomNav() {
	const path = currentPath();
	const activeAgenda = path === "/";
	const activeSaved = path === "/guardados" || path.startsWith("/guardados");
	const activeConta = path === "/entrar" || path === "/entrar/";

	return (
		<nav
			aria-label="Principal"
			className="fixed inset-x-0 bottom-0 z-40 border-border border-t bg-background/95 backdrop-blur-sm sm:hidden"
		>
			<div
				className="relative mx-auto grid w-full max-w-md grid-cols-3 px-2 pt-1"
				style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
			>
				<Tab
					href="/"
					label="Agenda"
					icon={CalendarDays}
					active={activeAgenda}
				/>
				<Tab
					href={savedHref()}
					label="Guardados"
					icon={Bookmark}
					active={activeSaved}
				/>
				<ContaTab active={activeConta} />
			</div>
		</nav>
	);
}
