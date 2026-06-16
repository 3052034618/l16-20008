const http = require('http');

const BASE = 'http://localhost:3000';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const args = process.argv.slice(2);
const ONLY_SELFCHECK = args.includes('--selfcheck');
const CLEAN_FIRST = args.includes('--clean');

function request(path, options = {}, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: { raw: data } });
        }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

let pass = 0, fail = 0;
function assert(name, cond, detail = '') {
  if (cond) {
    console.log(`  ${GREEN}✅${RESET} ${name}`);
    pass++;
  } else {
    console.log(`  ${RED}❌${RESET} ${name}  ${RED}${detail}${RESET}`);
    fail++;
  }
}
function section(title) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`${CYAN}📋 ${title}${RESET}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

function pad(str, len, align = 'left') {
  str = String(str);
  if (str.length >= len) return str.slice(0, len);
  const pad = ' '.repeat(len - str.length);
  return align === 'right' ? pad + str : str + pad;
}

function printAsciiTable(rows, headers, aligns) {
  const widths = headers.map((h, i) => {
    let w = String(h).length;
    for (const r of rows) w = Math.max(w, String(r[i] ?? '').length);
    return w;
  });
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  console.log(sep);
  console.log('| ' + headers.map((h, i) => pad(h, widths[i], aligns?.[i] ?? 'left')).join(' | ') + ' |');
  console.log(sep);
  for (const r of rows) {
    console.log('| ' + r.map((v, i) => pad(v ?? '', widths[i], aligns?.[i] ?? 'left')).join(' | ') + ' |');
  }
  console.log(sep);
}

let productId = null;
let warehouse1 = null;
let warehouse2 = null;

async function resetInventory() {
  const inv = (await request('/api/inventory')).body.data || [];
  for (const row of inv) {
    await request('/api/stocktakes', { method: 'POST' }, {
      warehouse_id: row.warehouse_id, operator: 'TEST_RESET', remark: '测试重置',
      items: [{ product_id: row.product_id, actual_quantity: 0 }]
    });
  }
}

async function doSelfCheck() {
  section('★ 日常自检：库存 & 单据 & 日志 一致性核对');

  const products = (await request('/api/products')).body.data || [];
  const warehouses = (await request('/api/warehouses')).body.data || [];
  const prodMap = {};
  for (const p of products) prodMap[p.id] = p;
  const whMap = {};
  for (const w of warehouses) whMap[w.id] = w;

  const inventory = (await request('/api/inventory')).body.data || [];
  const invMap = {};
  for (const i of inventory) invMap[`${i.product_id}_${i.warehouse_id}`] = i;

  const allLogs = (await request('/api/inventory/logs?limit=100000')).body.data || [];
  const logPerKey = {};
  const logCountPerKey = {};
  for (const log of allLogs) {
    const k = `${log.product_id}_${log.warehouse_id}`;
    if (!logPerKey[k]) logPerKey[k] = { in: 0, out: 0, adjust: 0 };
    logCountPerKey[k] = (logCountPerKey[k] || 0) + 1;
    if (log.change_type === 'IN') logPerKey[k].in += log.change_quantity;
    else if (log.change_type === 'OUT') logPerKey[k].out += -log.change_quantity;
    else logPerKey[k].adjust += log.change_quantity;
  }

  const inDocs = (await request('/api/stock-in')).body.data || [];
  const outDocs = (await request('/api/stock-out')).body.data || [];
  const tfDocs = (await request('/api/transfers')).body.data || [];

  const inCountPerWh = {};
  for (const d of inDocs) {
    const items = (await request(`/api/stock-in/${d.id}`)).body.data?.items || [];
    for (const it of items) {
      const k = `${it.product_id}_${d.warehouse_id}`;
      inCountPerWh[k] = (inCountPerWh[k] || 0) + 1;
    }
  }
  const outCountPerWh = {};
  for (const d of outDocs) {
    const items = (await request(`/api/stock-out/${d.id}`)).body.data?.items || [];
    for (const it of items) {
      const k = `${it.product_id}_${d.warehouse_id}`;
      outCountPerWh[k] = (outCountPerWh[k] || 0) + 1;
    }
  }
  const tfCountPerWh = {};
  for (const d of tfDocs) {
    const items = (await request(`/api/transfers/${d.id}`)).body.data?.items || [];
    for (const it of items) {
      const k1 = `${it.product_id}_${d.from_warehouse_id}`;
      const k2 = `${it.product_id}_${d.to_warehouse_id}`;
      tfCountPerWh[k1] = (tfCountPerWh[k1] || 0) + 1;
      tfCountPerWh[k2] = (tfCountPerWh[k2] || 0) + 1;
    }
  }

  const allKeys = new Set();
  for (const k of Object.keys(invMap)) allKeys.add(k);
  for (const k of Object.keys(logPerKey)) allKeys.add(k);
  for (const k of Object.keys(inCountPerWh)) allKeys.add(k);
  for (const k of Object.keys(outCountPerWh)) allKeys.add(k);
  for (const k of Object.keys(tfCountPerWh)) allKeys.add(k);

  const rows = [];
  let allConsistent = true;
  for (const k of Array.from(allKeys).sort()) {
    const [pid, wid] = k.split('_').map(Number);
    const prod = prodMap[pid];
    const wh = whMap[wid];
    if (!prod || !wh) continue;

    const qty = invMap[k]?.quantity ?? 0;
    const inN = inCountPerWh[k] || 0;
    const outN = outCountPerWh[k] || 0;
    const tfN = tfCountPerWh[k] || 0;
    const logN = logCountPerKey[k] || 0;
    const l = logPerKey[k] || { in: 0, out: 0, adjust: 0 };
    const calc = l.in - l.out + l.adjust;
    const consistent = qty === calc;
    if (!consistent) allConsistent = false;

    rows.push([
      `${prod.sku} ${prod.name}`,
      wh.code,
      qty,
      inN,
      outN,
      tfN,
      logN,
      l.in,
      l.out,
      l.adjust,
      calc,
      consistent ? `${GREEN}✅一致${RESET}` : `${RED}❌差异${RESET}`
    ]);
  }

  const headers = ['商品', '仓库', '当前库存', '入库单数', '出库单数', '调拨单数', '日志数', 'IN合计', 'OUT合计', 'ADJUST', '推算=IN-OUT+ADJ', '是否一致'];
  const aligns = ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left'];
  printAsciiTable(rows, headers, aligns);

  assert('自检：所有(商品+仓库) 推算库存 == 当前库存', allConsistent);
  return allConsistent;
}

(async () => {
  console.log('等待服务启动...');
  for (let i = 0; i < 30; i++) {
    try {
      const r = await request('/api/health');
      if (r.status === 200 && r.body.success) break;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }

  if (CLEAN_FIRST) {
    section('※ --clean 模式：重置所有库存为0');
    await resetInventory();
    console.log('  已重置所有库存为0');
  }

  section('0. 准备测试数据（查询商品/仓库）');
  const prods = (await request('/api/products')).body.data;
  productId = prods.find(p => p.sku === 'SKU001').id;
  console.log(`  测试商品: SKU001 (id=${productId})`);
  const whs = (await request('/api/warehouses')).body.data;
  warehouse1 = whs[0].id;
  warehouse2 = whs[1].id;
  console.log(`  仓库1: ${whs[0].code} (id=${warehouse1})  仓库2: ${whs[1].code} (id=${warehouse2})`);

  if (ONLY_SELFCHECK) {
    console.log(`\n${YELLOW}⚠ --selfcheck 模式：仅执行自检，跳过场景测试${RESET}`);
    await doSelfCheck();
    console.log(`\n═══════════════════════════════════════════════════════════════`);
    if (fail === 0) {
      console.log(`${GREEN}🎯 自检完成：全部通过 ${pass} / ${pass + fail}${RESET}`);
    } else {
      console.log(`${RED}🎯 自检完成：通过 ${pass} / ${pass + fail}，失败 ${fail}${RESET}`);
    }
    console.log(`═══════════════════════════════════════════════════════════════`);
    process.exit(fail > 0 ? 1 : 0);
  }

  if (!CLEAN_FIRST) {
    await resetInventory();
    console.log('  已重置所有库存为0');
  }

  section('1. 同一商品同仓库连续并发入库（N次同时提交）');
  const N_IN = 20;
  const qtyPerIn = 3;

  const inPromises = [];
  for (let i = 0; i < N_IN; i++) {
    inPromises.push(request('/api/stock-in', { method: 'POST' }, {
      warehouse_id: warehouse1, operator: `并发入库#${i}`, remark: `并发测试 ${i}`,
      items: [{ product_id: productId, quantity: qtyPerIn, unit_price: 100 }]
    }));
  }
  const inResults = await Promise.all(inPromises);
  const successIn = inResults.filter(r => r.status === 200 && r.body.success).length;
  const failedIn = N_IN - successIn;
  console.log(`  共提交 ${N_IN} 次入库，成功 ${successIn} 次，失败 ${failedIn} 次`);

  assert('所有入库请求应全部成功', successIn === N_IN, `成功${successIn} != ${N_IN}`);
  assert('失败次数应为0', failedIn === 0);

  const invAfterIn = (await request('/api/inventory')).body.data;
  const wh1Prod1 = invAfterIn.find(r => r.warehouse_id === warehouse1 && r.product_id === productId);
  const expectedAfterIn = N_IN * qtyPerIn;
  assert(`仓库1商品库存应 = ${N_IN} * ${qtyPerIn} = ${expectedAfterIn}`,
    wh1Prod1 && wh1Prod1.quantity === expectedAfterIn,
    `实际: ${wh1Prod1 ? wh1Prod1.quantity : 'NULL'}`);

  const summary = (await request('/api/inventory/summary')).body.data;
  const sum = summary.find(s => s.product_id === productId);
  assert(`汇总接口商品总库存应为 ${expectedAfterIn}`,
    sum && sum.total_quantity === expectedAfterIn,
    `实际: ${sum ? sum.total_quantity : 'NULL'}`);

  section('2. 同一商品同仓库连续并发出库（超过库存应被精准拦截）');
  const START_QTY = expectedAfterIn;
  const QTY_PER_OUT = 5;
  const N_OUT = 15;

  const outPromises = [];
  for (let i = 0; i < N_OUT; i++) {
    outPromises.push(request('/api/stock-out', { method: 'POST' }, {
      warehouse_id: warehouse1, operator: `并发出库#${i}`,
      items: [{ product_id: productId, quantity: QTY_PER_OUT }]
    }));
  }
  const outResults = await Promise.all(outPromises);
  const successOut = outResults.filter(r => r.status === 200 && r.body.success).length;
  const failedOut = outResults.filter(r => r.body && !r.body.success).length;
  const expectedSuccess = Math.floor(START_QTY / QTY_PER_OUT);
  const expectedFailed = N_OUT - expectedSuccess;
  console.log(`  提交 ${N_OUT} 次出库 (每次 ${QTY_PER_OUT})`);
  console.log(`  成功 ${successOut} 次 (预期 ${expectedSuccess})，失败 ${failedOut} 次 (预期 ${expectedFailed})`);

  assert(`成功次数应精确为 ${expectedSuccess}`,
    successOut === expectedSuccess,
    `实际成功${successOut}，会导致库存算错`);
  assert(`失败次数应精确为 ${expectedFailed}`, failedOut === expectedFailed);

  for (const r of outResults) {
    if (r.status === 200 && !r.body.success) {
      console.log(`  警告: 200 但 success=false: ${JSON.stringify(r.body)}`);
    }
  }

  const invAfterOut = (await request('/api/inventory')).body.data;
  const wh1Prod1After = invAfterOut.find(r => r.warehouse_id === warehouse1 && r.product_id === productId);
  const expectedAfterOut = START_QTY - successOut * QTY_PER_OUT;
  assert(`出库后库存应 = ${START_QTY} - ${successOut}*${QTY_PER_OUT} = ${expectedAfterOut}`,
    wh1Prod1After && wh1Prod1After.quantity === expectedAfterOut,
    `实际: ${wh1Prod1After ? wh1Prod1After.quantity : 'NULL'}`);

  const outDocCount = (await request('/api/stock-out')).body.data.length;
  console.log(`  当前出库单数量: ${outDocCount}`);

  section('3. 库存不足出库测试（单笔超额）');
  const beforeInv = (await request('/api/inventory')).body.data
    .find(r => r.warehouse_id === warehouse1 && r.product_id === productId).quantity;
  const overQty = beforeInv + 999;

  const r3 = await request('/api/stock-out', { method: 'POST' }, {
    warehouse_id: warehouse1, operator: '超额出库',
    items: [{ product_id: productId, quantity: overQty }]
  });
  assert('超额出库应返回400', r3.status === 400, `status=${r3.status}`);
  assert('返回信息应包含「库存不足」',
    r3.body && r3.body.message && r3.body.message.includes('库存不足'),
    `实际message: ${JSON.stringify(r3.body.message)}`);

  const afterInv = (await request('/api/inventory')).body.data
    .find(r => r.warehouse_id === warehouse1 && r.product_id === productId).quantity;
  assert(`失败后库存应保持不变 (${beforeInv})`, afterInv === beforeInv,
    `实际: ${afterInv}`);

  section('4. 跨仓调拨（正常 + 失败回滚测试）');

  await request('/api/stock-in', { method: 'POST' }, {
    warehouse_id: warehouse1, operator: '调拨前补货',
    items: [{ product_id: productId, quantity: 100, unit_price: 1 }]
  });
  const curInvW1 = (await request('/api/inventory')).body.data
    .find(r => r.warehouse_id === warehouse1 && r.product_id === productId).quantity;
  const curInvW2Orig = ((await request('/api/inventory')).body.data
    .find(r => r.warehouse_id === warehouse2 && r.product_id === productId) || {}).quantity || 0;
  console.log(`  调拨前: 仓1=${curInvW1}, 仓2=${curInvW2Orig}`);

  const TF_QTY = 25;
  const tfOk = await request('/api/transfers', { method: 'POST' }, {
    from_warehouse_id: warehouse1, to_warehouse_id: warehouse2,
    operator: '正常调拨', items: [{ product_id: productId, quantity: TF_QTY }]
  });
  assert('正常调拨应返回200成功', tfOk.status === 200 && tfOk.body.success,
    `status=${tfOk.status} body=${JSON.stringify(tfOk.body)}`);

  const afterTf = (await request('/api/inventory')).body.data;
  const w1After = afterTf.find(r => r.warehouse_id === warehouse1 && r.product_id === productId).quantity;
  const w2After = (afterTf.find(r => r.warehouse_id === warehouse2 && r.product_id === productId) || {}).quantity || 0;
  console.log(`  调拨后: 仓1=${w1After}, 仓2=${w2After}`);

  assert(`仓1应减少 ${TF_QTY} (=${curInvW1 - TF_QTY})`,
    w1After === curInvW1 - TF_QTY, `实际${w1After}`);
  assert(`仓2应增加 ${TF_QTY} (=${curInvW2Orig + TF_QTY})`,
    w2After === curInvW2Orig + TF_QTY, `实际${w2After}`);

  const hugeQty = w1After + 1000;
  const beforeRollback = JSON.stringify((await request('/api/inventory')).body.data
    .map(r => ({ w: r.warehouse_id, p: r.product_id, q: r.quantity }))
    .sort((a, b) => a.w - b.w || a.p - b.p));
  const transferCountBefore = (await request('/api/transfers')).body.data.length;

  const tfFail = await request('/api/transfers', { method: 'POST' }, {
    from_warehouse_id: warehouse1, to_warehouse_id: warehouse2,
    operator: '失败调拨', items: [{ product_id: productId, quantity: hugeQty }]
  });

  assert(`超额调拨(${hugeQty})应返回400`, tfFail.status === 400,
    `status=${tfFail.status} body=${JSON.stringify(tfFail.body)}`);

  const afterRollback = JSON.stringify((await request('/api/inventory')).body.data
    .map(r => ({ w: r.warehouse_id, p: r.product_id, q: r.quantity }))
    .sort((a, b) => a.w - b.w || a.p - b.p));
  const transferCountAfter = (await request('/api/transfers')).body.data.length;

  assert('调拨失败后，所有仓库库存应保持原样', beforeRollback === afterRollback,
    `\n     前: ${beforeRollback}\n     后: ${afterRollback}`);
  assert('调拨失败后，不应新增调拨单', transferCountBefore === transferCountAfter,
    `前后单据数: ${transferCountBefore} -> ${transferCountAfter}`);

  section('5. 库存一致性校验（库存表 vs 汇总表 vs 出入库/调拨日志）');

  const detail = (await request('/api/inventory')).body.data;
  const perWarehouse = {};
  for (const d of detail) {
    perWarehouse[`${d.product_id}_${d.warehouse_id}`] = d.quantity;
  }
  const detailTotal = {};
  for (const d of detail) {
    detailTotal[d.product_id] = (detailTotal[d.product_id] || 0) + d.quantity;
  }

  const summaryRows = (await request('/api/inventory/summary')).body.data;
  let matchSum = true;
  for (const s of summaryRows) {
    if ((detailTotal[s.product_id] || 0) !== s.total_quantity) {
      matchSum = false;
      console.log(`  ${YELLOW}⚠️${RESET}  product=${s.product_id} 明细汇总=${detailTotal[s.product_id]}  !=  汇总表=${s.total_quantity}`);
    }
  }
  assert('分仓库存SUM == 汇总表total_quantity（按商品）', matchSum);

  const allLogs5 = (await request('/api/inventory/logs?limit=100000')).body.data;
  const logPerKey5 = {};
  for (const log of allLogs5) {
    const k = `${log.product_id}_${log.warehouse_id}`;
    if (!logPerKey5[k]) logPerKey5[k] = { in: 0, out: 0, adjust: 0 };
    if (log.change_type === 'IN') logPerKey5[k].in += log.change_quantity;
    else if (log.change_type === 'OUT') logPerKey5[k].out += -log.change_quantity;
    else logPerKey5[k].adjust += log.change_quantity;
  }

  let matchLog = true;
  const allKeys5 = new Set([...Object.keys(perWarehouse), ...Object.keys(logPerKey5)]);
  for (const k of allKeys5) {
    const inv = perWarehouse[k] || 0;
    const l = logPerKey5[k] || { in: 0, out: 0, adjust: 0 };
    const expected = l.in - l.out + l.adjust;
    if (inv !== expected) {
      matchLog = false;
      console.log(`  ${YELLOW}⚠️${RESET}  [${k}] 库存=${inv}  vs  日志IN(${l.in})-OUT(${l.out})+ADJ(${l.adjust})=${expected}`);
    }
  }
  assert('每个(商品+仓库)：IN合计 - OUT合计 + ADJUST合计 == 当前库存', matchLog);

  const inDocs5 = (await request('/api/stock-in')).body.data;
  const outDocs5 = (await request('/api/stock-out')).body.data;
  const tfDocs5 = (await request('/api/transfers')).body.data;

  const countLogByRef = (refType, refId, changeType) => {
    return allLogs5.filter(l => l.ref_type === refType && l.ref_id === refId &&
      (changeType ? l.change_type === changeType : true)).length;
  };

  let docOk = true;
  for (const d of inDocs5) {
    const items = (await request(`/api/stock-in/${d.id}`)).body.data.items;
    const c = countLogByRef('STOCK_IN', d.id, 'IN');
    if (c !== items.length) {
      docOk = false;
      console.log(`  ${YELLOW}⚠️${RESET}  入库单${d.id} 明细${items.length}项 vs IN日志${c}条`);
    }
  }
  for (const d of outDocs5) {
    const items = (await request(`/api/stock-out/${d.id}`)).body.data.items;
    const c = countLogByRef('STOCK_OUT', d.id, 'OUT');
    if (c !== items.length) {
      docOk = false;
      console.log(`  ${YELLOW}⚠️${RESET}  出库单${d.id} 明细${items.length}项 vs OUT日志${c}条`);
    }
  }
  for (const d of tfDocs5) {
    const items = (await request(`/api/transfers/${d.id}`)).body.data.items;
    const cOut = countLogByRef('TRANSFER_OUT', d.id, 'OUT');
    const cIn = countLogByRef('TRANSFER_IN', d.id, 'IN');
    if (cOut !== items.length || cIn !== items.length) {
      docOk = false;
      console.log(`  ${YELLOW}⚠️${RESET}  调拨单${d.id} 明细${items.length}项 vs OUT日志${cOut}条 + IN日志${cIn}条`);
    }
  }
  assert('每张单据明细行数 == 对应inventory_logs行数（入/出各正确）', docOk);

  section('6. 多浏览器/快速重复提交场景：同一请求发多次（幂等性验证）');

  const duplicateBody = {
    warehouse_id: warehouse1, operator: '重复提交测试',
    items: [{ product_id: productId, quantity: 2 }]
  };
  const dupCount = 8;
  const dupPromises = [];
  for (let i = 0; i < dupCount; i++) {
    dupPromises.push(request('/api/stock-in', { method: 'POST' }, duplicateBody));
  }
  const dupResults = await Promise.all(dupPromises);
  const dupSuccess = dupResults.filter(r => r.status === 200 && r.body.success).length;
  console.log(`  ${dupCount}次重复提交入库，成功 ${dupSuccess} 次（都应成功，因为每次都是新单据）`);
  assert('重复提交入库（非同一业务单号）应全部成功', dupSuccess === dupCount);

  const curInv6 = (await request('/api/inventory')).body.data
    .find(r => r.warehouse_id === warehouse1 && r.product_id === productId).quantity;
  console.log(`  当前仓1库存: ${curInv6}（重复入库应新增 dupSuccess*2 = ${dupSuccess * 2}）`);

  section('7. 并发混合：入+出+调 同时进行，总库存守恒检查');

  await resetInventory();
  await request('/api/stock-in', { method: 'POST' }, {
    warehouse_id: warehouse1, operator: '混合测试起点',
    items: [{ product_id: productId, quantity: 500 }]
  });
  const startInv = (await request('/api/inventory')).body.data;
  const startTotal = startInv.reduce((s, r) => s + (r.product_id === productId ? r.quantity : 0), 0);
  const startLogs = (await request('/api/inventory/logs?limit=1')).body.data;
  const startLogId = startLogs.length > 0 ? startLogs[0].id : 0;

  const MIX = [];
  const PLAN = {
    inTotal: 0, outTotal: 0, tfOutTotal: 0, tfInTotal: 0
  };
  for (let i = 0; i < 30; i++) {
    const r = Math.random();
    if (r < 0.33) {
      const q = 1 + Math.floor(Math.random() * 5);
      PLAN.inTotal += q;
      MIX.push(request('/api/stock-in', { method: 'POST' }, {
        warehouse_id: warehouse1, items: [{ product_id: productId, quantity: q }]
      }));
    } else if (r < 0.66) {
      const q = 1 + Math.floor(Math.random() * 3);
      PLAN.outTotal += q;
      MIX.push(request('/api/stock-out', { method: 'POST' }, {
        warehouse_id: warehouse1, items: [{ product_id: productId, quantity: q }]
      }));
    } else {
      const q = 1 + Math.floor(Math.random() * 4);
      MIX.push(request('/api/transfers', { method: 'POST' }, {
        from_warehouse_id: warehouse1, to_warehouse_id: warehouse2,
        items: [{ product_id: productId, quantity: q }]
      }));
    }
  }

  console.log(`  提交 ${MIX.length} 个混合请求（入库/出库/调拨）`);
  console.log(`  起始两仓商品合计库存 = ${startTotal}`);
  await Promise.all(MIX);

  const mixInv = (await request('/api/inventory')).body.data;
  const w1Final = (mixInv.find(r => r.warehouse_id === warehouse1 && r.product_id === productId) || {}).quantity || 0;
  const w2Final = (mixInv.find(r => r.warehouse_id === warehouse2 && r.product_id === productId) || {}).quantity || 0;
  const totalFinal = w1Final + w2Final;
  console.log(`  结束: 仓1=${w1Final} 仓2=${w2Final} 两仓合计=${totalFinal}`);

  const mixLogs = (await request('/api/inventory/logs?limit=100000')).body.data
    .filter(l => l.id > startLogId && l.product_id === productId);
  let inSum = 0, outSum = 0;
  for (const l of mixLogs) {
    if (l.change_type === 'IN') inSum += l.change_quantity;
    else if (l.change_type === 'OUT') outSum += -l.change_quantity;
  }
  const expectedByLog = startTotal + inSum - outSum;

  assert('两仓合计库存 == 起始库存 + 新IN合计 - 新OUT合计', totalFinal === expectedByLog,
    `\n     两仓合计=${totalFinal}  日志推算=${startTotal} + ${inSum} - ${outSum} = ${expectedByLog}`);
  assert('库存不能为负（所有行都 ≥ 0）',
    mixInv.every(r => r.quantity >= 0),
    mixInv.filter(r => r.quantity < 0).map(r => `${r.product_name}@${r.warehouse_name}=-${-r.quantity}`).join(','));

  section('8. 幂等测试：同一request_id发两次入库，第二次返回idempotent:true且库存只加一次');

  const invBeforeIdem = (await request('/api/inventory')).body.data
    .find(r => r.warehouse_id === warehouse1 && r.product_id === productId)?.quantity || 0;
  console.log(`  幂等测试前仓1库存: ${invBeforeIdem}`);

  const IDEM_QTY = 17;
  const IDEM_REQ_ID = `test_idem_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const idemBody = {
    request_id: IDEM_REQ_ID,
    warehouse_id: warehouse1,
    operator: '幂等测试',
    remark: 'request_id幂等验证',
    items: [{ product_id: productId, quantity: IDEM_QTY, unit_price: 88 }]
  };

  const rFirst = await request('/api/stock-in', { method: 'POST' }, idemBody);
  assert('第一次入库应成功(200且success=true)',
    rFirst.status === 200 && rFirst.body && rFirst.body.success === true,
    `status=${rFirst.status} body=${JSON.stringify(rFirst.body)}`);
  assert('第一次入库响应不应有idempotent字段或为false',
    !rFirst.body.idempotent,
    `idempotent=${rFirst.body.idempotent}`);

  const firstDocId = rFirst.body?.data?.id;
  const firstDocNo = rFirst.body?.data?.doc_no;
  console.log(`  第一次入库单据: id=${firstDocId} doc_no=${firstDocNo}`);

  const rSecond = await request('/api/stock-in', { method: 'POST' }, idemBody);
  assert('第二次入库应返回成功(200)',
    rSecond.status === 200 && rSecond.body,
    `status=${rSecond.status} body=${JSON.stringify(rSecond.body)}`);
  assert('第二次入库响应idempotent字段应为true',
    rSecond.body.idempotent === true,
    `idempotent=${rSecond.body.idempotent}，应为true`);
  assert('第二次入库应返回同一单据id',
    rSecond.body?.data?.id === firstDocId,
    `首次docId=${firstDocId} 二次docId=${rSecond.body?.data?.id}`);
  assert('第二次入库应返回同一单据号',
    rSecond.body?.data?.doc_no === firstDocNo,
    `首次docNo=${firstDocNo} 二次docNo=${rSecond.body?.data?.doc_no}`);

  const invAfterIdem = (await request('/api/inventory')).body.data
    .find(r => r.warehouse_id === warehouse1 && r.product_id === productId)?.quantity || 0;
  console.log(`  幂等测试后仓1库存: ${invAfterIdem}（应只增加 ${IDEM_QTY}）`);
  assert(`库存应只加一次 (${invBeforeIdem} + ${IDEM_QTY} = ${invBeforeIdem + IDEM_QTY})`,
    invAfterIdem === invBeforeIdem + IDEM_QTY,
    `实际库存=${invAfterIdem}，期望=${invBeforeIdem + IDEM_QTY}`);

  const idemInDocCount = (await request('/api/stock-in')).body.data
    .filter(d => d.doc_no === firstDocNo).length;
  assert('数据库中应只有一张入库单（不重复创建）',
    idemInDocCount === 1,
    `匹配doc_no的单据数=${idemInDocCount}`);

  const idemLogs = (await request('/api/inventory/logs?limit=100000')).body.data
    .filter(l => l.ref_type === 'STOCK_IN' && l.ref_id === firstDocId && l.change_type === 'IN');
  assert('对应的IN日志应只产生1条',
    idemLogs.length === 1,
    `日志条数=${idemLogs.length}`);

  await doSelfCheck();

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  if (fail === 0) {
    console.log(`${GREEN}🎯 全部通过：通过 ${pass} / ${pass + fail}${RESET}`);
  } else {
    console.log(`${RED}🎯 存在失败：通过 ${pass} / ${pass + fail}，失败 ${fail}${RESET}`);
  }
  console.log(`═══════════════════════════════════════════════════════════════`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('测试脚本异常：', e);
  process.exit(2);
});
