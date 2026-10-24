import { RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { BUTTON } from "@/components/agenda/layout";
import { isChunkLoadError } from "@/utils/chunk-error";

type Props = {
	children: ReactNode;
	/** Shown in the heading's place, e.g. "O mapa não carregou." */
	title?: string;
};

type State = { error: Error | null };

/**
 * Catches render and lazy-chunk failures below it so one broken piece does not
 * blank the whole app. The usual cause is a stale tab after a deploy: its chunk
 * hashes no longer exist, and a reload fetches the new build.
 */
export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: unknown): State {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(error, info.componentStack);
	}

	render() {
		const { error } = this.state;
		if (!error) return this.props.children;

		const stale = isChunkLoadError(error);
		return (
			<div role="alert" className="max-w-[46ch] py-6">
				<p className="type-section">{this.props.title ?? "Algo correu mal."}</p>
				<p className="mt-2 text-[15px] text-muted-foreground leading-relaxed">
					{stale
						? "O site foi atualizado entretanto. Recarrega a página para obter a versão mais recente."
						: "Ocorreu um erro inesperado. Recarrega a página para tentar de novo."}
				</p>
				<button
					type="button"
					onClick={() => window.location.reload()}
					className={`${BUTTON} mt-5`}
				>
					<RefreshCw aria-hidden="true" strokeWidth={1.5} className="size-4" />
					Recarregar
				</button>
			</div>
		);
	}
}
