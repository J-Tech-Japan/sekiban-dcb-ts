/**
 * G43's structural measurement harness. It is deliberately opt-in and holds
 * no durable state: a test starts it immediately before a real Tag DO handler
 * request and completes it only after response serialization. Every SQL
 * cursor obtained through the handler is retained until final consumption, so
 * counters are summed over the complete statement universe rather than a
 * hand-selected query.
 */
export interface G43MeasuredCursor {
  readonly query: string;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface G43SqlMeasurementSnapshot {
  readonly statements: readonly string[];
  readonly cursors: readonly G43MeasuredCursor[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

interface TrackedCursor {
  readonly query: string;
  readonly cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
}

export class G43SqlMeasurement {
  private readonly statements: string[] = [];
  private readonly cursors: TrackedCursor[] = [];
  private completed = false;

  instrument(sql: SqlStorage): SqlStorage {
    return new Proxy(sql, {
      get: (target, property, receiver) => {
        if (property === "exec") {
          return <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T> => {
            if (this.completed) throw new Error("G43 SQL measurement cannot observe a completed handler");
            const cursor = target.exec<T>(query, ...bindings);
            this.statements.push(query);
            this.cursors.push({
              query,
              cursor: cursor as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>,
            });
            return cursor;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SqlStorage;
  }

  complete(): G43SqlMeasurementSnapshot {
    if (this.completed) throw new Error("G43 SQL measurement is already complete");
    this.completed = true;
    const cursors = this.cursors.map(({ query, cursor }) => {
      // SqlStorage cursor counters are only final after full enumeration. This
      // consumes even write/no-row cursors, and makes an omitted statement
      // impossible to hide behind a partial cursor read.
      cursor.toArray();
      return { query, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
    });
    return Object.freeze({
      statements: Object.freeze([...this.statements]),
      cursors: Object.freeze(cursors),
      rowsRead: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      rowsWritten: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
    });
  }
}
