/**
 * The libSQL client for deployed functions: HTTP/WebSocket only, pure
 * JavaScript. Selected by the `#libsql-client` import map in package.json.
 *
 * Importing `@libsql/client` (the Node entry) would drag the native `libsql`
 * binary into every Vercel function bundle, although production only talks
 * `libsql://` over the network.
 */
export { createClient } from "@libsql/client/web";
