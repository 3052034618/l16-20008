const express = require('express');
const router = express.Router();
const { run, get, all } = require('../db/database');
const { checkAndCreateLowStockAlert } = require('../utils/inventory');

router.get('/', async (req, res) => {
  const { warehouse_id, product_id, is_resolved } = req.query;
  let sql = `
    SELECT a.*, p.sku, p.name as product_name, p.unit,
           p.low_stock_threshold,
           w.code as warehouse_code, w.name as warehouse_name
    FROM stock_alerts a
    LEFT JOIN products p ON a.product_id = p.id
    LEFT JOIN warehouses w ON a.warehouse_id = w.id
    WHERE 1=1
  `;
  const params = [];

  if (warehouse_id) {
    sql += ' AND a.warehouse_id = ?';
    params.push(warehouse_id);
  }
  if (product_id) {
    sql += ' AND a.product_id = ?';
    params.push(product_id);
  }
  if (is_resolved !== undefined) {
    sql += ' AND a.is_resolved = ?';
    params.push(is_resolved === 'true' || is_resolved === 1 ? 1 : 0);
  }
  sql += ' ORDER BY a.is_resolved ASC, a.id DESC';

  const alerts = await all(sql, params);
  res.json({ success: true, data: alerts });
});

router.get('/stats', async (req, res) => {
  const unresolved = await get(`
    SELECT COUNT(*) as cnt FROM stock_alerts WHERE is_resolved = 0
  `);

  const byWarehouse = await all(`
    SELECT a.warehouse_id, w.name as warehouse_name, COUNT(*) as alert_count
    FROM stock_alerts a
    LEFT JOIN warehouses w ON a.warehouse_id = w.id
    WHERE a.is_resolved = 0
    GROUP BY a.warehouse_id
  `);

  res.json({
    success: true,
    data: {
      unresolved_count: unresolved ? unresolved.cnt : 0,
      by_warehouse: byWarehouse
    }
  });
});

router.put('/:id/resolve', async (req, res) => {
  const alert = await get('SELECT * FROM stock_alerts WHERE id = ?', [req.params.id]);
  if (!alert) {
    return res.status(404).json({ success: false, message: '预警记录不存在' });
  }
  await run('UPDATE stock_alerts SET is_resolved = 1 WHERE id = ?', [req.params.id]);
  res.json({ success: true, message: '预警已处理' });
});

router.post('/scan-all', async (req, res) => {
  const { warehouse_id } = req.body;
  const inventory = await all(`
    SELECT i.*, p.low_stock_threshold
    FROM inventory i
    LEFT JOIN products p ON i.product_id = p.id
    ${warehouse_id ? 'WHERE i.warehouse_id = ?' : ''}
  `, warehouse_id ? [warehouse_id] : []);

  const alerts = [];
  for (const inv of inventory) {
    const alert = await checkAndCreateLowStockAlert(inv.product_id, inv.warehouse_id);
    if (alert) alerts.push(alert);
  }
  res.json({ success: true, data: alerts, message: `扫描完成，新产生${alerts.length}条预警` });
});

module.exports = router;
