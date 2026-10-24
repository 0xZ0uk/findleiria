import tailwindcss from "@tailwindcss/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No router: the SPA picks its page from the pathname (src/utils/route.ts), so
// there is no router plugin and no generated route tree.
export default defineConfig({
	server: {
		port: 3300,
		// Auth runs on the dev server, but the browser must only ever see one
		// origin — the same shape production has, where the Worker serves
		// the API beside the SPA. `changeOrigin` stays off so the Host header remains
		// :3300 and better-auth builds the Google callback against it.
		proxy: {
			"/api": { target: "http://localhost:3301" },
		},
	},
	resolve: {
		tsconfigPaths: true,
	},
	// varlock loads the repo-root .env.schema (#web items, see package.json),
	// validates it on `vite dev` / `vite build`, and puts the values in
	// process.env. Only VITE_-prefixed items reach `import.meta.env`, and every
	// item the schema marks @sensitive is kept out of client code.
	plugins: [varlockVitePlugin(), tailwindcss(), react()],
});
