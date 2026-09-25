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
  const gists = {}; let n = 0; const net = { online: true };
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
      return json(201, gists[id]);
    }
    const m = u.pathname.match(/^\/gists\/(\w+)$/);
    if (m && !gists[m[1]]) return json(404, {});
    if (m && req.method() === "GET") return json(200, gists[m[1]]);
    if (m && req.method() === "PATCH") {
      for (const [k, v] of Object.entries(req.postDataJSON().files)) gists[m[1]].files[k] = { content: v.content, truncated: false };
      return json(200, gists[m[1]]);
    }
    return json(500, {});
  };
  return { gists, net, handler };
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
    await page.waitForTimeout(400);
  };
  const phone = await openApp({ github });
  await seed(phone, [[0, "s-wpullup", { log: [{ reps: 5, load: 30 }], done: true, note: "from phone" }]]);
  await connect(phone, "ghp_wrong");
  assert.match(await phone.textContent("#syncErr"), /./);
  await phone.fill("#syncToken", "ghp_good"); await phone.click("[data-sync=connect]"); await phone.waitForTimeout(500);
  assert.equal(Object.keys(github.gists).length, 1);

  const laptop = await openApp({ github });
  await connect(laptop, "ghp_good");
  await laptop.click("#confirmYes"); await laptop.waitForTimeout(400);
  assert.deepEqual(await laptop.evaluate(() => Object.values(db.plan).flat().map(e => e.note)), ["from phone"]);

  await laptop.evaluate(() => { db.lift[dkey(new Date())] = 55; save(); });
  await laptop.waitForTimeout(2600);
  await phone.evaluate(() => syncPull()); await phone.waitForTimeout(400);
  assert.equal(await phone.evaluate(() => db.lift[dkey(new Date())]), 55);

  github.net.online = false;
  await phone.evaluate(() => { db.lift[dkey(new Date())] = 60; save(); });
  await phone.waitForTimeout(2600);
  github.net.online = true;
  await phone.evaluate(() => window.dispatchEvent(new Event("online"))); await phone.waitForTimeout(500);
  assert.equal(Object.values(JSON.parse(github.gists.g1.files["training-plan.json"].content).lift)[0], 60);
  assert.equal(await phone.evaluate(() => JSON.stringify(db).includes("ghp_")), false, "token never stored in the data");
  assert.deepEqual([...phone.errors, ...laptop.errors], []);
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
