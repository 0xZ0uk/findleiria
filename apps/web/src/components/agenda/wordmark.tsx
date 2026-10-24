/**
 * The FindLeiria wordmark.
 *
 * Type only: "find" upright, "leiria" in the italic and the primary green, so
 * the name still reads as two words without a second mark beside it. The
 * favicon carries the pin for places where type cannot fit.
 */
export function Wordmark({ className = "" }: { className?: string }) {
	return (
		<span className={`type-wordmark ${className}`}>
			find<em className="font-normal text-primary italic">leiria</em>
		</span>
	);
}
