const express = require('express');
const router = express.Router();
const { run, get, all, transaction, checkIdempotency, saveIdempotency } = require('../db/database');
const { updateInventory, checkAndCreateLowStockAlert, generateDocNo, getInventory } = require('../utils/inventory');

router.get('/', (req, res) => {
  const { warehouse_id, start_date, end_date, product_id, doc_no } = req.query;
  let sql = `
    SELECT DISTINCT d.*, w.name as warehouse_name
    FROM stock_documents d
    LEFT JOIN warehouses w ON d.warehouse_id = w.id
  `;
  const params = [];
  const conditions = [`d.doc_type = 'OUT'`];

  if (warehouse_id) { conditions.push('d.warehouse_id = ?'); params.push(warehouse_id); }
  if (doc_no) { conditions.push('d.doc_no LIKE ?'); params.push(`%${doc_no}%`); }
  if (start_date) { conditions.push('d.created_at >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('d.created_at <= ?'); params.push(end_date); }

  if (product_id) {
    sql += `
      INNER JOIN stock_document_items di ON d.id = di.document_id
    `;
    conditions.push('di.product_id = ?');
    params.push(product_id);
  }

  sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY d.id DESC';

  const docs = all(sql, params);
  res.json({ success: true, data: docs });
});

router.get('/:id', (req, res) => {
  const doc = get(`
    SELECT d.*, w.name as warehouse_name
    FROM stock_documents d
    LEFT JOIN warehouses w ON d.warehouse_id = w.id
    WHERE d.id = ? AND d.doc_type = 'OUT'
  `, [req.params.id]);

  if (!doc) return res.status(404).json({ success: false, message: '出库单不存在' });

  doc.items = all(`
    SELECT i.*, p.name as product_name, p.sku, p.unit
    FROM stock_document_items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.document_id = ?
  `, [req.params.id]);

  doc.inventory_logs = all(`
    SELECT il.*, p.name as product_name, p.sku, w.name as warehouse_name
    FROM inventory_logs il
    LEFT JOIN products p ON il.product_id = p.id
    LEFT JOIN warehouses w ON il.warehouse_id = w.id
    WHERE il.ref_type = 'STOCK_OUT' AND il.ref_id = ?
    ORDER BY il.id
  `, [req.params.id]);

  res.json({ success: true, data: doc });
});

router.post('/', async (req, res) => {
  const { request_id, warehouse_id, ref_no, operator, remark, items } = req.body;

  if (request_id) {
    const cached = await checkIdempotency(request_id);
    if (cached) {
      return res.json({ ...cached, idempotent: true });
    }
  }

  if (!warehouse_id || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: '仓库和商品明细不能为空' });
  }
  for (const it of items) {
    if (!it.product_id || !it.quantity || it.quantity <= 0) {
      return res.status(400).json({ success: false, message: '商品和数量必须有效' });
    }
  }

  try {
    const txResult = await transaction(() => {
      const warehouse = get('SELECT * FROM warehouses WHERE id = ?', [warehouse_id]);
      if (!warehouse) throw new Error('仓库不存在');

      const productIds = items.map(i => i.product_id);
      const placeholders = productIds.map(() => '?').join(',');
      const productRows = all(`SELECT * FROM products WHERE id IN (${placeholders})`, productIds);
      const productMap = {};
      for (const p of productRows) productMap[p.id] = p;

      const stockErrors = [];
      for (const it of items) {
        const p = productMap[it.product_id];
        if (!p) {
          stockErrors.push(`商品ID ${it.product_id} 不存在`);
          continue;
        }
        const inv = getInventory(it.product_id, warehouse_id);
        const curQty = inv ? inv.quantity : 0;
        if (curQty < it.quantity) {
          stockErrors.push(`商品 [${p.sku} ${p.name}] 库存不足，当前库存: ${curQty}，需出库: ${it.quantity}`);
        }
      }
      if (stockErrors.length > 0) {
        throw new Error(stockErrors.join('；'));
      }

      const doc_no = generateDocNo('OUT');
      const docInfo = run(`
        INSERT INTO stock_documents (doc_no, doc_type, warehouse_id, ref_no, operator, remark, status)
        VALUES (?, 'OUT', ?, ?, ?, ?, 1)
      `, [doc_no, warehouse_id, ref_no || null, operator || 'system', remark || null]);

      const docId = docInfo.lastID;
      const alerts = [];

      for (const it of items) {
        run(`
          INSERT INTO stock_document_items (document_id, product_id, quantity, unit_price, remark)
          VALUES (?, ?, ?, ?, ?)
        `, [docId, it.product_id, it.quantity, it.unit_price || 0, it.remark || null]);

        updateInventory(
          it.product_id, warehouse_id, -it.quantity,
          operator || 'system', 'STOCK_OUT', docId,
          `出库单: ${doc_no}`
        );

        const alert = checkAndCreateLowStockAlert(it.product_id, warehouse_id);
        if (alert) alerts.push(alert);
      }

      return { docId, alerts };
    });

    const doc = get(`
      SELECT d.*, w.name as warehouse_name
      FROM stock_documents d
      LEFT JOIN warehouses w ON d.warehouse_id = w.id
      WHERE d.id = ?
    `, [txResult.docId]);
    doc.items = all(`
      SELECT i.*, p.name as product_name, p.sku, p.unit
      FROM stock_document_items i
      LEFT JOIN products p ON i.product_id = p.id
      WHERE i.document_id = ?
    `, [txResult.docId]);

    let message = '出库成功';
    if (txResult.alerts.length > 0) {
      message += `，注意：有${txResult.alerts.length}个商品触发低库存预警`;
    }

    const responseBody = { success: true, data: doc, alerts: txResult.alerts, message };

    if (request_id) {
      await saveIdempotency(request_id, 'STOCK_OUT', responseBody);
    }

    res.json(responseBody);
  } catch (err) {
    const msg = err.message;
    const isClient = /不存在|库存不足/.test(msg);
    res.status(isClient ? 400 : 500).json({ success: false, message: msg });
  }
});

module.exports = router;
