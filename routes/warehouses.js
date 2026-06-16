const express = require('express');
const router = express.Router();
const { run, get, all, serializedWrite } = require('../db/database');

router.get('/', (req, res) => {
  res.json({ success: true, data: all('SELECT * FROM warehouses ORDER BY id') });
});

router.get('/:id', (req, res) => {
  const warehouse = get('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
  if (!warehouse) return res.status(404).json({ success: false, message: '仓库不存在' });
  res.json({ success: true, data: warehouse });
});

router.post('/', async (req, res) => {
  const { code, name, address, manager, phone } = req.body;
  if (!code || !name) return res.status(400).json({ success: false, message: '仓库编码和名称不能为空' });

  try {
    const info = await serializedWrite(() => {
      const exists = get('SELECT id FROM warehouses WHERE code = ?', [code]);
      if (exists) throw new Error('仓库编码已存在');
      return run(`INSERT INTO warehouses (code, name, address, manager, phone) VALUES (?, ?, ?, ?, ?)`,
        [code, name, address || null, manager || null, phone || null]);
    });
    res.json({ success: true, data: get('SELECT * FROM warehouses WHERE id = ?', [info.lastID]), message: '仓库创建成功' });
  } catch (err) {
    res.status(err.message === '仓库编码已存在' ? 400 : 500).json({ success: false, message: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { code, name, address, manager, phone, status } = req.body;
  try {
    await serializedWrite(() => {
      const w = get('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
      if (!w) throw new Error('仓库不存在');
      if (code && code !== w.code) {
        const exists = get('SELECT id FROM warehouses WHERE code = ? AND id != ?', [code, req.params.id]);
        if (exists) throw new Error('仓库编码已存在');
      }
      run(`UPDATE warehouses SET code=?, name=?, address=?, manager=?, phone=?, status=? WHERE id=?`,
        [code || w.code, name || w.name, address !== undefined ? address : w.address,
         manager !== undefined ? manager : w.manager, phone !== undefined ? phone : w.phone,
         status !== undefined ? status : w.status, req.params.id]);
    });
    res.json({ success: true, data: get('SELECT * FROM warehouses WHERE id = ?', [req.params.id]), message: '仓库更新成功' });
  } catch (err) {
    const msg = err.message;
    res.status(/不存在/.test(msg) ? 404 : /已存在/.test(msg) ? 400 : 500).json({ success: false, message: msg });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await serializedWrite(() => {
      const w = get('SELECT * FROM warehouses WHERE id = ?', [req.params.id]);
      if (!w) throw new Error('仓库不存在');
      const inv = get('SELECT * FROM inventory WHERE warehouse_id = ? AND quantity > 0', [req.params.id]);
      if (inv) throw new Error('该仓库存在库存，无法删除');
      run('DELETE FROM warehouses WHERE id = ?', [req.params.id]);
    });
    res.json({ success: true, message: '仓库删除成功' });
  } catch (err) {
    const msg = err.message;
    res.status(/不存在/.test(msg) ? 404 : 400).json({ success: false, message: msg });
  }
});

module.exports = router;
