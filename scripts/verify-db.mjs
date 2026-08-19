import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) throw new Error("Podaj ścieżkę do lokalnego pliku SQLite.");

const db = new DatabaseSync(path, { readOnly: true });
const indexes = db
  .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name")
  .all();
const plan = db
  .prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM trade_events WHERE username = ? AND occurred_at >= ? ORDER BY occurred_at DESC",
  )
  .all("AtlasNomad", "2026-08-18");

console.log(JSON.stringify({ indexes, plan }, null, 2));
