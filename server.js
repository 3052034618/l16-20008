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
