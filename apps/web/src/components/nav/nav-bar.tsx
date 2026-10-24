import {
	Bookmark,
	CalendarDays,
	LogOut,
	type LucideIcon,
	User,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "@/utils/auth-client";
import { savedHref } from "@/utils/route";

/** The path we are on right now; safe for the prerender step, no window there. */
function currentPath(): string {
	return typeof window === "undefined" ? "/" : window.location.pathname;
}

const MICRO_NAV =
	"font-mono text-[11px] font-medium uppercase tracking-[0.14em]";

type TabSpec = { href: string; label: string; icon: LucideIcon };

/** One desktop inline link in the masthead row. */
function DeskNavLink({ href, label }: { href: string; label: string }) {
	const active =
		currentPath() === href || (href !== "/" && currentPath().startsWith(href));
	return (
		<a
			href={href}
			aria-current={active ? "page" : undefined}
			className={`focus-ring inline-flex h-10 items-center rounded-[4px] px-3 font-medium text-[14px] motion-safe:transition-colors ${
				active ? "text-primary" : "text-muted-foreground hover:text-foreground"
			}`}
		>
			{label}
		</a>
	);
}

/**
 * The top navigation — the condensed route set, inline in the header row,
 * desktop only. Hidden below `sm`, where the bottom tab bar takes over.
 */
export function TopNav() {
	return (
		<nav
			aria-label="Principal"
			className="absolute top-1/2 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 sm:block"
		>
			<div className="flex items-center gap-1">
				<DeskNavLink href="/" label="Agenda" />
				<DeskNavLink href={savedHref()} label="Guardados" />
			</div>
		</nav>
	);
}

/** One mobile tab in the bottom bar. Active tab reads in amber, targets ≥44px. */
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
			className={`focus-ring inline-flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-[4px] motion-safe:transition-colors ${
				active ? "text-primary" : "text-muted-foreground"
			}`}
		>
			<Icon aria-hidden="true" strokeWidth={1.5} className="size-5" />
			<span
				className={`${MICRO_NAV} ${active ? "text-primary" : "text-muted-foreground"}`}
			>
				{label}
			</span>
		</a>
	);
}

/**
 * The Conta tab: a link to `/entrar` when signed out; when signed in it opens
 * a small sheet above the bar with the account and the way out. Symmetric to
 * the desktop AccountMenu — one ref, one outside-click listener, Escape.
 */
function ContaTab({ active }: { active: boolean }) {
	const { data: session } = useSession();
	const user = session?.user ?? null;
	const [open, setOpen] = useState(false);
	const wrapper = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;

		const onPointerDown = (event: PointerEvent) => {
			if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};

		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	// Signed out, Conta is the way in.
	if (!user) {
		return (
			<a
				href="/entrar"
				aria-current={active ? "page" : undefined}
				className={`focus-ring inline-flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-[4px] motion-safe:transition-colors ${
					active ? "text-primary" : "text-muted-foreground"
				}`}
			>
				<User aria-hidden="true" strokeWidth={1.5} className="size-5" />
				<span
					className={`${MICRO_NAV} ${active ? "text-primary" : "text-muted-foreground"}`}
				>
					Conta
				</span>
			</a>
		);
	}

	// The tab reads "Conta" either way; the sheet carries the name and email.
	const called = open ? "text-primary" : "text-muted-foreground";

	return (
		<div ref={wrapper} className="relative">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label="A sua conta"
				className={`focus-ring inline-flex min-h-[56px] w-full flex-col items-center justify-center gap-1 rounded-[4px] motion-safe:transition-colors ${called}`}
			>
				<User
					aria-hidden="true"
					strokeWidth={1.5}
					className="size-5"
					fill={open ? "currentColor" : "none"}
				/>
				<span className={`${MICRO_NAV} ${called}`}>Conta</span>
			</button>

			{open ? (
				<div
					role="menu"
					className="absolute bottom-full left-1/2 z-30 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-[4px] border border-border bg-card p-4 shadow-lg sm:hidden"
				>
					<p className={`${MICRO_NAV} text-muted-foreground`}>
						Sessão iniciada
					</p>
					<p className="mt-2 truncate text-[14px]">{user.email}</p>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							void signOut();
						}}
						className="focus-ring mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-[4px] border border-muted-foreground/60 text-[14px] hover:border-primary/60 hover:text-primary motion-safe:transition-colors"
					>
						<LogOut aria-hidden="true" strokeWidth={1.5} className="size-4" />
						Terminar sessão
					</button>
				</div>
			) : null}
		</div>
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
				className="relative mx-auto grid w-full max-w-md grid-cols-3"
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
