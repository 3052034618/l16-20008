const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'inventory.db');
let db = null;
let inTransaction = false;

let _writeChain = Promise.resolve();
function serializedWrite(fn) {
  const result = _writeChain.then(() => fn());
  _writeChain = result.catch(() => {});
  return result;
}

let _readyResolve = null;
const ready = new Promise(resolve => { _readyResolve = resolve; });
let isReady = false;

function save() {
  if (inTransaction) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

function run(sql, params = []) {
  if (!db) throw new Error('数据库未就绪');
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  stmt.step();
  const changes = db.getRowsModified();
  const lastID = db.exec('SELECT last_insert_rowid() as id')[0]?.values[0]?.[0];
  stmt.free();
  save();
  return { lastID, changes };
}

function get(sql, params = []) {
  if (!db) throw new Error('数据库未就绪');
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function all(sql, params = []) {
  if (!db) throw new Error('数据库未就绪');
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function exec(sql) {
  if (!db) throw new Error('数据库未就绪');
  db.run(sql);
  save();
}

function serialize(fn) {
  return fn();
}

function runTransactionSync(fn) {
  if (!db) throw new Error('数据库未就绪');
  inTransaction = true;
  try {
    db.run('BEGIN EXCLUSIVE TRANSACTION');
    const result = fn();
    db.run('COMMIT');
    inTransaction = false;
    save();
    return result;
  } catch (err) {
    try { db.run('ROLLBACK'); } catch (e) {}
    inTransaction = false;
    save();
    throw err;
  }
}

async function transaction(fn) {
  return serializedWrite(() => Promise.resolve(runTransactionSync(fn)));
}

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    console.log('数据库加载成功');
  } else {
    db = new SQL.Database();
    console.log('新数据库创建成功');
  }

  const tables = [];

  tables.push(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      unit TEXT DEFAULT '个',
      spec TEXT,
      low_stock_threshold INTEGER DEFAULT 10,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      manager TEXT,
      phone TEXT,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(product_id, warehouse_id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS stock_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no TEXT UNIQUE NOT NULL,
      doc_type TEXT NOT NULL,
      warehouse_id INTEGER NOT NULL,
      ref_no TEXT,
      operator TEXT,
      remark TEXT,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS stock_document_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL DEFAULT 0,
      remark TEXT,
      FOREIGN KEY (document_id) REFERENCES stock_documents(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_no TEXT UNIQUE NOT NULL,
      from_warehouse_id INTEGER NOT NULL,
      to_warehouse_id INTEGER NOT NULL,
      operator TEXT,
      remark TEXT,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id)
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS transfer_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      FOREIGN KEY (transfer_id) REFERENCES transfers(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS stock_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      current_quantity INTEGER NOT NULL,
      threshold INTEGER NOT NULL,
      alert_type TEXT DEFAULT 'low_stock',
      is_resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS stocktakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stocktake_no TEXT UNIQUE NOT NULL,
      warehouse_id INTEGER NOT NULL,
      operator TEXT,
      remark TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS stocktake_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stocktake_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      system_quantity INTEGER NOT NULL,
      actual_quantity INTEGER NOT NULL,
      diff_quantity INTEGER NOT NULL,
      remark TEXT,
      FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS inventory_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      change_type TEXT NOT NULL,
      change_quantity INTEGER NOT NULL,
      before_quantity INTEGER NOT NULL,
      after_quantity INTEGER NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      operator TEXT,
      remark TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    )
  `);

  tables.push(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      expires_at TEXT NOT NULL
    )
  `);

  for (const sql of tables) {
    db.run(sql);
  }

  try {
    const cols = db.exec("PRAGMA table_info(idempotency_keys)");
    const colNames = cols[0]?.values?.map(c => c[1]) || [];
    if (!colNames.includes('status')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS idempotency_keys_new (
          key TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT,
          created_at TEXT DEFAULT (datetime('now', 'localtime')),
          updated_at TEXT DEFAULT (datetime('now', 'localtime')),
          expires_at TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT OR IGNORE INTO idempotency_keys_new (key, type, status, result_json, expires_at, created_at)
        SELECT key, type, 'DONE', result_json, expires_at, created_at FROM idempotency_keys
      `);
      db.exec(`DROP TABLE IF EXISTS idempotency_keys`);
      db.exec(`ALTER TABLE idempotency_keys_new RENAME TO idempotency_keys`);
    }
  } catch (e) {
    console.log('迁移 idempotency_keys 表时跳过:', e.message);
  }

  db.run(`DELETE FROM idempotency_keys WHERE expires_at <= datetime('now', 'localtime')`);

  const warehouseCount = get('SELECT COUNT(*) as cnt FROM warehouses');
  if (!warehouseCount || warehouseCount.cnt === 0) {
    const insertWh = `INSERT INTO warehouses (code, name, address, manager, phone) VALUES (?, ?, ?, ?, ?)`;
    run(insertWh, ['WH001', '总仓', '北京市朝阳区总仓路1号', '张三', '13800138001']);
    run(insertWh, ['WH002', '分仓A', '上海市浦东区分仓路2号', '李四', '13800138002']);
    run(insertWh, ['WH003', '分仓B', '广州市天河区分仓路3号', '王五', '13800138003']);
  }

  const productCount = get('SELECT COUNT(*) as cnt FROM products');
  if (!productCount || productCount.cnt === 0) {
    const insertProd = `INSERT INTO products (sku, name, category, unit, spec, low_stock_threshold, description) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    run(insertProd, ['SKU001', '苹果 iPhone 15', '电子产品', '台', '256GB 黑色', 5, '苹果智能手机']);
    run(insertProd, ['SKU002', '华为 Mate60', '电子产品', '台', '512GB 白色', 5, '华为智能手机']);
    run(insertProd, ['SKU003', '小米14', '电子产品', '台', '256GB 蓝色', 10, '小米智能手机']);
    run(insertProd, ['SKU004', '无线鼠标', '办公设备', '个', '蓝牙版', 20, '办公用无线鼠标']);
    run(insertProd, ['SKU005', '机械键盘', '办公设备', '个', '青轴', 15, '办公用机械键盘']);
  }

  save();
  isReady = true;
  _readyResolve(true);
  console.log('数据库初始化完成');
}

initDatabase().catch(err => {
  console.error('数据库初始化失败:', err);
  _readyResolve(false);
});

const IDEMPOTENCY_TTL_DAYS = 30;

function runInTransaction(sql, params = []) {
  if (!db) throw new Error('数据库未就绪');
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  stmt.step();
  const changes = db.getRowsModified();
  const lastID = db.exec('SELECT last_insert_rowid() as id')[0]?.values[0]?.[0];
  stmt.free();
  return { lastID, changes };
}

function getInTransaction(sql, params = []) {
  if (!db) throw new Error('数据库未就绪');
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function ensureIdempotency(key, type) {
  if (!key) {
    return { isFirst: true };
  }
  const result = runInTransaction(
    `INSERT OR IGNORE INTO idempotency_keys (key, type, status, created_at, updated_at, expires_at)
     VALUES (?, ?, 'PROCESSING', datetime('now', 'localtime'), datetime('now', 'localtime'), datetime('now', 'localtime', '+${IDEMPOTENCY_TTL_DAYS} days'))`,
    [key, type]
  );
  if (result.changes === 1) {
    return { isFirst: true };
  }
  const row = getInTransaction(
    `SELECT status, result_json FROM idempotency_keys WHERE key = ?`,
    [key]
  );
  if (!row) {
    return { isFirst: true };
  }
  if (row.status === 'DONE') {
    return {
      isFirst: false,
      cachedResult: row.result_json ? JSON.parse(row.result_json) : null
    };
  }
  if (row.status === 'PROCESSING') {
    throw new Error('正在处理中...稍后重试');
  }
  return { isFirst: true };
}

function finalizeIdempotency(key, resultObject) {
  if (!key) return;
  runInTransaction(
    `UPDATE idempotency_keys SET status = 'DONE', result_json = ?, updated_at = datetime('now', 'localtime') WHERE key = ?`,
    [JSON.stringify(resultObject), key]
  );
}

module.exports = {
  ready,
  isReady: () => isReady,
  serializedWrite,
  db,
  run,
  get,
  all,
  exec,
  serialize,
  transaction,
  runTransactionSync,
  ensureIdempotency,
  finalizeIdempotency
};
