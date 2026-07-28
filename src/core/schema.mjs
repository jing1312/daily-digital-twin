// 中文注释：集中管理 SQLite 连接参数与版本化迁移，避免每个调用方各写一套建表语句。

export const SCHEMA_VERSION = 2;

// 中文注释：v1 基础表，保持与首个版本完全一致，便于旧库原地升级。
const BASE_TABLES = `
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request TEXT NOT NULL,
    state TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    state TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS resource_locks (
    resource TEXT PRIMARY KEY,
    task_id INTEGER NOT NULL,
    acquired_at TEXT NOT NULL
  );
`;

// 中文注释：v2 新增表，全部使用 IF NOT EXISTS，重复执行不报错。
const V2_TABLES = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS verification_waits (
    task_id INTEGER PRIMARY KEY,
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS execution_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    target TEXT,
    process_id INTEGER,
    process_name TEXT,
    detail TEXT,
    verified_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS token_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_hit INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    estimated_cost REAL,
    recorded_at TEXT NOT NULL
  );
`;

// 中文注释：v1 -> v2 需要补的列，按表分组，逐列判断是否已存在。
const ADDED_COLUMNS = {
  tasks: [
    ['paused_from', 'TEXT'],
    ['attempt', 'INTEGER NOT NULL DEFAULT 0'],
    ['failure_reason', 'TEXT'],
    ['resume_state', 'TEXT'],
    ['owner_open_id', 'TEXT']
  ],
  resource_locks: [['exclusive_class', 'TEXT']],
  token_ledger: [['cached_tokens', 'INTEGER NOT NULL DEFAULT 0']]
};

// 中文注释：前台动作全局互斥依赖这个部分唯一索引，后台动作 exclusive_class 为 NULL 不受限。
const V2_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS resource_locks_one_per_class
    ON resource_locks (exclusive_class) WHERE exclusive_class IS NOT NULL;
  CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, id);
  CREATE INDEX IF NOT EXISTS execution_evidence_task ON execution_evidence (task_id, id);
  CREATE INDEX IF NOT EXISTS token_ledger_task ON token_ledger (task_id, id);
  CREATE INDEX IF NOT EXISTS tasks_state ON tasks (state, paused);
`;

const KNOWN_TABLES = new Set(Object.keys(ADDED_COLUMNS));

// 中文注释：判断表是否已存在，用来区分"全新库"和"待升级的旧库"。
export function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

// 中文注释：读取列清单。PRAGMA 不支持参数占位，因此只允许白名单表名拼接。
export function listColumns(db, table) {
  if (!KNOWN_TABLES.has(table)) throw new Error(`不允许查询未登记的表：${table}`);
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

// 中文注释：幂等加列。ALTER TABLE ADD COLUMN 重复执行会抛 duplicate column name，必须先判断。
function addColumnIfMissing(db, table, column, definition) {
  if (listColumns(db, table).includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

// 中文注释：连接参数。WAL + busy_timeout 是并发的最低要求，但不能替代"短事务 + 遇忙重试"。
export function applyPragmas(db, { busyTimeoutMs = 5000 } = {}) {
  const timeout = Number.parseInt(busyTimeoutMs, 10);
  db.exec(`PRAGMA busy_timeout = ${Number.isFinite(timeout) && timeout > 0 ? timeout : 5000}`);
  db.exec('PRAGMA foreign_keys = ON');
  let journalMode = null;
  try {
    // 中文注释：内存库无法进入 WAL，会返回 memory，这是预期结果，不视为失败。
    journalMode = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode ?? null;
  } catch {
    journalMode = null;
  }
  db.exec('PRAGMA synchronous = NORMAL');
  return {
    journalMode,
    busyTimeout: Number(db.prepare('PRAGMA busy_timeout').get()?.timeout ?? 0),
    foreignKeys: Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys ?? 0) === 1
  };
}

// 中文注释：读取 schema 版本；没有 schema_meta 表时返回 null。
export function readSchemaVersion(db) {
  if (!tableExists(db, 'schema_meta')) return null;
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get();
  if (!row) return null;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function writeSchemaVersion(db, version) {
  db.prepare(`
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(version));
}

// 中文注释：版本闸 + 逐列幂等升级。返回迁移报告，供测试和 doctor 脚本核对。
export function migrate(db) {
  const preexistingTasks = tableExists(db, 'tasks');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  const recorded = readSchemaVersion(db);
  const fromVersion = recorded ?? (preexistingTasks ? 1 : 0);

  if (fromVersion >= SCHEMA_VERSION) {
    return { fromVersion, toVersion: fromVersion, addedColumns: [], migrated: false };
  }

  const addedColumns = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(BASE_TABLES);
    db.exec(V2_TABLES);
    for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
      for (const [column, definition] of columns) {
        if (addColumnIfMissing(db, table, column, definition)) addedColumns.push(`${table}.${column}`);
      }
    }
    db.exec(V2_INDEXES);
    writeSchemaVersion(db, SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { fromVersion, toVersion: SCHEMA_VERSION, addedColumns, migrated: true };
}
