const PASSWORD_ITERATIONS = 100000;
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const ROOM_TTL_SECONDS = 60 * 60 * 3;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
const AVATARS = new Set(['🧑‍🎓','🦊','🐸','🐼','🤖','👾','🐱','🦄','🐢','🐙','🐧','🦉']);
const encoder = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      ...extraHeaders,
    },
  });
}
function fail(message, status = 400) { return json({ error: message }, status); }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function randBytes(length) { const out = new Uint8Array(length); crypto.getRandomValues(out); return out; }
function b64(bytes) { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); }
function unb64(value) { const raw = atob(value); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; }
function b64url(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
async function sha256Hex(value) {
  const hash = await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function passwordHash(password, saltB64, iterations = PASSWORD_ITERATIONS) {
  const salt = saltB64 ? unb64(saltB64) : randBytes(16);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const result = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return { hash: b64(new Uint8Array(result)), salt: b64(salt), iterations };
}
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function cookieValue(request, name) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const pos = part.indexOf('='); if (pos < 0) continue;
    if (part.slice(0, pos).trim() === name) { try { return decodeURIComponent(part.slice(pos + 1).trim()); } catch { return null; } }
  }
  return null;
}
function sessionCookie(request, token, maxAge = SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `rq_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function clearSessionCookie(request) { return sessionCookie(request, '', 0); }
function profileOf(row, includePresence = false) {
  if (!row) return null;
  const answered = Math.max(0, Number(row.answered) || 0);
  const correct = Math.max(0, Number(row.correct) || 0);
  const out = {
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar || '🧑‍🎓',
    year: row.year || 'Year 11',
    board: row.exam_board || 'Mixed / not sure',
    goal: String(row.daily_goal || 15),
    focusSubject: row.focus_subject || '',
    xp: Math.max(0, Number(row.xp) || 0),
    answered,
    correct,
    streak: Math.max(0, Number(row.streak) || 0),
    level: Math.floor(Math.max(0, Number(row.xp) || 0) / 100) + 1,
    accuracy: answered ? Math.round(correct / answered * 100) : 0,
    createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
    updatedAt: new Date(Number(row.updated_at) * 1000).toISOString(),
  };
  if (includePresence) {
    const lastSeen = Number(row.last_seen_at) || 0;
    out.online = nowSeconds() - lastSeen <= 120;
    out.lastSeenAt = lastSeen ? new Date(lastSeen * 1000).toISOString() : null;
  }
  return out;
}
async function bodyJson(request) {
  try { return await request.json(); } catch { return null; }
}
function checkOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
async function currentUser(request, env, updateSeen = true) {
  const token = cookieValue(request, 'rq_session');
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`SELECT u.* , s.expires_at AS session_expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? LIMIT 1`).bind(tokenHash).first();
  if (!row) return null;
  const now = nowSeconds();
  if (Number(row.session_expires_at) <= now) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(tokenHash).run();
    return null;
  }
  if (updateSeen && now - (Number(row.last_seen_at) || 0) >= 45) {
    await env.DB.prepare('UPDATE users SET last_seen_at=? WHERE id=?').bind(now, row.id).run();
    row.last_seen_at = now;
  }
  return row;
}
async function requireUser(request, env) {
  const user = await currentUser(request, env);
  return user || null;
}
async function allowAuthAttempt(request, env, purpose, maximum, windowSeconds) {
  const now = nowSeconds();
  const ip = request.headers.get('cf-connecting-ip') || 'local/unknown';
  const key = await sha256Hex(`auth-limit:${ip}:${purpose}`);
  const row = await env.DB.prepare('SELECT window_started,attempts FROM auth_limits WHERE scope_key=?').bind(key).first();
  if (row && now - Number(row.window_started) < windowSeconds && Number(row.attempts) >= maximum) return false;
  const active = row && now - Number(row.window_started) < windowSeconds;
  const started = active ? Number(row.window_started) : now;
  const attempts = active ? Number(row.attempts) + 1 : 1;
  await env.DB.prepare(`INSERT INTO auth_limits(scope_key,window_started,attempts) VALUES(?,?,?)
    ON CONFLICT(scope_key) DO UPDATE SET window_started=excluded.window_started,attempts=excluded.attempts`)
    .bind(key, started, attempts).run();
  return true;
}
async function createSession(request, env, userId) {
  const token = b64url(randBytes(32));
  const tokenHash = await sha256Hex(token);
  const now = nowSeconds();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .bind(tokenHash, userId, now + SESSION_SECONDS, now).run();
  return sessionCookie(request, token);
}
async function register(request, env) {
  if (!(await allowAuthAttempt(request, env, 'register', 5, 3600))) return fail('Too many account creation attempts from this connection. Try again later.', 429);
  const data = await bodyJson(request);
  if (!data) return fail('Please send valid JSON.');
  const username = String(data.username || '').trim();
  const normalized = username.toLowerCase();
  const password = String(data.password || '');
  const displayName = String(data.displayName || username).trim().slice(0, 35);
  const avatar = AVATARS.has(data.avatar) ? data.avatar : '🧑‍🎓';
  const year = String(data.year || 'Year 11').slice(0, 40);
  const examBoard = String(data.board || 'Mixed / not sure').slice(0, 40);
  const dailyGoal = Math.min(120, Math.max(5, Number(data.goal) || 15));
  if (!USERNAME_RE.test(username)) return fail('Username must be 3–24 characters using letters, numbers, _ or -.');
  if (password.length < 10 || password.length > 128) return fail('Choose a password between 10 and 128 characters.');
  if (!displayName) return fail('Enter a display name.');
  const salt = b64(randBytes(16));
  const hashed = await passwordHash(password, salt, PASSWORD_ITERATIONS);
  const now = nowSeconds();
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO users(id,username,username_normalized,display_name,avatar,password_hash,password_salt,password_iterations,year,exam_board,daily_goal,created_at,updated_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, username, normalized, displayName, avatar, hashed.hash, hashed.salt, hashed.iterations, year, examBoard, dailyGoal, now, now, now).run();
  } catch (error) {
    if (/unique|constraint/i.test(String(error))) return fail('That username is already taken. Choose another.', 409);
    throw error;
  }
  const setCookie = await createSession(request, env, id);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  return json({ user: profileOf(user) }, 201, { 'set-cookie': setCookie });
}
async function login(request, env) {
  const data = await bodyJson(request);
  const usernameForLimit = String(data?.username || '').trim().toLowerCase();
  const ipAllowed = await allowAuthAttempt(request, env, 'login-ip', 40, 900);
  const userAllowed = await allowAuthAttempt(request, env, 'login-user:' + usernameForLimit.slice(0, 24), 12, 900);
  if (!ipAllowed || !userAllowed) return fail('Too many sign-in attempts. Wait 15 minutes and try again.', 429);
  if (!data) return fail('Please send valid JSON.');
  const username = String(data.username || '').trim().toLowerCase();
  const password = String(data.password || '');
  if (!username || !password || password.length > 128) return fail('Username or password is incorrect.', 401);
  const user = await env.DB.prepare('SELECT * FROM users WHERE username_normalized=? LIMIT 1').bind(username).first();
  if (!user) { // Do a dummy PBKDF2 to make unknown usernames less distinguishable by timing.
    await passwordHash(password.slice(0, 128), b64(new Uint8Array(16)), PASSWORD_ITERATIONS);
    return fail('Username or password is incorrect.', 401);
  }
  const attempt = await passwordHash(password, user.password_salt, Number(user.password_iterations) || PASSWORD_ITERATIONS);
  if (!sameString(attempt.hash, user.password_hash)) return fail('Username or password is incorrect.', 401);
  const userRateKey = await sha256Hex(`auth-limit:${request.headers.get('cf-connecting-ip') || 'local/unknown'}:login-user:${username.slice(0, 24)}`);
  await env.DB.prepare('DELETE FROM auth_limits WHERE scope_key=?').bind(userRateKey).run();
  const setCookie = await createSession(request, env, user.id);
  const now = nowSeconds();
  await env.DB.prepare('UPDATE users SET last_seen_at=?,updated_at=? WHERE id=?').bind(now, now, user.id).run();
  user.last_seen_at = now;
  return json({ user: profileOf(user) }, 200, { 'set-cookie': setCookie });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!checkOrigin(request)) return fail('Cross-origin request blocked.', 403);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      try { await env.DB.prepare('SELECT 1 AS ok').first(); }
      catch { return fail('Cloudflare Worker is live, but the D1 database is not configured. Complete the database setup steps.', 503); }
      return json({ ok: true, service: 'Revision Quest 98 Cloudflare API', realtime: 'Durable Objects WebSockets', accounts: true, friends: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      const user = await currentUser(request, env);
      return json({ user: profileOf(user) });
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/register') return register(request, env);
    if (request.method === 'POST' && url.pathname === '/api/auth/login') return login(request, env);
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = cookieValue(request, 'rq_session');
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256Hex(token)).run();
      return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(request) });
    }

    // All remaining API routes require a signed-in account.
    const user = await requireUser(request, env);
    if (!user) return fail('Please sign in to use online accounts, friends, and live rooms.', 401);
    if (request.method === 'GET' && url.pathname === '/api/profile') return json({ user: profileOf(user, true) });
    if (request.method === 'PATCH' && url.pathname === '/api/profile') {
      const data = await bodyJson(request); if (!data) return fail('Please send valid JSON.');
      const displayName = String(data.displayName ?? user.display_name).trim().slice(0, 35);
      const avatar = AVATARS.has(data.avatar) ? data.avatar : user.avatar;
      const year = String(data.year ?? user.year).slice(0, 40);
      const board = String(data.board ?? user.exam_board).slice(0, 40);
      const goal = Math.min(120, Math.max(5, Number(data.goal ?? user.daily_goal) || 15));
      const focus = String(data.focusSubject ?? user.focus_subject ?? '').slice(0, 80);
      if (!displayName) return fail('Display name cannot be empty.');
      const now = nowSeconds();
      await env.DB.prepare('UPDATE users SET display_name=?,avatar=?,year=?,exam_board=?,daily_goal=?,focus_subject=?,updated_at=?,last_seen_at=? WHERE id=?')
        .bind(displayName, avatar, year, board, goal, focus, now, now, user.id).run();
      const updated = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
      return json({ user: profileOf(updated, true) });
    }
    if (request.method === 'POST' && url.pathname === '/api/progress') {
      const data = await bodyJson(request); if (!data) return fail('Please send valid JSON.');
      const xp = Math.min(100000000, Math.max(0, Math.floor(Number(data.xp) || 0)));
      const answered = Math.min(100000000, Math.max(0, Math.floor(Number(data.answered) || 0)));
      const correct = Math.min(answered, Math.max(0, Math.floor(Number(data.correct) || 0)));
      const streak = Math.min(100000, Math.max(0, Math.floor(Number(data.streak) || 0)));
      const focus = String(data.focusSubject || user.focus_subject || '').slice(0, 80);
      const now = nowSeconds();
      await env.DB.prepare('UPDATE users SET xp=?,answered=?,correct=?,streak=?,focus_subject=?,updated_at=?,last_seen_at=? WHERE id=?')
        .bind(xp, answered, correct, streak, focus, now, now, user.id).run();
      const updated = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
      return json({ user: profileOf(updated, true) });
    }

    if (url.pathname === '/api/friends' && request.method === 'GET') {
      const rows = await env.DB.prepare(`SELECT f.id AS friendship_id,u.* FROM friendships f
        JOIN users u ON u.id=CASE WHEN f.requester_id=? THEN f.addressee_id ELSE f.requester_id END
        WHERE f.status='accepted' AND (f.requester_id=? OR f.addressee_id=?) ORDER BY u.username_normalized`)
        .bind(user.id, user.id, user.id).all();
      return json({ friends: (rows.results || []).map(row => ({ friendshipId: row.friendship_id, ...profileOf(row, true) })) });
    }
    if (url.pathname === '/api/friends/requests' && request.method === 'GET') {
      const rows = await env.DB.prepare(`SELECT f.id AS request_id,f.created_at AS requested_at,u.* FROM friendships f
        JOIN users u ON u.id=f.requester_id WHERE f.addressee_id=? AND f.status='pending' ORDER BY f.created_at ASC`)
        .bind(user.id).all();
      return json({ requests: (rows.results || []).map(row => ({ requestId: row.request_id, requestedAt: new Date(Number(row.requested_at) * 1000).toISOString(), user: profileOf(row, true) })) });
    }
    if (url.pathname === '/api/friends/request' && request.method === 'POST') {
      const data = await bodyJson(request); if (!data) return fail('Please send valid JSON.');
      const targetName = String(data.username || '').trim().replace(/^@/, '').toLowerCase();
      if (!USERNAME_RE.test(targetName)) return fail('Enter a valid username (3–24 characters).');
      const target = await env.DB.prepare('SELECT id,username FROM users WHERE username_normalized=?').bind(targetName).first();
      if (!target) return fail('No account found with that username.', 404);
      if (target.id === user.id) return fail('You cannot add yourself.');
      const existing = await env.DB.prepare(`SELECT id,status,requester_id,addressee_id FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?) LIMIT 1`)
        .bind(user.id, target.id, target.id, user.id).first();
      if (existing) {
        if (existing.status === 'accepted') return fail('You are already friends.', 409);
        if (existing.addressee_id === user.id) return fail('That person has already requested to be your friend. Check incoming requests.', 409);
        return fail('Friend request already sent.', 409);
      }
      const now = nowSeconds();
      await env.DB.prepare('INSERT INTO friendships(id,requester_id,addressee_id,status,created_at,updated_at) VALUES(?,?,?,\'pending\',?,?)')
        .bind(crypto.randomUUID(), user.id, target.id, now, now).run();
      return json({ ok: true, message: `Friend request sent to @${target.username}.` }, 201);
    }
    if (url.pathname === '/api/friends/respond' && request.method === 'POST') {
      const data = await bodyJson(request); if (!data) return fail('Please send valid JSON.');
      const id = String(data.requestId || '');
      const requestRow = await env.DB.prepare('SELECT id FROM friendships WHERE id=? AND addressee_id=? AND status=\'pending\'').bind(id, user.id).first();
      if (!requestRow) return fail('Friend request not found or already handled.', 404);
      if (data.accept === true) await env.DB.prepare('UPDATE friendships SET status=\'accepted\',updated_at=? WHERE id=?').bind(nowSeconds(), id).run();
      else await env.DB.prepare('DELETE FROM friendships WHERE id=?').bind(id).run();
      return json({ ok: true, accepted: data.accept === true });
    }
    const friendDelete = url.pathname.match(/^\/api\/friends\/([0-9a-f-]{36})$/i);
    if (friendDelete && request.method === 'DELETE') {
      const result = await env.DB.prepare('DELETE FROM friendships WHERE id=? AND (requester_id=? OR addressee_id=?)').bind(friendDelete[1], user.id, user.id).run();
      if (!result.meta?.changes) return fail('Friend link not found.', 404);
      return json({ ok: true });
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const data = await bodyJson(request); if (!data) return fail('Please send valid JSON.');
      const subject = String(data.subject || 'Mixed GCSE').trim().slice(0, 80) || 'Mixed GCSE';
      await env.DB.prepare("DELETE FROM rooms WHERE expires_at < ? OR status='closed'").bind(nowSeconds()).run();
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        const bytes = randBytes(6); code = [...bytes].map(b => alphabet[b % alphabet.length]).join('');
        const existing = await env.DB.prepare('SELECT code FROM rooms WHERE code=?').bind(code).first();
        if (!existing) break;
        code = '';
      }
      if (!code) return fail('Could not allocate a room code. Try again.', 503);
      const now = nowSeconds();
      await env.DB.prepare('INSERT INTO rooms(code,host_user_id,subject,status,created_at,expires_at) VALUES(?,?,?,\'waiting\',?,?)')
        .bind(code, user.id, subject, now, now + ROOM_TTL_SECONDS).run();
      return json({ code, subject, expiresAt: new Date((now + ROOM_TTL_SECONDS) * 1000).toISOString() }, 201);
    }
    const wsMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/ws$/i);
    if (wsMatch && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const code = wsMatch[1].toUpperCase();
      const room = await env.DB.prepare('SELECT code,host_user_id,status,expires_at FROM rooms WHERE code=?').bind(code).first();
      if (!room || Number(room.expires_at) <= nowSeconds() || room.status === 'closed') return fail('Room code is invalid or expired. Ask the host to create a new room.', 404);
      const role = room.host_user_id === user.id ? 'host' : 'guest';
      const id = env.GAME_ROOMS.idFromName(code);
      // Forward the original Upgrade request untouched so the WebSocket handshake is preserved.
      // The Durable Object independently validates the session cookie and room role.
      return env.GAME_ROOMS.get(id).fetch(request);
    }

    return fail('API route not found.', 404);
  },
};

// Each room is one Durable Object. It coordinates WebSocket players, room state and
// the host-authoritative revision round. Passwords/sessions never enter room messages.
export class GameRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/ws$/i);
    if (!match || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
    const roomCode = match[1].toUpperCase();
    const user = await currentUser(request, this.env);
    if (!user) return new Response('Sign in required', { status: 401 });
    const room = await this.env.DB.prepare('SELECT host_user_id,status,expires_at FROM rooms WHERE code=?').bind(roomCode).first();
    if (!room || Number(room.expires_at) <= nowSeconds() || room.status === 'closed') return new Response('Room is invalid or expired', { status: 404 });
    const userId = user.id;
    const username = String(user.username || 'Player').slice(0, 24);
    const avatar = AVATARS.has(user.avatar) ? user.avatar : '🧑‍🎓';
    const hostUserId = room.host_user_id;
    const role = hostUserId === userId ? 'host' : 'guest';
    const sockets = this.ctx.getWebSockets();
    const existing = sockets.map(ws => this.playerFrom(ws)).filter(Boolean);
    if (existing.some(player => player.userId === userId)) return new Response('This account is already connected to the room.', { status: 409 });
    if (existing.length >= 8) return new Response('Room is full (maximum 8 players).', { status: 409 });
    const knownHost = await this.ctx.storage.get('hostUserId');
    if (knownHost && knownHost !== hostUserId) return new Response('Room host does not match.', { status: 403 });
    if (!knownHost) await this.ctx.storage.put('hostUserId', hostUserId);
    await this.ctx.storage.put('roomCode', roomCode);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const player = { id: crypto.randomUUID(), userId, username, avatar, role, joinedAt: nowSeconds() };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(player);
    const safePlayer = this.publicPlayer(player);
    server.send(JSON.stringify({ event: 'ready', self: safePlayer, role, hostId: role === 'host' ? player.id : (existing.find(p => p.userId === hostUserId)?.id || null), players: existing.map(p => this.publicPlayer(p)) }));
    for (const ws of sockets) this.safeSend(ws, { event: 'peer-join', peer: safePlayer });
    return new Response(null, { status: 101, webSocket: client });
  }

  playerFrom(ws) { try { return ws.deserializeAttachment(); } catch { return null; } }
  publicPlayer(p) { return { id: p.id, username: p.username, avatar: p.avatar, role: p.role }; }
  safeSend(ws, value) { try { if (ws.readyState === 1) ws.send(JSON.stringify(value)); } catch {} }
  broadcast(value, exceptId = null) {
    for (const ws of this.ctx.getWebSockets()) {
      const p = this.playerFrom(ws); if (!p || p.id === exceptId) continue;
      this.safeSend(ws, value);
    }
  }

  async webSocketMessage(ws, message) {
    const sender = this.playerFrom(ws);
    if (!sender) return;
    if (typeof message !== 'string' || message.length > 16000) { try { ws.close(1009, 'Message too large'); } catch {} return; }
    let packet; try { packet = JSON.parse(message); } catch { return; }
    if (!packet || packet.type !== 'client-message' || !packet.message || typeof packet.message !== 'object') return;
    const m = packet.message;
    const allowed = new Set(['hello','welcome','lobby','question','answer','result','scoreboard','next','end']);
    if (!allowed.has(String(m.type))) return;
    // Do not let a guest overwrite official questions or host-scored results.
    if (sender.role !== 'host' && ['lobby','question','result','scoreboard','next','end'].includes(m.type)) return;
    // Resolve displayed identity from the authenticated session, not client-supplied names.
    let safeMessage = m;
    if (m.type === 'hello' || m.type === 'welcome') {
      safeMessage = { ...m, username: sender.username, avatar: sender.avatar, role: sender.role, roomCode: await this.ctx.storage.get('roomCode') };
    }
    const payload = { event: 'game-message', peerId: sender.id, message: safeMessage };
    const target = typeof packet.target === 'string' ? packet.target : null;
    if (target) {
      const socket = this.ctx.getWebSockets().find(candidate => this.playerFrom(candidate)?.id === target);
      if (socket && socket !== ws) this.safeSend(socket, payload);
    } else {
      this.broadcast(payload, sender.id);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const player = this.playerFrom(ws);
    if (!player) return;
    this.broadcast({ event: 'peer-left', peerId: player.id, username: player.username });
    if (player.role === 'host') {
      const roomCode = await this.ctx.storage.get('roomCode');
      if (roomCode) await this.env.DB.prepare('UPDATE rooms SET status=\'closed\' WHERE code=? AND host_user_id=?').bind(roomCode, player.userId).run().catch(() => {});
      this.broadcast({ event: 'room-closed', message: 'The host left. Create a new room to play again.' });
      for (const socket of this.ctx.getWebSockets()) { try { socket.close(1000, 'Host left room'); } catch {} }
    }
  }
  async webSocketError(ws, error) { this.webSocketClose(ws, 1011, 'WebSocket error', false); }
}
