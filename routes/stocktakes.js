const express = require('express');
const router = express.Router();
const { run, get, all, transaction } = require('../db/database');
const { updateInventory, checkAndCreateLowStockAlert, generateDocNo, getInventory } = require('../utils/inventory');

router.get('/', async (req, res) => {
  const { warehouse_id, start_date, end_date } = req.query;
  let sql = `
    SELECT s.*, w.name as warehouse_name
    FROM stocktakes s
    LEFT JOIN warehouses w ON s.warehouse_id = w.id
    WHERE 1=1
  `;
  const params = [];

  if (warehouse_id) {
    sql += ' AND s.warehouse_id = ?';
    params.push(warehouse_id);
  }
  if (start_date) {
    sql += ' AND s.created_at >= ?';
    params.push(start_date);
  }
  if (end_date) {
    sql += ' AND s.created_at <= ?';
    params.push(end_date);
  }
  sql += ' ORDER BY s.id DESC';

  const stocktakes = await all(sql, params);
  res.json({ success: true, data: stocktakes });
});

router.get('/:id', async (req, res) => {
  const stocktake = await get(`
    SELECT s.*, w.name as warehouse_name
    FROM stocktakes s
    LEFT JOIN warehouses w ON s.warehouse_id = w.id
    WHERE s.id = ?
  `, [req.params.id]);

  if (!stocktake) {
    return res.status(404).json({ success: false, message: '盘点单不存在' });
  }

  const items = await all(`
    SELECT i.*, p.name as product_name, p.sku, p.unit
    FROM stocktake_items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.stocktake_id = ?
  `, [req.params.id]);

  stocktake.items = items;
  res.json({ success: true, data: stocktake });
});

router.post('/', async (req, res) => {
  const { warehouse_id, operator, remark, items } = req.body;

  if (!warehouse_id || !items || items.length === 0) {
    return res.status(400).json({ success: false, message: '仓库和盘点明细不能为空' });
  }

  const warehouse = await get('SELECT * FROM warehouses WHERE id = ?', [warehouse_id]);
  if (!warehouse) {
    return res.status(404).json({ success: false, message: '仓库不存在' });
  }

  for (const item of items) {
    if (!item.product_id || item.actual_quantity === undefined || item.actual_quantity < 0) {
      return res.status(400).json({ success: false, message: '商品和实盘数量必须有效' });
    }
    const product = await get('SELECT * FROM products WHERE id = ?', [item.product_id]);
    if (!product) {
      return res.status(404).json({ success: false, message: `商品ID ${item.product_id} 不存在` });
    }
  }

  const stocktake_no = generateDocNo('ST');
  const alerts = [];

  try {
    const stId = await transaction(async () => {
      const stInfo = await run(`
        INSERT INTO stocktakes (stocktake_no, warehouse_id, operator, remark)
        VALUES (?, ?, ?, ?)
      `, [stocktake_no, warehouse_id, operator || 'system', remark || null]);

      const id = stInfo.lastID;

      for (const item of items) {
        const inv = await getInventory(item.product_id, warehouse_id);
        const systemQty = inv ? inv.quantity : 0;
        const actualQty = item.actual_quantity;
        const diffQty = actualQty - systemQty;

        await run(`
          INSERT INTO stocktake_items (stocktake_id, product_id, system_quantity, actual_quantity, diff_quantity, remark)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [id, item.product_id, systemQty, actualQty, diffQty, item.remark || null]);

        if (diffQty !== 0) {
          await updateInventory(
            item.product_id, warehouse_id, diffQty,
            operator || 'system', 'STOCKTAKE', id,
            `盘点调整: ${stocktake_no}, 原:${systemQty} 实:${actualQty} 差:${diffQty}`
          );

          const alert = await checkAndCreateLowStockAlert(item.product_id, warehouse_id);
          if (alert) alerts.push(alert);
        }
      }

      return id;
    });

    const stocktake = await get(`
      SELECT s.*, w.name as warehouse_name
      FROM stocktakes s
      LEFT JOIN warehouses w ON s.warehouse_id = w.id
      WHERE s.id = ?
    `, [stId]);

    const stItems = await all(`
      SELECT i.*, p.name as product_name, p.sku, p.unit
      FROM stocktake_items i
      LEFT JOIN products p ON i.product_id = p.id
      WHERE i.stocktake_id = ?
    `, [stId]);

    stocktake.items = stItems;

    const diffCount = stItems.filter(i => i.diff_quantity !== 0).length;
    let message = `盘点完成，共${stItems.length}个商品，${diffCount}个有差异已调整`;
    if (alerts.length > 0) {
      message += `，${alerts.length}个商品触发低库存预警`;
    }

    res.json({
      success: true,
      data: stocktake,
      alerts: alerts,
      message: message
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
