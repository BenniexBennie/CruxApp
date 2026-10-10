// End-to-end tests for Training Plan. Run: npm test (from this folder, after npm install).
// The app is served from a fake https://benniexbennie.github.io/CruxApp/ and GitHub's API is
// mocked in memory, so nothing touches the network.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const SITE = "https://benniexbennie.github.io/CruxApp/";
let browser;

before(async () => {
  browser = await chromium.launch(fs.existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
});
after(() => browser.close());

// Fake GitHub gist API: one user, token "ghp_good", gists kept in memory.
function fakeGitHub() {
  const gists = {}, history = {}; let n = 0, rev = 0; const net = { online: true };
  const record = id => (history[id] ||= []).unshift({ version: "v" + (++rev), committed_at: new Date(Date.now() + rev * 1000).toISOString(), content: gists[id].files["training-plan.json"].content });
  const handler = async route => {
    if (!net.online) return route.abort("internetdisconnected");
    const req = route.request(), u = new URL(req.url()), auth = req.headers()["authorization"] || "";
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (auth !== "Bearer ghp_good") return json(401, { message: "Bad credentials" });
    if (u.pathname === "/user") return json(200, { login: "tester" });
    if (u.pathname === "/gists" && req.method() === "GET") return json(200, Object.values(gists));
    if (u.pathname === "/gists" && req.method() === "POST") {
      const body = req.postDataJSON(), id = "g" + (++n);
      gists[id] = { id, description: body.description, files: Object.fromEntries(Object.entries(body.files).map(([k, v]) => [k, { content: v.content, truncated: false }])) };
      record(id);
      return json(201, gists[id]);
    }
    const hc = u.pathname.match(/^\/gists\/(\w+)\/commits$/);
    if (hc) return json(200, (history[hc[1]] || []).map(({ version, committed_at }) => ({ version, committed_at })));
    const hv = u.pathname.match(/^\/gists\/(\w+)\/(v\d+)$/);
    if (hv) { const h = (history[hv[1]] || []).find(x => x.version === hv[2]); return h ? json(200, { id: hv[1], files: { "training-plan.json": { content: h.content, truncated: false } } }) : json(404, {}); }
    const m = u.pathname.match(/^\/gists\/(\w+)$/);
    if (m && !gists[m[1]]) return json(404, {});
    if (m && req.method() === "GET") return json(200, gists[m[1]]);
    if (m && req.method() === "PATCH") {
      for (const [k, v] of Object.entries(req.postDataJSON().files)) gists[m[1]].files[k] = { content: v.content, truncated: false };
      record(m[1]);
      return json(200, gists[m[1]]);
    }
    return json(500, {});
  };
  return { gists, history, net, handler };
}

async function openApp({ github, url = SITE } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(SITE + "**", r => {
    const file = new URL(r.request().url()).pathname.replace("/CruxApp/", "") || "index.html";
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) return r.fulfill({ status: 404, body: "" });
    return r.fulfill({ status: 200, contentType: p.endsWith(".js") ? "text/javascript" : "text/html", body: fs.readFileSync(p) });
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: "" }));
  if (github) await ctx.route("https://api.github.com/**", github.handler);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  await page.goto(url);
  return page;
}

// Adds an entry for an exercise on a date (offset in days from today).
const seed = (page, list) => page.evaluate(list => {
  for (const [offset, id, extra] of list) {
    const k = dkey(addDays(new Date(), offset)), ex = findEx(id);
    (db.plan[k] ||= []).push({ id: uid(), ex: id, name: ex.name, cat: ex.cat, fields: ex.fields, target: [], log: [], done: false, note: "", ...extra });
  }
  save(); renderAll();
}, list);
const today = page => page.evaluate(() => dkey(new Date()));
const entry = (page, offset, i = 0) => page.evaluate(([o, i]) => db.plan[dkey(addDays(new Date(), o))][i], [offset, i]);

test("ticking an exercise logs it as planned, and Undo reverts it", async () => {
  const page = await openApp();
  await seed(page, [[0, "s-bench", { target: [{ reps: 8, load: 135 }] }]]);
  const k = await today(page);
  await page.click(`#day-${k} [data-act=toggle]`);
  let e = await entry(page, 0);
  assert.equal(e.done, true);
  assert.deepEqual(e.log, [{ reps: 8, load: 135 }]);
  await page.click("#toast button");
  e = await entry(page, 0);
  assert.equal(e.done, false);
  assert.equal(e.log.length, 0);
  assert.deepEqual(page.errors, []);
});

test("entry dialog opens on Log for today and Plan for future days", async () => {
  const page = await openApp();
  await seed(page, [[0, "s-bench"], [3, "s-squat"]]);
  await page.click(`#day-${await today(page)} [data-act=entry]`);
  assert.equal(await page.getAttribute("#entryPanes [data-pane=log]", "aria-pressed"), "true");
  await page.click("#entryDialog [data-close]");
  const future = await page.evaluate(() => dkey(addDays(new Date(), 3)));
  await page.evaluate(k => { state.week = mondayOf(parseKey(k)); renderWeek(); }, future);
  await page.click(`#day-${future} [data-act=entry]`);
  assert.equal(await page.getAttribute("#entryPanes [data-pane=plan]", "aria-pressed"), "true");
});

test("a heavier set than ever before is a PR", async () => {
  const page = await openApp();
  await seed(page, [[-7, "s-wpullup", { log: [{ reps: 5, load: 25 }], done: true }], [0, "s-wpullup", { target: [{ reps: 5, load: 35 }] }]]);
  await page.evaluate(() => { state.week = mondayOf(new Date()); renderWeek(); });
  await page.click(`#day-${await today(page)} [data-act=toggle]`);
  assert.match(await page.textContent("#toast"), /New PR: Weighted pull-ups \+35 lb/);
  assert.match(await page.textContent(`#day-${await today(page)} .entry strong`), /🏆/);
  await page.click(".tabs [data-tab=data]");
  assert.match(await page.innerText("#view-data"), /Personal records[\s\S]*\+35 lb/);
});

test("check-in saves and sore fingers warn on a hard day", async () => {
  const page = await openApp();
  await seed(page, [[0, "s-maxhang"]]);
  const k = await today(page);
  await page.click(`#day-${k} [data-act=checkin]`);
  await page.click('#ckRows [data-ck=fingers][data-v="2"]');
  await page.click("#checkForm button.primary");
  assert.deepEqual(await page.evaluate(k => db.checkin[k], k), { fingers: 2 });
  assert.match(await page.textContent(`#day-${k} .warnchip`), /Fingers felt sore/);
});

test("three hard finger days in a row warn", async () => {
  const page = await openApp();
  await seed(page, [[-2, "s-maxhang"], [-1, "s-board"], [0, "s-limit"]]);
  assert.match(await page.textContent(`#day-${await today(page)} .warnchip`), /3 hard finger days/);
});

test("hang timer runs through its phases", async () => {
  const page = await openApp();
  await seed(page, [[0, "s-repeaters"]]);
  await page.click(`#day-${await today(page)} [data-act=entry]`);
  await page.click("#timerBtn");
  await page.click("#tmMode [data-tm=hang]");
  await page.fill("#tmOn", "1"); await page.fill("#tmOff", "1"); await page.fill("#tmReps", "1");
  await page.click("#tmStart");
  await page.waitForFunction(() => $("#tmPhase").textContent.startsWith("Hang"), null, { timeout: 8000 });
  await page.waitForFunction(() => $("#tmPhase").textContent === "Done ✓", null, { timeout: 8000 });
  assert.equal(await page.textContent("#tmClock"), "0");
});

test("month view shows training days and jumps back to the week", async () => {
  const page = await openApp();
  await seed(page, [[0, "s-bench"]]);
  await page.click("[data-act=mode][data-mode=month]");
  assert.ok(await page.locator(".mday.today i b").count() >= 1);
  await page.click(".mday.today");
  assert.ok(await page.isVisible(".weekhead"));
});

test("projects: add, try, send", async () => {
  const page = await openApp();
  await page.click(".tabs [data-tab=plan]");
  await page.click("[data-act=newproj] >> nth=0");
  await page.fill("#prName", "Pink roof");
  await page.selectOption("#prGrade", "6");
  await page.click("#projForm button.primary");
  await page.click("[data-act=projtry]");
  await page.click("[data-act=projsent]");
  const p = await page.evaluate(() => db.projects[0]);
  assert.equal(p.grade, 6);
  assert.equal(p.sentOn, await today(page));
  assert.match(await page.textContent("#toast"), /Sent Pink roof \(V6\)/);
});

test("sync: two devices share data through a gist", async () => {
  const github = fakeGitHub();
  const connect = async (page, token) => {
    await page.click("#settingsBtn");
    await page.fill("#syncToken", token);
    await page.click("[data-sync=connect]");
    await page.waitForTimeout(500);
  };
  const notes = page => page.evaluate(() => Object.values(db.plan).flat().map(e => e.note).sort());
  const phone = await openApp({ github });
  await seed(phone, [[-7, "s-limit", { grades: [5, 6], mins: 90, done: true, note: "phone climb" }]]);
  await connect(phone, "ghp_wrong");
  assert.match(await phone.textContent("#syncErr"), /./);
  await phone.fill("#syncToken", "ghp_good"); await phone.click("[data-sync=connect]"); await phone.waitForTimeout(500);
  assert.equal(Object.keys(github.gists).length, 1);

  // A second device that already has its own workouts: connecting combines both, nothing is replaced.
  const laptop = await openApp({ github });
  await seed(laptop, [[-1, "s-bench", { log: [{ reps: 5, load: 135 }], done: true, note: "laptop lift" }]]);
  await connect(laptop, "ghp_good");
  assert.deepEqual(await notes(laptop), ["laptop lift", "phone climb"]);
  await phone.evaluate(() => syncNow()); await phone.waitForTimeout(300);
  assert.deepEqual(await notes(phone), ["laptop lift", "phone climb"]);

  // The bug that lost workouts: the phone logs a session but the app is closed before it uploads,
  // then the laptop saves something newer. Both changes must survive.
  await phone.evaluate(() => {
    const ex = findEx("s-tension");
    db.plan[dkey(addDays(new Date(), -3))] = [{ id: uid(), ex: ex.id, name: ex.name, cat: ex.cat, fields: ex.fields, target: [], log: [], done: true, note: "unsent TB", grades: [6] }];
    save(); clearTimeout(syncState.timer); syncState.timer = null;   // app closed before the upload
  });
  await laptop.evaluate(() => { db.lift[dkey(new Date())] = 55; save(); });
  await laptop.waitForTimeout(2200);
  await phone.evaluate(() => syncNow()); await phone.waitForTimeout(400);
  assert.deepEqual(await notes(phone), ["laptop lift", "phone climb", "unsent TB"]);
  assert.equal(await phone.evaluate(() => db.lift[dkey(new Date())]), 55);
  const onGitHub = JSON.parse(github.gists.g1.files["training-plan.json"].content);
  assert.ok(Object.values(onGitHub.plan).flat().some(e => e.note === "unsent TB"), "the unsent session reached GitHub");
  await laptop.evaluate(() => syncNow()); await laptop.waitForTimeout(300);
  assert.deepEqual(await notes(laptop), ["laptop lift", "phone climb", "unsent TB"]);

  // A delete on one device is a delete everywhere (it isn't brought back by the other copy).
  await laptop.evaluate(() => { for (const k of Object.keys(db.plan)) db.plan[k] = db.plan[k].filter(e => e.note !== "laptop lift"); for (const k of Object.keys(db.plan)) if (!db.plan[k].length) delete db.plan[k]; save(); });
  await laptop.waitForTimeout(2200);
  await phone.evaluate(() => syncNow()); await phone.waitForTimeout(300);
  assert.deepEqual(await notes(phone), ["phone climb", "unsent TB"]);

  // Offline: saved locally, synced when back.
  github.net.online = false;
  await phone.evaluate(() => { db.lift[dkey(new Date())] = 60; save(); });
  await phone.waitForTimeout(2000);
  assert.match(await phone.textContent("#sync"), /Offline/);
  github.net.online = true;
  await phone.evaluate(() => window.dispatchEvent(new Event("online"))); await phone.waitForTimeout(500);
  assert.equal(Object.values(JSON.parse(github.gists.g1.files["training-plan.json"].content).lift)[0], 60);
  assert.equal(await phone.evaluate(() => JSON.stringify(db).includes("ghp_")), false, "token never stored in the data");
  assert.deepEqual([...phone.errors, ...laptop.errors], []);
});

test("bring back lost workouts from GitHub history or a saved copy", async () => {
  const github = fakeGitHub();
  const page = await openApp({ github });
  await seed(page, [[-7, "s-tension", { grades: [5, 6], mins: 80, done: true, note: "lost TB" }], [-6, "s-limit", { grades: [4], done: true, note: "lost limit" }]]);
  await page.click("#settingsBtn");
  await page.fill("#syncToken", "ghp_good"); await page.click("[data-sync=connect]"); await page.waitForTimeout(500);
  // Simulate the loss: last week's climbs vanish and that copy is synced.
  await page.evaluate(() => { for (const k of Object.keys(db.plan)) delete db.plan[k]; db.lift[dkey(new Date())] = 30; save(); });
  await page.waitForTimeout(2200);
  assert.equal(await page.evaluate(() => Object.keys(db.plan).length), 0);

  await page.evaluate(() => closeAllSheets());
  await page.click("#settingsBtn");
  await page.click("[data-recover=loadgh]");
  await page.waitForSelector("[data-recover=gh]");
  await page.click("[data-recover=gh] >> nth=-1");   // the oldest copy
  await page.waitForSelector("#confirmDialog[open]");
  assert.match(await page.textContent("#confirmMsg"), /has 2 items you don't have now/);
  await page.click("#confirmYes");
  assert.deepEqual(await page.evaluate(() => Object.values(db.plan).flat().map(e => e.note).sort()), ["lost TB", "lost limit"]);
  assert.equal(await page.evaluate(() => db.lift[dkey(new Date())]), 30, "newer data is kept");
  assert.deepEqual(await page.evaluate(() => Object.values(db.plan).flat().find(e => e.note === "lost TB").grades), [5, 6]);

  // Copies saved on this device work the same way.
  const snapCount = await page.evaluate(() => { snapshot("test"); for (const k of Object.keys(db.plan)) delete db.plan[k]; save(); return previewRecover(snapshots()[0].data); });
  assert.equal(snapCount, 2);
  assert.deepEqual(page.errors, []);
});

test("a shared session link adds the session", async () => {
  const page = await openApp();
  const link = await page.evaluate(() => {
    const x = db.sessions[0];
    const payload = { n: "Shared test", i: x.items.map(s => [s.ex, nameOf(s), catOf(s), fieldsOf(s), s.target || []]) };
    return location.origin + location.pathname + "#share=" + b64url(JSON.stringify(payload));
  });
  const other = await openApp({ url: link });
  await other.waitForTimeout(500);
  await other.click("#confirmYes");
  assert.ok(await other.evaluate(() => db.sessions.some(x => x.name === "Shared test")));
  assert.equal(await other.evaluate(() => location.hash), "");
});

test("bodyweight from the check-in shows strength as % of bodyweight", async () => {
  const page = await openApp();
  await seed(page, [[-7, "s-maxhang", { log: [{ time: 10, load: 20, edge: 20 }], done: true }], [0, "s-maxhang", { log: [{ time: 10, load: 34, edge: 20 }], done: true }]]);
  const k = await today(page);
  await page.click(`#day-${k} [data-act=checkin]`);
  await page.fill("#ckBw", "170");
  await page.click("#checkForm button.primary");
  assert.equal(await page.evaluate(k => db.bw[k], k), 170);
  assert.match(await page.textContent(`#day-${k} [data-act=checkin]`), /170 lb/);
  // Max hangs: (170 + 34) / 170 = 120% BW; bench is the bar alone: 170 / 170 = 100%.
  assert.equal(await page.evaluate(() => Math.round(relStrength(findEx("s-maxhang"), 34, 170))), 120);
  assert.equal(await page.evaluate(() => Math.round(relStrength(findEx("s-bench"), 170, 170))), 100);
  await page.click(".tabs [data-tab=data]");
  assert.match(await page.innerText("#view-data"), /Max hangs\s+\+34 lb \(120% BW\)/);
  await page.selectOption("#progEx", "s-maxhang");
  await page.click("[data-metric=rel]");
  assert.match(await page.innerText("#view-data"), /% of bodyweight[\s\S]*120% BW/);
  assert.match(await page.innerText("#view-data"), /Bodyweight[\s\S]*Latest 170 lb/);
  assert.deepEqual(page.errors, []);
});

test("grade pyramid counts sends and points at a thin layer", async () => {
  const page = await openApp();
  await seed(page, [[-3, "s-limit", { grades: [6, 6, 5, 5, 5, 4, 4, 4, 4, 4, 4], done: true }], [-60, "s-limit", { grades: [7], done: true }]]);
  await page.click(".tabs [data-tab=data]");
  const card = () => page.locator("#view-data section:has-text('Grade pyramid')").innerText();
  assert.match(await card(), /11 sends/);
  assert.match(await card(), /Build your base at V5: 3 sends vs 2 at V6/);
  await page.click("[data-pyr=all]");
  assert.match(await card(), /12 sends/);
  assert.match(await card(), /V7/);
});

test("habits: quit nicotine (yes/no) and count drinks, with streaks", async () => {
  const page = await openApp();
  await page.click(".tabs [data-tab=plan]");
  await page.click("[data-act=habittpl][data-name=Nicotine]");
  assert.equal(await page.inputValue("#hbName"), "Nicotine");
  await page.click("#habitForm button.primary");
  await page.click("[data-act=habittpl][data-name=Alcohol]");
  await page.fill("#hbLimit", "2");
  await page.click("#habitForm button.primary");
  const [nic, alc] = await page.evaluate(() => db.habits.map(h => h.id));
  assert.equal(await page.evaluate(() => db.habits[1].limit), 2);

  // Six clean days logged before today, then today on the Week tab makes 7 → milestone toast.
  await page.evaluate(id => { for (let i = 1; i <= 6; i++) (db.habitLog[dkey(addDays(new Date(), -i))] ||= {})[id] = 0; save(); renderPlanTab(); }, nic);
  // Logged on the Plan tab; the Week tab stays free of habits.
  assert.equal(await page.locator("#view-week .hgrid").count(), 0);
  const k = await today(page);
  const cell = id => `[data-act=habit][data-h="${id}"][data-date="${k}"]`;
  await page.click(cell(nic));
  assert.equal(await page.textContent(cell(nic)), "✓");
  assert.match(await page.textContent("#toast"), /7 days nicotine-free/);
  await page.click(cell(nic));   // tap again: slipped
  assert.equal(await page.textContent(cell(nic)), "✗");
  assert.equal(await page.evaluate(() => habitStreak(db.habits[0])), 0);
  await page.click(cell(nic));   // and again: cleared
  assert.equal(await page.evaluate(k => db.habitLog[k] && db.habitLog[k][db.habits[0].id], k), undefined);

  // Count: 3 drinks is over the limit of 2.
  await page.click(cell(alc));
  await page.click("#hcDialog [data-step='1']"); await page.click("#hcDialog [data-step='1']"); await page.click("#hcDialog [data-step='1']");
  await page.click("#hcForm button.primary");
  assert.equal(await page.textContent(cell(alc)), "3");
  assert.match(await page.getAttribute(cell(alc), "class"), /miss/);

  // Last week is one tap back.
  await page.click("#view-plan [data-act=hprev]");
  const lastWeek = await page.evaluate(() => dkey(addDays(mondayOf(new Date()), -7)));
  assert.equal(await page.locator(`#view-plan [data-h="${nic}"][data-date="${lastWeek}"]`).count(), 1);

  await page.click(".tabs [data-tab=data]");
  assert.equal(await page.locator("#view-data .hgrid").count(), 0, "habits are not on the Data tab");
  assert.equal(await page.evaluate(() => habitBest(db.habits[0])), 6);
  assert.deepEqual(page.errors, []);
});

test("supersets: link exercises, keep them together, carry them over", async () => {
  const page = await openApp();
  await seed(page, [[0, "s-bench"], [0, "s-squat"], [0, "s-trxrow"], [0, "s-dips"]]);
  const k = await today(page);
  // Open Bench press and superset it with TRX low row (third in the list).
  await page.click(`#day-${k} [data-act=entry] >> text=Bench press`);
  await page.click("#ssChips [data-ss] >> text=TRX low row");
  await page.click("#entryForm button.primary[type=submit]");
  const names = () => page.evaluate(k => db.plan[k].map(e => nameOf(e) + (e.ss ? "*" : "")), k);
  const list = await names();
  assert.equal(list[0], "Bench press*");
  assert.equal(list[1], "TRX low row*");
  assert.deepEqual(await page.$$eval(`#day-${k} .sstag`, els => els.map(e => e.textContent)), ["A1", "A2"]);

  // Chain a third (circuit) from Dips: picking Bench pulls in its whole group.
  await page.click(`#day-${k} [data-act=entry] >> text=Dips`);
  await page.click("#ssChips [data-ss] >> text=Bench press");
  await page.click("#entryForm button.primary[type=submit]");
  assert.deepEqual(await page.$$eval(`#day-${k} .sstag`, els => els.map(e => e.textContent)), ["A1", "A2", "A3"]);

  // The dialog shows current partners as selected; unpicking all leaves the group.
  await page.click(`#day-${k} [data-act=entry] >> text=Dips`);
  assert.equal(await page.locator("#ssChips [aria-pressed=true]").count(), 2);
  await page.click("#ssChips [data-ss] >> text=Bench press");
  await page.click("#ssChips [data-ss] >> text=TRX low row");
  await page.click("#entryForm button.primary[type=submit]");
  assert.deepEqual(await page.$$eval(`#day-${k} .sstag`, els => els.map(e => e.textContent)), ["A1", "A2"]);

  // Moving one away (drag/remove) breaks up a pair of two.
  await page.evaluate(k => { const id = db.plan[k][1].id; moveItem("cal", k, id, dkey(addDays(parseKey(k), 1)), 0); }, k);
  assert.equal(await page.evaluate(k => db.plan[k].some(e => e.ss), k), false);

  // Copy to next week and save-as-session keep groups.
  await page.click(`#day-${k} [data-act=entry] >> text=Bench press`);
  await page.click("#ssChips [data-ss] >> text=Dips");
  await page.click("#entryForm button.primary[type=submit]");
  await page.evaluate(() => { state.week = mondayOf(new Date()); });
  await page.evaluate(() => copyWeekForward());
  await page.waitForTimeout(200);
  const nk = await page.evaluate(k => dkey(addDays(parseKey(k), 7)), k);
  const next = await page.evaluate(nk => db.plan[nk].map(e => !!e.ss), nk);
  assert.equal(next.filter(Boolean).length, 2);
  assert.deepEqual(page.errors, []);
});

test("exercise progress shows reps: best set, rep charts, and a table", async () => {
  const page = await openApp();
  await seed(page, [
    [-7, "s-wpullup", { log: [{ reps: 6, load: 25 }, { reps: 5, load: 25 }], done: true }],
    [0, "s-wpullup", { log: [{ reps: 5, load: 35 }, { reps: 4, load: 35 }, { reps: 8, load: 0 }], done: true }],
  ]);
  await page.click(".tabs [data-tab=data]");
  await page.selectOption("#progEx", "s-wpullup");
  const chips = await page.$$eval("#view-data [data-metric]", els => els.map(e => e.textContent));
  assert.deepEqual(chips, ["Weight", "Reps", "Total reps"]);
  const svg = () => page.locator("#view-data section:has-text('Exercise progress') svg").innerHTML();
  assert.match(await svg(), /\+35 lb × 5/);           // heaviest set says how many reps
  await page.click("[data-metric=reps]");
  assert.match(await svg(), /8 reps/);
  await page.click("[data-metric=vol]");
  assert.match(await svg(), /17 reps/);               // 5 + 4 + 8
  await page.click("#view-data section:has-text('Exercise progress') summary");
  const table = await page.locator("#view-data section:has-text('Exercise progress') table").innerText();
  assert.match(table, /\+35 lb × 5\s+3\s+17/);
  assert.match(table, /\+25 lb × 6\s+2\s+11/);
  assert.match(await page.innerText("#view-data"), /Personal records[\s\S]*Weighted pull-ups\s+\+35 lb × 5/);
  assert.deepEqual(page.errors, []);
});

test("yoga: a category to log, counted in training time, with a yoga timer", async () => {
  const page = await openApp();
  assert.equal(await page.evaluate(() => findEx("s-yoga") && findEx("s-yoga").cat), "Yoga");
  await seed(page, [[0, "s-yoga"]]);
  const k = await today(page);
  await page.click(`#day-${k} [data-act=entry] >> text=Yoga`);
  await page.click("#timerBtn");
  assert.equal(await page.getAttribute("#tmMode [data-tm=yoga]", "aria-pressed"), "true", "yoga opens in Yoga mode");
  // A tiny routine: 1 pose of 30s, no switch. Speed the clock up to finish fast.
  await page.click("#tmHolds [data-hold='30']");
  await page.fill("#tmPoses", "1");
  assert.match(await page.textContent("#tmPhase"), /1 poses × 30s/);
  await page.click("#tmYogaKind [data-yk=session]");
  await page.click("#tmSess [data-sess='20']");
  await page.click("#tmBell [data-bell='5']");
  assert.equal(await page.evaluate(() => buildPhases().filter(p => p.label === "Yoga").length), 4);
  assert.equal(await page.textContent("#tmClock"), "10");
  await page.evaluate(() => { timer.phases = buildPhases(); timer.i = timer.phases.length; timer.left = 0; renderTimer(); });
  assert.equal(await page.textContent("#tmPhase"), "Namaste 🙏");
  assert.equal(await page.textContent("#tmLog"), "Log 20 min");
  await page.click("#tmLog");
  await page.click("#entryForm button.primary[type=submit]");
  assert.deepEqual(await page.evaluate(k => db.plan[k][0].log, k), [{ mins: 20 }]);
  assert.equal(await page.evaluate(() => weekTime(mondayOf(new Date())).yoga), 20);
  assert.equal(await page.evaluate(() => weekTime(mondayOf(new Date())).cardio), 0);
  assert.deepEqual(page.errors, []);
});

test("Tension Board sessions log sends that show apart in the grade pyramid", async () => {
  const page = await openApp();
  const ex = await page.evaluate(() => findEx("s-tension"));
  assert.equal(ex.name, "Tension Board session");
  assert.equal(ex.cat, "Climbing");
  await seed(page, [[-2, "s-limit", { grades: [5, 4, 4], done: true }], [0, "s-tension"]]);
  const k = await today(page);
  // Log two Tension Board sends with the grade buttons.
  await page.click(`#day-${k} [data-act=entry] >> text=Tension Board session`);
  assert.ok(await page.isVisible("#gradeBtns"), "grade buttons on a Tension Board session");
  assert.ok(await page.isVisible("#sendsWrap"), "notable sends box too");
  await page.click("#gradeBtns button >> text=V5");
  await page.click("#gradeBtns button >> text=V6");
  await page.click("#entryForm button.primary[type=submit]");
  await page.click(".tabs [data-tab=data]");
  const card = page.locator("#view-data section:has-text('Grade pyramid')");
  const text = await card.innerText();
  assert.match(text, /Gym & outdoor 3/);
  assert.match(text, /Tension Board 2 · top V6/);
  // V5 has one of each: two segments, the Tension Board one marked.
  const v5 = card.locator(".track").nth(1);
  assert.equal(await v5.locator("span").count(), 2);
  assert.equal(await v5.locator("span.tb").count(), 1);
  assert.match(await v5.getAttribute("data-tip"), /1 gym & outdoor · 1 Tension Board/);
  assert.match(await card.locator(".pyr").getAttribute("aria-label"), /V6: 1 \(1 Tension Board\)/);
  assert.deepEqual(page.errors, []);
});

test("older saved data gets the Tension Board session", async () => {
  const ctxPage = await openApp();
  const v = await ctxPage.evaluate(() => {
    const d = clone(db); d.v = 14; d.exercises = d.exercises.filter(e => e.id !== "s-tension");
    const n = normalize(d); return [n.v, n.exercises.some(e => e.id === "s-tension")];
  });
  assert.deepEqual(v, [15, true]);
});

test("syncing with nothing new doesn't write to GitHub", async () => {
  const github = fakeGitHub();
  const page = await openApp({ github });
  await seed(page, [[0, "s-bench", { log: [{ reps: 5, load: 135 }], done: true }]]);
  await page.click("#settingsBtn");
  await page.fill("#syncToken", "ghp_good"); await page.click("[data-sync=connect]"); await page.waitForTimeout(500);
  const before = github.history.g1.length;
  for (let i = 0; i < 3; i++) await page.evaluate(() => syncNow());
  assert.equal(github.history.g1.length, before);
  // A second device joining with an empty library doesn't write either, unless it adds something.
  const other = await openApp({ github });
  await other.click("#settingsBtn");
  await other.fill("#syncToken", "ghp_good"); await other.click("[data-sync=connect]"); await other.waitForTimeout(500);
  await other.evaluate(() => syncNow());
  assert.ok(github.history.g1.length <= before + 1);
  assert.deepEqual([...page.errors, ...other.errors], []);
});
