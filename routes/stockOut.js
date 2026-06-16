const express = require('express');
const router = express.Router();
const { run, get, all, transaction } = require('../db/database');
const { updateInventory, checkAndCreateLowStockAlert, generateDocNo, getInventory } = require('../utils/inventory');

router.get('/', async (req, res) => {
  const { warehouse_id, start_date, end_date } = req.query;
  let sql = `
    SELECT d.*, w.name as warehouse_name
    FROM stock_documents d
    LEFT JOIN warehouses w ON d.warehouse_id = w.id
    WHERE d.doc_type = 'OUT'
  `;
  const params = [];

  if (warehouse_id) {
    sql += ' AND d.warehouse_id = ?';
    params.push(warehouse_id);
  }
  if (start_date) {
    sql += ' AND d.created_at >= ?';
    params.push(start_date);
  }
  if (end_date) {
    sql += ' AND d.created_at <= ?';
    params.push(end_date);
  }
  sql += ' ORDER BY d.id DESC';

  const docs = await all(sql, params);
  res.json({ success: true, data: docs });
});

router.get('/:id', async (req, res) => {
  const doc = await get(`
    SELECT d.*, w.name as warehouse_name
    FROM stock_documents d
    LEFT JOIN warehouses w ON d.warehouse_id = w.id
    WHERE d.id = ? AND d.doc_type = 'OUT'
  `, [req.params.id]);

  if (!doc) {
    return res.status(404).json({ success: false, message: '出库单不存在' });
  }

  const items = await all(`
    SELECT i.*, p.name as product_name, p.sku, p.unit
    FROM stock_document_items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.document_id = ?
  `, [req.params.id]);

  doc.items = items;
  res.json({ success: true, data: doc });
});

router.post('/', async (req, res) => {
  const { warehouse_id, ref_no, operator, remark, items } = req.body;

  if (!warehouse_id || !items || items.length === 0) {
    return res.status(400).json({ success: false, message: '仓库和商品明细不能为空' });
  }

  const warehouse = await get('SELECT * FROM warehouses WHERE id = ?', [warehouse_id]);
  if (!warehouse) {
    return res.status(404).json({ success: false, message: '仓库不存在' });
  }

  for (const item of items) {
    if (!item.product_id || !item.quantity || item.quantity <= 0) {
      return res.status(400).json({ success: false, message: '商品和数量必须有效' });
    }
    const product = await get('SELECT * FROM products WHERE id = ?', [item.product_id]);
    if (!product) {
      return res.status(404).json({ success: false, message: `商品ID ${item.product_id} 不存在` });
    }
    const inv = await getInventory(item.product_id, warehouse_id);
    if (!inv || inv.quantity < item.quantity) {
      return res.status(400).json({
        success: false,
        message: `商品 [${product.sku} ${product.name}] 库存不足，当前库存: ${inv ? inv.quantity : 0}，需出库: ${item.quantity}`
      });
    }
  }

  const doc_no = generateDocNo('OUT');
  const alerts = [];

  try {
    const docId = await transaction(async () => {
      const docInfo = await run(`
        INSERT INTO stock_documents (doc_no, doc_type, warehouse_id, ref_no, operator, remark, status)
        VALUES (?, 'OUT', ?, ?, ?, ?, 1)
      `, [doc_no, warehouse_id, ref_no || null, operator || 'system', remark || null]);

      const id = docInfo.lastID;

      for (const item of items) {
        await run(`
          INSERT INTO stock_document_items (document_id, product_id, quantity, unit_price, remark)
          VALUES (?, ?, ?, ?, ?)
        `, [id, item.product_id, item.quantity, item.unit_price || 0, item.remark || null]);

        await updateInventory(
          item.product_id, warehouse_id, -item.quantity,
          operator || 'system', 'STOCK_OUT', id,
          `出库单: ${doc_no}`
        );

        const alert = await checkAndCreateLowStockAlert(item.product_id, warehouse_id);
        if (alert) alerts.push(alert);
      }

      return id;
    });

    const doc = await get(`
      SELECT d.*, w.name as warehouse_name
      FROM stock_documents d
      LEFT JOIN warehouses w ON d.warehouse_id = w.id
      WHERE d.id = ?
    `, [docId]);

    const docItems = await all(`
      SELECT i.*, p.name as product_name, p.sku, p.unit
      FROM stock_document_items i
      LEFT JOIN products p ON i.product_id = p.id
      WHERE i.document_id = ?
    `, [docId]);

    doc.items = docItems;

    let message = '出库成功';
    if (alerts.length > 0) {
      message += `，注意：有${alerts.length}个商品触发低库存预警`;
    }

    res.json({
      success: true,
      data: doc,
      alerts: alerts,
      message: message
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
