// scripts/check-signal.mjs
// 定时拉取 BTC/ETH/SOL/DOGE 数据(1小时颗粒度)、分别计算信号。
// - 新闻只保留和"这次真正变化的币种"相关的关键词匹配结果
// - 信号需要连续两次检测都指向同一个新分类,才算"确认变化"并推送,避免临界值来回抖动
// - 每次检测(不管有没有推送)都会记一行历史,方便以后回测这套规则准不准

import fs from 'fs';

const STATE_FILE = 'signal-state.json';
const HISTORY_FILE = 'signal-history.jsonl';
const DASHBOARD_URL = 'https://qq374514249.github.io/crypto-signal-station-Visibility/';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 想增减关注的币种,改这个数组就行
const COINS = [
  { id: 'bitcoin', name: 'BTC', binanceSymbol: 'BTCUSDT', newsKeywords: ['bitcoin', 'btc'] },
  { id: 'ethereum', name: 'ETH', binanceSymbol: 'ETHUSDT', newsKeywords: ['ethereum', 'eth'] },
  { id: 'solana', name: 'SOL', binanceSymbol: 'SOLUSDT', newsKeywords: ['solana', 'sol'] },
  { id: 'dogecoin', name: 'DOGE', binanceSymbol: 'DOGEUSDT', newsKeywords: ['dogecoin', 'doge'] },
];

function calcSMA(closes, period){
  if(closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14){
  if(closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  const slice = closes.slice(-(period + 1));
  for(let i = 1; i < slice.length; i++){
    const diff = slice[i] - slice[i - 1];
    if(diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if(avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcEMASeries(values, period){
  const k = 2 / (period + 1);
  const out = [values[0]];
  for(let i = 1; i < values.length; i++){
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function calcMACD(closes){
  if(closes.length < 26) return null;
  const ema12 = calcEMASeries(closes, 12);
  const ema26 = calcEMASeries(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signalLine = calcEMASeries(macdLine, 9);
  return { macdLine, signalLine };
}

// 近期波动参考:每小时收益率的标准差(不是严格意义上的ATR,因为这里没有真正的高低点数据,
// 只是给一个"这个币最近平均每小时大概会晃多少"的客观参考,方便自己判断止损该放多远)
function calcHourlyVolatility(closes, lookback = 24){
  const recent = closes.slice(-(lookback + 1));
  if(recent.length < 3) return null;
  const returns = [];
  for(let i = 1; i < recent.length; i++){
    returns.push((recent[i] - recent[i - 1]) / recent[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance); // 小数形式,比如 0.006 代表 0.6%
}


async function fetchJson(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`);
  return res.json();
}

function classify(score){
  if(score >= 3) return '偏多 · 关注入场时机';
  if(score >= 1) return '轻微偏多';
  if(score === 0) return '中性观望';
  if(score >= -2) return '轻微偏空';
  return '偏空 · 关注离场/减仓';
}

// 计算单个币种的信号
async function computeCoinSignal(coin, fngValue){
  const chart = await fetchJson(`https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart?vs_currency=usd&days=3`);
  const closes = chart.prices.map(p => p[1]);
  const currentPrice = closes[closes.length - 1];
  const support = Math.min(...closes);
  const resistance = Math.max(...closes);

  const rsi14 = calcRSI(closes, 14);
  const sma7 = calcSMA(closes, 7);
  const macd = calcMACD(closes);
  const hourlyVol = calcHourlyVolatility(closes, 24);

  let fundingRate = null;
  try{
    const fund = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.binanceSymbol}`);
    fundingRate = parseFloat(fund.lastFundingRate) * 100;
  }catch(e){
    console.warn(`${coin.name} 资金费率获取失败(跳过):`, e.message);
  }

  // 多空持仓账户比例(不同于资金费率,这个是实际账户数的多空比,同样是判断"是否拥挤"的参考)
  let longShortRatio = null;
  try{
    const lsData = await fetchJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin.binanceSymbol}&period=1h&limit=1`);
    if(Array.isArray(lsData) && lsData[0]) longShortRatio = parseFloat(lsData[0].longShortRatio);
  }catch(e){
    console.warn(`${coin.name} 多空持仓比例获取失败(跳过):`, e.message);
  }

  const factors = [];
  let score = 0;

  if(rsi14 !== null){
    let v = 'neutral', reason = `RSI ${rsi14.toFixed(1)},中性区间`;
    if(rsi14 <= 30){ v = 'bull'; score += 1; reason = `RSI ${rsi14.toFixed(1)},超卖区间`; }
    else if(rsi14 >= 70){ v = 'bear'; score -= 1; reason = `RSI ${rsi14.toFixed(1)},超买区间`; }
    factors.push({ name: 'RSI(14)', verdict: v, reason });
  }

  if(macd){
    const li = macd.macdLine.length - 1;
    const bull = macd.macdLine[li] >= macd.signalLine[li];
    score += bull ? 1 : -1;
    factors.push({ name: 'MACD', verdict: bull ? 'bull' : 'bear', reason: bull ? 'MACD线上穿信号线' : 'MACD线下穿信号线' });
  }

  if(sma7 !== null){
    const bull = currentPrice >= sma7;
    score += bull ? 1 : -1;
    factors.push({ name: '均线趋势', verdict: bull ? 'bull' : 'bear', reason: bull ? '现价在7小时均线上方' : '现价在7小时均线下方' });
  }

  let fgV = 'neutral';
  if(fngValue <= 25){ fgV = 'bull'; score += 1; }
  else if(fngValue >= 75){ fgV = 'bear'; score -= 1; }
  factors.push({ name: '恐慌贪婪指数', verdict: fgV, reason: `指数 ${fngValue}` });

  if(fundingRate !== null){
    let frV = 'neutral';
    if(fundingRate >= 0.05){ frV = 'bear'; score -= 1; }
    else if(fundingRate <= -0.02){ frV = 'bull'; score += 1; }
    factors.push({ name: '资金费率', verdict: frV, reason: `费率 ${fundingRate.toFixed(4)}%` });
  }

  if(longShortRatio !== null){
    let lsV = 'neutral';
    if(longShortRatio >= 2.0){ lsV = 'bear'; score -= 1; }
    else if(longShortRatio <= 0.6){ lsV = 'bull'; score += 1; }
    factors.push({ name: '多空持仓比', verdict: lsV, reason: `多空比 ${longShortRatio.toFixed(2)}${lsV === 'bear' ? '(多头过于拥挤)' : lsV === 'bull' ? '(空头过于拥挤)' : ''}` });
  }

  const label = classify(score);
  const pricePos = resistance > support ? ((currentPrice - support) / (resistance - support) * 100) : 50;

  return { label, score, factors, currentPrice, support, resistance, pricePos, hourlyVol };
}

function titleMatchesKeywords(title, keywords){
  const lower = title.toLowerCase();
  return keywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(lower));
}

// 抓取 CoinDesk RSS,只保留过去24小时内、且标题里提到相关币种关键词的新闻
async function fetchRelevantNews(keywords){
  if(keywords.length === 0) return [];
  try{
    const res = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/');
    if(!res.ok) throw new Error(`新闻源请求失败 ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    const news = items.map(item => {
      const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const title = titleMatch ? titleMatch[1].trim() : '';
      const pubDate = dateMatch ? new Date(dateMatch[1].trim()) : null;
      return { title, pubDate };
    }).filter(n => n.title);

    return news
      .filter(n => n.pubDate && !isNaN(n.pubDate) && n.pubDate.getTime() >= cutoff)
      .filter(n => titleMatchesKeywords(n.title, keywords))
      .slice(0, 4);
  }catch(e){
    console.warn('新闻获取失败(跳过):', e.message);
    return [];
  }
}

async function sendTelegram(text){
  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: '📊 打开信号台网页版', url: DASHBOARD_URL }]]
      }
    })
  });
  if(!tgRes.ok){
    console.error('Telegram 发送失败:', await tgRes.text());
  }else{
    console.log('已发送 Telegram 通知');
  }
}

function appendHistory(records){
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(HISTORY_FILE, lines);
}

async function main(){
  if(!BOT_TOKEN || !CHAT_ID){
    console.error('缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID 环境变量(需要在仓库 Secrets 里配置)');
    process.exit(1);
  }

  const fng = await fetchJson('https://api.alternative.me/fng/?limit=1');
  const fngValue = parseInt(fng.data[0].value, 10);

  let prevState = {};
  try{
    prevState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }catch(e){
    // 文件不存在或读取失败,当成全新开始
  }

  const newState = {};
  const changedBlocks = [];
  const changedCoins = [];
  const historyRecords = [];
  const checkedAt = new Date().toISOString();

  for(const coin of COINS){
    let result;
    try{
      result = await computeCoinSignal(coin, fngValue);
    }catch(e){
      console.error(`${coin.name} 信号计算失败(跳过这个币种):`, e.message);
      if(prevState[coin.id]) newState[coin.id] = prevState[coin.id]; // 保留上次的状态,避免这次网络失败把历史记录抹掉
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }

    const existing = prevState[coin.id];
    const rawLabel = result.label;
    let notify = false;
    let newConfirmed, newPending;
    let displayPrevLabel = '(首次运行)';

    if(!existing){
      // 从没记录过这个币种:先建立基线,不推送(避免"从无到有"也算一次变化的误报)
      newConfirmed = rawLabel;
      newPending = null;
      console.log(`${coin.name} 首次记录,建立基线信号: ${rawLabel}(不推送)`);
    }else{
      const prevConfirmed = existing.confirmedLabel ?? null;
      const prevPending = existing.pendingLabel ?? null;
      displayPrevLabel = prevConfirmed || '(首次运行)';

      if(rawLabel === prevConfirmed){
        // 和已确认的信号一致,没有变化
        newConfirmed = prevConfirmed;
        newPending = null;
      }else if(rawLabel === prevPending){
        // 连续两次都指向同一个新分类,确认变化
        newConfirmed = rawLabel;
        newPending = null;
        notify = true;
      }else{
        // 第一次出现这个新分类,先记为待确认,不推送
        newConfirmed = prevConfirmed;
        newPending = rawLabel;
      }
      console.log(`${coin.name} 原始信号: ${rawLabel} | 已确认: ${prevConfirmed || '无'} | 待确认: ${prevPending || '无'} | 本次是否推送: ${notify}`);
    }

    newState[coin.id] = { confirmedLabel: newConfirmed, pendingLabel: newPending, score: result.score, checkedAt };

    historyRecords.push({
      t: checkedAt,
      coin: coin.id,
      price: result.currentPrice,
      score: result.score,
      rawLabel,
      confirmedLabel: newConfirmed,
      notified: notify
    });

    if(notify){
      const volLine = result.hourlyVol !== null
        ? `波动参考:近24h每小时约 ±${(result.hourlyVol * 100).toFixed(2)}%(约 $${(result.hourlyVol * result.currentPrice).toFixed(result.currentPrice < 1 ? 6 : 0)})`
        : null;
      changedBlocks.push(
        [
          `🎯 ${coin.name} 信号变化:${displayPrevLabel} → ${rawLabel}`,
          `现价 $${result.currentPrice.toLocaleString('en-US', { maximumFractionDigits: result.currentPrice < 1 ? 6 : 0 })} | 评分 ${result.score >= 0 ? '+' : ''}${result.score} | 区间位置 ${result.pricePos.toFixed(0)}%`,
          ...(volLine ? [volLine] : []),
          ...result.factors.map(f => `${f.verdict === 'bull' ? '▲' : f.verdict === 'bear' ? '▼' : '●'} ${f.name}:${f.reason}`)
        ].join('\n')
      );
      changedCoins.push(coin);
    }

    await new Promise(r => setTimeout(r, 1000)); // 每个币种之间留点间隔,降低被限流的概率
  }

  if(changedBlocks.length > 0){
    const messageParts = ['📊 加密市场信号更新', '', ...changedBlocks.map(b => b + '\n')];

    const keywords = [...new Set(changedCoins.flatMap(c => c.newsKeywords))];
    const news = await fetchRelevantNews(keywords);
    if(news.length > 0){
      messageParts.push('📰 相关新闻(24小时内)');
      news.forEach((n, i) => messageParts.push(`${i + 1}. ${n.title}`));
      messageParts.push('');
    }

    messageParts.push('⚠️ 机械化技术信号,不构成投资建议');
    await sendTelegram(messageParts.join('\n'));
  }else{
    console.log('本轮没有币种的信号被"连续两次确认"为变化,不发送通知');
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
  appendHistory(historyRecords);
}

main().catch(err => {
  console.error('运行出错:', err);
  process.exit(1);
});
