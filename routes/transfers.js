const express = require('express');
const router = express.Router();
const { run, get, all, transaction, ensureIdempotency, finalizeIdempotency } = require('../db/database');
const { updateInventory, checkAndCreateLowStockAlert, generateDocNo, getInventory } = require('../utils/inventory');

router.get('/', (req, res) => {
  const { from_warehouse_id, to_warehouse_id, start_date, end_date, product_id, doc_no, business_no } = req.query;
  let sql = `
    SELECT DISTINCT t.*,
           fw.name as from_warehouse_name,
           tw.name as to_warehouse_name
    FROM transfers t
    LEFT JOIN warehouses fw ON t.from_warehouse_id = fw.id
    LEFT JOIN warehouses tw ON t.to_warehouse_id = tw.id
  `;
  const params = [];
  const conditions = [`1=1`];

  if (from_warehouse_id) { conditions.push('t.from_warehouse_id = ?'); params.push(from_warehouse_id); }
  if (to_warehouse_id) { conditions.push('t.to_warehouse_id = ?'); params.push(to_warehouse_id); }
  if (doc_no) { conditions.push('t.transfer_no LIKE ?'); params.push(`%${doc_no}%`); }
  if (business_no) { conditions.push('t.business_no LIKE ?'); params.push(`%${business_no}%`); }
  if (start_date) { conditions.push('t.created_at >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('t.created_at <= ?'); params.push(end_date); }

  if (product_id) {
    sql += `
      INNER JOIN transfer_items ti ON t.id = ti.transfer_id
    `;
    conditions.push('ti.product_id = ?');
    params.push(product_id);
  }

  sql += ' WHERE ' + conditions.join(' AND ');
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

  transfer.inventory_logs = all(`
    SELECT il.*, p.name as product_name, p.sku, w.name as warehouse_name
    FROM inventory_logs il
    LEFT JOIN products p ON il.product_id = p.id
    LEFT JOIN warehouses w ON il.warehouse_id = w.id
    WHERE il.ref_type IN ('TRANSFER_OUT', 'TRANSFER_IN') AND il.ref_id = ?
    ORDER BY il.id
  `, [req.params.id]);

  res.json({ success: true, data: transfer });
});

router.post('/', async (req, res) => {
  const { business_no, request_id, from_warehouse_id, to_warehouse_id, operator, remark, items } = req.body;
  const idempotencyKey = business_no || request_id;

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
    const responseBody = await transaction(() => {
      const idemResult = ensureIdempotency(idempotencyKey, 'TRANSFER');
      if (!idemResult.isFirst) {
        return { ...idemResult.cachedResult, idempotent: true };
      }

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
        INSERT INTO transfers (transfer_no, from_warehouse_id, to_warehouse_id, business_no, operator, remark, status)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `, [transfer_no, from_warehouse_id, to_warehouse_id, business_no || null, operator || 'system', remark || null]);

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

      const transfer = get(`
        SELECT t.*,
               fw.name as from_warehouse_name,
               tw.name as to_warehouse_name
        FROM transfers t
        LEFT JOIN warehouses fw ON t.from_warehouse_id = fw.id
        LEFT JOIN warehouses tw ON t.to_warehouse_id = tw.id
        WHERE t.id = ?
      `, [tfId]);
      transfer.items = all(`
        SELECT i.*, p.name as product_name, p.sku, p.unit
        FROM transfer_items i
        LEFT JOIN products p ON i.product_id = p.id
        WHERE i.transfer_id = ?
      `, [tfId]);

      let message = '调拨成功';
      if (alerts.length > 0) {
        message += `，注意：源仓库有${alerts.length}个商品触发低库存预警`;
      }

      const result = { success: true, data: transfer, alerts, message };
      finalizeIdempotency(idempotencyKey, 'TRANSFER', result);
      return result;
    });

    res.json(responseBody);
  } catch (err) {
    const msg = err.message;
    let statusCode = 500;
    if (msg === '正在处理中...稍后重试') {
      statusCode = 409;
    } else if (/不存在|库存不足|不能相同/.test(msg)) {
      statusCode = 400;
    }
    res.status(statusCode).json({ success: false, message: msg });
  }
});

module.exports = router;
