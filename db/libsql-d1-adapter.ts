import type { Client, InArgs, ResultSet } from "@libsql/client";

// lib/store.ts and lib/etoro.ts are written against Cloudflare D1's
// prepared-statement API (`.prepare(sql).bind(...).run()/.all()/.first()`,
// and `d1.batch([...])`). Turso's libSQL client has a different shape
// (`.execute({sql, args})`, `.batch([...])`). This adapter implements just
// enough of D1's surface on top of libSQL so the D1-authored SQL access code
// works unchanged against a Turso-hosted database — the two are both
// SQLite dialects, so the SQL itself is portable as-is.

function rowsToObjects(result: ResultSet): Record<string, unknown>[] {
  return result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((column, index) => {
      obj[column] = row[index];
    });
    return obj;
  });
}

export class LibsqlPreparedStatement {
  constructor(
    private readonly client: Client,
    private readonly sql: string,
    private readonly args: InArgs = [],
  ) {}

  bind(...values: unknown[]): LibsqlPreparedStatement {
    return new LibsqlPreparedStatement(this.client, this.sql, values as InArgs);
  }

  async run<T = Record<string, unknown>>() {
    const result = await this.client.execute({ sql: this.sql, args: this.args });
    return {
      results: rowsToObjects(result) as T[],
      success: true,
      meta: {
        changes: result.rowsAffected,
        last_row_id: result.lastInsertRowid == null ? 0 : Number(result.lastInsertRowid),
      },
    };
  }

  async all<T = Record<string, unknown>>() {
    const result = await this.client.execute({ sql: this.sql, args: this.args });
    return { results: rowsToObjects(result) as T[], success: true, meta: {} };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.client.execute({ sql: this.sql, args: this.args });
    const rows = rowsToObjects(result);
    return (rows[0] ?? null) as T | null;
  }

  // Not part of D1's public surface, used internally by LibsqlD1Adapter.batch().
  toLibsqlStatement() {
    return { sql: this.sql, args: this.args };
  }
}

export class LibsqlD1Adapter {
  constructor(private readonly client: Client) {}

  prepare(sql: string): LibsqlPreparedStatement {
    return new LibsqlPreparedStatement(this.client, sql);
  }

  async batch<T = Record<string, unknown>>(statements: LibsqlPreparedStatement[]) {
    const libsqlStatements = statements.map((statement) => statement.toLibsqlStatement());
    const results = await this.client.batch(libsqlStatements, "write");
    return results.map((result) => ({
      results: rowsToObjects(result) as T[],
      success: true,
      meta: {
        changes: result.rowsAffected,
        last_row_id: result.lastInsertRowid == null ? 0 : Number(result.lastInsertRowid),
      },
    }));
  }
}
