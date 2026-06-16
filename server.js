const express = require('express');
const cors = require('cors');
const path = require('path');
const dbModule = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (dbModule.isReady()) return next();
  dbModule.ready.then((ok) => {
    if (ok) next();
    else res.status(503).json({ success: false, message: '数据库初始化失败' });
  });
});

app.use('/api/products', require('./routes/products'));
app.use('/api/warehouses', require('./routes/warehouses'));
app.use('/api/stock-in', require('./routes/stockIn'));
app.use('/api/stock-out', require('./routes/stockOut'));
app.use('/api/transfers', require('./routes/transfers'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/stocktakes', require('./routes/stocktakes'));
app.use('/api/alerts', require('./routes/alerts'));

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: '库存管理系统服务运行正常', db_ready: dbModule.isReady() });
});

app.get('/api/business-no/:no', (req, res) => {
  const { no } = req.params;
  if (!no) return res.status(400).json({ success: false, message: '业务号不能为空' });

  const { get, all } = dbModule;

  const stockInDocs = all(`
    SELECT d.*, w.name as warehouse_name
    FROM stock_documents d
    LEFT JOIN warehouses w ON d.warehouse_id = w.id
    WHERE d.business_no = ? AND d.doc_type = 'IN'
  `, [no]);

  const stockOutDocs = all(`
    SELECT d.*, w.name as warehouse_name
    FROM stock_documents d
    LEFT JOIN warehouses w ON d.warehouse_id = w.id
    WHERE d.business_no = ? AND d.doc_type = 'OUT'
  `, [no]);

  const transferDocs = all(`
    SELECT t.*,
           fw.name as from_warehouse_name,
           tw.name as to_warehouse_name
    FROM transfers t
    LEFT JOIN warehouses fw ON t.from_warehouse_id = fw.id
    LEFT JOIN warehouses tw ON t.to_warehouse_id = tw.id
    WHERE t.business_no = ?
  `, [no]);

  for (const doc of stockInDocs) {
    doc.type = 'IN';
    doc.items = all(`
      SELECT i.*, p.name as product_name, p.sku, p.unit
      FROM stock_document_items i
      LEFT JOIN products p ON i.product_id = p.id
      WHERE i.document_id = ?
    `, [doc.id]);
    doc.inventory_logs = all(`
      SELECT il.*, p.name as product_name, p.sku, w.name as warehouse_name
      FROM inventory_logs il
      LEFT JOIN products p ON il.product_id = p.id
      LEFT JOIN warehouses w ON il.warehouse_id = w.id
      WHERE il.ref_type = 'STOCK_IN' AND il.ref_id = ?
      ORDER BY il.id
    `, [doc.id]);
  }

  for (const doc of stockOutDocs) {
    doc.type = 'OUT';
    doc.items = all(`
      SELECT i.*, p.name as product_name, p.sku, p.unit
      FROM stock_document_items i
      LEFT JOIN products p ON i.product_id = p.id
      WHERE i.document_id = ?
    `, [doc.id]);
    doc.inventory_logs = all(`
      SELECT il.*, p.name as product_name, p.sku, w.name as warehouse_name
      FROM inventory_logs il
      LEFT JOIN products p ON il.product_id = p.id
      LEFT JOIN warehouses w ON il.warehouse_id = w.id
      WHERE il.ref_type = 'STOCK_OUT' AND il.ref_id = ?
      ORDER BY il.id
    `, [doc.id]);
  }

  for (const doc of transferDocs) {
    doc.type = 'TRANSFER';
    doc.items = all(`
      SELECT i.*, p.name as product_name, p.sku, p.unit
      FROM transfer_items i
      LEFT JOIN products p ON i.product_id = p.id
      WHERE i.transfer_id = ?
    `, [doc.id]);
    doc.inventory_logs = all(`
      SELECT il.*, p.name as product_name, p.sku, w.name as warehouse_name
      FROM inventory_logs il
      LEFT JOIN products p ON il.product_id = p.id
      LEFT JOIN warehouses w ON il.warehouse_id = w.id
      WHERE il.ref_type IN ('TRANSFER_OUT', 'TRANSFER_IN') AND il.ref_id = ?
      ORDER BY il.id
    `, [doc.id]);
  }

  const totalDocCount = stockInDocs.length + stockOutDocs.length + transferDocs.length;
  const totalLogCount = stockInDocs.reduce((s, d) => s + d.inventory_logs.length, 0)
    + stockOutDocs.reduce((s, d) => s + d.inventory_logs.length, 0)
    + transferDocs.reduce((s, d) => s + d.inventory_logs.length, 0);

  const summary = {
    stock_in_count: stockInDocs.length,
    stock_out_count: stockOutDocs.length,
    transfer_count: transferDocs.length,
    total_doc_count: totalDocCount,
    total_log_count: totalLogCount
  };

  res.json({
    success: true,
    data: {
      business_no: no,
      stock_in_docs: stockInDocs,
      stock_out_docs: stockOutDocs,
      transfer_docs: transferDocs,
      total_log_count: totalLogCount,
      summary
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

dbModule.ready.then((ok) => {
  if (!ok) {
    console.error('数据库初始化失败，服务无法启动');
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`  库存管理系统启动成功`);
    console.log(`  服务地址: http://localhost:${PORT}`);
    console.log(`  前端页面: http://localhost:${PORT}`);
    console.log(`  API文档:  http://localhost:${PORT}/api/health`);
    console.log(`========================================`);
  });
});
