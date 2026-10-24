import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@events-tracker/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva(
	"group/button inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-[4px] border border-transparent bg-clip-padding font-semibold text-[14px] outline-none transition-all focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				/* Primary CTA: amber fill — the ONE colour in the system */
				default:
					"rounded-[4px] bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]",
				/* Secondary: dark surface, ink text */
				secondary:
					"rounded-[4px] border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:border-[var(--muted-foreground)]",
				/* Ghost: quiet, muted */
				ghost:
					"rounded-[4px] bg-transparent text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]",
				/* Outline: hairline border, sharp */
				outline:
					"rounded-[4px] border border-[var(--border)] bg-transparent text-[var(--foreground)] hover:border-[var(--muted-foreground)] aria-expanded:bg-muted aria-expanded:text-foreground",
				destructive:
					"bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
				link: "text-[var(--primary)] underline-offset-4 hover:underline",
				/* Legacy Arc variants kept as aliases → primary look */
				arc: "h-[52px] rounded-[4px] bg-[var(--primary)] px-[22px] text-[15px] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]",
				"arc-cta":
					"h-[52px] gap-3 rounded-[4px] bg-[var(--primary)] px-[22px] text-[16px] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]",
				blue: "rounded-[4px] bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]",
			},
			size: {
				default:
					"h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
				xs: "h-6 gap-1 rounded-[2px] px-3 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1.5 rounded-[2px] px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
				lg: "h-10 gap-1.5 px-5 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
				cta: "h-[52px] gap-3 rounded-[4px] px-[22px] text-[16px]",
				icon: "size-9 rounded-[4px]",
				"icon-xs":
					"size-7 rounded-[2px] [&_svg:not([class*='size-'])]:size-3.5",
				"icon-sm": "size-8 rounded-[4px]",
				"icon-lg": "size-10 rounded-[4px]",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
