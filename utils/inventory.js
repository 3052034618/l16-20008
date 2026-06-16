const { run, get } = require('../db/database');

function getInventory(productId, warehouseId) {
  return get(
    'SELECT * FROM inventory WHERE product_id = ? AND warehouse_id = ?',
    [productId, warehouseId]
  );
}

function updateInventory(productId, warehouseId, changeQuantity, operator, refType, refId, remark) {
  const inv = getInventory(productId, warehouseId);
  const beforeQty = inv ? inv.quantity : 0;
  const afterQty = beforeQty + changeQuantity;

  if (afterQty < 0) {
    throw new Error(`库存不足，操作后数量为${afterQty}`);
  }

  if (inv) {
    run(
      'UPDATE inventory SET quantity = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?',
      [afterQty, inv.id]
    );
  } else {
    run(
      'INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?, ?, ?)',
      [productId, warehouseId, afterQty]
    );
  }

  run(`
    INSERT INTO inventory_logs
    (product_id, warehouse_id, change_type, change_quantity, before_quantity, after_quantity, ref_type, ref_id, operator, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    productId, warehouseId,
    changeQuantity > 0 ? 'IN' : (changeQuantity < 0 ? 'OUT' : 'ADJUST'),
    changeQuantity, beforeQty, afterQty,
    refType || null, refId || null,
    operator || 'system', remark || null
  ]);

  return { before: beforeQty, after: afterQty };
}

function checkAndCreateLowStockAlert(productId, warehouseId) {
  const inv = getInventory(productId, warehouseId);
  if (!inv) return null;

  const product = get('SELECT low_stock_threshold FROM products WHERE id = ?', [productId]);
  if (!product) return null;

  if (inv.quantity <= product.low_stock_threshold) {
    const existing = get(`
      SELECT * FROM stock_alerts
      WHERE product_id = ? AND warehouse_id = ? AND is_resolved = 0
    `, [productId, warehouseId]);

    if (!existing) {
      const info = run(`
        INSERT INTO stock_alerts (product_id, warehouse_id, current_quantity, threshold, alert_type)
        VALUES (?, ?, ?, ?, 'low_stock')
      `, [productId, warehouseId, inv.quantity, product.low_stock_threshold]);
      return get('SELECT * FROM stock_alerts WHERE id = ?', [info.lastID]);
    } else {
      run(`
        UPDATE stock_alerts SET current_quantity = ?, created_at = datetime('now', 'localtime')
        WHERE id = ?
      `, [inv.quantity, existing.id]);
      return get('SELECT * FROM stock_alerts WHERE id = ?', [existing.id]);
    }
  } else {
    run(`
      UPDATE stock_alerts SET is_resolved = 1
      WHERE product_id = ? AND warehouse_id = ? AND is_resolved = 0
    `, [productId, warehouseId]);
    return null;
  }
}

function generateDocNo(prefix) {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${prefix}${dateStr}${rand}`;
}

module.exports = {
  getInventory,
  updateInventory,
  checkAndCreateLowStockAlert,
  generateDocNo
};
