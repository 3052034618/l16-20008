# 库存管理系统

基于 Node.js + Express + SQLite 的完整库存管理系统，支持商品管理、多仓库、出入库单据、仓库调拨、库存预警、库存盘点等核心功能。

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务
npm start
```

启动后访问: http://localhost:3000

## 项目结构

```
├── server.js              # 主服务入口
├── package.json
├── db/
│   └── database.js        # 数据库初始化与表结构
├── utils/
│   └── inventory.js       # 库存核心业务工具（更新库存、日志、预警检测）
├── routes/
│   ├── products.js        # 商品管理 API
│   ├── warehouses.js      # 仓库管理 API
│   ├── stockIn.js         # 入库单据 API
│   ├── stockOut.js        # 出库单据 API
│   ├── transfers.js       # 仓库调拨 API
│   ├── inventory.js       # 库存查询 API
│   ├── stocktakes.js      # 库存盘点 API
│   └── alerts.js          # 库存预警 API
└── public/
    └── index.html         # 前端演示页面
```

---

## 核心设计要点详解

### 一、出入库作为单据记录并同步更新库存余额

**设计思路：** 所有库存变动（入库、出库、调拨、盘点）均通过「单据」驱动，单据与库存更新在同一个数据库事务中完成，保证数据一致性。

**核心实现在 [utils/inventory.js](file:///d:/trae-bz/TraeProjects/20008/utils/inventory.js) 的 `updateInventory` 函数：**

1. **单据先行**：先创建单据主表（`stock_documents`）和明细表（`stock_document_items`），获得单据 ID
2. **事务包裹**：整个操作包裹在 `db.transaction()` 中，单据创建和库存更新是原子操作
3. **库存变更**：调用 `updateInventory(productId, warehouseId, changeQuantity, ...)` 更新库存表
4. **变动留痕**：每次库存变动自动写入 `inventory_logs` 表，记录变动前/后数量、业务来源、操作人

**代码位置参考：**
- 入库单据事务：[routes/stockIn.js](file:///d:/trae-bz/TraeProjects/20008/routes/stockIn.js#L58-L96)
- 出库单据事务：[routes/stockOut.js](file:///d:/trae-bz/TraeProjects/20008/routes/stockOut.js#L64-L109)

---

### 二、库存数量并发下的准确性保证

**1. 库存不足校验前置**
在创建出库/调拨单时，先校验每个商品在对应仓库的当前库存是否充足：
```javascript
const inv = getInventory(item.product_id, warehouse_id);
if (!inv || inv.quantity < item.quantity) {
  throw new Error('库存不足');
}
```

**2. 负数拦截（最终防线）**
在 `updateInventory` 函数中计算 `afterQty = beforeQty + changeQuantity`，若 `< 0` 立即抛出异常中断事务：
```javascript
if (afterQty < 0) {
  throw new Error(`库存不足，操作后数量为${afterQty}`);
}
```

**3. SQLite 事务隔离**
使用 `better-sqlite3` 的同步事务 + WAL 模式（见 [db/database.js](file:///d:/trae-bz/TraeProjects/20008/db/database.js#L7-L8)），保证并发写操作串行化执行。

---

### 三、多仓库下同一商品的分仓管理与汇总

**分仓存储：** `inventory` 表以 `(product_id, warehouse_id)` 作为联合唯一键：
```sql
UNIQUE(product_id, warehouse_id)
```
每个商品在每个仓库各占一条记录，互相独立。

**查询方式：**

| 查询方式 | API 端点 | 说明 |
|---------|---------|------|
| 分仓明细 | `GET /api/inventory` | 返回每个仓库每个商品的独立库存行 |
| 商品汇总 | `GET /api/inventory/summary` | 按 `product_id` 分组，`SUM(quantity)` 得到总库存，同时显示存放仓库数、最大/最小仓库库存 |

代码位置：[routes/inventory.js](file:///d:/trae-bz/TraeProjects/20008/routes/inventory.js)

---

### 四、仓库间调拨的一致性保证（一仓减、一仓加）

调拨是最容易出问题的操作（减了A仓没加上B仓，或反之），系统通过以下机制保证一致性：

**1. 单事务内双仓库操作**
在 [routes/transfers.js](file:///d:/trae-bz/TraeProjects/20008/routes/transfers.js#L86-L122) 的事务回调中：
```javascript
// 源仓库减库存
updateInventory(item.product_id, from_warehouse_id, -item.quantity, ...);
// 目标仓库加库存
updateInventory(item.product_id, to_warehouse_id, item.quantity, ...);
```
两步操作在同一个 `db.transaction()` 中，任何一步失败都会整体回滚。

**2. 源仓库库存前置校验**
事务开始前遍历检查每个商品在源仓库的库存是否充足，避免调拨中途失败。

**3. 双日志记录**
源仓库记录一条 `TRANSFER_OUT` 日志，目标仓库记录一条 `TRANSFER_IN` 日志，均关联同一个 `transfer_id`，便于事后对账。

---

### 五、低库存预警的实时判定

**触发时机：**
- 每次出库后（含调拨出库）自动检测
- 每次盘点调整后自动检测
- 也可手动调用 `POST /api/alerts/scan-all` 全库扫描

**检测逻辑**（[utils/inventory.js](file:///d:/trae-bz/TraeProjects/20008/utils/inventory.js#L42-L70) 的 `checkAndCreateLowStockAlert`）：
1. 获取商品当前库存和 `low_stock_threshold` 预警阈值
2. 若 `quantity <= threshold`：
   - 检查是否已有未处理预警，有则更新数量，无则创建新预警记录
   - 写入 `stock_alerts` 表
3. 若库存已恢复到阈值以上，自动将未处理预警标记为已解决

**预警状态流转：**
- `is_resolved = 0`：待处理
- 库存恢复 / 手动标记 → `is_resolved = 1`：已处理

前端在出库成功后若返回 `alerts` 数组，会用黄色 Toast 提醒操作员。

---

### 六、库存盘点（实际与系统不符）的调整与留痕

**流程：**
1. 选择仓库，系统自动加载该仓所有商品的当前「系统数量」
2. 操作员录入「实盘数量」
3. 系统自动计算差异：`diff_quantity = actual - system`
4. 对有差异的商品执行库存调整（`updateInventory`，变更类型标记为 `ADJUST`）

**留痕设计：**
- 盘点单主表 `stocktakes`：记录仓库、操作人、时间
- 盘点明细表 `stocktake_items`：每行记录 `system_quantity`、`actual_quantity`、`diff_quantity`，永久保存盘点快照
- `inventory_logs`：差异调整记录 `ref_type = 'STOCKTAKE'`，备注中写明「原:X 实:Y 差:Z」

代码位置：[routes/stocktakes.js](file:///d:/trae-bz/TraeProjects/20008/routes/stocktakes.js#L75-L125)

---

## API 接口一览

| 模块 | 方法 | 路径 | 说明 |
|-----|------|------|------|
| **商品** | GET | `/api/products` | 商品列表（支持 keyword、category 筛选） |
| | GET | `/api/products/:id` | 商品详情 |
| | POST | `/api/products` | 新增商品 |
| | PUT | `/api/products/:id` | 更新商品 |
| | DELETE | `/api/products/:id` | 删除商品 |
| **仓库** | GET | `/api/warehouses` | 仓库列表 |
| | POST | `/api/warehouses` | 新增仓库 |
| | PUT | `/api/warehouses/:id` | 更新仓库 |
| | DELETE | `/api/warehouses/:id` | 删除仓库 |
| **入库** | GET | `/api/stock-in` | 入库单列表 |
| | GET | `/api/stock-in/:id` | 入库单详情（含明细） |
| | POST | `/api/stock-in` | 新建入库单（自动更新库存） |
| **出库** | GET | `/api/stock-out` | 出库单列表 |
| | GET | `/api/stock-out/:id` | 出库单详情 |
| | POST | `/api/stock-out` | 新建出库单（自动更新库存+预警检测） |
| **调拨** | GET | `/api/transfers` | 调拨单列表 |
| | GET | `/api/transfers/:id` | 调拨单详情 |
| | POST | `/api/transfers` | 新建调拨单（事务双仓更新） |
| **库存** | GET | `/api/inventory` | 分仓库存明细 |
| | GET | `/api/inventory/summary` | 按商品汇总库存 |
| | GET | `/api/inventory/logs` | 库存变动日志 |
| **盘点** | GET | `/api/stocktakes` | 盘点单列表 |
| | GET | `/api/stocktakes/:id` | 盘点单详情 |
| | POST | `/api/stocktakes` | 新建盘点（自动调整差异） |
| **预警** | GET | `/api/alerts` | 预警列表 |
| | GET | `/api/alerts/stats` | 预警统计 |
| | PUT | `/api/alerts/:id/resolve` | 标记预警已处理 |
| | POST | `/api/alerts/scan-all` | 全库扫描预警 |

---

## 数据库表结构

| 表名 | 用途 |
|------|------|
| `products` | 商品主数据（含 low_stock_threshold 预警阈值） |
| `warehouses` | 仓库主数据 |
| `inventory` | 库存表（product_id + warehouse_id 联合唯一） |
| `stock_documents` | 出入库单据主表（doc_type: IN/OUT） |
| `stock_document_items` | 出入库单据明细 |
| `transfers` | 调拨单主表 |
| `transfer_items` | 调拨单明细 |
| `stocktakes` | 盘点单主表 |
| `stocktake_items` | 盘点单明细（含系统数、实盘数、差异数） |
| `stock_alerts` | 库存预警记录 |
| `inventory_logs` | 库存变动流水（所有变动的完整审计日志） |
