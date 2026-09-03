async function ensureSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, date TEXT, gameType TEXT, stakes TEXT, location TEXT, startTime TEXT, endTime TEXT, buyIn REAL, rebuy REAL, cashOut REAL, expenses REAL, notes TEXT)`
  ).run();
  for (const col of ["bigBlind REAL DEFAULT 0", "place REAL DEFAULT 0", "bounties REAL DEFAULT 0", "players REAL DEFAULT 0", "game TEXT DEFAULT ''", "endDate TEXT DEFAULT ''"]) {
    try { await db.prepare(`ALTER TABLE sessions ADD COLUMN ${col}`).run(); } catch (e) { /* column already exists */ }
  }

  // weekly_history used to be keyed by a positional `idx` and store a running `total`
  // that every edit had to recompute across every later row. It's now keyed by a
  // stable id (year-label) storing only weekNet — total is derived client-side as a
  // prefix sum, so an edit only ever needs to touch the one row that actually changed.
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS weekly_history (id TEXT PRIMARY KEY, year INTEGER, week INTEGER, label TEXT, weekNet REAL)`
  ).run();
  const wh = await db.prepare("PRAGMA table_info(weekly_history)").all();
  const whCols = wh.results.map(c => c.name);
  if (whCols.includes("idx") && !whCols.includes("id")) {
    await db.prepare(`ALTER TABLE weekly_history RENAME TO weekly_history_old_20260902`).run();
    await db.prepare(
      `CREATE TABLE weekly_history (id TEXT PRIMARY KEY, year INTEGER, week INTEGER, label TEXT, weekNet REAL)`
    ).run();
    await db.prepare(
      `INSERT INTO weekly_history (id, year, week, label, weekNet)
       SELECT year || '-' || label, year, CAST(substr(label, 3) AS INTEGER), label, weekNet FROM weekly_history_old_20260902`
    ).run();
  }

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS daily_balance (id TEXT PRIMARY KEY, date TEXT, cash REAL, casino REAL, cash2 REAL, createdAt INTEGER)`
  ).run();
}

async function isAuthorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const password = await env.APP_PASSWORD.get();
  return Boolean(password) && token === password;
}

async function handleGet(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, date, gameType, game, stakes, location, startTime, endTime, endDate, buyIn, rebuy, cashOut, expenses, notes, bigBlind, place, bounties, players FROM sessions ORDER BY date, startTime"
  ).all();
  return Response.json(results);
}

async function handlePost(request, env) {
  const sessions = await request.json();
  if (!Array.isArray(sessions)) return new Response("Expected an array", { status: 400 });
  const stmts = [env.DB.prepare("DELETE FROM sessions")];
  for (const s of sessions) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO sessions (id, date, gameType, game, stakes, location, startTime, endTime, endDate, buyIn, rebuy, cashOut, expenses, notes, bigBlind, place, bounties, players)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        String(s.id), s.date || "", s.gameType || "", s.game || "", s.stakes || "", s.location || "",
        s.startTime || "", s.endTime || "", s.endDate || "", +s.buyIn || 0, +s.rebuy || 0, +s.cashOut || 0,
        +s.expenses || 0, s.notes || "", +s.bigBlind || 0, +s.place || 0, +s.bounties || 0, +s.players || 0
      )
    );
  }
  const CHUNK = 100;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await env.DB.batch(stmts.slice(i, i + CHUNK));
  }
  return Response.json({ ok: true, count: sessions.length });
}

async function handlePutSession(request, env, id) {
  const s = await request.json();
  await env.DB.prepare(
    `INSERT INTO sessions (id, date, gameType, game, stakes, location, startTime, endTime, endDate, buyIn, rebuy, cashOut, expenses, notes, bigBlind, place, bounties, players)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       date=excluded.date, gameType=excluded.gameType, game=excluded.game, stakes=excluded.stakes, location=excluded.location,
       startTime=excluded.startTime, endTime=excluded.endTime, endDate=excluded.endDate, buyIn=excluded.buyIn, rebuy=excluded.rebuy,
       cashOut=excluded.cashOut, expenses=excluded.expenses, notes=excluded.notes, bigBlind=excluded.bigBlind, place=excluded.place,
       bounties=excluded.bounties, players=excluded.players`
  ).bind(
    id, s.date || "", s.gameType || "", s.game || "", s.stakes || "", s.location || "",
    s.startTime || "", s.endTime || "", s.endDate || "", +s.buyIn || 0, +s.rebuy || 0, +s.cashOut || 0,
    +s.expenses || 0, s.notes || "", +s.bigBlind || 0, +s.place || 0, +s.bounties || 0, +s.players || 0
  ).run();
  return Response.json({ ok: true });
}

async function handleDeleteSession(env, id) {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}

async function handleGetWeekly(env) {
  const { results } = await env.DB.prepare(
    "SELECT year, label, weekNet FROM weekly_history ORDER BY year, week"
  ).all();
  return Response.json(results);
}

async function handlePostWeekly(request, env) {
  const rows = await request.json();
  if (!Array.isArray(rows)) return new Response("Expected an array", { status: 400 });
  const stmts = [env.DB.prepare("DELETE FROM weekly_history")];
  rows.forEach((r) => {
    const year = +r[0] || 0, label = String(r[1] || ""), weekNet = r[2] == null ? 0 : +r[2];
    const week = parseInt((label.match(/\d+/) || ["0"])[0], 10);
    stmts.push(
      env.DB.prepare(`INSERT INTO weekly_history (id, year, week, label, weekNet) VALUES (?, ?, ?, ?, ?)`)
        .bind(year + "-" + label, year, week, label, weekNet)
    );
  });
  const CHUNK = 100;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await env.DB.batch(stmts.slice(i, i + CHUNK));
  }
  return Response.json({ ok: true, count: rows.length });
}

async function handlePutWeekly(request, env, id) {
  const r = await request.json();
  const year = +r.year || 0, label = String(r.label || ""), weekNet = r.weekNet == null ? 0 : +r.weekNet;
  const week = Number.isFinite(+r.week) ? +r.week : parseInt((label.match(/\d+/) || ["0"])[0], 10);
  await env.DB.prepare(
    `INSERT INTO weekly_history (id, year, week, label, weekNet) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET year=excluded.year, week=excluded.week, label=excluded.label, weekNet=excluded.weekNet`
  ).bind(id, year, week, label, weekNet).run();
  return Response.json({ ok: true });
}

async function handleGetDailyBalance(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, date, cash, casino, cash2, createdAt FROM daily_balance ORDER BY date, createdAt"
  ).all();
  return Response.json(results);
}

async function handlePostDailyBalance(request, env) {
  const rows = await request.json();
  if (!Array.isArray(rows)) return new Response("Expected an array", { status: 400 });
  const stmts = [env.DB.prepare("DELETE FROM daily_balance")];
  for (const r of rows) {
    stmts.push(
      env.DB.prepare(`INSERT INTO daily_balance (id, date, cash, casino, cash2, createdAt) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(String(r[4] || ""), String(r[0] || ""), +r[1] || 0, +r[2] || 0, +r[3] || 0, +r[5] || 0)
    );
  }
  const CHUNK = 100;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await env.DB.batch(stmts.slice(i, i + CHUNK));
  }
  return Response.json({ ok: true, count: rows.length });
}

async function handlePutDailyBalance(request, env, id) {
  const r = await request.json();
  await env.DB.prepare(
    `INSERT INTO daily_balance (id, date, cash, casino, cash2, createdAt) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET date=excluded.date, cash=excluded.cash, casino=excluded.casino, cash2=excluded.cash2, createdAt=excluded.createdAt`
  ).bind(id, String(r.date || ""), +r.cash || 0, +r.casino || 0, +r.cash2 || 0, +r.createdAt || 0).run();
  return Response.json({ ok: true });
}

async function handleDeleteDailyBalance(env, id) {
  await env.DB.prepare("DELETE FROM daily_balance WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const sessionIdMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionIdMatch) {
      try {
        await ensureSchema(env.DB);
        if (request.method !== "PUT" && request.method !== "DELETE") {
          return new Response("Method not allowed", { status: 405 });
        }
        if (!(await isAuthorized(request, env))) return new Response("Unauthorized", { status: 401 });
        const id = decodeURIComponent(sessionIdMatch[1]);
        if (request.method === "PUT") return handlePutSession(request, env, id);
        return handleDeleteSession(env, id);
      } catch (err) {
        return new Response("Server error", { status: 500 });
      }
    }

    const weeklyIdMatch = url.pathname.match(/^\/api\/weekly-history\/([^/]+)$/);
    if (weeklyIdMatch) {
      try {
        await ensureSchema(env.DB);
        if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
        if (!(await isAuthorized(request, env))) return new Response("Unauthorized", { status: 401 });
        const id = decodeURIComponent(weeklyIdMatch[1]);
        return handlePutWeekly(request, env, id);
      } catch (err) {
        return new Response("Server error", { status: 500 });
      }
    }

    const dailyBalanceIdMatch = url.pathname.match(/^\/api\/daily-balance\/([^/]+)$/);
    if (dailyBalanceIdMatch) {
      try {
        await ensureSchema(env.DB);
        if (request.method !== "PUT" && request.method !== "DELETE") {
          return new Response("Method not allowed", { status: 405 });
        }
        if (!(await isAuthorized(request, env))) return new Response("Unauthorized", { status: 401 });
        const id = decodeURIComponent(dailyBalanceIdMatch[1]);
        if (request.method === "PUT") return handlePutDailyBalance(request, env, id);
        return handleDeleteDailyBalance(env, id);
      } catch (err) {
        return new Response("Server error", { status: 500 });
      }
    }

    if (url.pathname === "/api/sessions") {
      try {
        await ensureSchema(env.DB);

        if (request.method === "GET") return handleGet(env);
        if (request.method === "POST") {
          if (!(await isAuthorized(request, env))) {
            return new Response("Unauthorized", { status: 401 });
          }
          return handlePost(request, env);
        }
        return new Response("Method not allowed", { status: 405 });
      } catch (err) {
        return new Response("Server error", { status: 500 });
      }
    }

    if (url.pathname === "/api/weekly-history") {
      try {
        await ensureSchema(env.DB);

        if (request.method === "GET") return handleGetWeekly(env);
        if (request.method === "POST") {
          if (!(await isAuthorized(request, env))) {
            return new Response("Unauthorized", { status: 401 });
          }
          return handlePostWeekly(request, env);
        }
        return new Response("Method not allowed", { status: 405 });
      } catch (err) {
        return new Response("Server error", { status: 500 });
      }
    }

    if (url.pathname === "/api/daily-balance") {
      try {
        await ensureSchema(env.DB);

        if (request.method === "GET") return handleGetDailyBalance(env);
        if (request.method === "POST") {
          if (!(await isAuthorized(request, env))) {
            return new Response("Unauthorized", { status: 401 });
          }
          return handlePostDailyBalance(request, env);
        }
        return new Response("Method not allowed", { status: 405 });
      } catch (err) {
        return new Response("Server error", { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
