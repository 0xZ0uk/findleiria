import type { db } from "@events-tracker/db";

/** An open drizzle transaction on the events database. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What the write paths run their queries on: the database itself, or a
 * transaction the caller opened (C8). Inside a transaction EVERY query must go
 * through it: the libSQL client hands its connection to the transaction, so a
 * stray query on `db` opens a second connection and waits on the write lock.
 */
export type Conn = typeof db | Tx;
