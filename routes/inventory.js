const express = require('express');
const router = express.Router();
const { all, get } = require('../db/database');

router.get('/', (req, res) => {
  const { warehouse_id, product_id, keyword, low_stock_only } = req.query;
  let sql = `
    SELECT i.*, p.sku, p.name as product_name, p.category, p.unit, p.spec,
           p.low_stock_threshold, w.code as warehouse_code, w.name as warehouse_name,
           CASE WHEN i.quantity <= p.low_stock_threshold THEN 1 ELSE 0 END as is_low_stock
    FROM inventory i
    LEFT JOIN products p ON i.product_id = p.id
    LEFT JOIN warehouses w ON i.warehouse_id = w.id
    WHERE 1=1
  `;
  const params = [];
  if (warehouse_id) { sql += ' AND i.warehouse_id = ?'; params.push(warehouse_id); }
  if (product_id) { sql += ' AND i.product_id = ?'; params.push(product_id); }
  if (keyword) { sql += ' AND (p.name LIKE ? OR p.sku LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  if (low_stock_only === 'true') { sql += ' AND i.quantity <= p.low_stock_threshold'; }
  sql += ' ORDER BY i.id DESC';
  res.json({ success: true, data: all(sql, params) });
});

router.get('/summary', (req, res) => {
  const { product_id, keyword } = req.query;
  let sql = `
    SELECT i.product_id, p.sku, p.name as product_name, p.category, p.unit, p.spec,
           p.low_stock_threshold,
           SUM(i.quantity) as total_quantity,
           COUNT(DISTINCT i.warehouse_id) as warehouse_count,
           MIN(i.quantity) as min_quantity,
           MAX(i.quantity) as max_quantity,
           CASE WHEN SUM(i.quantity) <= p.low_stock_threshold THEN 1 ELSE 0 END as is_low_stock
    FROM inventory i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (product_id) { sql += ' AND i.product_id = ?'; params.push(product_id); }
  if (keyword) { sql += ' AND (p.name LIKE ? OR p.sku LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  sql += ' GROUP BY i.product_id ORDER BY total_quantity DESC';
  res.json({ success: true, data: all(sql, params) });
});

router.get('/logs', (req, res) => {
  const { product_id, warehouse_id, change_type, ref_type, start_date, end_date, limit } = req.query;
  let sql = `
    SELECT l.*, p.sku, p.name as product_name, p.unit,
           w.code as warehouse_code, w.name as warehouse_name
    FROM inventory_logs l
    LEFT JOIN products p ON l.product_id = p.id
    LEFT JOIN warehouses w ON l.warehouse_id = w.id
    WHERE 1=1
  `;
  const params = [];
  if (product_id) { sql += ' AND l.product_id = ?'; params.push(product_id); }
  if (warehouse_id) { sql += ' AND l.warehouse_id = ?'; params.push(warehouse_id); }
  if (change_type) { sql += ' AND l.change_type = ?'; params.push(change_type); }
  if (ref_type) { sql += ' AND l.ref_type = ?'; params.push(ref_type); }
  if (start_date) { sql += ' AND l.created_at >= ?'; params.push(start_date); }
  if (end_date) { sql += ' AND l.created_at <= ?'; params.push(end_date); }
  sql += ' ORDER BY l.id DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit)); }
  res.json({ success: true, data: all(sql, params) });
});

module.exports = router;
