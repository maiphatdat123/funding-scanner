const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3456;

app.use(express.static(path.join(__dirname, 'public')));

// Cache to avoid rate limiting
let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 15000; // 15 seconds

// ===================== EXCHANGE API FETCHERS =====================
// Tất cả fetcher đều verify coin ĐANG TRADING, không lấy coin postponed/delisted

async function fetchBinanceFunding() {
  try {
    const [infoRes, rateRes] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/exchangeInfo', { timeout: 10000 }),
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { timeout: 10000 })
    ]);
    const infoData = await infoRes.json();
    const rateData = await rateRes.json();

    const tradeable = new Set();
    if (infoData.symbols) {
      for (const s of infoData.symbols) {
        if (s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT')) {
          tradeable.add(s.symbol);
        }
      }
    }

    const result = {};
    for (const item of rateData) {
      if (item.symbol.endsWith('USDT') && tradeable.has(item.symbol)) {
        const symbol = item.symbol.replace('USDT', '');
        result[symbol] = {
          rate: parseFloat(item.lastFundingRate) * 100,
          nextTime: item.nextFundingTime,
          price: parseFloat(item.markPrice)
        };
      }
    }
    console.log(`  Binance: ${Object.keys(result).length} tradeable`);
    return result;
  } catch (e) {
    console.error('Binance error:', e.message);
    return {};
  }
}

async function fetchBybitFunding() {
  try {
    // Get actively trading instruments first
    const [instRes, tickerRes] = await Promise.all([
      fetch('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000', { timeout: 10000 }),
      fetch('https://api.bybit.com/v5/market/tickers?category=linear', { timeout: 10000 })
    ]);
    const instData = await instRes.json();
    const tickerData = await tickerRes.json();

    // Build whitelist of TRADING instruments
    const tradeable = new Set();
    if (instData.result?.list) {
      for (const inst of instData.result.list) {
        if (inst.status === 'Trading' && inst.symbol.endsWith('USDT') && inst.contractType === 'LinearPerpetual') {
          tradeable.add(inst.symbol);
        }
      }
    }

    const result = {};
    if (tickerData.result?.list) {
      for (const item of tickerData.result.list) {
        if (item.symbol.endsWith('USDT') && tradeable.has(item.symbol)) {
          const symbol = item.symbol.replace('USDT', '');
          result[symbol] = {
            rate: parseFloat(item.fundingRate) * 100,
            nextTime: parseInt(item.nextFundingTime),
            price: parseFloat(item.markPrice)
          };
        }
      }
    }
    console.log(`  Bybit: ${Object.keys(result).length} tradeable`);
    return result;
  } catch (e) {
    console.error('Bybit error:', e.message);
    return {};
  }
}

async function fetchGateFunding() {
  try {
    const res = await fetch('https://api.gateio.ws/api/v4/futures/usdt/contracts', { timeout: 10000 });
    const data = await res.json();
    const result = {};
    for (const item of data) {
      if (item.in_delisting) continue;
      if (item.trade_size === 0) continue; // no trading activity
      const symbol = item.name.replace('_USDT', '');
      result[symbol] = {
        rate: parseFloat(item.funding_rate) * 100,
        nextTime: item.funding_next_apply * 1000,
        price: parseFloat(item.mark_price)
      };
    }
    console.log(`  Gate: ${Object.keys(result).length} tradeable`);
    return result;
  } catch (e) {
    console.error('Gate error:', e.message);
    return {};
  }
}

async function fetchMEXCFunding() {
  try {
    const res = await fetch('https://contract.mexc.com/api/v1/contract/ticker', { timeout: 10000 });
    const data = await res.json();
    const result = {};
    if (data.data) {
      for (const item of data.data) {
        // Skip coins with no volume (likely inactive)
        if (parseFloat(item.volume24) === 0) continue;
        const symbol = item.symbol.replace('_USDT', '');
        result[symbol] = {
          rate: parseFloat(item.fundingRate) * 100,
          nextTime: null,
          price: parseFloat(item.lastPrice)
        };
      }
    }
    console.log(`  MEXC: ${Object.keys(result).length} tradeable`);
    return result;
  } catch (e) {
    console.error('MEXC error:', e.message);
    return {};
  }
}

async function fetchBitgetFunding() {
  try {
    const res = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', { timeout: 10000 });
    const data = await res.json();
    const result = {};
    if (data.data) {
      for (const item of data.data) {
        // Only include coins with actual trading (has last price)
        if (!item.lastPr || parseFloat(item.lastPr) === 0) continue;
        const symbol = item.symbol.replace('USDT', '');
        result[symbol] = {
          rate: parseFloat(item.fundingRate) * 100,
          nextTime: null,
          price: parseFloat(item.markPrice || item.lastPr)
        };
      }
    }
    console.log(`  Bitget: ${Object.keys(result).length} tradeable`);
    return result;
  } catch (e) {
    console.error('Bitget error:', e.message);
    return {};
  }
}

async function fetchOKXFunding() {
  try {
    // Fetch instruments (to check state) + tickers + funding rates in parallel
    const [instRes, tickerRes, fundingRes] = await Promise.all([
      fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP', { timeout: 10000 }),
      fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP', { timeout: 10000 }),
      fetch('https://www.okx.com/api/v5/public/funding-rate-all', { timeout: 10000 })
        .catch(() => null)
    ]);

    const instData = await instRes.json();
    const tickerData = await tickerRes.json();
    const result = {};

    // Build whitelist: only LIVE instruments
    const tradeable = new Set();
    if (instData.data) {
      for (const inst of instData.data) {
        if (inst.state === 'live' && inst.instId.endsWith('-USDT-SWAP')) {
          tradeable.add(inst.instId);
        }
      }
    }

    // Build price map from tickers
    const priceMap = {};
    if (tickerData.data) {
      for (const t of tickerData.data) {
        if (t.instId.endsWith('-USDT-SWAP') && tradeable.has(t.instId)) {
          const symbol = t.instId.replace('-USDT-SWAP', '');
          priceMap[symbol] = parseFloat(t.last) || parseFloat(t.markPx) || null;
        }
      }
    }

    // Try bulk funding rates
    if (fundingRes) {
      try {
        const fundingData = await fundingRes.json();
        const fundingList = Array.isArray(fundingData.data) ? fundingData.data : [];
        for (const f of fundingList) {
          if (f.instId && f.instId.endsWith('-USDT-SWAP') && tradeable.has(f.instId)) {
            const symbol = f.instId.replace('-USDT-SWAP', '');
            result[symbol] = {
              rate: parseFloat(f.fundingRate) * 100,
              nextTime: parseInt(f.nextFundingTime) || null,
              price: priceMap[symbol] || null
            };
          }
        }
      } catch (e) {}
    }

    // Fallback: individual requests for tradeable only
    if (Object.keys(result).length === 0) {
      const usdtSwaps = [...tradeable].slice(0, 100);
      const batchSize = 20;
      for (let i = 0; i < usdtSwaps.length; i += batchSize) {
        const batch = usdtSwaps.slice(i, i + batchSize);
        await Promise.all(batch.map(async (instId) => {
          try {
            const res = await fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`, { timeout: 5000 });
            const data = await res.json();
            if (data.data?.[0]) {
              const symbol = instId.replace('-USDT-SWAP', '');
              result[symbol] = {
                rate: parseFloat(data.data[0].fundingRate) * 100,
                nextTime: parseInt(data.data[0].nextFundingTime),
                price: priceMap[symbol] || null
              };
            }
          } catch {}
        }));
        await new Promise(r => setTimeout(r, 100));
      }
    }

    console.log(`  OKX: ${Object.keys(result).length} tradeable`);
    return result;
  } catch (e) {
    console.error('OKX error:', e.message);
    return {};
  }
}

async function fetchKuCoinFunding() {
  try {
    // Fetch contracts (has funding rate) + tickers (has price) in parallel
    const [contractRes, tickerRes] = await Promise.all([
      fetch('https://api-futures.kucoin.com/api/v1/contracts/active', { timeout: 10000 }),
      fetch('https://api-futures.kucoin.com/api/v1/allTickers', { timeout: 10000 })
        .catch(() => null)
    ]);

    const contractData = await contractRes.json();
    const result = {};

    // Build price map from tickers
    const priceMap = {};
    if (tickerRes) {
      const tickerData = await tickerRes.json();
      if (tickerData.data) {
        const tickers = Array.isArray(tickerData.data) ? tickerData.data : (tickerData.data.ticker || []);
        for (const t of tickers) {
          if (t.symbol && t.symbol.endsWith('USDTM')) {
            const symbol = t.symbol.replace('USDTM', '');
            priceMap[symbol] = parseFloat(t.price) || parseFloat(t.lastTradePrice) || null;
          }
        }
      }
    }

    if (contractData.data) {
      for (const item of contractData.data) {
        if (item.symbol.endsWith('USDTM')) {
          // Skip non-active contracts
          if (item.status && item.status !== 'Open') continue;
          const symbol = item.symbol.replace('USDTM', '');
          result[symbol] = {
            rate: parseFloat(item.fundingFeeRate) * 100,
            nextTime: item.nextFundingRateTime,
            price: priceMap[symbol] || parseFloat(item.markPrice) || null
          };
        }
      }
    }
    console.log(`  KuCoin: ${Object.keys(result).length} tradeable`);
    return result;
  } catch (e) {
    console.error('KuCoin error:', e.message);
    return {};
  }
}

// ===================== DATA PROCESSING =====================

function processData(exchanges) {
  const { Binance: binance, Bybit: bybit, Gate: gate, MEXC: mexc, Bitget: bitget, OKX: okx, KuCoin: kucoin } = exchanges;

  const allSymbols = new Set();
  for (const ex of Object.values(exchanges)) {
    for (const sym of Object.keys(ex)) {
      allSymbols.add(sym);
    }
  }

  const opportunities = [];
  
  for (const symbol of allSymbols) {
    const rates = {};
    const prices = {};
    let bestPrice = null;
    let exchangeCount = 0;

    for (const [exName, exData] of Object.entries(exchanges)) {
      if (exData[symbol]) {
        rates[exName] = exData[symbol].rate;
        if (exData[symbol].price) {
          prices[exName] = exData[symbol].price;
          bestPrice = exData[symbol].price;
        }
        exchangeCount++;
      }
    }

    if (exchangeCount < 2) continue;

    const rateValues = Object.values(rates);
    const maxRate = Math.max(...rateValues);
    const minRate = Math.min(...rateValues);
    const spread = maxRate - minRate;

    const maxExchange = Object.keys(rates).find(k => rates[k] === maxRate);
    const minExchange = Object.keys(rates).find(k => rates[k] === minRate);

    const shortPrice = prices[maxExchange] || null;
    const longPrice = prices[minExchange] || null;
    let priceDiff = null;
    let priceDiffAbs = null;
    if (shortPrice && longPrice && longPrice > 0) {
      priceDiffAbs = shortPrice - longPrice;
      priceDiff = ((shortPrice - longPrice) / longPrice) * 100;
    }

    opportunities.push({
      symbol, price: bestPrice, prices, rates,
      maxRate, minRate, spread, maxExchange, minExchange, exchangeCount,
      shortPrice, longPrice, priceDiff, priceDiffAbs,
      strategy: {
        short: maxExchange, long: minExchange,
        profitPer8h: spread, profitPerDay: spread * 3,
        aprEstimate: spread * 3 * 365
      }
    });
  }

  opportunities.sort((a, b) => b.spread - a.spread);

  return {
    timestamp: Date.now(),
    exchangeStatus: {
      Binance: Object.keys(binance).length,
      Bybit: Object.keys(bybit).length,
      Gate: Object.keys(gate).length,
      MEXC: Object.keys(mexc).length,
      Bitget: Object.keys(bitget).length,
      OKX: Object.keys(okx).length,
      KuCoin: Object.keys(kucoin).length
    },
    totalOpportunities: opportunities.length,
    opportunities: opportunities.slice(0, 100)
  };
}

// ===================== BACKGROUND POLLING =====================
// Server tự fetch liên tục, client nhận data INSTANT từ cache
const POLL_INTERVAL = 5000; // 5 giây fetch 1 lần
let isFetching = false;

async function backgroundFetch() {
  if (isFetching) return; // skip nếu đang fetch
  isFetching = true;

  try {
    const start = Date.now();

    const [binance, bybit, gate, mexc, bitget, okx, kucoin] = await Promise.all([
      fetchBinanceFunding(),
      fetchBybitFunding(),
      fetchGateFunding(),
      fetchMEXCFunding(),
      fetchBitgetFunding(),
      fetchOKXFunding(),
      fetchKuCoinFunding()
    ]);

    const exchanges = { Binance: binance, Bybit: bybit, Gate: gate, MEXC: mexc, Bitget: bitget, OKX: okx, KuCoin: kucoin };
    cachedData = processData(exchanges);
    lastFetchTime = Date.now();

    const elapsed = Date.now() - start;
    console.log(`[${new Date().toLocaleTimeString()}] ✅ ${cachedData.totalOpportunities} pairs in ${elapsed}ms | Top: ${cachedData.opportunities[0]?.symbol} ${cachedData.opportunities[0]?.spread.toFixed(4)}%`);
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] ❌ Fetch error:`, e.message);
  }

  isFetching = false;
}

// ===================== API ENDPOINT (instant from cache) =====================

app.get('/api/funding', (req, res) => {
  if (cachedData) {
    res.json(cachedData);
  } else {
    res.json({ timestamp: Date.now(), exchangeStatus: {}, totalOpportunities: 0, opportunities: [], loading: true });
  }
});

// ===================== REAL-TIME PRICE VIA WEBSOCKET =====================
const WebSocket = require('ws');

// Live prices from WebSocket (updated every ~1s)
const livePrices = {}; // { symbol: { Binance: price, Bybit: price, ... } }

function startBinanceWS() {
  const url = 'wss://fstream.binance.com/ws/!markPrice@arr@1s';
  let ws;

  function connect() {
    ws = new WebSocket(url);
    ws.on('open', () => console.log('🔌 Binance WS connected'));
    ws.on('message', (data) => {
      try {
        const items = JSON.parse(data);
        for (const item of items) {
          if (item.s && item.s.endsWith('USDT')) {
            const symbol = item.s.replace('USDT', '');
            if (!livePrices[symbol]) livePrices[symbol] = {};
            livePrices[symbol].Binance = parseFloat(item.p); // mark price
          }
        }
      } catch {}
    });
    ws.on('close', () => { console.log('🔌 Binance WS reconnecting...'); setTimeout(connect, 3000); });
    ws.on('error', () => { ws.close(); });
  }
  connect();
}

function startBybitWS() {
  const url = 'wss://stream.bybit.com/v5/public/linear';
  let ws;

  function connect() {
    ws = new WebSocket(url);
    ws.on('open', () => {
      console.log('🔌 Bybit WS connected');
      ws.send(JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT', 'tickers.ETHUSDT', 'tickers.SOLUSDT'] }));
      // Subscribe to top coins
      const tops = ['BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','LINK','DOT','MATIC','UNI','ARB','OP','APE','PEPE','WIF','BONK','SHIB','FIL','LTC'];
      for (const s of tops) {
        ws.send(JSON.stringify({ op: 'subscribe', args: [`tickers.${s}USDT`] }));
      }
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.data && msg.topic && msg.topic.startsWith('tickers.')) {
          const symbol = msg.data.symbol?.replace('USDT', '');
          if (symbol && msg.data.markPrice) {
            if (!livePrices[symbol]) livePrices[symbol] = {};
            livePrices[symbol].Bybit = parseFloat(msg.data.markPrice);
          }
        }
      } catch {}
    });
    ws.on('close', () => { console.log('🔌 Bybit WS reconnecting...'); setTimeout(connect, 3000); });
    ws.on('error', () => { ws.close(); });
  }
  connect();
}

// API endpoint for live prices (frontend polls every 1s)
app.get('/api/prices', (req, res) => {
  res.json({ timestamp: Date.now(), prices: livePrices });
});

// ===================== START =====================

const HOST = '0.0.0.0';
const LISTEN_PORT = process.env.PORT || PORT;

const server = app.listen(LISTEN_PORT, HOST, () => {
  console.log(`\n🚀 Funding Rate Arbitrage Scanner`);
  console.log(`📊 Local:   http://localhost:${LISTEN_PORT}`);
  console.log(`📱 LAN:     http://192.168.x.x:${LISTEN_PORT} (cùng WiFi)`);
  console.log(`🔄 Funding poll: every ${POLL_INTERVAL / 1000}s`);
  console.log(`🔌 WebSocket: Binance + Bybit real-time prices\n`);

  startBinanceWS();
  startBybitWS();
  backgroundFetch();
  setInterval(backgroundFetch, POLL_INTERVAL);

  // ===== KEEP-ALIVE: Tự ping mỗi 10 phút để Render Free không ngủ =====
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    console.log(`🏓 Keep-alive: pinging ${RENDER_URL} every 10 min`);
    setInterval(async () => {
      try {
        await fetch(`${RENDER_URL}/api/funding`);
        console.log(`[${new Date().toLocaleTimeString()}] 🏓 Keep-alive ping OK`);
      } catch {}
    }, 10 * 60 * 1000); // 10 phút
  }
});
