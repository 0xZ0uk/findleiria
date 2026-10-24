import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@events-tracker/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva(
	"group/badge inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-[2px] border border-transparent px-2.5 py-0.5 font-bold font-mono text-[11px] uppercase tracking-[0.4px] transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
	{
		variants: {
			variant: {
				/* Status chip: dark surface + muted ink (DESIGN.md status-chip) */
				default:
					"border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]",
				secondary:
					"border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]",
				/* Amber reserved — use sparingly (one per view) */
				blue: "bg-[var(--primary)] text-[var(--primary-foreground)]",
				pinkish: "bg-destructive/15 text-destructive",
				salmon:
					"border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]",
				students:
					"border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]",
				outline:
					"border-[var(--border)] bg-transparent text-[var(--muted-foreground)]",
				ghost: "hover:bg-muted hover:text-muted-foreground",
				destructive:
					"bg-destructive/10 text-destructive focus-visible:ring-destructive/20",
				link: "text-primary underline-offset-4 hover:underline",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

function Badge({
	className,
	variant = "default",
	render,
	...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(
			{
				className: cn(badgeVariants({ variant }), className),
			},
			props,
		),
		render,
		state: {
			slot: "badge",
			variant,
		},
	});
}

export { Badge, badgeVariants };
