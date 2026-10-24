/**
 * The Node libSQL client, which can open `file:` databases. Selected by the
 * `#libsql-client` import map under Bun (tests and the dev server). Nothing a
 * deployed function loads references this file, so file tracing never reaches
 * the native `libsql` package through it.
 */
export { createClient } from "@libsql/client";
