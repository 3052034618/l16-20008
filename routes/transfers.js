const express = require('express');
const router = express.Router();
const { run, get, all, transaction } = require('../db/database');
const { updateInventory, checkAndCreateLowStockAlert, generateDocNo, getInventory } = require('../utils/inventory');

router.get('/', (req, res) => {
  const { from_warehouse_id, to_warehouse_id, start_date, end_date } = req.query;
  let sql = `
    SELECT t.*,
           fw.name as from_warehouse_name,
           tw.name as to_warehouse_name
    FROM transfers t
    LEFT JOIN warehouses fw ON t.from_warehouse_id = fw.id
    LEFT JOIN warehouses tw ON t.to_warehouse_id = tw.id
    WHERE 1=1
  `;
  const params = [];

  if (from_warehouse_id) { sql += ' AND t.from_warehouse_id = ?'; params.push(from_warehouse_id); }
  if (to_warehouse_id) { sql += ' AND t.to_warehouse_id = ?'; params.push(to_warehouse_id); }
  if (start_date) { sql += ' AND t.created_at >= ?'; params.push(start_date); }
  if (end_date) { sql += ' AND t.created_at <= ?'; params.push(end_date); }
  sql += ' ORDER BY t.id DESC';

  const transfers = all(sql, params);
  res.json({ success: true, data: transfers });
});

router.get('/:id', (req, res) => {
  const transfer = get(`
    SELECT t.*,
           fw.name as from_warehouse_name,
           tw.name as to_warehouse_name
    FROM transfers t
    LEFT JOIN warehouses fw ON t.from_warehouse_id = fw.id
    LEFT JOIN warehouses tw ON t.to_warehouse_id = tw.id
    WHERE t.id = ?
  `, [req.params.id]);

  if (!transfer) return res.status(404).json({ success: false, message: '调拨单不存在' });

  transfer.items = all(`
    SELECT i.*, p.name as product_name, p.sku, p.unit
    FROM transfer_items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.transfer_id = ?
  `, [req.params.id]);

  res.json({ success: true, data: transfer });
});

router.post('/', async (req, res) => {
  const { from_warehouse_id, to_warehouse_id, operator, remark, items } = req.body;

  if (!from_warehouse_id || !to_warehouse_id) {
    return res.status(400).json({ success: false, message: '源仓库和目标仓库不能为空' });
  }
  if (String(from_warehouse_id) === String(to_warehouse_id)) {
    return res.status(400).json({ success: false, message: '源仓库和目标仓库不能相同' });
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: '商品明细不能为空' });
  }
  for (const it of items) {
    if (!it.product_id || !it.quantity || it.quantity <= 0) {
      return res.status(400).json({ success: false, message: '商品和数量必须有效' });
    }
  }

  try {
    const txResult = await transaction(() => {
      const fromWh = get('SELECT * FROM warehouses WHERE id = ?', [from_warehouse_id]);
      const toWh = get('SELECT * FROM warehouses WHERE id = ?', [to_warehouse_id]);
      if (!fromWh) throw new Error('源仓库不存在');
      if (!toWh) throw new Error('目标仓库不存在');

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
        const inv = getInventory(it.product_id, from_warehouse_id);
        const curQty = inv ? inv.quantity : 0;
        if (curQty < it.quantity) {
          stockErrors.push(`商品 [${p.sku} ${p.name}] 在源仓库库存不足，当前库存: ${curQty}，需调拨: ${it.quantity}`);
        }
      }
      if (stockErrors.length > 0) {
        throw new Error(stockErrors.join('；'));
      }

      const transfer_no = generateDocNo('TF');
      const tfInfo = run(`
        INSERT INTO transfers (transfer_no, from_warehouse_id, to_warehouse_id, operator, remark, status)
        VALUES (?, ?, ?, ?, ?, 1)
      `, [transfer_no, from_warehouse_id, to_warehouse_id, operator || 'system', remark || null]);

      const tfId = tfInfo.lastID;
      const alerts = [];

      for (const it of items) {
        run(`
          INSERT INTO transfer_items (transfer_id, product_id, quantity)
          VALUES (?, ?, ?)
        `, [tfId, it.product_id, it.quantity]);

        updateInventory(
          it.product_id, from_warehouse_id, -it.quantity,
          operator || 'system', 'TRANSFER_OUT', tfId,
          `调拨出库: ${transfer_no} -> ${toWh.name}`
        );

        updateInventory(
          it.product_id, to_warehouse_id, it.quantity,
          operator || 'system', 'TRANSFER_IN', tfId,
          `调拨入库: ${transfer_no} <- ${fromWh.name}`
        );

        const alert = checkAndCreateLowStockAlert(it.product_id, from_warehouse_id);
        if (alert) alerts.push(alert);
      }

      return { tfId, alerts };
    });

    const transfer = get(`
      SELECT t.*,
             fw.name as from_warehouse_name,
             tw.name as to_warehouse_name
      FROM transfers t
      LEFT JOIN warehouses fw ON t.from_warehouse_id = fw.id
      LEFT JOIN warehouses tw ON t.to_warehouse_id = tw.id
      WHERE t.id = ?
    `, [txResult.tfId]);
    transfer.items = all(`
      SELECT i.*, p.name as product_name, p.sku, p.unit
      FROM transfer_items i
      LEFT JOIN products p ON i.product_id = p.id
      WHERE i.transfer_id = ?
    `, [txResult.tfId]);

    let message = '调拨成功';
    if (txResult.alerts.length > 0) {
      message += `，注意：源仓库有${txResult.alerts.length}个商品触发低库存预警`;
    }

    res.json({ success: true, data: transfer, alerts: txResult.alerts, message });
  } catch (err) {
    const msg = err.message;
    const isClient = /不存在|库存不足|不能相同/.test(msg);
    res.status(isClient ? 400 : 500).json({ success: false, message: msg });
  }
});

module.exports = router;
