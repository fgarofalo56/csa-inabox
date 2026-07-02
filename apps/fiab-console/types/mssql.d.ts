/**
 * Minimal ambient declaration for `mssql` (node-mssql / Tedious).
 *
 * The `mssql` package ships no bundled TypeScript types and `@types/mssql`
 * is not installed in this workspace. Rather than suppress the untyped-import
 * error, this declares the subset of the API the Loom SQL clients actually
 * consume (lib/azure/azure-sql-client.ts, lib/azure/synapse-sql-client.ts):
 * ConnectionPool, Request, IResult, config, and the NVarChar/MAX helpers.
 *
 * Mirrors the shape of @types/mssql (namespace + `export =`) so that both
 * value access (`new sql.ConnectionPool(...)`) and type access
 * (`sql.config`, `sql.IResult<T>`) resolve from a default import.
 */
declare module 'mssql' {
  namespace mssql {
    /** Connection configuration (host/db/auth/options); loosely typed. */
    interface config {
      server?: string;
      database?: string;
      user?: string;
      password?: string;
      port?: number;
      options?: Record<string, unknown>;
      authentication?: Record<string, unknown>;
      pool?: Record<string, unknown>;
      [key: string]: unknown;
    }

    /** Result of a query execution. Rows default to `any` (dynamic columns). */
    interface IResult<T = any> {
      recordset: T[];
      recordsets: T[][];
      rowsAffected: number[];
      output: Record<string, unknown>;
      returnValue?: unknown;
    }

    /** A parameterized request bound to a pool/transaction. */
    class Request {
      constructor(pool?: ConnectionPool);
      input(name: string, type: unknown, value?: unknown): this;
      input(name: string, value: unknown): this;
      output(name: string, type: unknown, value?: unknown): this;
      query<T = any>(command: string): Promise<IResult<T>>;
      batch<T = any>(command: string): Promise<IResult<T>>;
      on(event: string, listener: (...args: any[]) => void): this;
      cancel(): void;
      [key: string]: unknown;
    }

    /** A pooled set of connections to a single server/database. */
    class ConnectionPool {
      constructor(config: config | string);
      connect(): Promise<ConnectionPool>;
      close(): Promise<void>;
      request(): Request;
      readonly connected: boolean;
      readonly connecting: boolean;
      on(event: string, handler: (...args: unknown[]) => void): this;
      [key: string]: unknown;
    }

    /** Sentinel length for MAX-width string/binary column types. */
    const MAX: number;

    /** SQL type factory for NVARCHAR columns/parameters. */
    function NVarChar(length?: number): unknown;
    function VarChar(length?: number): unknown;
    function Int(): unknown;
    function BigInt(): unknown;
    function Bit(): unknown;
    function Float(): unknown;
    function DateTime2(): unknown;
  }

  export = mssql;
}
