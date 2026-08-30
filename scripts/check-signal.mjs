// scripts/check-signal.mjs
// 定时拉取 BTC/ETH/SOL/DOGE 数据(1小时颗粒度)、分别计算信号,
// 只有某个币种信号发生变化时,才把当次变化 + 24小时内市场新闻一起推送 Telegram

import fs from 'fs';

const STATE_FILE = 'signal-state.json';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 想增减关注的币种,改这个数组就行
const COINS = [
  { id: 'bitcoin', name: 'BTC', binanceSymbol: 'BTCUSDT' },
  { id: 'ethereum', name: 'ETH', binanceSymbol: 'ETHUSDT' },
  { id: 'solana', name: 'SOL', binanceSymbol: 'SOLUSDT' },
  { id: 'dogecoin', name: 'DOGE', binanceSymbol: 'DOGEUSDT' },
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

  let fundingRate = null;
  try{
    const fund = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.binanceSymbol}`);
    fundingRate = parseFloat(fund.lastFundingRate) * 100;
  }catch(e){
    console.warn(`${coin.name} 资金费率获取失败(跳过):`, e.message);
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

  const label = classify(score);
  const pricePos = resistance > support ? ((currentPrice - support) / (resistance - support) * 100) : 50;

  return { label, score, factors, currentPrice, support, resistance, pricePos };
}

// 抓取 CoinDesk RSS,只保留过去24小时内的新闻标题
async function fetchNews(){
  try{
    const res = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/');
    if(!res.ok) throw new Error(`新闻源请求失败 ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    const news = items.map(item => {
      const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
      const title = titleMatch ? titleMatch[1].trim() : '';
      const pubDate = dateMatch ? new Date(dateMatch[1].trim()) : null;
      const link = linkMatch ? linkMatch[1].trim() : '';
      return { title, pubDate, link };
    }).filter(n => n.title);

    const recent = news.filter(n => n.pubDate && !isNaN(n.pubDate) && n.pubDate.getTime() >= cutoff);
    return recent.slice(0, 4);
  }catch(e){
    console.warn('新闻获取失败(跳过):', e.message);
    return [];
  }
}

async function sendTelegram(text){
  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true })
  });
  if(!tgRes.ok){
    console.error('Telegram 发送失败:', await tgRes.text());
  }else{
    console.log('已发送 Telegram 通知');
  }
}

async function main(){
  if(!BOT_TOKEN || !CHAT_ID){
    console.error('缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID 环境变量(需要在仓库 Secrets 里配置)');
    process.exit(1);
  }

  // 恐慌贪婪指数是全市场共用的,只需要拉一次
  const fng = await fetchJson('https://api.alternative.me/fng/?limit=1');
  const fngValue = parseInt(fng.data[0].value, 10);

  // 读取上次各币种的状态
  let prevState = {};
  try{
    prevState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }catch(e){
    // 文件不存在(首次运行),忽略
  }

  const newState = {};
  const changedBlocks = [];

  for(const coin of COINS){
    let result;
    try{
      result = await computeCoinSignal(coin, fngValue);
    }catch(e){
      console.error(`${coin.name} 信号计算失败(跳过这个币种):`, e.message);
      continue;
    }

    const prevLabel = prevState[coin.id]?.label ?? null;
    const changed = prevLabel !== result.label;
    console.log(`${coin.name} 当前信号: ${result.label} (评分 ${result.score}) | 上次: ${prevLabel || '(无记录)'} | 是否变化: ${changed}`);

    newState[coin.id] = { label: result.label, score: result.score, checkedAt: new Date().toISOString() };

    if(changed){
      changedBlocks.push(
        [
          `🎯 ${coin.name} 信号变化:${prevLabel || '(首次运行)'} → ${result.label}`,
          `现价 $${result.currentPrice.toLocaleString('en-US', { maximumFractionDigits: result.currentPrice < 1 ? 6 : 0 })} | 评分 ${result.score >= 0 ? '+' : ''}${result.score} | 区间位置 ${result.pricePos.toFixed(0)}%`,
          ...result.factors.map(f => `${f.verdict === 'bull' ? '▲' : f.verdict === 'bear' ? '▼' : '●'} ${f.name}:${f.reason}`)
        ].join('\n')
      );
    }
  }

  if(changedBlocks.length > 0){
    const messageParts = ['📊 加密市场信号更新', '', ...changedBlocks.map(b => b + '\n')];

    const news = await fetchNews();
    if(news.length > 0){
      messageParts.push('📰 24小时内市场新闻');
      news.forEach((n, i) => messageParts.push(`${i + 1}. ${n.title}`));
      messageParts.push('');
    }

    messageParts.push('⚠️ 机械化技术信号,不构成投资建议');
    await sendTelegram(messageParts.join('\n'));
  }else{
    console.log('本轮所有币种信号均未变化,不发送通知');
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
}

main().catch(err => {
  console.error('运行出错:', err);
  process.exit(1);
});
