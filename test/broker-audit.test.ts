// Broker audit event + the audit_log CHECK migration.
//
// Milestone 3 makes each brokered call a first-class `broker` audit event. That
// required widening audit_log's event CHECK constraint, which SQLite can't alter
// in place — so the store rebuilds the table on DBs created before the broker.
// These tests cover both a fresh DB and a real pre-broker DB being migrated.

import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

const P = process.pid;
const FRESH = join(tmpdir(), `stm-brokeraudit-fresh-${P}.sqlite`);
const OLD = join(tmpdir(), `stm-brokeraudit-old-${P}.sqlite`);

afterAll(() => {
  for (const f of [FRESH, OLD]) {
    for (const s of ["", "-wal", "-shm"]) {
      try { rmSync(f + s); } catch { /* ignore */ }
    }
  }
});

test("fresh DB records and filters a broker audit event", () => {
  const s = new Store(FRESH);
  s.recordAudit({
    event: "broker",
    tool: "openai",
    label: "default",
    command: "GET /v1/models -> 200",
    agent: "broker",
  });
  const rows = s.listAudit({ event: "broker" });
  s.close();
  expect(rows).toHaveLength(1);
  expect(rows[0].event).toBe("broker");
  expect(rows[0].command).toContain("/v1/models");
  expect(rows[0].agent).toBe("broker");
});

test("a pre-broker DB is migrated so it accepts broker events, rows preserved", () => {
  // Build an OLD-schema audit_log whose CHECK does NOT include 'broker'.
  const raw = new Database(OLD);
  raw.exec(`
    CREATE TABLE audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT NOT NULL,
      event      TEXT NOT NULL CHECK(event IN (
                   'substitute','policy.deny','policy.warn','unresolved','malformed')),
      tool TEXT, label TEXT, command TEXT, agent TEXT, policy_id INTEGER, reason TEXT
    );
    INSERT INTO audit_log (ts,event,tool,label,command,agent)
      VALUES ('2026-01-01T00:00:00Z','substitute','openai','default','echo hi','claude-code');
  `);
  // Precondition: the old table rejects a broker event.
  expect(() => raw.exec(`INSERT INTO audit_log (ts,event) VALUES ('x','broker')`)).toThrow();
  raw.close();

  // Opening through Store runs the rebuild migration.
  const s = new Store(OLD);
  expect(s.auditCount()).toBe(1); // legacy row preserved

  // Broker events are now accepted.
  s.recordAudit({
    event: "broker",
    tool: "fal",
    label: "default",
    command: "POST /run -> 200",
    agent: "broker",
  });
  const brokerRows = s.listAudit({ event: "broker" });
  expect(brokerRows).toHaveLength(1);
  expect(brokerRows[0].tool).toBe("fal");

  // Re-opening is a no-op (idempotent migration).
  s.close();
  const s2 = new Store(OLD);
  expect(s2.auditCount()).toBe(2);
  s2.close();
});
