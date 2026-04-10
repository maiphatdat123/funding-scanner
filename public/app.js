// ===================== STATE =====================
let currentData = null;
let refreshInterval = null;
let countdownInterval = null;
let nextRefreshTime = 0;
let currentFilter = 'all';
let openModalSymbol = null; // Track which modal is open for live refresh

// ===================== EXCHANGE FEES (Futures Taker %) =====================
const EXCHANGE_FEES = {
  Binance: { taker: 0.04, maker: 0.02, label: '0.04%' },
  Bybit:   { taker: 0.055, maker: 0.02, label: '0.055%' },
  Gate:    { taker: 0.05, maker: 0.015, label: '0.05%' },
  MEXC:    { taker: 0.02, maker: 0.00, label: '0.02%' },
  Bitget:  { taker: 0.051, maker: 0.017, label: '0.051%' },
  OKX:     { taker: 0.05, maker: 0.02, label: '0.05%' },
  KuCoin:  { taker: 0.06, maker: 0.02, label: '0.06%' }
};

// ===================== EXCHANGE FUTURES URLs =====================
function getFuturesUrl(exchange, symbol) {
  const s = symbol.toUpperCase();
  switch (exchange) {
    case 'Binance': return `https://www.binance.com/en/futures/${s}USDT`;
    case 'Bybit':   return `https://www.bybit.com/trade/usdt/${s}USDT`;
    case 'Gate':    return `https://www.gate.io/futures/USDT/${s}_USDT`;
    case 'MEXC':    return `https://futures.mexc.com/exchange/${s}_USDT`;
    case 'Bitget':  return `https://www.bitget.com/futures/usdt/${s}USDT`;
    case 'OKX':     return `https://www.okx.com/trade-swap/${s.toLowerCase()}-usdt-swap`;
    case 'KuCoin':  return `https://www.kucoin.com/futures/trade/${s}USDTM`;
    default: return '#';
  }
}
function exLink(exchange, symbol, label) {
  const url = getFuturesUrl(exchange, symbol);
  return `<a href="${url}" target="_blank" class="ex-link" onclick="event.stopPropagation()" title="Mở ${exchange} Futures">${label || exchange}</a>`;
}

// ===================== CORE PROFIT CALCULATOR =====================
// Logic funding:
//   Positive rate → Longs trả Shorts
//   Negative rate → Shorts trả Longs
// 
// Chiến lược: SHORT sàn có rate CAO, LONG sàn có rate THẤP
//
// SHORT side (maxRate exchange):
//   - maxRate > 0 → Bạn NHẬN funding (longs trả shorts) ✅
//   - maxRate < 0 → Bạn TRẢ funding (shorts trả longs) ❌
//
// LONG side (minRate exchange):
//   - minRate > 0 → Bạn TRẢ funding (longs trả shorts) ❌
//   - minRate < 0 → Bạn NHẬN funding (shorts trả longs) ✅
//
// Net funding = (short nhận) + (long nhận)
//             = maxRate × pos + (-minRate) × pos
//             = (maxRate - minRate) × pos = spread × pos

function calcProfit(item, capital, leverage, slippagePct) {
  // VỐN CHIA 2: Mỗi sàn 1 nửa
  const marginPerSide = capital / 2;
  const posPerSide = marginPerSide * leverage;

  // ============ FUNDING TỪNG BÊN ============
  const shortIncome8h = (item.maxRate / 100) * posPerSide;
  const longIncome8h = -(item.minRate / 100) * posPerSide;
  const netFunding8h = shortIncome8h + longIncome8h;
  const netFundingDay = netFunding8h * 3;

  // ============ PHÍ GIAO DỊCH (1 lần vào + ra) ============
  const shortFeeRate = (EXCHANGE_FEES[item.maxExchange]?.taker || 0.05) * 2;
  const longFeeRate = (EXCHANGE_FEES[item.minExchange]?.taker || 0.05) * 2;
  const shortFeeCost = (shortFeeRate / 100) * posPerSide;
  const longFeeCost = (longFeeRate / 100) * posPerSide;
  const totalFeeCost = shortFeeCost + longFeeCost;
  const totalFeePercent = shortFeeRate + longFeeRate;

  // ============ SLIPPAGE / BID-ASK SPREAD (1 lần vào + ra, mỗi bên) ============
  // Khi SHORT: bán ở BID (thấp hơn mark) → lỗ slippage%
  // Khi LONG: mua ở ASK (cao hơn mark) → lỗ slippage%  
  // Vào + ra = 2 lần mỗi bên
  const slippage = slippagePct || 0;
  const shortSlippageCost = (slippage * 2 / 100) * posPerSide; // vào + ra
  const longSlippageCost = (slippage * 2 / 100) * posPerSide;
  const totalSlippageCost = shortSlippageCost + longSlippageCost;

  // ============ CHÊNH LỆCH GIÁ GIỮA 2 SÀN (1 lần) ============
  let priceDiffPercent = item.priceDiff || 0;
  let priceDiffCost = (priceDiffPercent / 100) * posPerSide;

  // ============ TỔNG HỢP ============
  const totalOneTimeCost = totalFeeCost + totalSlippageCost - priceDiffCost;
  const netDay1 = netFundingDay - totalOneTimeCost;
  const netDayN = netFundingDay;

  const breakEvenPeriods = netFunding8h > 0 
    ? Math.max(0, Math.ceil(Math.max(0, totalOneTimeCost) / netFunding8h)) 
    : Infinity;
  const breakEvenHours = breakEvenPeriods * 8;

  const aprOnCapital = capital > 0 ? (netFundingDay / capital) * 365 * 100 : 0;

  return {
    marginPerSide, posPerSide,
    shortIncome8h, longIncome8h, netFunding8h, netFundingDay,
    shortFeeRate, longFeeRate, shortFeeCost, longFeeCost, totalFeeCost, totalFeePercent,
    slippage, shortSlippageCost, longSlippageCost, totalSlippageCost,
    priceDiffPercent, priceDiffCost,
    totalOneTimeCost, netDay1, netDayN,
    breakEvenPeriods, breakEvenHours, aprOnCapital
  };
}

const tableBody = document.getElementById('tableBody');
const searchInput = document.getElementById('searchInput');
const capitalInput = document.getElementById('capitalInput');
const leverageSelect = document.getElementById('leverageSelect');
const minSpreadSelect = document.getElementById('minSpreadSelect');
const slippageSelect = document.getElementById('slippageSelect');
const refreshSelect = document.getElementById('refreshSelect');
const sortSelect = document.getElementById('sortSelect');
const refreshBtn = document.getElementById('refreshBtn');
const modalOverlay = document.getElementById('modalOverlay');

// ===================== EVENTS =====================
searchInput.addEventListener('input', () => renderTable());
capitalInput.addEventListener('input', () => renderTable());
leverageSelect.addEventListener('change', () => renderTable());
minSpreadSelect.addEventListener('change', () => renderTable());
slippageSelect.addEventListener('change', () => renderTable());
sortSelect.addEventListener('change', () => renderTable());
refreshSelect.addEventListener('change', () => setupAutoRefresh());

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderTable();
  });
});

// ===================== FETCH =====================
async function fetchData() {
  refreshBtn.classList.add('loading');
  try {
    const res = await fetch('/api/funding');
    currentData = await res.json();
    updateStats(currentData);
    updateExchangeStatus(currentData.exchangeStatus);
    renderTable();
    // Auto-refresh modal if open
    if (openModalSymbol && currentData.opportunities) {
      const freshItem = currentData.opportunities.find(o => o.symbol === openModalSymbol);
      if (freshItem) showDetail(freshItem);
    }
  } catch (e) {
    tableBody.innerHTML = `<tr><td colspan="12" class="loading-cell">
      <p style="color:var(--red)">❌ Lỗi kết nối server</p></td></tr>`;
  }
  refreshBtn.classList.remove('loading');
  nextRefreshTime = Date.now() + (parseInt(refreshSelect.value) * 1000);
}

// ===================== STATS =====================
function updateStats(data) {
  if (!data) return;
  const online = Object.values(data.exchangeStatus).filter(v => v > 0).length;
  document.getElementById('statExchanges').textContent = `${online}/7`;
  document.getElementById('statPairs').textContent = data.totalOpportunities;

  if (data.opportunities?.length > 0) {
    const best = data.opportunities[0];
    document.getElementById('statBestSpread').textContent = `${best.spread.toFixed(4)}%`;
    const capital = parseFloat(capitalInput.value) || 1000;
    const lev = parseInt(leverageSelect.value) || 3;
    const p = calcProfit(best, capital, lev, parseFloat(slippageSelect.value) || 0);
    document.getElementById('statBestROI').textContent = `${((p.netDay1 / capital) * 100).toFixed(2)}%`;
  }
  document.getElementById('statLastUpdate').textContent = new Date(data.timestamp).toLocaleTimeString('vi-VN');
}

// ===================== EXCHANGE STATUS =====================
function updateExchangeStatus(status) {
  if (!status) return;
  const c = { Binance:'#f0b90b', Bybit:'#f7a600', Gate:'#2354e6', MEXC:'#2ca2db', Bitget:'#00b897', OKX:'#fff', KuCoin:'#23af91' };
  document.getElementById('exchangeStatus').innerHTML = Object.entries(status).map(([n, cnt]) => `
    <div class="ex-badge ${cnt > 0 ? '' : 'offline'}">
      <span class="dot"></span>
      <span style="color:${c[n]||'#fff'}">${n}</span>
      <span class="count">${cnt}</span>
    </div>`).join('');
}

// ===================== FORMAT =====================
function fmtPrice(p) {
  if (!p) return '-';
  if (p >= 1000) return '$' + p.toLocaleString('en', { maximumFractionDigits: 2 });
  if (p >= 1) return '$' + p.toFixed(4);
  if (p >= 0.001) return '$' + p.toFixed(6);
  return '$' + p.toFixed(8);
}
function fmtDollar(v) {
  return (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2);
}

// ===================== RENDER TABLE =====================
function renderTable() {
  if (!currentData?.opportunities) return;

  const capital = parseFloat(capitalInput.value) || 1000;
  const lev = parseInt(leverageSelect.value) || 3;
  const slip = parseFloat(slippageSelect.value) || 0;
  const minSpr = parseFloat(minSpreadSelect.value) || 0;
  const search = searchInput.value.toUpperCase().trim();
  const sortBy = sortSelect.value;

  let items = [...currentData.opportunities].filter(i => i.spread >= minSpr);

  if (currentFilter === 'positive') items = items.filter(i => i.spread > 0.1);
  if (currentFilter === 'high') items = items.filter(i => i.spread > 0.5);
  if (currentFilter === 'extreme') items = items.filter(i => i.spread > 1);
  if (search) items = items.filter(i => i.symbol.includes(search));

  // Pre-calculate profits ONCE (avoids recalculating in sort)
  const profitCache = new Map();
  for (const item of items) {
    profitCache.set(item.symbol, calcProfit(item, capital, lev, slip));
  }

  if (sortBy === 'spread') items.sort((a, b) => b.spread - a.spread);
  else if (sortBy === 'apr') items.sort((a, b) => profitCache.get(b.symbol).aprOnCapital - profitCache.get(a.symbol).aprOnCapital);
  else items.sort((a, b) => a.symbol.localeCompare(b.symbol));

  if (!items.length) {
    tableBody.innerHTML = `<tr><td colspan="12" class="loading-cell">Không tìm thấy kết quả.</td></tr>`;
    return;
  }

  tableBody.innerHTML = items.map((item, idx) => {
    const rank = idx + 1;
    const topCls = rank <= 3 ? `top-${rank}` : '';
    const p = profitCache.get(item.symbol);

    const sCls = item.spread > 1 ? 'spread-extreme' : item.spread > 0.5 ? 'spread-high' : item.spread > 0.1 ? 'spread-med' : 'spread-low';
    const aCls = p.aprOnCapital > 500 ? 'apr-extreme' : p.aprOnCapital > 200 ? 'apr-high' : p.aprOnCapital > 50 ? 'apr-med' : 'apr-low';

    const pd = item.priceDiff;
    let priceDiffHtml = pd !== null
      ? (pd >= 0 ? `<span class="pdiff-good">+${pd.toFixed(3)}%</span>` : `<span class="pdiff-bad">${pd.toFixed(3)}%</span>`)
      : `<span class="pdiff-na">N/A</span>`;

    const sPrice = item.shortPrice ? fmtPrice(item.shortPrice) : '-';
    const lPrice = item.longPrice ? fmtPrice(item.longPrice) : '-';

    return `<tr class="${topCls}" onclick='showDetail(${JSON.stringify(item)})'>
      <td class="cell-rank">${rank}</td>
      <td class="cell-coin">
        <span class="coin-symbol">${item.symbol}</span>
        <span class="coin-exchanges">${item.exchangeCount} sàn</span>
      </td>
      <td>
        <div class="cell-rate">
          ${exLink(item.maxExchange, item.symbol, `<span class="rate-exchange high-ex">${item.maxExchange}</span>`)}
          <span class="rate-value ${item.maxRate > 0 ? 'positive' : 'negative'}">${item.maxRate.toFixed(4)}%</span>
        </div>
      </td>
      <td>
        <div class="cell-rate">
          ${exLink(item.minExchange, item.symbol, `<span class="rate-exchange low-ex">${item.minExchange}</span>`)}
          <span class="rate-value ${item.minRate > 0 ? 'positive' : 'negative'}">${item.minRate.toFixed(4)}%</span>
        </div>
      </td>
      <td class="cell-spread ${sCls}">${item.spread.toFixed(4)}%</td>
      <td class="cell-prices">
        <div class="prices-pair">
          <span class="price-short">S: ${sPrice}</span>
          <span class="price-long">L: ${lPrice}</span>
        </div>
        ${priceDiffHtml}
      </td>
      <td class="cell-fee">-$${p.totalFeeCost.toFixed(2)}</td>
      <td class="cell-strategy">
        <div class="strat-box">
          ${exLink(item.maxExchange, item.symbol, `<span class="strat-short">S: ${item.maxExchange} ↗</span>`)}
          ${exLink(item.minExchange, item.symbol, `<span class="strat-long">L: ${item.minExchange} ↗</span>`)}
        </div>
      </td>
      <td class="cell-profit">${fmtDollar(p.netFunding8h)}</td>
      <td class="cell-profit">${fmtDollar(p.netFundingDay)}</td>
      <td class="cell-net ${p.netDay1 > 0 ? 'net-positive' : 'net-negative'}">${fmtDollar(p.netDay1)}</td>
      <td class="cell-apr ${aCls}">${p.aprOnCapital.toFixed(0)}%</td>
    </tr>`;
  }).join('');
}

// ===================== DETAIL MODAL =====================
function showDetail(item) {
  document.getElementById('modalTitle').textContent = `${item.symbol} — Chi tiết Arbitrage`;

  const capital = parseFloat(capitalInput.value) || 1000;
  const lev = parseInt(leverageSelect.value) || 3;
  const p = calcProfit(item, capital, lev, parseFloat(slippageSelect.value) || 0);

  const sorted = Object.entries(item.rates).sort((a, b) => b[1] - a[1]);
  const shortFee = EXCHANGE_FEES[item.maxExchange];
  const longFee = EXCHANGE_FEES[item.minExchange];

  let html = `
    <h3 class="modal-section-title">📐 Phân Bổ Vốn</h3>
    <div class="capital-breakdown">
      <div class="cap-row">
        <span class="cap-label">Tổng vốn</span>
        <span class="cap-val"><strong>$${capital.toLocaleString()}</strong></span>
      </div>
      <div class="cap-row">
        <span class="cap-label">÷ 2 sàn → Mỗi sàn</span>
        <span class="cap-val"><strong>$${p.marginPerSide.toLocaleString()}</strong> margin</span>
      </div>
      <div class="cap-row">
        <span class="cap-label">× ${lev}x đòn bẩy</span>
        <span class="cap-val"><strong>$${p.posPerSide.toLocaleString()}</strong> vol/bên</span>
      </div>
      <div class="cap-note">
        Short $${p.posPerSide.toLocaleString()} trên ${item.maxExchange} | Long $${p.posPerSide.toLocaleString()} trên ${item.minExchange}
      </div>
    </div>

    <h3 class="modal-section-title">💱 So Sánh Giá 2 Sàn</h3>
    <div class="price-compare">
      <div class="price-compare-row">
        <div class="price-ex">
          <span class="rate-exchange high-ex">${item.maxExchange}</span>
          <span class="price-ex-label">SHORT bán ở giá</span>
        </div>
        <span class="price-ex-value">${fmtPrice(item.shortPrice)}</span>
      </div>
      <div class="price-compare-row">
        <div class="price-ex">
          <span class="rate-exchange low-ex">${item.minExchange}</span>
          <span class="price-ex-label">LONG mua ở giá</span>
        </div>
        <span class="price-ex-value">${fmtPrice(item.longPrice)}</span>
      </div>
      <div class="price-compare-result ${p.priceDiffCost >= 0 ? 'result-good' : 'result-bad'}">
        ${item.priceDiff !== null ? `
          <span>Chênh lệch: <strong>${item.priceDiff >= 0 ? '+' : ''}${item.priceDiff.toFixed(4)}%</strong> = <strong>${fmtDollar(p.priceDiffCost)}</strong></span>
          <span>${p.priceDiffCost >= 0
            ? '✅ Short bán CAO hơn Long mua → Lãi ngay khi vào lệnh!'
            : '⚠️ Short bán THẤP hơn Long mua → Lỗ khi vào lệnh'
          }</span>
        ` : '<span>⚠️ Không có dữ liệu giá</span>'}
      </div>
    </div>

    <h3 class="modal-section-title">📊 Funding Rate Tất Cả Sàn</h3>
    <table class="modal-rates">
      <thead><tr>
        <th>Sàn</th>
        <th>Giá</th>
        <th>Funding Rate</th>
        <th>Fee</th>
        <th>Vai trò</th>
      </tr></thead>
      <tbody>`;

  for (const [ex, rate] of sorted) {
    const cls = rate > 0 ? 'positive' : 'negative';
    const fee = EXCHANGE_FEES[ex];
    const exPrice = item.prices?.[ex];
    const role = ex === item.maxExchange
      ? '<span class="role-short">⬇ SHORT</span>'
      : ex === item.minExchange
        ? '<span class="role-long">⬆ LONG</span>'
        : '<span class="role-none">—</span>';
    const link = getFuturesUrl(ex, item.symbol);

    html += `<tr>
      <td><a href="${link}" target="_blank" class="ex-link-modal" onclick="event.stopPropagation()">${ex} ↗</a></td>
      <td style="color:var(--text-sec);font-size:12px">${fmtPrice(exPrice)}</td>
      <td class="rate-value ${cls}">${rate.toFixed(4)}%</td>
      <td style="color:var(--text-sec)">${fee ? fee.label : '?'}</td>
      <td>${role}</td>
    </tr>`;
  }

  html += `</tbody></table>

    <h3 class="modal-section-title">🧮 Tính Toán Chi Tiết (Vol mỗi bên: $${p.posPerSide.toLocaleString()})</h3>
    <div class="final-calc">

      <div class="calc-section">
        <div class="calc-title">A. Funding mỗi 8h (lặp lại)</div>
        <div class="calc-row">
          <span>🔴 SHORT ${item.maxExchange} (FR: ${item.maxRate >= 0 ? '+' : ''}${item.maxRate.toFixed(4)}%)</span>
          <span class="${p.shortIncome8h >= 0 ? 'calc-plus' : 'calc-minus'}">${fmtDollar(p.shortIncome8h)}</span>
        </div>
        <div class="calc-row">
          <span class="calc-explain">${item.maxRate >= 0 
            ? '→ Rate dương: Longs trả Shorts → Bạn SHORT nên NHẬN' 
            : '→ Rate âm: Shorts trả Longs → Bạn SHORT nên TRẢ'}</span>
        </div>
        <div class="calc-row">
          <span>🟢 LONG ${item.minExchange} (FR: ${item.minRate >= 0 ? '+' : ''}${item.minRate.toFixed(4)}%)</span>
          <span class="${p.longIncome8h >= 0 ? 'calc-plus' : 'calc-minus'}">${fmtDollar(p.longIncome8h)}</span>
        </div>
        <div class="calc-row">
          <span class="calc-explain">${item.minRate >= 0 
            ? '→ Rate dương: Longs trả Shorts → Bạn LONG nên TRẢ' 
            : '→ Rate âm: Shorts trả Longs → Bạn LONG nên NHẬN'}</span>
        </div>
        <div class="calc-row calc-subtotal">
          <span><strong>NET Funding/8h</strong> (nhận − trả)</span>
          <span class="${p.netFunding8h >= 0 ? 'calc-plus' : 'calc-minus'}"><strong>${fmtDollar(p.netFunding8h)}</strong></span>
        </div>
        <div class="calc-row">
          <span>× 3 kỳ/ngày</span>
          <span class="${p.netFundingDay >= 0 ? 'calc-plus' : 'calc-minus'}"><strong>${fmtDollar(p.netFundingDay)}/ngày</strong></span>
        </div>
      </div>

      <div class="calc-section">
        <div class="calc-title">B. Phí giao dịch (1 lần, vào + ra cả 2 sàn)</div>
        <div class="calc-row">
          <span>Short ${item.maxExchange}: 2 × ${shortFee?.label || '?'} × $${p.posPerSide.toLocaleString()}</span>
          <span class="calc-minus">-$${p.shortFeeCost.toFixed(2)}</span>
        </div>
        <div class="calc-row">
          <span>Long ${item.minExchange}: 2 × ${longFee?.label || '?'} × $${p.posPerSide.toLocaleString()}</span>
          <span class="calc-minus">-$${p.longFeeCost.toFixed(2)}</span>
        </div>
        <div class="calc-row calc-subtotal">
          <span>Tổng phí</span>
          <span class="calc-minus"><strong>-$${p.totalFeeCost.toFixed(2)}</strong></span>
        </div>
      </div>

      <div class="calc-section">
        <div class="calc-title">C. Chênh lệch giá vào lệnh (1 lần)</div>
        <div class="calc-row">
          <span>Short bán ${fmtPrice(item.shortPrice)} vs Long mua ${fmtPrice(item.longPrice)}</span>
          <span class="${p.priceDiffCost >= 0 ? 'calc-plus' : 'calc-minus'}"><strong>${fmtDollar(p.priceDiffCost)}</strong></span>
        </div>
      </div>

      <div class="calc-section">
        <div class="calc-title">D. Slippage / Bid-Ask Spread (${p.slippage}%/bên, vào + ra)</div>
        <div class="calc-row">
          <span>Short ${item.maxExchange}: 2 × ${p.slippage}% × $${p.posPerSide.toLocaleString()}</span>
          <span class="calc-minus">-$${p.shortSlippageCost.toFixed(2)}</span>
        </div>
        <div class="calc-row">
          <span>Long ${item.minExchange}: 2 × ${p.slippage}% × $${p.posPerSide.toLocaleString()}</span>
          <span class="calc-minus">-$${p.longSlippageCost.toFixed(2)}</span>
        </div>
        <div class="calc-row calc-subtotal">
          <span>Tổng slippage</span>
          <span class="calc-minus"><strong>-$${p.totalSlippageCost.toFixed(2)}</strong></span>
        </div>
        <div class="calc-row">
          <span class="calc-explain">→ Giá BID/ASK chênh so với Mark Price. Coin thanh khoản thấp = slippage cao hơn.</span>
        </div>
      </div>

      <div class="calc-section calc-final">
        <div class="calc-title">📌 KẾT QUẢ CUỐI CÙNG</div>
        <div class="calc-row">
          <span>Chi phí 1 lần = Phí + Slippage − Lãi giá</span>
          <span class="${p.totalOneTimeCost > 0 ? 'calc-minus' : 'calc-plus'}">${p.totalOneTimeCost > 0 ? '-' : '+'}$${Math.abs(p.totalOneTimeCost).toFixed(2)}</span>
        </div>
        <div class="calc-row result-row ${p.netDay1 >= 0 ? 'result-positive' : 'result-negative'}">
          <span>⭐ LÃI RÒNG NGÀY 1</span>
          <span><strong>${fmtDollar(p.netDay1)}</strong></span>
        </div>
        <div class="calc-row result-row result-positive">
          <span>🔄 LÃI RÒNG TỪ NGÀY 2+</span>
          <span><strong>${fmtDollar(p.netFundingDay)}/ngày</strong></span>
        </div>
        <div class="calc-row">
          <span>⏱ Hòa vốn phí sau</span>
          <span class="calc-cyan">${p.breakEvenPeriods} kỳ (~${p.breakEvenHours}h)</span>
        </div>
        <div class="calc-row">
          <span>📊 ROI trên vốn $${capital.toLocaleString()}</span>
          <span class="calc-cyan">${((p.netDay1 / capital) * 100).toFixed(2)}% ngày 1 → ${((p.netFundingDay / capital) * 100).toFixed(2)}%/ngày</span>
        </div>
      </div>
    </div>

    <div class="modal-note">
      ⚠️ <strong>Logic:</strong> Vốn $${capital.toLocaleString()} ÷ 2 = $${p.marginPerSide.toLocaleString()}/sàn × ${lev}x = $${p.posPerSide.toLocaleString()} vol/bên.<br>
      SHORT nhận funding nếu rate dương. LONG trả funding nếu rate dương.<br>
      Net Funding = (Short nhận) − (Long trả) = Spread × Vol mỗi bên.
    </div>`;

  document.getElementById('modalBody').innerHTML = html;
  modalOverlay.classList.add('active');
  openModalSymbol = item.symbol; // Track for live refresh
}

function closeModal() {
  modalOverlay.classList.remove('active');
  openModalSymbol = null;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ===================== AUTO REFRESH (Funding every 5s) =====================
function setupAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  if (countdownInterval) clearInterval(countdownInterval);
  const sec = parseInt(refreshSelect.value);
  if (sec <= 0) { document.getElementById('statCountdown').textContent = 'Off'; return; }
  nextRefreshTime = Date.now() + sec * 1000;
  refreshInterval = setInterval(() => { fetchData(); nextRefreshTime = Date.now() + sec * 1000; }, sec * 1000);
  countdownInterval = setInterval(() => {
    document.getElementById('statCountdown').textContent = Math.max(0, Math.ceil((nextRefreshTime - Date.now()) / 1000)) + 's';
  }, 1000);
}

// ===================== REAL-TIME PRICES (every 1s from WebSocket) =====================
let livePrices = {};
let priceInterval = null;

async function fetchLivePrices() {
  try {
    const res = await fetch('/api/prices');
    const data = await res.json();
    if (data.prices) {
      livePrices = data.prices;
      mergeLivePrices();
    }
  } catch {}
}

function mergeLivePrices() {
  if (!currentData?.opportunities) return;

  let changed = false;
  for (const item of currentData.opportunities) {
    const lp = livePrices[item.symbol];
    if (!lp) continue;

    // Update prices per exchange from WebSocket
    for (const [ex, price] of Object.entries(lp)) {
      if (price && price > 0) {
        if (!item.prices) item.prices = {};
        const oldPrice = item.prices[ex];
        if (oldPrice !== price) {
          item.prices[ex] = price;
          item.price = price;
          changed = true;
        }
      }
    }

    // Recalculate price diff if both exchanges have live prices
    if (item.prices[item.maxExchange]) item.shortPrice = item.prices[item.maxExchange];
    if (item.prices[item.minExchange]) item.longPrice = item.prices[item.minExchange];
    if (item.shortPrice && item.longPrice && item.longPrice > 0) {
      item.priceDiffAbs = item.shortPrice - item.longPrice;
      item.priceDiff = ((item.shortPrice - item.longPrice) / item.longPrice) * 100;
    }
  }

  if (changed) {
    renderTable();
    // Update modal if open
    if (openModalSymbol && currentData.opportunities) {
      const freshItem = currentData.opportunities.find(o => o.symbol === openModalSymbol);
      if (freshItem) showDetail(freshItem);
    }
  }
}

function startLivePrices() {
  if (priceInterval) clearInterval(priceInterval);
  fetchLivePrices(); // first fetch
  priceInterval = setInterval(fetchLivePrices, 1000); // every 1s
}

fetchData();
setupAutoRefresh();
startLivePrices();
