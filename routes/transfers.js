const express = require('express');
const router = express.Router();
const { run, get, all, transaction } = require('../db/database');
const { updateInventory, checkAndCreateLowStockAlert, generateDocNo, getInventory } = require('../utils/inventory');

router.get('/', async (req, res) => {
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

  if (from_warehouse_id) {
    sql += ' AND t.from_warehouse_id = ?';
    params.push(from_warehouse_id);
  }
  if (to_warehouse_id) {
    sql += ' AND t.to_warehouse_id = ?';
    params.push(to_warehouse_id);
  }
  if (start_date) {
    sql += ' AND t.created_at >= ?';
    params.push(start_date);
  }
  if (end_date) {
    sql += ' AND t.created_at <= ?';
    params.push(end_date);
  }
  sql += ' ORDER BY t.id DESC';

  const transfers = await all(sql, params);
  res.json({ success: true, data: transfers });
});

router.get('/:id', async (req, res) => {
  const transfer = await get(`
    SELECT t.*,
           fw.name as from_warehouse_name,
           tw.name as to_warehouse_name
    FROM transfers t
    LEFT JOIN warehouses fw ON t.from_warehouse_id = fw.id
    LEFT JOIN warehouses tw ON t.to_warehouse_id = tw.id
    WHERE t.id = ?
  `, [req.params.id]);

  if (!transfer) {
    return res.status(404).json({ success: false, message: '调拨单不存在' });
  }

  const items = await all(`
    SELECT i.*, p.name as product_name, p.sku, p.unit
    FROM transfer_items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.transfer_id = ?
  `, [req.params.id]);

  transfer.items = items;
  res.json({ success: true, data: transfer });
});

router.post('/', async (req, res) => {
  const { from_warehouse_id, to_warehouse_id, operator, remark, items } = req.body;

  if (!from_warehouse_id || !to_warehouse_id) {
    return res.status(400).json({ success: false, message: '源仓库和目标仓库不能为空' });
  }
  if (from_warehouse_id === to_warehouse_id) {
    return res.status(400).json({ success: false, message: '源仓库和目标仓库不能相同' });
  }
  if (!items || items.length === 0) {
    return res.status(400).json({ success: false, message: '商品明细不能为空' });
  }

  const fromWh = await get('SELECT * FROM warehouses WHERE id = ?', [from_warehouse_id]);
  const toWh = await get('SELECT * FROM warehouses WHERE id = ?', [to_warehouse_id]);
  if (!fromWh) return res.status(404).json({ success: false, message: '源仓库不存在' });
  if (!toWh) return res.status(404).json({ success: false, message: '目标仓库不存在' });

  for (const item of items) {
    if (!item.product_id || !item.quantity || item.quantity <= 0) {
      return res.status(400).json({ success: false, message: '商品和数量必须有效' });
    }
    const product = await get('SELECT * FROM products WHERE id = ?', [item.product_id]);
    if (!product) {
      return res.status(404).json({ success: false, message: `商品ID ${item.product_id} 不存在` });
    }
    const inv = await getInventory(item.product_id, from_warehouse_id);
    if (!inv || inv.quantity < item.quantity) {
      return res.status(400).json({
        success: false,
        message: `商品 [${product.sku} ${product.name}] 在源仓库库存不足，当前库存: ${inv ? inv.quantity : 0}，需调拨: ${item.quantity}`
      });
    }
  }

  const transfer_no = generateDocNo('TF');
  const alerts = [];

  try {
    const tfId = await transaction(async () => {
      const tfInfo = await run(`
        INSERT INTO transfers (transfer_no, from_warehouse_id, to_warehouse_id, operator, remark, status)
        VALUES (?, ?, ?, ?, ?, 1)
      `, [transfer_no, from_warehouse_id, to_warehouse_id, operator || 'system', remark || null]);

      const id = tfInfo.lastID;

      for (const item of items) {
        await run(`
          INSERT INTO transfer_items (transfer_id, product_id, quantity)
          VALUES (?, ?, ?)
        `, [id, item.product_id, item.quantity]);

        await updateInventory(
          item.product_id, from_warehouse_id, -item.quantity,
          operator || 'system', 'TRANSFER_OUT', id,
          `调拨出库: ${transfer_no} -> ${toWh.name}`
        );

        await updateInventory(
          item.product_id, to_warehouse_id, item.quantity,
          operator || 'system', 'TRANSFER_IN', id,
          `调拨入库: ${transfer_no} <- ${fromWh.name}`
        );

        const alert = await checkAndCreateLowStockAlert(item.product_id, from_warehouse_id);
        if (alert) alerts.push(alert);
      }

      return id;
    });

    const transfer = await get(`
      SELECT t.*,
             fw.name as from_warehouse_name,
             tw.name as to_warehouse_name
      FROM transfers t
      LEFT JOIN warehouses fw ON t.from_warehouse_id = fw.id
      LEFT JOIN warehouses tw ON t.to_warehouse_id = tw.id
      WHERE t.id = ?
    `, [tfId]);

    const tfItems = await all(`
      SELECT i.*, p.name as product_name, p.sku, p.unit
      FROM transfer_items i
      LEFT JOIN products p ON i.product_id = p.id
      WHERE i.transfer_id = ?
    `, [tfId]);

    transfer.items = tfItems;

    let message = '调拨成功';
    if (alerts.length > 0) {
      message += `，注意：源仓库有${alerts.length}个商品触发低库存预警`;
    }

    res.json({
      success: true,
      data: transfer,
      alerts: alerts,
      message: message
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
