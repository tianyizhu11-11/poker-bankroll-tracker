async function ensureSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, date TEXT, gameType TEXT, stakes TEXT, location TEXT, startTime TEXT, endTime TEXT, buyIn REAL, rebuy REAL, cashOut REAL, expenses REAL, notes TEXT)`
  ).run();
  for (const col of ["bigBlind REAL DEFAULT 0", "place REAL DEFAULT 0", "bounties REAL DEFAULT 0", "players REAL DEFAULT 0", "game TEXT DEFAULT ''"]) {
    try { await db.prepare(`ALTER TABLE sessions ADD COLUMN ${col}`).run(); } catch (e) { /* column already exists */ }
  }
}

async function isAuthorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const password = await env.APP_PASSWORD.get();
  return Boolean(password) && token === password;
}

async function handleGet(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, date, gameType, game, stakes, location, startTime, endTime, buyIn, rebuy, cashOut, expenses, notes, bigBlind, place, bounties, players FROM sessions ORDER BY date, startTime"
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
        `INSERT INTO sessions (id, date, gameType, game, stakes, location, startTime, endTime, buyIn, rebuy, cashOut, expenses, notes, bigBlind, place, bounties, players)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        String(s.id), s.date || "", s.gameType || "", s.game || "", s.stakes || "", s.location || "",
        s.startTime || "", s.endTime || "", +s.buyIn || 0, +s.rebuy || 0, +s.cashOut || 0,
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

    return env.ASSETS.fetch(request);
  },
};
