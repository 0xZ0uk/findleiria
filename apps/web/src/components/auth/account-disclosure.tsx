import { LogOut } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { signOut } from "@/utils/auth-client";

/**
 * The signed-in account panel, shared by the desktop header and the mobile
 * tab bar.
 *
 * A disclosure, not a menu: a button with `aria-expanded`/`aria-controls`
 * that reveals a plain panel (the address and a sign-out button). Menu roles
 * promise arrow-key navigation and roving focus that a single button does not
 * need, so there are none — Tab walks into the panel like any other content.
 *
 * Escape and a press outside both close it; Escape also hands focus back to
 * the trigger, so a keyboard reader lands where they were. A press outside
 * leaves focus alone — it already went where the reader pointed.
 */
export function AccountDisclosure({
	email,
	trigger,
	triggerClassName,
	panelClassName,
	captionClassName,
	signOutClassName,
}: {
	email: string;
	/** The trigger's contents; `open` lets the caller restyle the open state. */
	trigger: (open: boolean) => ReactNode;
	triggerClassName: string;
	panelClassName: string;
	captionClassName: string;
	signOutClassName: string;
}) {
	const [open, setOpen] = useState(false);
	const wrapper = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const panelId = useId();

	useEffect(() => {
		if (!open) return;

		const onPointerDown = (event: PointerEvent) => {
			if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setOpen(false);
			button.current?.focus();
		};

		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div ref={wrapper} className="relative">
			<button
				ref={button}
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				aria-controls={panelId}
				aria-label="A sua conta"
				className={triggerClassName}
			>
				{trigger(open)}
			</button>

			<div id={panelId} hidden={!open} className={panelClassName}>
				<p className={captionClassName}>Sessão iniciada</p>
				<p className="mt-2 truncate text-[14px]">{email}</p>
				<button
					type="button"
					onClick={() => {
						setOpen(false);
						void signOut();
					}}
					className={signOutClassName}
				>
					<LogOut aria-hidden="true" strokeWidth={1.5} className="size-4" />
					Terminar sessão
				</button>
			</div>
		</div>
	);
}
