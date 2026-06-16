const express = require('express');
const router = express.Router();
const { run, get, all } = require('../db/database');

router.get('/', async (req, res) => {
  const warehouses = await all('SELECT * FROM warehouses ORDER BY id');
  res.json({ success: true, data: warehouses });
});

router.get('/:id', async (req, res) => {
  const warehouse = await get('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
  if (!warehouse) {
    return res.status(404).json({ success: false, message: '仓库不存在' });
  }
  res.json({ success: true, data: warehouse });
});

router.post('/', async (req, res) => {
  const { code, name, address, manager, phone } = req.body;

  if (!code || !name) {
    return res.status(400).json({ success: false, message: '仓库编码和名称不能为空' });
  }

  const exists = await get('SELECT id FROM warehouses WHERE code = ?', [code]);
  if (exists) {
    return res.status(400).json({ success: false, message: '仓库编码已存在' });
  }

  const info = await run(`
    INSERT INTO warehouses (code, name, address, manager, phone)
    VALUES (?, ?, ?, ?, ?)
  `, [code, name, address || null, manager || null, phone || null]);

  const warehouse = await get('SELECT * FROM warehouses WHERE id = ?', [info.lastID]);
  res.json({ success: true, data: warehouse, message: '仓库创建成功' });
});

router.put('/:id', async (req, res) => {
  const { code, name, address, manager, phone, status } = req.body;

  const warehouse = await get('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
  if (!warehouse) {
    return res.status(404).json({ success: false, message: '仓库不存在' });
  }

  if (code && code !== warehouse.code) {
    const exists = await get('SELECT id FROM warehouses WHERE code = ? AND id != ?', [code, req.params.id]);
    if (exists) {
      return res.status(400).json({ success: false, message: '仓库编码已存在' });
    }
  }

  await run(`
    UPDATE warehouses
    SET code = ?, name = ?, address = ?, manager = ?, phone = ?, status = ?
    WHERE id = ?
  `, [
    code || warehouse.code,
    name || warehouse.name,
    address !== undefined ? address : warehouse.address,
    manager !== undefined ? manager : warehouse.manager,
    phone !== undefined ? phone : warehouse.phone,
    status !== undefined ? status : warehouse.status,
    req.params.id
  ]);

  const updated = await get('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
  res.json({ success: true, data: updated, message: '仓库更新成功' });
});

router.delete('/:id', async (req, res) => {
  const warehouse = await get('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
  if (!warehouse) {
    return res.status(404).json({ success: false, message: '仓库不存在' });
  }

  const inv = await get('SELECT * FROM inventory WHERE warehouse_id = ? AND quantity > 0', [req.params.id]);
  if (inv) {
    return res.status(400).json({ success: false, message: '该仓库存在库存，无法删除' });
  }

  await run('DELETE FROM warehouses WHERE id = ?', [req.params.id]);
  res.json({ success: true, message: '仓库删除成功' });
});

module.exports = router;
