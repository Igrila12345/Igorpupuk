const { Telegraf, Markup } = require("telegraf");
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URLSearchParams } = require("url");
const { SocksProxyAgent } = require("socks-proxy-agent");

const BOT_TOKEN = "8933739032:AAEDh5424JQ8r3dtFZp5voPOEXenNrRSVzU";
const ADMIN_ID = "8100362442";
const PROXY_USER_ID = "1851268445";
const PROXY_URL = "socks5://hwGAWd:kKnKaa@94.127.137.39:8000";
const API_BASE = "https://api.slaves.su/v1";
const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const escMd = (s) => String(s ?? "").replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");

const FILES = {
    accounts: path.join(DATA_DIR, "accounts.json"),
    access: path.join(DATA_DIR, "access.json"),
    sessions: path.join(DATA_DIR, "sessions.json"),
};

function load(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } }
function save(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

function getAccounts(oid) { const a = load(FILES.accounts, {}); return a[String(oid)] || {}; }
function getAccount(oid, aid) { return getAccounts(oid)[aid] || null; }
function saveAccount(oid, aid, acc) {
    const a = load(FILES.accounts, {});
    if (!a[String(oid)]) a[String(oid)] = {};
    a[String(oid)][aid] = acc;
    save(FILES.accounts, a);
}
function deleteAccount(oid, aid) {
    const a = load(FILES.accounts, {});
    const k = String(oid);
    if (a[k] && a[k][aid]) { delete a[k][aid]; save(FILES.accounts, a); return true; }
    return false;
}
function listAllAccounts() {
    const a = load(FILES.accounts, {});
    const rows = [];
    for (const o in a) for (const i in a[o]) rows.push({ ownerId: o, accId: i, ...a[o][i] });
    return rows;
}

function getAccessList() { return load(FILES.access, []); }
function hasAccess(tg, adm) {
    if (String(tg) === String(adm)) return true;
    return getAccessList().includes(String(tg));
}
function grantAccess(tg) {
    const l = getAccessList();
    if (!l.includes(String(tg))) { l.push(String(tg)); save(FILES.access, l); return true; }
    return false;
}
function revokeAccess(tg) {
    const l = getAccessList().filter((x) => x !== String(tg));
    save(FILES.access, l);
}

function getSession(tg) { return load(FILES.sessions, {})[String(tg)] || null; }
function setSession(tg, s) { const a = load(FILES.sessions, {}); a[String(tg)] = s; save(FILES.sessions, a); }
function clearSession(tg) { const a = load(FILES.sessions, {}); delete a[String(tg)]; save(FILES.sessions, a); }

function defaultSettings() {
    return {
        theft: { victimId: "", delayMs: 100, adWaitMs: 7000 },
        buyVictim: { victimId: "", minPrice: 0, maxPrice: 40000, minProfit: 0, maxProfit: 999999, delayMs: 1000, buyLimit: 0 },
        buyTop: {
            minPrice: 0, maxPrice: 20000, minProfit: 65, maxProfit: 999999,
            delayScanMs: 0, delayBuyMs: 500, buyPerToper: 250, topLimit: 0,
            buyLimitTotal: 0, sortMode: "price_asc", concurrency: 10,
        },
    };
}

function createAccount(name, launchParams, vkUserId) {
    return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name, launchParams, vkUserId, createdAt: Date.now(),
        settings: defaultSettings(),
        stats: { totalTheft: 0, totalBought: 0, lastJobAt: null },
    };
}

function md5(buf) { return crypto.createHash("md5").update(buf).digest(); }
function evpKDF(pass, salt) {
    const p = Buffer.from(pass, "utf8");
    let data = Buffer.alloc(0), prev = Buffer.alloc(0);
    while (data.length < 48) { prev = md5(Buffer.concat([prev, p, salt])); data = Buffer.concat([data, prev]); }
    return { key: data.slice(0, 32), iv: data.slice(32, 48) };
}
function aesEncrypt(plain, pass) {
    const salt = crypto.randomBytes(8);
    const { key, iv } = evpKDF(pass, salt);
    const c = crypto.createCipheriv("aes-256-cbc", key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([Buffer.from("Salted__", "utf8"), salt, ct]).toString("base64");
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
function genUUIDToken(g = 6) {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const grp = () => Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join("");
    return Array.from({ length: g }, grp).join("-");
}

class SlavesClient {
    constructor(lp, useProxy = false) {
        this.launchParams = lp;
        this.params = new URLSearchParams(lp);
        this.token = null;
        this.drift = 0;
        this.myVkId = this.params.get("vk_user_id");
        this.useProxy = useProxy;

        if (useProxy) {
            this.agent = new SocksProxyAgent(PROXY_URL, {
                keepAlive: true,
                keepAliveMsecs: 30000,
                maxSockets: 40,
                maxFreeSockets: 20,
            });
        } else {
            this.agent = new https.Agent({
                keepAlive: true,
                keepAliveMsecs: 30000,
                maxSockets: 40,
                maxFreeSockets: 20,
                scheduling: "lifo",
            });
        }
    }
    _now() { return Date.now() + this.drift; }
    checkString() {
        const o = {};
        this.params.forEach((v, k) => { o[k] = v; });
        return Object.keys(o).sort().map((k) => k + "=" + encodeURIComponent(o[k])).join("&");
    }
    genCry(text) { return aesEncrypt(Buffer.from(text).toString("base64"), this.token); }
    contentSign() {
        const ts = Math.floor(this._now() / 1000);
        const plain = this.checkString() + ":" + genUUIDToken(6) + ":" + ts;
        return aesEncrypt(b64(encodeURIComponent(plain)), this.token);
    }
    xVersion() { return Number(this.myVkId).toString(32); }
    getHeaders(p) {
        const h = {
            "Content-Sign": this.contentSign(),
            "x-version": this.xVersion(),
            "Accept": "application/json, text/plain, */*",
        };
        if (p.startsWith("/slaves/") && p.endsWith("/profile")) {
            const v = p.split("/")[2];
            h["x-temp-sign"] = this.genCry(`profile:${this._now()}:${v}`);
        }
        if (p.includes("/profile_slaves")) {
            const v = p.split("/")[2];
            h["x-temp-sign"] = this.genCry(`profile_slaves:${this._now()}:${v}`);
        }
        if (p.startsWith("/slaves/") && p.endsWith("/buy")) {
            const v = p.split("/")[2];
            h["x-temp-sign"] = this.genCry(`buy:${this._now()}:${v}:profile`);
        }
        if (p.includes("/ads/check")) {
            const us = Math.floor(this._now() / 1000);
            h["x-temp-sign"] = this.genCry(`check_ads:${us}:theft:reward_theft_from_top:100`);
        }
        if (p.includes("/ads/prepare")) h["x-temp-sign"] = this.genCry("reward");
        return h;
    }
    _req(method, p, headers = {}, body = null) {
        const url = API_BASE + p;
        return new Promise((resolve, reject) => {
            const options = { method, headers: { ...headers }, agent: this.agent };
            const req = https.request(url, options, (res) => {
                let data = "";
                res.on("data", (d) => (data += d));
                res.on("end", () => {
                    let json; try { json = JSON.parse(data); } catch { json = data; }
                    if (res.statusCode >= 400) {
                        const err = new Error("HTTP " + res.statusCode + ": " + JSON.stringify(json));
                        err.statusCode = res.statusCode;
                        err.body = json;
                        return reject(err);
                    }
                    resolve(json);
                });
            });
            req.on("error", reject);
            req.setTimeout(15000, () => req.destroy(new Error("HTTP timeout 15s")));
            if (method === "POST") {
                req.setHeader("Content-Type", "application/json");
                const bs = body === null ? "" : JSON.stringify(body);
                if (bs) {
                    req.setHeader("Content-Length", Buffer.byteLength(bs));
                    req.write(bs);
                }
            }
            req.end();
        });
    }
    async authenticate() {
        if (this.token) return this.token;
        const headers = {
            "x-init-data": encodeURIComponent(this.checkString()),
            "x-geo": JSON.stringify({ ok: false }),
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://slaves.su",
            "Referer": "https://slaves.su/",
        };
        const data = await this._req("GET", "/auth?ts=" + Date.now(), headers);
        if (!data || !data.token) throw new Error("auth без token: " + JSON.stringify(data));
        this.token = data.token;
        this.drift = data.drift || 0;
        return this.token;
    }
    getProfile(v) { const p = "/slaves/" + v + "/profile"; return this._req("GET", p, this.getHeaders(p)); }
    getVictimSlaves(v) { const p = "/slaves/" + v + "/profile_slaves"; return this._req("GET", p, this.getHeaders(p)); }
    buySlave(v) { const p = "/slaves/" + v + "/buy"; return this._req("POST", p, this.getHeaders(p), {}); }
    prepareAd() { const p = "/ads/prepare"; return this._req("GET", p, this.getHeaders(p)); }
    checkAd() { const p = "/ads/check"; return this._req("GET", p, this.getHeaders(p)); }
    getTopMembers() {
        const p = "/top/members/get";
        const h = { "Content-Sign": this.contentSign(), "x-version": this.xVersion(), "Accept": "application/json, text/plain, */*" };
        return this._req("GET", p, h);
    }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function sleep(ms, ctx) {
    return new Promise((resolve, reject) => {
        const total = Math.max(0, ms);
        const step = 100;
        let elapsed = 0;
        const tick = () => {
            if (ctx && ctx.shouldStop()) return reject(new Error("__STOPPED__"));
            if (elapsed >= total) return resolve();
            const next = Math.min(step, total - elapsed);
            elapsed += next;
            setTimeout(tick, next);
        };
        tick();
    });
}

function checkStop(ctx) { if (ctx.shouldStop()) throw new Error("__STOPPED__"); }

async function retry429(fn, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            if (String(e.message).includes("429")) { await delay(1000 * Math.pow(2, i)); continue; }
            throw e;
        }
    }
    throw new Error("retries exhausted");
}

function errText(err) {
    let t = String(err && err.message ? err.message : err || "");
    try { if (err && err.body) t += " " + JSON.stringify(err.body); } catch (_) {}
    return t.toLowerCase();
}
function isSlaveLimitErr(err) {
    const s = errText(err);
    return s.includes("работник") || s.includes("работ") || s.includes("превыш") ||
           s.includes("лимит") || s.includes("maximum") || s.includes("slave");
}
function isNoMoneyErr(err) {
    const s = errText(err);
    return s.includes("balance") || s.includes("денег") || s.includes("средств") ||
           s.includes("недостаточно") || s.includes("402");
}
function isRateLimitErr(err) {
    const s = errText(err);
    return s.includes("429") || s.includes("rate limit");
}

async function runTheft(acc, onLog, ctx, useProxy = false) {
    const s = acc.settings.theft;
    if (!s.victimId) throw new Error("Не указан VICTIM_ID");
    const client = new SlavesClient(acc.launchParams, useProxy);
    onLog(`Авторизация...${useProxy ? " (через прокси)" : ""}`);
    await client.authenticate();
    checkStop(ctx);
    const my = await client.getProfile(client.myVkId);
    checkStop(ctx);
    onLog(`Профиль: ${my.first_name} ${my.last_name} | баланс: ${my.balance}`);
    const v = await client.getProfile(s.victimId);
    checkStop(ctx);
    onLog(`Жертва: ${v.first_name} ${v.last_name} | баланс: ${v.balance}`);
    let total = 0, count = 0;
    while (true) {
        checkStop(ctx);
        count++;
        try {
            onLog(`[${count}] prepare...`);
            await client.prepareAd();
            checkStop(ctx);
            await sleep(s.adWaitMs, ctx);
            checkStop(ctx);
            const r = await client.checkAd();
            checkStop(ctx);
            const stolen = r.theft_deducted || 0;
            const reward = r.theft_to_add || 0;
            total += stolen;
            onLog(`[${count}] украдено ${stolen} | награда ${reward} | всего ${total}`);
            await sleep(s.delayMs, ctx);
        } catch (e) {
            if (e.message === "__STOPPED__") throw e;
            onLog(`[${count}] ошибка: ${e.message}`);
            if (e.message.toLowerCase().includes("balance")) { onLog("Закончились деньги"); break; }
            await sleep(3000, ctx);
        }
    }
    return { totalStolen: total, count };
}

async function runBuyVictim(acc, onLog, ctx, useProxy = false) {
    const s = acc.settings.buyVictim;
    if (!s.victimId) throw new Error("Не указан VICTIM_ID");
    const client = new SlavesClient(acc.launchParams, useProxy);
    onLog(`Авторизация...${useProxy ? " (через прокси)" : ""}`);
    await client.authenticate();
    checkStop(ctx);
    const my = await client.getProfile(client.myVkId);
    checkStop(ctx);
    onLog(`Профиль: ${my.first_name} ${my.last_name} | баланс: ${my.balance}`);
    const v = await client.getProfile(s.victimId);
    checkStop(ctx);
    onLog(`Жертва: ${v.first_name} ${v.last_name} | рабов ${v.slaves_count}`);
    let totalBought = 0, totalSkipped = 0, round = 0;
    while (true) {
        checkStop(ctx);
        round++;
        onLog(`Стенка ${round}`);
        const slaves = await client.getVictimSlaves(s.victimId);
        checkStop(ctx);
        if (!Array.isArray(slaves) || slaves.length === 0) { onLog("Нет рабов — стоп"); break; }
        onLog(`Загружено ${slaves.length} рабов`);
        let bRound = 0, sRound = 0;
        for (const sl of slaves) {
            checkStop(ctx);
            const price = sl.cost || 0, profit = sl.salary || 0;
            const sid = sl.vkid || sl.id;
            const name = `${sl.first_name || ""} ${sl.last_name || ""}`.trim() || "Unknown";
            if (sl.my_slave === 1) { sRound++; totalSkipped++; continue; }
            const pOk = price >= s.minPrice && price <= s.maxPrice;
            const dOk = profit >= s.minProfit && profit <= s.maxProfit;
            if (!pOk || !dOk) { sRound++; totalSkipped++; continue; }
            if (s.buyLimit > 0 && totalBought >= s.buyLimit) { onLog(`Лимит ${s.buyLimit}`); return { totalBought, totalSkipped, round }; }
            try {
                const r = await client.buySlave(sid);
                checkStop(ctx);
                totalBought++; bRound++;
                onLog(`Куплен ${name} за ${price} (доход ${profit}) | всего ${totalBought}`);
                if (r) onLog(`  баланс ${r.new_balance} | рабов ${r.slaves_count}`);
            } catch (e) {
                if (e.message === "__STOPPED__") throw e;
                if (e.message.includes("429")) onLog(`Rate limit ${name}`);
                else if (e.message.toLowerCase().includes("balance")) { onLog("Закончились деньги"); return { totalBought, totalSkipped, round }; }
                else onLog(`Ошибка ${name}: ${e.message}`);
            }
            await sleep(s.delayMs, ctx);
        }
        onLog(`Стенка ${round}: куплено ${bRound}, пропущено ${sRound}`);
        const upd = await client.getProfile(s.victimId);
        checkStop(ctx);
        onLog(`Профиль жертвы: рабов ${upd.slaves_count}`);
        if (upd.slaves_count === 0) break;
        if (bRound === 0 && sRound > 0) break;
    }
    return { totalBought, totalSkipped, round };
}

function extractTopers(data) {
    if (!data) return [];
    let arr = null;
    if (Array.isArray(data)) arr = data;
    else if (Array.isArray(data.members)) arr = data.members;
    else if (Array.isArray(data.top)) arr = data.top;
    else if (Array.isArray(data.users)) arr = data.users;
    else if (Array.isArray(data.items)) arr = data.items;
    else if (data.data && Array.isArray(data.data)) arr = data.data;
    if (!arr) return [];
    const out = [], seen = new Set();
    for (const it of arr) {
        let id = null;
        if (typeof it === "number") id = String(it);
        else if (it) id = String(it.vkid ?? it.id ?? it.user_id ?? it.uid ?? "");
        if (id && id !== "undefined" && id !== "null" && !seen.has(id)) { seen.add(id); out.push({ vkid: id }); }
    }
    return out;
}

async function runBuyTop(acc, onLog, ctx, useProxy = false) {
    const s = acc.settings.buyTop;
    const client = new SlavesClient(acc.launchParams, useProxy);
    const CONC = s.concurrency || 10;
    const LOG_EVERY_N = 25;
    const LIMIT_STREAK_STOP = 10;

    onLog(`Авторизация...${useProxy ? " (через прокси)" : ""}`);
    await client.authenticate();
    checkStop(ctx);

    const my = await client.getProfile(client.myVkId);
    checkStop(ctx);
    onLog(`Профиль: ${my.first_name} ${my.last_name} | баланс: ${my.balance} | рабов: ${my.slaves_count}`);

    const maxSlaves = my.max_slaves ?? my.max_slaves_count ?? null;
    onLog(`Мой лимит рабов: ${maxSlaves ?? "?"} | у меня ${my.slaves_count}`);

    onLog("\nПолучаю топеров...");
    const topData = await client.getTopMembers();
    checkStop(ctx);
    let topers = extractTopers(topData);
    onLog(`Найдено топеров: ${topers.length}`);
    if (topers.length === 0) return { error: "Пустой список топеров" };
    if (s.topLimit > 0) topers = topers.slice(0, s.topLimit);

    const cands = [], seen = new Set();
    const t0 = Date.now();

    async function processToper(tid, idx) {
        checkStop(ctx);
        if (tid === client.myVkId) return;
        try {
            const slaves = await retry429(() => client.getVictimSlaves(tid), 3);
            checkStop(ctx);
            if (!Array.isArray(slaves) || slaves.length === 0) {
                if (idx % LOG_EVERY_N === 0) onLog(`[${idx}/${topers.length}] ${tid} | рабов 0`);
                return;
            }
            let m = 0;
            for (const sl of slaves) {
                if (m >= s.buyPerToper) break;
                const sid = String(sl.vkid ?? sl.id ?? "");
                if (!sid || seen.has(sid)) continue;
                if (sl.my_slave === 1) continue;
                const price = sl.cost || 0, profit = sl.salary || 0;
                if (price < s.minPrice || price > s.maxPrice) continue;
                if (profit < s.minProfit || profit > s.maxProfit) continue;
                seen.add(sid);
                cands.push({ vkid: sid, name: `${sl.first_name || ""} ${sl.last_name || ""}`.trim() || sid, price, profit });
                m++;
            }
            if (idx % LOG_EVERY_N === 0) onLog(`[${idx}/${topers.length}] ${tid} | рабов ${slaves.length} | подходит ${m} | всего ${cands.length}`);
        } catch (e) {
            if (e.message === "__STOPPED__") throw e;
            if (idx % LOG_EVERY_N === 0) onLog(`[${idx}/${topers.length}] ${tid} ошибка: ${e.message}`);
        }
    }

    for (let i = 0; i < topers.length; i += CONC) {
        checkStop(ctx);
        const batch = topers.slice(i, i + CONC);
        await Promise.all(batch.map((t, j) => processToper(t.vkid, i + j + 1)));
        if (s.delayScanMs > 0) await sleep(s.delayScanMs, ctx);
    }

    const scanTime = ((Date.now() - t0) / 1000).toFixed(1);
    onLog(`\nСкан завершён за ${scanTime}с. Кандидатов: ${cands.length}`);

    if (s.sortMode === "price_asc") cands.sort((a, b) => a.price - b.price);
    else if (s.sortMode === "price_desc") cands.sort((a, b) => b.price - a.price);
    else if (s.sortMode === "profit_desc") cands.sort((a, b) => b.profit - a.profit);

    onLog(`Суммарная цена кандидатов: ${cands.reduce((x, c) => x + c.price, 0)}`);

    let bought = 0, failed = 0, stopR = null;
    let consecutiveLimitFails = 0;

    for (let i = 0; i < cands.length; i++) {
        checkStop(ctx);
        if (s.buyLimitTotal > 0 && bought >= s.buyLimitTotal) { onLog(`Лимит покупок: ${s.buyLimitTotal}`); break; }
        const c = cands[i];
        let done = false;

        while (!done) {
            checkStop(ctx);
            try {
                const r = await client.buySlave(c.vkid);
                checkStop(ctx);

                if (r && (r.error || r.ok === false || (r.message && /превыш|лимит|работ/i.test(r.message)))) {
                    const fakeErr = { message: String(r.error || r.message || "") };
                    if (isSlaveLimitErr(fakeErr)) {
                        consecutiveLimitFails++;
                        failed++;
                        onLog(`${c.name} — лимит рабов (подряд: ${consecutiveLimitFails})`);
                        if (consecutiveLimitFails >= LIMIT_STREAK_STOP) {
                            onLog(`\n🛑 ${LIMIT_STREAK_STOP} рабов подряд с лимитом. Вероятно, у тебя лимит. Стоп.`);
                            stopR = "slave_limit_all";
                            done = true;
                            break;
                        }
                        done = true;
                        break;
                    }
                    if (isNoMoneyErr(fakeErr)) { stopR = "no_money"; done = true; break; }
                    failed++;
                    onLog(`${c.name} API: ${fakeErr.message}`);
                    done = true;
                    break;
                }

                bought++;
                consecutiveLimitFails = 0;
                onLog(`${c.name} за ${c.price} (доход ${c.profit}) | всего ${bought}`);
                done = true;
            } catch (e) {
                if (e.message === "__STOPPED__") throw e;
                if (isSlaveLimitErr(e)) {
                    consecutiveLimitFails++;
                    failed++;
                    onLog(`${c.name} — лимит рабов (подряд: ${consecutiveLimitFails})`);
                    if (consecutiveLimitFails >= LIMIT_STREAK_STOP) {
                        onLog(`\n🛑 ${LIMIT_STREAK_STOP} рабов подряд с лимитом. Вероятно, у тебя лимит. Стоп.`);
                        stopR = "slave_limit_all";
                        done = true;
                        break;
                    }
                    done = true;
                    break;
                }
                if (isNoMoneyErr(e)) { stopR = "no_money"; done = true; break; }
                if (isRateLimitErr(e)) { onLog(`${c.name} — 429, пауза 1с`); await sleep(1000, ctx); continue; }
                failed++;
                onLog(`${c.name}: ${e.message}`);
                done = true;
            }
        }

        if (stopR === "no_money") { onLog("Закончились деньги"); break; }
        if (stopR === "slave_limit_all") break;
        if (s.delayBuyMs > 0) await sleep(s.delayBuyMs, ctx);
    }

    onLog(`\nИтог: куплено ${bought} | ошибок ${failed} | не обработано ${Math.max(0, cands.length - bought - failed)}`);
    return { bought, failed, candidates: cands.length, stopReason: stopR };
}

const bot = new Telegraf(BOT_TOKEN, {
    handlerTimeout: 9_000_000,
});

bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (!hasAccess(ctx.from.id, ADMIN_ID)) { await ctx.reply("⛔ Нет доступа. Обратитесь к администратору."); return; }
    return next();
});

const activeJobs = new Map();

function makeJobCtx(tg, aid) {
    const key = `${String(tg).trim()}:${String(aid).trim()}`;
    const state = { stop: false, stopAt: null };
    activeJobs.set(key, state);
    return { shouldStop: () => state.stop, remove: () => activeJobs.delete(key), key };
}

function accountMenu(aid) {
    return Markup.inlineKeyboard([
        [Markup.button.callback("🦹 Кража", `theft:${aid}`)],
        [Markup.button.callback("🎯 Закуп у жертвы", `buyv:${aid}`)],
        [Markup.button.callback("🏆 Закуп по топу", `buyt:${aid}`)],
        [Markup.button.callback("⚙️ Настройки", `settings:${aid}`)],
        [Markup.button.callback("✏️ Переименовать", `rename:${aid}`), Markup.button.callback("🗑 Удалить", `delacc:${aid}`)],
        [Markup.button.callback("🛑 Стоп задачи", `stop:${aid}`)],
        [Markup.button.callback("◀️ Назад к списку", "list_accounts")],
    ]);
}

function settingsMenu(aid) {
    return Markup.inlineKeyboard([
        [Markup.button.callback("⏱ Задержки", `st_delay:${aid}`)],
        [Markup.button.callback("🎚 Фильтры закупа у жертвы", `st_filt_v:${aid}`)],
        [Markup.button.callback("🎚 Фильтры закупа по топу", `st_filt_t:${aid}`)],
        [Markup.button.callback("🎯 Жертва (VK ID)", `st_victim:${aid}`)],
        [Markup.button.callback("📊 Пресеты", `st_presets:${aid}`)],
        [Markup.button.callback("◀️ Назад к аккаунту", `acc:${aid}`)],
    ]);
}

function adminMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("👥 Выдать доступ", "adm_grant"), Markup.button.callback("🚫 Забрать", "adm_revoke")],
        [Markup.button.callback("📋 Список доступов", "adm_list_access")],
        [Markup.button.callback("📊 Все аккаунты", "adm_all_accounts")],
        [Markup.button.callback("❓ Команды админа", "adm_help")],
    ]);
}

bot.start((ctx) => {
    const isAdmin = String(ctx.from.id) === ADMIN_ID;
    const rows = [
        [Markup.button.callback("➕ Добавить аккаунт", "add_account")],
        [Markup.button.callback("📋 Мои аккаунты", "list_accounts")],
        [Markup.button.callback("❓ Помощь", "help")],
    ];
    if (isAdmin) rows.push([Markup.button.callback("🛡 Админка", "admin")]);
    ctx.reply(`👋 Добро пожаловать в ByHaos Bot!\n\nВаш ID: ${ctx.from.id}`, Markup.inlineKeyboard(rows));
});

bot.action("main", (ctx) => {
    ctx.answerCbQuery();
    const isAdmin = String(ctx.from.id) === ADMIN_ID;
    const rows = [
        [Markup.button.callback("➕ Добавить аккаунт", "add_account")],
        [Markup.button.callback("📋 Мои аккаунты", "list_accounts")],
        [Markup.button.callback("❓ Помощь", "help")],
    ];
    if (isAdmin) rows.push([Markup.button.callback("🛡 Админка", "admin")]);
    ctx.editMessageText("🏠 Главное меню", Markup.inlineKeyboard(rows));
});

bot.action("add_account", (ctx) => {
    ctx.answerCbQuery();
    setSession(ctx.from.id, { step: "add_params" });
    ctx.editMessageText("📥 Пришлите строку запуска VK:", Markup.inlineKeyboard([[Markup.button.callback("◀️ Отмена", "main")]]));
});

bot.action("list_accounts", (ctx) => {
    ctx.answerCbQuery();
    const accs = getAccounts(ctx.from.id);
    const ids = Object.keys(accs);
    if (ids.length === 0) return ctx.editMessageText("📭 Нет аккаунтов", Markup.inlineKeyboard([
        [Markup.button.callback("➕ Добавить", "add_account")],
        [Markup.button.callback("◀️ Назад", "main")],
    ]));
    const rows = ids.map((id) => {
        const a = accs[id];
        const st = activeJobs.has(`${String(ctx.from.id).trim()}:${String(id).trim()}`) ? " 🟢" : "";
        return [Markup.button.callback(`${a.name}${st}`, `acc:${id}`)];
    });
    rows.push([Markup.button.callback("◀️ Назад", "main")]);
    ctx.editMessageText("📋 Ваши аккаунты:", Markup.inlineKeyboard(rows));
});

bot.action(/^acc:(.+)$/, (ctx) => {
    const aid = ctx.match[1];
    const acc = getAccount(ctx.from.id, aid);
    if (!acc) return ctx.answerCbQuery("Не найден");
    ctx.answerCbQuery();
    const run = activeJobs.has(`${String(ctx.from.id).trim()}:${String(aid).trim()}`);
    const isProxyUser = String(ctx.from.id) === PROXY_USER_ID;
    const proxyMark = isProxyUser ? " 🔒" : "";
    const text = `👤 *${escMd(acc.name)}*${proxyMark}\n🆔 VK: \`${escMd(acc.vkUserId)}\`\n📅 ${escMd(new Date(acc.createdAt).toLocaleString("ru"))}\n🎮 ${run ? "🟢 работает" : "⚪ свободен"}${isProxyUser ? "\n🔒 Все запросы через прокси" : ""}`;
    ctx.editMessageText(text, { parse_mode: "Markdown", ...accountMenu(aid) });
});

bot.action(/^settings:(.+)$/, (ctx) => { ctx.answerCbQuery(); ctx.editMessageText("⚙️ Настройки", settingsMenu(ctx.match[1])); });

bot.action(/^st_delay:(.+)$/, (ctx) => {
    const aid = ctx.match[1];
    const s = getAccount(ctx.from.id, aid).settings;
    const text =
        `⏱ *Задержки*\n\n` +
        `*🦹 Кража:*\n` +
        `  Пауза между кражами: ${s.theft.delayMs} мс\n` +
        `  Ожидание рекламы: ${s.theft.adWaitMs} мс\n\n` +
        `*🎯 Закуп у жертвы:*\n` +
        `  Пауза между покупками: ${s.buyVictim.delayMs} мс\n` +
        `  Лимит покупок: ${s.buyVictim.buyLimit || "∞"}\n\n` +
        `*🏆 Закуп по топу:*\n` +
        `  Пауза между сканами топеров: ${s.buyTop.delayScanMs} мс\n` +
        `  Пауза между покупками: ${s.buyTop.delayBuyMs} мс\n` +
        `  Параллельных запросов: ${s.buyTop.concurrency}`;
    const kb = Markup.inlineKeyboard([
        [Markup.button.callback("🦹 Кража: пауза", `set:${aid}:theft.delayMs`)],
        [Markup.button.callback("🦹 Кража: ожидание рекламы", `set:${aid}:theft.adWaitMs`)],
        [Markup.button.callback("🎯 Закуп у жертвы: пауза", `set:${aid}:buyVictim.delayMs`)],
        [Markup.button.callback("🎯 Закуп у жертвы: лимит", `set:${aid}:buyVictim.buyLimit`)],
        [Markup.button.callback("🏆 Закуп по топу: пауза скана", `set:${aid}:buyTop.delayScanMs`)],
        [Markup.button.callback("🏆 Закуп по топу: пауза покупки", `set:${aid}:buyTop.delayBuyMs`)],
        [Markup.button.callback("🏆 Закуп по топу: параллельных", `set:${aid}:buyTop.concurrency`)],
        [Markup.button.callback("◀️ Назад к настройкам", `settings:${aid}`)],
    ]);
    ctx.answerCbQuery();
    ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
});

bot.action(/^st_filt_v:(.+)$/, (ctx) => {
    const aid = ctx.match[1];
    const s = getAccount(ctx.from.id, aid).settings.buyVictim;
    const text =
        `🎚 *Фильтры закупа у жертвы*\n\n` +
        `Цена: ${s.minPrice} – ${s.maxPrice}\n` +
        `Доход: ${s.minProfit} – ${s.maxProfit}`;
    const kb = Markup.inlineKeyboard([
        [Markup.button.callback("Мин. цена", `set:${aid}:buyVictim.minPrice`)],
        [Markup.button.callback("Макс. цена", `set:${aid}:buyVictim.maxPrice`)],
        [Markup.button.callback("Мин. доход", `set:${aid}:buyVictim.minProfit`)],
        [Markup.button.callback("Макс. доход", `set:${aid}:buyVictim.maxProfit`)],
        [Markup.button.callback("◀️ Назад к настройкам", `settings:${aid}`)],
    ]);
    ctx.answerCbQuery();
    ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
});

bot.action(/^st_filt_t:(.+)$/, (ctx) => {
    const aid = ctx.match[1];
    const s = getAccount(ctx.from.id, aid).settings.buyTop;
    const text =
        `🎚 *Фильтры закупа по топу*\n\n` +
        `Цена: ${s.minPrice} – ${s.maxPrice}\n` +
        `Доход: ${s.minProfit} – ${s.maxProfit}\n` +
        `Лимит топеров: ${s.topLimit || "∞"}\n` +
        `Лимит покупок: ${s.buyLimitTotal || "∞"}\n` +
        `Макс. рабов с одного топера: ${s.buyPerToper}\n` +
        `Сортировка: ${escMd(s.sortMode)}`;
    const kb = Markup.inlineKeyboard([
        [Markup.button.callback("Мин. цена", `set:${aid}:buyTop.minPrice`)],
        [Markup.button.callback("Макс. цена", `set:${aid}:buyTop.maxPrice`)],
        [Markup.button.callback("Мин. доход", `set:${aid}:buyTop.minProfit`)],
        [Markup.button.callback("Макс. доход", `set:${aid}:buyTop.maxProfit`)],
        [Markup.button.callback("Лимит топеров", `set:${aid}:buyTop.topLimit`)],
        [Markup.button.callback("Лимит покупок", `set:${aid}:buyTop.buyLimitTotal`)],
        [Markup.button.callback("Макс. рабов с топера", `set:${aid}:buyTop.buyPerToper`)],
        [Markup.button.callback("Сортировка", `set:${aid}:buyTop.sortMode`)],
        [Markup.button.callback("◀️ Назад к настройкам", `settings:${aid}`)],
    ]);
    ctx.answerCbQuery();
    ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
});

bot.action(/^st_victim:(.+)$/, (ctx) => {
    const aid = ctx.match[1];
    ctx.answerCbQuery();
    setSession(ctx.from.id, { step: "set_victim", accId: aid });
    ctx.editMessageText("🎯 Пришлите VK ID жертвы (число):", Markup.inlineKeyboard([[Markup.button.callback("◀️ Отмена", `settings:${aid}`)]]));
});

bot.action(/^set:([^:]+):(.+)$/, (ctx) => {
    const aid = ctx.match[1], key = ctx.match[2];
    const acc = getAccount(ctx.from.id, aid);
    if (!acc) return ctx.answerCbQuery("Не найден");
    const [group, field] = key.split(".");
    const cur = acc.settings[group][field];

    let backTo = "settings";
    if (group === "buyTop") backTo = "st_filt_t";
    else if (group === "buyVictim") backTo = "st_filt_v";
    else if (group === "theft") backTo = "st_delay";

    setSession(ctx.from.id, { step: "set_value", accId: aid, group, field, backTo });
    let hint = "Пришлите значение";
    if (field === "sortMode") hint = "price\\_asc | price\\_desc | profit\\_desc";
    else if (typeof cur === "number") hint = `Число (текущее: ${cur})`;
    ctx.answerCbQuery();
    ctx.editMessageText(
        `⚙️ *${escMd(group)}.${escMd(field)}*\n\n${hint}`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Отмена", `${backTo}:${aid}`)]]) }
    );
});

bot.action(/^st_presets:(.+)$/, (ctx) => {
    const aid = ctx.match[1];
    ctx.answerCbQuery();
    ctx.editMessageText("📊 Пресеты", Markup.inlineKeyboard([
        [Markup.button.callback("Safe", `preset:${aid}:safe`)],
        [Markup.button.callback("Fast", `preset:${aid}:fast`)],
        [Markup.button.callback("Default", `preset:${aid}:default`)],
        [Markup.button.callback("◀️ Назад к настройкам", `settings:${aid}`)],
    ]));
});

bot.action(/^preset:(.+):(.+)$/, (ctx) => {
    const aid = ctx.match[1], type = ctx.match[2];
    const acc = getAccount(ctx.from.id, aid);
    if (type === "safe") {
        acc.settings.theft.delayMs = 500; acc.settings.theft.adWaitMs = 9000;
        acc.settings.buyVictim.delayMs = 1500;
        acc.settings.buyTop.delayBuyMs = 1000; acc.settings.buyTop.concurrency = 3;
    } else if (type === "fast") {
        acc.settings.theft.delayMs = 50; acc.settings.theft.adWaitMs = 5500;
        acc.settings.buyVictim.delayMs = 300;
        acc.settings.buyTop.delayBuyMs = 100; acc.settings.buyTop.concurrency = 8;
    } else acc.settings = defaultSettings();
    saveAccount(ctx.from.id, aid, acc);
    ctx.answerCbQuery("Применено");
    ctx.editMessageText(`✅ Пресет *${escMd(type)}* применён`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад к настройкам", `settings:${aid}`)]]) });
});

async function startJob(ctx, aid, type) {
    const tg = String(ctx.from.id).trim();
    const aidStr = String(aid).trim();
    const key = `${tg}:${aidStr}`;
    if (activeJobs.has(key)) return ctx.answerCbQuery("Уже запущено");
    const acc = getAccount(tg, aidStr);
    if (!acc) return ctx.answerCbQuery("Не найден");

    const useProxy = (tg === PROXY_USER_ID);

    if (useProxy) console.log(`[PROXY] ${tg} → ${PROXY_URL}`);
    else console.log(`[DIRECT] ${tg} → без прокси`);

    const ctxJob = makeJobCtx(tg, aidStr);
    const proxyNote = useProxy ? " 🔒 через прокси" : "";
    const sent = await ctx.reply(`⏳ Запуск ${type} на ${acc.name}...${proxyNote}`);
    let lastEdit = 0;
    const buf = [];
    const onLog = (line) => {
        buf.push(line);
        const now = Date.now();
        if (now - lastEdit > 3500) {
            lastEdit = now;
            const t = buf.slice(-30).join("\n");
            bot.telegram.editMessageText(ctx.chat.id, sent.message_id, undefined,
                `📋 ${acc.name} [${type}]\n\n${t}`).catch(() => {});
        }
    };
    try {
        let res;
        if (type === "theft") res = await runTheft(acc, onLog, ctxJob, useProxy);
        else if (type === "buy-victim") res = await runBuyVictim(acc, onLog, ctxJob, useProxy);
        else if (type === "buy-top") res = await runBuyTop(acc, onLog, ctxJob, useProxy);
        const final = buf.slice(-30).join("\n") + "\n\n✅ Завершено";
        await bot.telegram.editMessageText(ctx.chat.id, sent.message_id, undefined,
            `📋 ${acc.name} [${type}]\n\n${final}`).catch(() => {});
        if (type === "theft") acc.stats.totalTheft += (res?.totalStolen || 0);
        else acc.stats.totalBought += (res?.bought || res?.totalBought || 0);
        acc.stats.lastJobAt = Date.now();
        saveAccount(tg, aidStr, acc);
    } catch (e) {
        if (e.message === "__STOPPED__") {
            onLog("🛑 Остановлено пользователем");
            await bot.telegram.editMessageText(ctx.chat.id, sent.message_id, undefined,
                `📋 ${acc.name} [${type}]\n\n${buf.slice(-30).join("\n")}`).catch(() => {});
        } else {
            await bot.telegram.editMessageText(ctx.chat.id, sent.message_id, undefined, `❌ ${e.message}`).catch(() => {});
        }
    } finally { ctxJob.remove(); }
}

bot.action(/^theft:(.+)$/, (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    startJob(ctx, ctx.match[1], "theft").catch((e) => console.error("theft err:", e));
});

bot.action(/^buyv:(.+)$/, (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    startJob(ctx, ctx.match[1], "buy-victim").catch((e) => console.error("buyv err:", e));
});

bot.action(/^buyt:(.+)$/, (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    startJob(ctx, ctx.match[1], "buy-top").catch((e) => console.error("buyt err:", e));
});

bot.action(/^stop:(.+)$/, (ctx) => {
    ctx.answerCbQuery("🛑 Останавливаю...").catch(() => {});
    try {
        const aid = String(ctx.match[1]).trim();
        const tg = String(ctx.from.id).trim();
        const key = `${tg}:${aid}`;
        const job = activeJobs.get(key);
        console.log("[STOP]", key, "found:", !!job, "active:", [...activeJobs.keys()]);
        if (job) {
            job.stop = true;
            job.stopAt = Date.now();
        }
    } catch (e) {
        console.error("stop handler error:", e);
    }
});

bot.action(/^rename:(.+)$/, (ctx) => {
    const aid = ctx.match[1];
    setSession(ctx.from.id, { step: "rename", accId: aid });
    ctx.answerCbQuery();
    ctx.editMessageText("✏️ Новое имя:", Markup.inlineKeyboard([[Markup.button.callback("◀️ Отмена", `acc:${aid}`)]]));
});

bot.action(/^delacc:(.+)$/, (ctx) => {
    const aid = ctx.match[1];
    ctx.answerCbQuery();
    ctx.editMessageText("🗑 Удалить?", Markup.inlineKeyboard([
        [Markup.button.callback("✅ Да", `delacc_yes:${aid}`)],
        [Markup.button.callback("❌ Нет", `acc:${aid}`)],
    ]));
});

bot.action(/^delacc_yes:(.+)$/, (ctx) => {
    deleteAccount(ctx.from.id, ctx.match[1]);
    ctx.answerCbQuery("Удалён");
    ctx.editMessageText("🗑 Удалён", Markup.inlineKeyboard([[Markup.button.callback("◀️ К аккаунтам", "list_accounts")]]));
});

bot.action("help", (ctx) => {
    ctx.answerCbQuery();
    const t = `📚 *Помощь ByHaos Bot*\n\n➕ Добавить аккаунт — по строке VK\n📋 Мои аккаунты\n\n*Функции:*\n🦹 Кража — качает монеты у жертвы\n🎯 Закуп у жертвы — скупает рабов по ID\n🏆 Закуп по топу — скан топов и закуп\n\n⚙️ Настройки — задержки, фильтры, жертва, пресеты\n🛑 Стоп задачи — мгновенная остановка\n✏️ Переименовать / 🗑 Удалить`;
    ctx.editMessageText(t, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "main")]]) });
});

function adminOnly(ctx, next) {
    if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("⛔ Только админ");
    return next();
}

bot.action("admin", adminOnly, (ctx) => { ctx.answerCbQuery(); ctx.editMessageText("🛡 *Админка*", { parse_mode: "Markdown", ...adminMenu() }); });

bot.action("adm_grant", adminOnly, (ctx) => {
    ctx.answerCbQuery();
    setSession(ctx.from.id, { step: "adm_grant" });
    ctx.editMessageText("👥 Пришлите Telegram ID:", Markup.inlineKeyboard([[Markup.button.callback("◀️ Отмена", "admin")]]));
});

bot.action("adm_revoke", adminOnly, (ctx) => {
    ctx.answerCbQuery();
    setSession(ctx.from.id, { step: "adm_revoke" });
    ctx.editMessageText("🚫 Пришлите Telegram ID:", Markup.inlineKeyboard([[Markup.button.callback("◀️ Отмена", "admin")]]));
});

bot.action("adm_list_access", adminOnly, (ctx) => {
    ctx.answerCbQuery();
    const l = getAccessList();
    const t = l.length ? l.map((x, i) => `${i + 1}. \`${escMd(x)}\``).join("\n") : "Пусто";
    ctx.editMessageText(`📋 *Доступы:*\n\n${t}\n\nАдмин: \`${escMd(ADMIN_ID)}\`\nПрокси-юзер: \`${escMd(PROXY_USER_ID)}\``, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "admin")]]) });
});

bot.action("adm_all_accounts", adminOnly, async (ctx) => {
    ctx.answerCbQuery();
    const rows = listAllAccounts();
    if (rows.length === 0) return ctx.editMessageText("Нет аккаунтов", Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "admin")]]));
    let out = "";
    for (const r of rows.slice(0, 30)) out += `👤 *${escMd(r.name)}*\nВладелец: \`${escMd(r.ownerId)}\`\nVK: \`${escMd(r.vkUserId)}\`\n\n`;
    if (rows.length > 30) out += `… ещё ${rows.length - 30}\n`;
    ctx.editMessageText(out, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "admin")]]) });
});

bot.action("adm_help", adminOnly, (ctx) => {
    ctx.answerCbQuery();
    ctx.editMessageText("*🛡 Команды админа*\n\n/allaccounts — все аккаунты\n/grant ID — выдать доступ\n/revoke ID — забрать доступ\n/accesslist — список доступов\n/broadcast текст — рассылка", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "admin")]]) });
});

bot.command("allaccounts", adminOnly, (ctx) => {
    const rows = listAllAccounts();
    if (!rows.length) return ctx.reply("Пусто");
    const chunks = [];
    let cur = "*📊 Все аккаунты:*\n\n";
    for (const r of rows) {
        const line = `👤 *${escMd(r.name)}*\nВладелец: \`${escMd(r.ownerId)}\`\nVK: \`${escMd(r.vkUserId)}\`\nСтрока: \`${escMd(r.launchParams)}\`\n\n`;
        if (cur.length + line.length > 3500) { chunks.push(cur); cur = ""; }
        cur += line;
    }
    if (cur) chunks.push(cur);
    for (const c of chunks) ctx.reply(c, { parse_mode: "Markdown" });
});

bot.command("grant", adminOnly, (ctx) => {
    const id = ctx.message.text.split(" ")[1];
    if (!id) return ctx.reply("Использование: /grant ID");
    grantAccess(id);
    ctx.reply(`✅ Доступ выдан \`${escMd(id)}\``, { parse_mode: "Markdown" });
});

bot.command("revoke", adminOnly, (ctx) => {
    const id = ctx.message.text.split(" ")[1];
    if (!id) return ctx.reply("Использование: /revoke ID");
    revokeAccess(id);
    ctx.reply(`🚫 Доступ забран \`${escMd(id)}\``, { parse_mode: "Markdown" });
});

bot.command("accesslist", adminOnly, (ctx) => {
    const l = getAccessList();
    ctx.reply(l.length ? "`" + l.map(escMd).join("\n") + "`" : "Пусто", { parse_mode: "Markdown" });
});

bot.command("broadcast", adminOnly, async (ctx) => {
    const text = ctx.message.text.replace(/^\/broadcast\s*/, "");
    if (!text) return ctx.reply("Использование: /broadcast текст");
    const l = [...new Set([...getAccessList(), ADMIN_ID])];
    let ok = 0;
    for (const id of l) { try { await bot.telegram.sendMessage(id, `📢 ${text}`); ok++; } catch {} }
    ctx.reply(`✅ ${ok}/${l.length}`);
});

bot.command("checkip", async (ctx) => {
    const useProxy = String(ctx.from.id) === PROXY_USER_ID;
    ctx.reply(`🔍 Проверяю IP ${useProxy ? "через прокси" : "напрямую"}...`);
    const agent = useProxy
        ? new SocksProxyAgent(PROXY_URL, { keepAlive: false })
        : undefined;
    const req = https.request({
        hostname: "api.ipify.org",
        path: "/?format=json",
        method: "GET",
        agent,
    }, (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
            try {
                const ip = JSON.parse(data).ip;
                ctx.reply(`✅ Твой IP: \`${escMd(ip)}\`\nЧерез прокси: ${useProxy}`, { parse_mode: "Markdown" });
            } catch {
                ctx.reply(`Ответ: ${data}`);
            }
        });
    });
    req.on("error", (e) => ctx.reply(`❌ Ошибка: ${e.message}`));
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    req.end();
});

bot.on("text", async (ctx, next) => {
    const s = getSession(ctx.from.id);
    if (!s) return next();
    const text = ctx.message.text.trim();

    if (s.step === "add_params") {
        if (!text.includes("vk_user_id=") || !text.includes("sign=")) return ctx.reply("❌ Неверный формат (нужен vk_user_id и sign)");
        const m = text.match(/vk_user_id=(\d+)/);
        if (!m) return ctx.reply("❌ Не найден vk_user_id");
        setSession(ctx.from.id, { step: "add_name", launchParams: text, vkUserId: m[1] });
        return ctx.reply("✏️ Имя аккаунта:");
    }

    if (s.step === "add_name") {
        const acc = createAccount(text, s.launchParams, s.vkUserId);
        saveAccount(ctx.from.id, acc.id, acc);
        clearSession(ctx.from.id);
        return ctx.reply(`✅ *${escMd(acc.name)}* добавлен\nVK: \`${escMd(acc.vkUserId)}\``, { parse_mode: "Markdown", ...Markup.inlineKeyboard([
            [Markup.button.callback("📋 К аккаунтам", "list_accounts")],
            [Markup.button.callback("➕ Ещё", "add_account")],
        ]) });
    }

    if (s.step === "rename") {
        const acc = getAccount(ctx.from.id, s.accId);
        if (!acc) { clearSession(ctx.from.id); return ctx.reply("Не найден"); }
        acc.name = text;
        saveAccount(ctx.from.id, s.accId, acc);
        clearSession(ctx.from.id);
        return ctx.reply(`✅ Переименовано в *${escMd(text)}*`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ К аккаунту", `acc:${s.accId}`)]]) });
    }

    if (s.step === "set_victim") {
        if (!/^\d+$/.test(text)) return ctx.reply("❌ Число");
        const acc = getAccount(ctx.from.id, s.accId);
        acc.settings.theft.victimId = text;
        acc.settings.buyVictim.victimId = text;
        saveAccount(ctx.from.id, s.accId, acc);
        clearSession(ctx.from.id);
        return ctx.reply(`🎯 Жертва: \`${escMd(text)}\``, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад к настройкам", `settings:${s.accId}`)]]) });
    }

    if (s.step === "set_value") {
        const { accId, group, field, backTo } = s;
        const acc = getAccount(ctx.from.id, accId);
        if (!acc) { clearSession(ctx.from.id); return ctx.reply("Не найден"); }
        let v;
        if (field === "sortMode") {
            if (!["price_asc", "price_desc", "profit_desc"].includes(text)) return ctx.reply("❌ price_asc | price_desc | profit_desc");
            v = text;
        } else {
            v = Number(text);
            if (isNaN(v)) return ctx.reply("❌ Число");
        }
        acc.settings[group][field] = v;
        saveAccount(ctx.from.id, accId, acc);
        clearSession(ctx.from.id);
        const target = backTo || "settings";
        return ctx.reply(`✅ \`${escMd(group)}.${escMd(field)}\` = \`${escMd(v)}\``, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", `${target}:${accId}`)]]),
        });
    }

    if (s.step === "adm_grant") {
        if (!/^\d+$/.test(text)) return ctx.reply("❌ Telegram ID — число");
        grantAccess(text);
        clearSession(ctx.from.id);
        return ctx.reply(`✅ Доступ выдан \`${escMd(text)}\``, { parse_mode: "Markdown" });
    }

    if (s.step === "adm_revoke") {
        if (!/^\d+$/.test(text)) return ctx.reply("❌ Число");
        revokeAccess(text);
        clearSession(ctx.from.id);
        return ctx.reply(`🚫 Доступ забран \`${escMd(text)}\``, { parse_mode: "Markdown" });
    }

    return next();
});

bot.catch((err, ctx) => {
    console.error("[BOT ERROR]", err.message);
    try {
        if (ctx && ctx.chat) {
            bot.telegram.sendMessage(ctx.chat.id, `⚠️ Ошибка: ${err.message}`).catch(() => {});
        }
    } catch (_) {}
});

if (!hasAccess(PROXY_USER_ID, ADMIN_ID)) {
    grantAccess(PROXY_USER_ID);
    console.log("✅ В доступ добавлен PROXY_USER_ID:", PROXY_USER_ID);
}

bot.launch({ dropPendingUpdates: true });
console.log("🤖 ByHaos Bot запущен");
console.log("👑 Админ:", ADMIN_ID);
console.log("🔒 Прокси-юзер:", PROXY_USER_ID, "→", PROXY_URL);

process.on("unhandledRejection", (e) => console.error("[UNHANDLED]", e));
process.on("uncaughtException", (e) => console.error("[UNCAUGHT]", e));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));