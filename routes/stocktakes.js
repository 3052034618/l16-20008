const express = require('express');
const router = express.Router();
const { run, get, all, transaction } = require('../db/database');
const { updateInventory, checkAndCreateLowStockAlert, generateDocNo, getInventory } = require('../utils/inventory');

router.get('/', (req, res) => {
  const { warehouse_id, start_date, end_date } = req.query;
  let sql = `
    SELECT s.*, w.name as warehouse_name
    FROM stocktakes s
    LEFT JOIN warehouses w ON s.warehouse_id = w.id
    WHERE 1=1
  `;
  const params = [];
  if (warehouse_id) { sql += ' AND s.warehouse_id = ?'; params.push(warehouse_id); }
  if (start_date) { sql += ' AND s.created_at >= ?'; params.push(start_date); }
  if (end_date) { sql += ' AND s.created_at <= ?'; params.push(end_date); }
  sql += ' ORDER BY s.id DESC';
  res.json({ success: true, data: all(sql, params) });
});

router.get('/:id', (req, res) => {
  const stocktake = get(`
    SELECT s.*, w.name as warehouse_name
    FROM stocktakes s
    LEFT JOIN warehouses w ON s.warehouse_id = w.id
    WHERE s.id = ?
  `, [req.params.id]);
  if (!stocktake) return res.status(404).json({ success: false, message: '盘点单不存在' });
  stocktake.items = all(`
    SELECT i.*, p.name as product_name, p.sku, p.unit
    FROM stocktake_items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.stocktake_id = ?
  `, [req.params.id]);
  res.json({ success: true, data: stocktake });
});

router.post('/', async (req, res) => {
  const { warehouse_id, operator, remark, items } = req.body;

  if (!warehouse_id || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: '仓库和盘点明细不能为空' });
  }
  for (const it of items) {
    if (!it.product_id || it.actual_quantity === undefined || it.actual_quantity < 0) {
      return res.status(400).json({ success: false, message: '商品和实盘数量必须有效' });
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

      for (const it of items) {
        if (!productMap[it.product_id]) {
          throw new Error(`商品ID ${it.product_id} 不存在`);
        }
      }

      const stocktake_no = generateDocNo('ST');
      const stInfo = run(`
        INSERT INTO stocktakes (stocktake_no, warehouse_id, operator, remark)
        VALUES (?, ?, ?, ?)
      `, [stocktake_no, warehouse_id, operator || 'system', remark || null]);

      const stId = stInfo.lastID;
      const alerts = [];

      for (const it of items) {
        const inv = getInventory(it.product_id, warehouse_id);
        const systemQty = inv ? inv.quantity : 0;
        const actualQty = it.actual_quantity;
        const diffQty = actualQty - systemQty;

        run(`
          INSERT INTO stocktake_items (stocktake_id, product_id, system_quantity, actual_quantity, diff_quantity, remark)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [stId, it.product_id, systemQty, actualQty, diffQty, it.remark || null]);

        if (diffQty !== 0) {
          updateInventory(
            it.product_id, warehouse_id, diffQty,
            operator || 'system', 'STOCKTAKE', stId,
            `盘点调整: ${stocktake_no}, 原:${systemQty} 实:${actualQty} 差:${diffQty}`
          );
          const alert = checkAndCreateLowStockAlert(it.product_id, warehouse_id);
          if (alert) alerts.push(alert);
        }
      }

      return { stId, alerts, total: items.length };
    });

    const stocktake = get(`
      SELECT s.*, w.name as warehouse_name
      FROM stocktakes s
      LEFT JOIN warehouses w ON s.warehouse_id = w.id
      WHERE s.id = ?
    `, [txResult.stId]);
    stocktake.items = all(`
      SELECT i.*, p.name as product_name, p.sku, p.unit
      FROM stocktake_items i
      LEFT JOIN products p ON i.product_id = p.id
      WHERE i.stocktake_id = ?
    `, [txResult.stId]);

    const diffCount = stocktake.items.filter(i => i.diff_quantity !== 0).length;
    let message = `盘点完成，共${txResult.total}个商品，${diffCount}个有差异已调整`;
    if (txResult.alerts.length > 0) {
      message += `，${txResult.alerts.length}个商品触发低库存预警`;
    }

    res.json({ success: true, data: stocktake, alerts: txResult.alerts, message });
  } catch (err) {
    const msg = err.message;
    const isClient = /不存在/.test(msg);
    res.status(isClient ? 400 : 500).json({ success: false, message: msg });
  }
});

module.exports = router;
