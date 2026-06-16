const express = require('express');
const router = express.Router();
const { run, get, all, transaction } = require('../db/database');
const { updateInventory, generateDocNo } = require('../utils/inventory');

router.get('/', (req, res) => {
  const { warehouse_id, start_date, end_date } = req.query;
  let sql = `
    SELECT d.*, w.name as warehouse_name
    FROM stock_documents d
    LEFT JOIN warehouses w ON d.warehouse_id = w.id
    WHERE d.doc_type = 'IN'
  `;
  const params = [];

  if (warehouse_id) { sql += ' AND d.warehouse_id = ?'; params.push(warehouse_id); }
  if (start_date) { sql += ' AND d.created_at >= ?'; params.push(start_date); }
  if (end_date) { sql += ' AND d.created_at <= ?'; params.push(end_date); }
  sql += ' ORDER BY d.id DESC';

  const docs = all(sql, params);
  res.json({ success: true, data: docs });
});

router.get('/:id', (req, res) => {
  const doc = get(`
    SELECT d.*, w.name as warehouse_name
    FROM stock_documents d
    LEFT JOIN warehouses w ON d.warehouse_id = w.id
    WHERE d.id = ? AND d.doc_type = 'IN'
  `, [req.params.id]);

  if (!doc) return res.status(404).json({ success: false, message: '入库单不存在' });

  doc.items = all(`
    SELECT i.*, p.name as product_name, p.sku, p.unit
    FROM stock_document_items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.document_id = ?
  `, [req.params.id]);

  res.json({ success: true, data: doc });
});

router.post('/', async (req, res) => {
  const { warehouse_id, ref_no, operator, remark, items } = req.body;

  if (!warehouse_id || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: '仓库和商品明细不能为空' });
  }
  for (const it of items) {
    if (!it.product_id || !it.quantity || it.quantity <= 0) {
      return res.status(400).json({ success: false, message: '商品和数量必须有效' });
    }
  }

  try {
    const result = await transaction(() => {
      const warehouse = get('SELECT * FROM warehouses WHERE id = ?', [warehouse_id]);
      if (!warehouse) throw new Error('仓库不存在');

      const productIds = items.map(i => i.product_id);
      const placeholders = productIds.map(() => '?').join(',');
      const productRows = all(`SELECT * FROM products WHERE id IN (${placeholders})`, productIds);
      const productMap = {};
      for (const p of productRows) productMap[p.id] = p;

      for (const it of items) {
        if (!productMap[it.product_id]) {
          throw new Error(`商品ID ${it.product_id} 不存在`);
        }
      }

      const doc_no = generateDocNo('IN');
      const docInfo = run(`
        INSERT INTO stock_documents (doc_no, doc_type, warehouse_id, ref_no, operator, remark, status)
        VALUES (?, 'IN', ?, ?, ?, ?, 1)
      `, [doc_no, warehouse_id, ref_no || null, operator || 'system', remark || null]);

      const docId = docInfo.lastID;

      for (const it of items) {
        run(`
          INSERT INTO stock_document_items (document_id, product_id, quantity, unit_price, remark)
          VALUES (?, ?, ?, ?, ?)
        `, [docId, it.product_id, it.quantity, it.unit_price || 0, it.remark || null]);

        updateInventory(
          it.product_id, warehouse_id, it.quantity,
          operator || 'system', 'STOCK_IN', docId,
          `入库单: ${doc_no}`
        );
      }

      return docId;
    });

    const doc = get(`
      SELECT d.*, w.name as warehouse_name
      FROM stock_documents d
      LEFT JOIN warehouses w ON d.warehouse_id = w.id
      WHERE d.id = ?
    `, [result]);
    doc.items = all(`
      SELECT i.*, p.name as product_name, p.sku, p.unit
      FROM stock_document_items i
      LEFT JOIN products p ON i.product_id = p.id
      WHERE i.document_id = ?
    `, [result]);

    res.json({ success: true, data: doc, message: '入库成功' });
  } catch (err) {
    res.status(err.message === '仓库不存在' ? 404 : 500).json({ success: false, message: err.message });
  }
});

module.exports = router;
