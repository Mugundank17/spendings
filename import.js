'use strict';
/*
 * Statement import: reads Excel/CSV (SheetJS) and PDF (pdf.js) bank or card
 * statements on-device, extracts spending transactions, auto-categorises them,
 * and lets the user review before adding. Nothing is uploaded anywhere.
 *
 * Depends on globals from app.js: state, save, render, CATEGORIES, catById, fmt, $.
 */
(function () {
  // ---------- lazy library loading ----------
  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete loaded[src]; reject(new Error('Could not load ' + src + ' (are you offline on first use?)')); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  // ---------- value parsing ----------
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => {
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1990 && y < 2100)) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  };

  // Matches a date at the start of a string. Returns {iso, len} or null.
  // dayFirst controls dd/mm vs mm/dd for all-numeric dates.
  const RE_YMD = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/;
  const RE_NUM = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?!\d)/;
  const RE_DMONY = /^(\d{1,2})[-\s/.]?([A-Za-z]{3,4})[a-z]*[-\s/.,]*('?\d{2,4})(?!\d)/;
  const RE_MONDY = /^([A-Za-z]{3,4})[a-z]*[\s.-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s.-]+(\d{4})/;
  function parseDateStr(s, dayFirst = true) {
    s = String(s).trim();
    let m;
    if ((m = s.match(RE_YMD))) { const r = iso(+m[1], +m[2], +m[3]); return r && { iso: r, len: m[0].length }; }
    if ((m = s.match(RE_NUM))) {
      const a = +m[1], b = +m[2], y = +m[3];
      const r = dayFirst ? iso(y, b, a) : iso(y, a, b);
      return r && { iso: r, len: m[0].length };
    }
    if ((m = s.match(RE_DMONY)) && MONTHS[m[2].toLowerCase()]) {
      const r = iso(+m[3].replace("'", ''), MONTHS[m[2].toLowerCase()], +m[1]);
      return r && { iso: r, len: m[0].length };
    }
    if ((m = s.match(RE_MONDY)) && MONTHS[m[1].toLowerCase()]) {
      const r = iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
      return r && { iso: r, len: m[0].length };
    }
    return null;
  }
  function toDate(v, dayFirst) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === 'number' && v > 25000 && v < 80000) { // Excel serial date
      const d = new Date(Math.round((v - 25569) * 86400000));
      return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    const p = parseDateStr(String(v), dayFirst);
    return p ? p.iso : null;
  }
  // For a column of numeric dates, decide dd/mm vs mm/dd from the data itself.
  function detectDayFirst(values) {
    let dayFirst = 0, monthFirst = 0;
    for (const v of values) {
      const m = typeof v === 'string' && v.trim().match(RE_NUM);
      if (!m) continue;
      if (+m[1] > 12) dayFirst++;
      if (+m[2] > 12) monthFirst++;
    }
    if (monthFirst > dayFirst) return false;
    if (dayFirst > 0) return true;
    return !/^en-US$/i.test(navigator.language || '');
  }

  // Parses "1,234.50", "₹ 1,234.50 Dr", "(45.00)", "-12", "1.234,50"? (kept simple: '.' decimal).
  // Returns {value, sign} where sign is -1 for debit markers / negatives, +1 for credit markers, 0 unknown.
  function parseAmount(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? { value: Math.abs(v), sign: v < 0 ? -1 : 0, raw: v } : null;
    let s = String(v).trim();
    if (!s) return null;
    let sign = 0;
    if (/\b(dr|debit)\.?$/i.test(s)) { sign = -1; s = s.replace(/\b(dr|debit)\.?$/i, ''); }
    else if (/\b(cr|credit)\.?$/i.test(s)) { sign = 1; s = s.replace(/\b(cr|credit)\.?$/i, ''); }
    s = s.replace(/[₹$€£¥]|rs\.?|inr|usd|eur|gbp|aed|sgd/gi, '').replace(/\s/g, '');
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/^-/.test(s)) { neg = true; s = s.slice(1); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
    if (/^\+/.test(s)) s = s.slice(1);
    if (!/^\d{1,3}(,\d{2,3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(s)) return null;
    const value = parseFloat(s.replace(/,/g, ''));
    if (!isFinite(value)) return null;
    if (neg && !sign) sign = -1;
    return { value, sign, raw: neg ? -value : value };
  }

  // ---------- categorising & cleaning descriptions ----------
  const RULES = [
    ['food', /swiggy|zomato|eatsure|domino|pizza|mcdonald|kfc|burger|starbucks|cafe|coffee|chai|restaurant|hotel\s?saravana|biryani|bakery|dunkin|subway|food|eatery|dine|kitchen|deliveroo|ubereats|doordash|grubhub/i],
    ['groceries', /bigbasket|blinkit|grofers|zepto|instamart|dmart|d-mart|reliance\s?fresh|more\s?retail|spencer|nature'?s\s?basket|jiomart|grocer|supermarket|kirana|vegetable|fruits|milk|dairy|tesco|walmart|aldi|lidl|costco|sainsbury|kroger|whole\s?foods/i],
    ['transport', /uber|ola\b|olacabs|rapido|metro|irctc|railway|redbus|petrol|diesel|fuel|hpcl|bpcl|iocl|indian\s?oil|shell|fastag|parking|toll|cab|taxi|auto|lyft|bus\b/i],
    ['bills', /electricity|eb\s?bill|tneb|bescom|power|water\s?bill|gas\s?bill|airtel|jio|vodafone|\bvi\b|bsnl|recharge|broadband|act\s?fibernet|postpaid|prepaid|dth|tata\s?play|insurance|lic\b|premium|emi|loan|credit\s?card\s?payment|utility|bill\s?pay|billdesk/i],
    ['rent', /\brent\b|house\s?rent|nobroker|landlord|maintenance|society/i],
    ['health', /pharma|medical|apollo|medplus|1mg|netmeds|pharmeasy|hospital|clinic|doctor|diagnostic|lab|dental|health|gym|cult\.?fit/i],
    ['fun', /netflix|prime\s?video|hotstar|spotify|youtube|bookmyshow|pvr|inox|cinema|movie|steam|playstation|xbox|game|disney|apple\.com\/bill|itunes|zee5|sonyliv/i],
    ['travel', /makemytrip|goibibo|cleartrip|yatra|ixigo|indigo|air\s?india|vistara|spicejet|akasa|airline|airbnb|oyo|booking\.com|agoda|expedia|hotel|resort|trip/i],
    ['shopping', /amazon|flipkart|myntra|ajio|meesho|nykaa|tata\s?cliq|croma|reliance\s?digital|decathlon|ikea|lifestyle|westside|zara|h&m|uniqlo|mall|store|mart|shop|ebay|etsy|target/i],
  ];
  function autoCategory(desc) {
    for (const [cat, re] of RULES) if (re.test(desc)) return cat;
    return 'other';
  }
  const CREDIT_WORDS = /\b(salary|refund|reversal|reversed|cashback|interest\s?(credit|paid)|credited|deposit|received|neft\s?cr|imps\s?cr|by\s?transfer|payment\s?received|thank\s?you)\b/i;
  const NOISE = new Set('upi dr cr p2m p2a imps neft rtgs pos ecom ach nach mmt inb ib txn ref ybl okicici okaxis oksbi okhdfcbank paytm payu razorpay pvt ltd private limited india the to from by transfer payment pay debit credit card vps vin na'.split(' '));
  function cleanNote(desc) {
    desc = String(desc || '').replace(/\s+/g, ' ').trim();
    const seg = desc.match(/\b(UPI|IMPS|NEFT|RTGS|MMT)[/\-].*/i);
    if (seg) desc = seg[0];
    desc = desc.replace(/^(POS|ECOM|VPS|VIN)\s*(\d+X*\d*\s*)?/i, '').replace(/^(ACH|NACH)\s*D?-?\s*/i, '').replace(/^(TO|BY)\s+TRANSFER-?\s*/i, '').trim();
    // UPI/IMPS style "UPI/DR/412345678901/SWIGGY LTD/YESB/swiggy@ybl/..." -> "SWIGGY LTD"
    if (/[/\-|]/.test(desc) && /^(upi|imps|neft|pos|ecom|ach|nach|mmt|vps|vin|bil|ib)/i.test(desc)) {
      const parts = desc.split(/[/|]|-(?=\S)/).map((p) => p.trim()).filter(Boolean);
      const pick = parts.find((p) => /[a-z]{3,}/i.test(p) && !NOISE.has(p.toLowerCase()) && !/@/.test(p) && !/^[A-Z]{4}0?\w{6,}$/.test(p) && !/^\d+$/.test(p));
      if (pick) return pick.slice(0, 80);
    }
    return desc.slice(0, 80);
  }

  // ---------- spreadsheet (xlsx/xls/csv) ----------
  const H = {
    date: /^(txn\s*|transaction\s*|tran\s*|posting\s*|post\s*|value\s*|booking\s*)?date|^date|^dt$|date$/i,
    desc: /narration|description|particulars|details|remarks|merchant|payee|transaction$|^name$|memo|reference|^info/i,
    debit: /debit|withdraw|^dr\b|paid\s*out|money\s*out|spent|outflow|expense/i,
    credit: /credit|deposit|^cr\b|paid\s*in|money\s*in|inflow|income/i,
    amount: /amount|^amt|value|^inr|^sum/i,
    type: /^type$|dr\s*\/\s*cr|cr\s*\/\s*dr|debit\s*\/\s*credit|txn\s*type|transaction\s*type/i,
    balance: /balance/i,
  };
  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const cells = rows[i].map((c) => String(c ?? '').trim());
      const has = (re) => cells.some((c) => c && c.length < 40 && re.test(c));
      if (has(H.date) && (has(H.debit) || has(H.amount))) return i;
    }
    return -1;
  }
  function guessMapping(header, body) {
    const idx = (re, not) => header.findIndex((h, i) => h && re.test(h) && !(not && not.test(h)) && !used.has(i));
    const used = new Set();
    const take = (i) => { if (i >= 0) used.add(i); return i; };
    const m = {};
    // prefer transaction date over value date
    m.date = take([/txn|transaction|tran|posting|^date$/i].map((re) => header.findIndex((h) => h && re.test(h) && H.date.test(h))).find((i) => i >= 0) ?? -1);
    if (m.date < 0) m.date = take(idx(H.date));
    m.type = take(idx(H.type));
    m.debit = take(idx(H.debit, H.balance));
    m.credit = take(idx(H.credit, H.balance));
    m.amount = m.debit >= 0 ? -1 : take(idx(H.amount, H.balance));
    m.desc = take(idx(H.desc, H.date));
    // fallback: the column with the longest average text
    if (m.desc < 0) {
      let best = -1, bestLen = 0;
      header.forEach((_, i) => {
        if (used.has(i)) return;
        const avg = body.slice(0, 50).reduce((s, r) => s + (typeof r[i] === 'string' ? r[i].length : 0), 0);
        if (avg > bestLen) { bestLen = avg; best = i; }
      });
      m.desc = best;
    }
    return m;
  }
  function inferMappingNoHeader(rows) {
    const n = Math.max(...rows.slice(0, 50).map((r) => r.length));
    const score = Array.from({ length: n }, (_, i) => {
      const col = rows.slice(0, 50).map((r) => r[i]);
      return {
        date: col.filter((v) => toDate(v, true)).length,
        num: col.filter((v) => parseAmount(v) && !toDate(v, true)).length,
        text: col.reduce((s, v) => s + (typeof v === 'string' && !parseAmount(v) && !toDate(v, true) ? v.length : 0), 0),
      };
    });
    const best = (k, excl = []) => score.reduce((b, s, i) => (!excl.includes(i) && s[k] > (b < 0 ? 0 : score[b][k]) ? i : b), -1);
    const date = best('date');
    const desc = best('text', [date]);
    const amount = best('num', [date, desc]);
    return { date, desc, amount, debit: -1, credit: -1, type: -1 };
  }

  function rowsFromSheet(rows, m) {
    const dayFirst = detectDayFirst(rows.map((r) => r[m.date]));
    const out = [];
    // When there's a single signed amount column, negatives are spending if the column has both signs.
    let signed = false;
    if (m.amount >= 0 && m.type < 0) {
      const vals = rows.map((r) => parseAmount(r[m.amount])).filter(Boolean);
      signed = vals.some((v) => v.raw < 0) && vals.some((v) => v.raw > 0);
    }
    for (const r of rows) {
      const date = toDate(r[m.date], dayFirst);
      if (!date) continue;
      const desc = m.desc >= 0 ? String(r[m.desc] ?? '').trim() : '';
      let amount = null, credit = false;
      if (m.debit >= 0) {
        const d = parseAmount(r[m.debit]);
        const c = m.credit >= 0 ? parseAmount(r[m.credit]) : null;
        if (d && d.value > 0) amount = d.value;
        else if (c && c.value > 0) { amount = c.value; credit = true; }
      } else if (m.amount >= 0) {
        const a = parseAmount(r[m.amount]);
        if (!a || !a.value) continue;
        amount = a.value;
        const t = m.type >= 0 ? String(r[m.type] ?? '') : '';
        if (t) credit = /^\s*(cr|credit|c|deposit|in)\b/i.test(t);
        else if (a.sign === 1) credit = true;
        else if (signed) credit = a.raw > 0;
        else credit = CREDIT_WORDS.test(desc);
      }
      if (!amount) continue;
      out.push({ date, desc, amount: Math.round(amount * 100) / 100, credit });
    }
    return out;
  }

  async function readSpreadsheet(file) {
    await loadScript('vendor/xlsx.full.min.js');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    // pick the sheet with the most rows
    let best = null;
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
      if (!best || rows.length > best.rows.length) best = { name, rows };
    }
    if (!best || !best.rows.length) throw new Error('The file looks empty.');
    const hi = findHeader(best.rows);
    let header, body, mapping;
    if (hi >= 0) {
      header = best.rows[hi].map((c) => String(c ?? '').trim());
      body = best.rows.slice(hi + 1);
      mapping = guessMapping(header, body);
    } else {
      body = best.rows;
      const n = Math.max(...body.map((r) => r.length));
      header = Array.from({ length: n }, (_, i) => `Column ${String.fromCharCode(65 + (i % 26))}`);
      mapping = inferMappingNoHeader(body);
    }
    return { kind: 'sheet', header, body, mapping };
  }

  // ---------- PDF ----------
  async function readPdf(file) {
    await loadScript('vendor/pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const data = new Uint8Array(await file.arrayBuffer());
    let pdf, password;
    for (;;) {
      try {
        pdf = await pdfjsLib.getDocument({ data: data.slice(), password }).promise;
        break;
      } catch (e) {
        if (e && e.name === 'PasswordException') {
          password = prompt(e.code === 2 ? 'Wrong password. Try again:' : 'This PDF is password-protected (common for bank statements). Enter its password:');
          if (password == null) throw new Error('Cancelled.');
          continue;
        }
        throw e;
      }
    }
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      pages.push(tc.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({ str: it.str.trim(), x: it.transform[4], y: it.transform[5], w: it.width || 0 })));
    }
    if (!pages.some((pg) => pg.length)) throw new Error('No text found in this PDF. If it is a scanned image, export a CSV/Excel statement from your bank instead.');
    return { kind: 'pdf', rows: parsePdfPages(pages) };
  }

  const AMT_TOKEN = /^[-+(]?[₹$€£]?\s?(\d{1,3}(,\d{2,3})+|\d+)\.\d{2}\)?(\s?(cr|dr)\.?)?$/i;
  const HEADER_RE = /(withdraw|debit|^dr\b|deposit|credit|^cr\b|amount|balance|paid\s*(in|out))/i;

  // Groups items whose y is within tol into lines (top to bottom).
  function toLines(items, tol = 3) {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const l = lines[lines.length - 1];
      if (l && Math.abs(l.y - it.y) <= tol) l.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    return lines;
  }

  // Bank PDFs are tables whose cells often wrap onto several lines. We anchor each
  // transaction row on its amount(s), then pull in every text fragment vertically
  // closest to that anchor, rebuild cells by column, and read date/description/amount.
  function parsePdfPages(pages) {
    let cols = null;
    const rows = [];
    for (const raw of pages) {
      // split items like "05 Nov 2026   SWIGGY   349.00" that come as one string
      const items = [];
      for (const it of raw) {
        const parts = it.str.split(/\s{2,}/);
        if (parts.length === 1) { items.push(it); continue; }
        const cw = it.w / it.str.length;
        let off = 0;
        for (const part of parts) {
          const i = it.str.indexOf(part, off);
          items.push({ str: part.trim(), x: it.x + i * cw, y: it.y, w: part.length * cw });
          off = i + part.length;
        }
      }
      // header (repeated per page in most statements)
      let headerY = null;
      for (const l of toLines(items, 8)) {
        const words = l.items.map((i) => i.str).join(' ');
        if (/date/i.test(words) && l.items.filter((i) => HEADER_RE.test(i.str)).length >= 1 && !l.items.some((i) => AMT_TOKEN.test(i.str))) {
          const find = (re) => { const it = l.items.find((i) => re.test(i.str)); return it ? it.x + it.w / 2 : null; };
          const c = { debit: find(/withdraw|debit|^dr\b|paid\s*out/i), credit: find(/deposit|credit|^cr\b|paid\s*in/i), balance: find(/balance/i), amount: find(/amount/i) };
          if (c.debit != null || c.credit != null || c.amount != null) { cols = c; headerY = Math.min(...l.items.map((i) => i.y)); break; }
        }
      }
      const body = headerY == null ? items : items.filter((i) => i.y < headerY - 1);
      // anchors: lines containing amount tokens
      const anchors = toLines(body.filter((i) => AMT_TOKEN.test(i.str)));
      if (!anchors.length) continue;
      const others = body.filter((i) => !AMT_TOKEN.test(i.str));
      const groups = anchors.map((a) => ({ y: a.y, amts: a.items, text: [] }));
      const gaps = groups.slice(1).map((g, i) => groups[i].y - g.y).sort((a, b) => a - b);
      const edge = gaps.length ? Math.min(26, gaps[Math.floor(gaps.length / 2)] / 2 + 0.5) : 26;
      for (const it of others) {
        let bi = -1, bd = Infinity;
        groups.forEach((g, i) => { const d = Math.abs(g.y - it.y); if (d < bd) { bd = d; bi = i; } });
        const g = groups[bi];
        const neighbour = groups[it.y > g.y ? bi - 1 : bi + 1];
        const limit = neighbour ? Math.abs(neighbour.y - g.y) / 2 + 0.5 : edge;
        if (bd <= Math.min(limit, 40)) g.text.push(it);
      }
      for (const g of groups) {
        // rebuild cells: fragments sharing a left edge belong to the same column
        const cells = [];
        for (const it of [...g.text].sort((a, b) => a.x - b.x || b.y - a.y)) {
          const c = cells.find((c) => Math.abs(c.x - it.x) < 4);
          if (c) c.items.push(it); else cells.push({ x: it.x, items: [it] });
        }
        cells.sort((a, b) => a.x - b.x);
        const cellText = cells.map((c) => c.items.sort((a, b) => b.y - a.y).reduce((s, i) => (s && !/[-/]$/.test(s) ? s + ' ' : s) + i.str, ''));
        rows.push({ cells: cellText, amts: g.amts });
      }
    }
    const dayFirst = detectDayFirst(rows.map((r) => r.cells.join(' ')));

    const out = [];
    let prevBalance = null;
    for (const r of rows) {
      const joined = r.cells.join(' ');
      const parsed = r.amts.map((t) => ({ ...parseAmount(t.str), cx: t.x + t.w / 2 })).filter((a) => a.value != null);
      if (!parsed.length) continue;
      if (/opening\s*balance|balance\s*(b\/f|brought|forward)/i.test(joined)) { prevBalance = parsed[parsed.length - 1].raw; continue; }
      // date = first cell that starts with a date; other date-only cells (value date) are dropped
      let d = null;
      const descParts = [];
      for (const c of r.cells) {
        const cd = parseDateStr(c, dayFirst);
        if (cd && !d) { d = cd; const rest = c.slice(cd.len).trim(); const rd = parseDateStr(rest, dayFirst); const tail = rd ? rest.slice(rd.len).trim() : rest; if (tail) descParts.push(tail); }
        else if (cd && c.trim().length - cd.len < 3) continue;
        else if (!/^page\s*\d+(\s*(of|\/)\s*\d+)?$/i.test(c)) descParts.push(c);
      }
      if (!d) continue;
      const desc = descParts.join(' ').trim();
      if (/^(total|closing\s*balance|grand\s*total)/i.test(desc)) continue;

      let amount = null, credit = null, balance = null;
      if (cols && (cols.debit != null || cols.credit != null || cols.amount != null)) {
        const opts = Object.entries(cols).filter(([, x]) => x != null);
        for (const a of parsed) {
          const which = opts.reduce((b, o) => (Math.abs(o[1] - a.cx) < Math.abs(b[1] - a.cx) ? o : b))[0];
          if (which === 'balance') balance = a.raw;
          else if (amount != null) continue;
          else if (which === 'debit') { amount = a.value; credit = false; }
          else if (which === 'credit') { amount = a.value; credit = true; }
          else { amount = a.value; credit = a.sign === 1 ? true : a.sign === -1 ? false : null; }
        }
      }
      if (amount == null) {
        const first = parsed[0];
        amount = first.value;
        credit = first.sign === 1 ? true : first.sign === -1 ? false : null;
        if (parsed.length >= 2) balance = parsed[parsed.length - 1].raw;
      }
      // balance movement is the most reliable signal when available
      if (balance != null && prevBalance != null) {
        const diff = Math.round((balance - prevBalance) * 100) / 100;
        if (Math.abs(Math.abs(diff) - amount) < 0.011) credit = diff > 0;
      }
      if (credit == null) credit = CREDIT_WORDS.test(desc);
      if (balance != null) prevBalance = balance;
      if (!amount) continue;
      out.push({ date: d.iso, desc, amount: Math.round(amount * 100) / 100, credit });
    }
    return out;
  }

  // ---------- review dialog ----------
  let current = null; // { parsed, rows: [{date, desc, amount, credit, note, category, include, dup}] }

  function buildRows(raw) {
    const existing = new Set(state.expenses.map((e) => `${e.date}|${e.amount}`));
    const seen = new Set();
    return raw.map((r) => {
      const note = cleanNote(r.desc);
      const key = `${r.date}|${r.amount}`;
      const dup = existing.has(key) || seen.has(key + '|' + note);
      seen.add(key + '|' + note);
      return { ...r, note, category: autoCategory(r.desc), dup, include: !r.credit && !dup };
    });
  }

  function renderMapping() {
    const box = $('impMapping');
    if (!current || current.parsed.kind !== 'sheet') { box.hidden = true; return; }
    box.hidden = false;
    const { header, mapping } = current.parsed;
    const opts = (sel) => `<option value="-1">—</option>` + header.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${escapeHtml(h || 'Column ' + (i + 1))}</option>`).join('');
    const fields = [['date', 'Date'], ['desc', 'Description'], ['debit', 'Debit / Withdrawal'], ['credit', 'Credit / Deposit'], ['amount', 'Amount (single column)'], ['type', 'Dr/Cr type']];
    const open = box.querySelector('details')?.open || !current.rows.length;
    box.innerHTML = `<details ${open ? 'open' : ''}><summary class="small">Columns used (tap to change)</summary>` +
      fields.map(([k, label]) => `<label class="field map">${label}<select data-k="${k}">${opts(mapping[k])}</select></label>`).join('') + '</details>';
    box.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => {
      mapping[s.dataset.k] = +s.value;
      current.rows = buildRows(rowsFromSheet(current.parsed.body, mapping));
      renderReview();
    }));
  }

  function renderReview() {
    const list = $('impList');
    const rows = current.rows;
    const sel = rows.filter((r) => r.include);
    $('impSummary').textContent = rows.length
      ? `Found ${rows.length} transactions · ${rows.filter((r) => r.credit).length} credits (skipped) · ${rows.filter((r) => r.dup).length} possible duplicates`
      : 'No transactions found. Check the column choices above, or try a different file.';
    $('impConfirm').textContent = `Add ${sel.length} expense${sel.length === 1 ? '' : 's'} · ${fmt(sel.reduce((s, r) => s + r.amount, 0))}`;
    $('impConfirm').disabled = !sel.length;
    $('impShowCredits').parentElement.hidden = !rows.some((r) => r.credit);

    const showCredits = $('impShowCredits').checked;
    list.innerHTML = '';
    rows.forEach((r, i) => {
      if (r.credit && !showCredits) return;
      const li = document.createElement('li');
      li.className = 'imp-row' + (r.include ? '' : ' off');
      li.innerHTML = `
        <input type="checkbox" ${r.include ? 'checked' : ''} aria-label="Include">
        <div class="imp-main">
          <input class="imp-note" type="text" maxlength="80">
          <div class="imp-meta">
            <span>${new Date(r.date + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' })}</span>
            ${r.credit ? '<span class="tag credit">credit</span>' : ''}${r.dup ? '<span class="tag dup">duplicate?</span>' : ''}
            <select class="imp-cat">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === r.category ? 'selected' : ''}>${c.emoji} ${c.name}</option>`).join('')}</select>
          </div>
        </div>
        <span class="amt">${fmt(r.amount)}</span>`;
      const note = li.querySelector('.imp-note');
      note.value = r.note;
      note.title = r.desc;
      note.addEventListener('change', () => { r.note = note.value.trim(); });
      li.querySelector('.imp-cat').addEventListener('change', (e) => { r.category = e.target.value; });
      li.querySelector('input[type=checkbox]').addEventListener('change', (e) => { r.include = e.target.checked; renderReview(); });
      list.appendChild(li);
    });
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function handleFile(file) {
    const dlg = $('importDialog');
    $('impStatus').textContent = `Reading ${file.name}…`;
    $('impStatus').hidden = false;
    $('impBody').hidden = true;
    dlg.showModal();
    try {
      const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      const parsed = isPdf ? await readPdf(file) : await readSpreadsheet(file);
      const raw = parsed.kind === 'pdf' ? parsed.rows : rowsFromSheet(parsed.body, parsed.mapping);
      current = { parsed, rows: buildRows(raw) };
      $('impStatus').hidden = true;
      $('impBody').hidden = false;
      $('impShowCredits').checked = false;
      renderMapping();
      renderReview();
    } catch (e) {
      $('impStatus').textContent = 'Could not read this file: ' + (e && e.message ? e.message : e);
    }
  }

  $('importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) handleFile(f);
  });
  $('impShowCredits').addEventListener('change', renderReview);
  $('impCancel').addEventListener('click', () => { $('importDialog').close(); current = null; });
  $('impAll').addEventListener('click', () => {
    const anyOff = current.rows.some((r) => !r.credit && !r.include);
    current.rows.forEach((r) => { if (!r.credit) r.include = anyOff; });
    renderReview();
  });
  $('impConfirm').addEventListener('click', () => {
    const sel = current.rows.filter((r) => r.include);
    const now = Date.now();
    sel.forEach((r, i) => state.expenses.push({
      id: now.toString(36) + i.toString(36) + Math.random().toString(36).slice(2, 5),
      created: now + i,
      amount: r.amount,
      category: r.category,
      note: r.note,
      date: r.date,
      source: 'import',
    }));
    save();
    $('importDialog').close();
    if (sel.length) {
      const latest = sel.map((r) => r.date).sort().pop().split('-').map(Number);
      window.showMonth(latest[0], latest[1] - 1);
    }
    current = null;
    alert(`Added ${sel.length} expenses.`);
  });

  // exposed for tests
  window.SpendImport = { parseDateStr, parseAmount, cleanNote, autoCategory, parsePdfPages, rowsFromSheet, handleFile };
})();
