const express = require('express');
const router = express.Router();
const { run, get, all } = require('../db/database');

router.get('/', async (req, res) => {
  const { keyword, category } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];

  if (keyword) {
    sql += ' AND (name LIKE ? OR sku LIKE ? OR description LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY id DESC';

  const products = await all(sql, params);
  res.json({ success: true, data: products });
});

router.get('/:id', async (req, res) => {
  const product = await get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) {
    return res.status(404).json({ success: false, message: '商品不存在' });
  }
  res.json({ success: true, data: product });
});

router.post('/', async (req, res) => {
  const { sku, name, category, unit, spec, low_stock_threshold, description } = req.body;

  if (!sku || !name) {
    return res.status(400).json({ success: false, message: 'SKU和商品名称不能为空' });
  }

  const exists = await get('SELECT id FROM products WHERE sku = ?', [sku]);
  if (exists) {
    return res.status(400).json({ success: false, message: 'SKU已存在' });
  }

  const info = await run(`
    INSERT INTO products (sku, name, category, unit, spec, low_stock_threshold, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    sku, name, category || null, unit || '个', spec || null,
    low_stock_threshold !== undefined ? low_stock_threshold : 10,
    description || null
  ]);

  const product = await get('SELECT * FROM products WHERE id = ?', [info.lastID]);
  res.json({ success: true, data: product, message: '商品创建成功' });
});

router.put('/:id', async (req, res) => {
  const { sku, name, category, unit, spec, low_stock_threshold, description } = req.body;

  const product = await get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) {
    return res.status(404).json({ success: false, message: '商品不存在' });
  }

  if (sku && sku !== product.sku) {
    const exists = await get('SELECT id FROM products WHERE sku = ? AND id != ?', [sku, req.params.id]);
    if (exists) {
      return res.status(400).json({ success: false, message: 'SKU已存在' });
    }
  }

  await run(`
    UPDATE products
    SET sku = ?, name = ?, category = ?, unit = ?, spec = ?,
        low_stock_threshold = ?, description = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `, [
    sku || product.sku,
    name || product.name,
    category !== undefined ? category : product.category,
    unit || product.unit,
    spec !== undefined ? spec : product.spec,
    low_stock_threshold !== undefined ? low_stock_threshold : product.low_stock_threshold,
    description !== undefined ? description : product.description,
    req.params.id
  ]);

  const updated = await get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  res.json({ success: true, data: updated, message: '商品更新成功' });
});

router.delete('/:id', async (req, res) => {
  const product = await get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) {
    return res.status(404).json({ success: false, message: '商品不存在' });
  }

  const inv = await get('SELECT * FROM inventory WHERE product_id = ?', [req.params.id]);
  if (inv && inv.quantity > 0) {
    return res.status(400).json({ success: false, message: '该商品存在库存，无法删除' });
  }

  await run('DELETE FROM products WHERE id = ?', [req.params.id]);
  res.json({ success: true, message: '商品删除成功' });
});

module.exports = router;
