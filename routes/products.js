const express = require('express');
const router = express.Router();
const { run, get, all, transaction, serializedWrite } = require('../db/database');

router.get('/', (req, res) => {
  const { keyword, category } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (keyword) {
    sql += ' AND (name LIKE ? OR sku LIKE ? OR description LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY id DESC';
  res.json({ success: true, data: all(sql, params) });
});

router.get('/:id', (req, res) => {
  const product = get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) return res.status(404).json({ success: false, message: '商品不存在' });
  res.json({ success: true, data: product });
});

router.post('/', async (req, res) => {
  const { sku, name, category, unit, spec, low_stock_threshold, description } = req.body;
  if (!sku || !name) return res.status(400).json({ success: false, message: 'SKU和商品名称不能为空' });

  try {
    const info = await serializedWrite(() => {
      const exists = get('SELECT id FROM products WHERE sku = ?', [sku]);
      if (exists) throw new Error('SKU已存在');
      return run(`
        INSERT INTO products (sku, name, category, unit, spec, low_stock_threshold, description)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        sku, name, category || null, unit || '个', spec || null,
        low_stock_threshold !== undefined ? low_stock_threshold : 10,
        description || null
      ]);
    });
    const product = get('SELECT * FROM products WHERE id = ?', [info.lastID]);
    res.json({ success: true, data: product, message: '商品创建成功' });
  } catch (err) {
    res.status(err.message === 'SKU已存在' ? 400 : 500).json({ success: false, message: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { sku, name, category, unit, spec, low_stock_threshold, description } = req.body;

  try {
    await serializedWrite(() => {
      const product = get('SELECT * FROM products WHERE id = ?', [req.params.id]);
      if (!product) throw new Error('商品不存在');
      if (sku && sku !== product.sku) {
        const exists = get('SELECT id FROM products WHERE sku = ? AND id != ?', [sku, req.params.id]);
        if (exists) throw new Error('SKU已存在');
      }
      run(`
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
    });
    const updated = get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: updated, message: '商品更新成功' });
  } catch (err) {
    const msg = err.message;
    res.status(/不存在/.test(msg) ? 404 : /已存在/.test(msg) ? 400 : 500)
      .json({ success: false, message: msg });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await serializedWrite(() => {
      const product = get('SELECT * FROM products WHERE id = ?', [req.params.id]);
      if (!product) throw new Error('商品不存在');
      const inv = get('SELECT * FROM inventory WHERE product_id = ?', [req.params.id]);
      if (inv && inv.quantity > 0) throw new Error('该商品存在库存，无法删除');
      run('DELETE FROM products WHERE id = ?', [req.params.id]);
    });
    res.json({ success: true, message: '商品删除成功' });
  } catch (err) {
    const msg = err.message;
    res.status(/不存在/.test(msg) ? 404 : 400).json({ success: false, message: msg });
  }
});

module.exports = router;
