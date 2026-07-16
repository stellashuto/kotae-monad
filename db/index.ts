import { schemaStatements } from "./schema";

export type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): any;
    run(): Promise<unknown>;
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results: T[] }>;
  };
  batch(statements: unknown[]): Promise<unknown>;
};

let initialized = false;

export async function getDb(db: D1Like) {
  if (!initialized) {
    await db.batch(schemaStatements.map((sql) => db.prepare(sql)));
    initialized = true;
  }
  return db;
}
