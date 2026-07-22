import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from 'baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Config (all via environment variables)
// ---------------------------------------------------------------------------

// WA_GROUPS: comma-separated list of WhatsApp groups to mirror into the ONE
// Signal group. Each entry is either "JID" or "JID=Label". Example:
//   WA_GROUPS=12036...@g.us=Admins,12036...@g.us=Chat
// If a label is omitted, the WhatsApp group's own name is used.
// (WA_GROUP_JID is still accepted as a single-group fallback.)
function parseGroups() {
  const raw = process.env.WA_GROUPS || process.env.WA_GROUP_JID || ''
  const map = new Map()
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=')
    if (eq === -1) map.set(entry, undefined)
    else map.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim() || undefined)
  }
  return map
}

const cfg = {
  signalApiUrl: (process.env.SIGNAL_API_URL || 'http://signal-cli-rest-api:8080').replace(/\/+$/, ''),
  signalNumber: process.env.SIGNAL_NUMBER || '',          // your own Signal number, e.g. +3585012345678
  signalGroupId: process.env.SIGNAL_GROUP_ID || '',       // "group.XXXX..." from GET /v1/groups/<number>
  groups: parseGroups(),                                  // Map<jid, label|undefined>
  showLabel: (process.env.SHOW_GROUP_LABEL || 'true').toLowerCase() !== 'false',
  relayFromMe: (process.env.RELAY_FROM_ME || 'true').toLowerCase() !== 'false',
  selfName: process.env.WA_SELF_NAME || 'Me',             // name used for your own outgoing WA messages
  authDir: process.env.AUTH_DIR || './auth',
  logLevel: process.env.LOG_LEVEL || 'info',
  uptimeKumaPushUrl: process.env.UPTIME_KUMA_PUSH_URL || '',
  uptimeKumaIntervalSec: parseInt(process.env.UPTIME_KUMA_PUSH_INTERVAL || '60', 10),
  // Reconnect catch-up: after an outage, backfill messages WhatsApp pushes on
  // reconnect that we haven't already relayed.
  catchupOnReconnect: (process.env.CATCHUP_ON_RECONNECT || 'true').toLowerCase() !== 'false',
  catchupMaxHours: parseInt(process.env.CATCHUP_MAX_HOURS || '24', 10),   // ignore gaps older than this
  catchupMaxCount: parseInt(process.env.CATCHUP_MAX_COUNT || '200', 10),  // safety cap per burst
}

const logger = pino({ level: cfg.logLevel })
const subjectByJid = {}   // jid -> WhatsApp group name, learned at runtime
let waConnected = false   // true only while the WhatsApp socket is open
let reconnectAttempts = 0 // for backoff + logging
let kumaLastOk = null     // last Kuma push result, so we only log recoveries once

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowSec = () => Math.floor(Date.now() / 1000)

// Map a DisconnectReason numeric code back to its name for readable logs.
const REASON_NAMES = Object.fromEntries(Object.entries(DisconnectReason).map(([k, v]) => [v, k]))
const reasonName = (code) => REASON_NAMES[code] || 'unknown'

// Hide the push token when logging the Kuma URL.
function maskToken(url) {
  return url.replace(/(\/api\/push\/)([^/?]+)/, (_, p, tok) => p + (tok.length > 4 ? '…' + tok.slice(-4) : tok))
}

// ---------------------------------------------------------------------------
// Dedup + high-water-mark state (persisted in the auth volume so it survives
// restarts). relayedIds prevents double-sends; lastRelayedTs bounds catch-up.
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(cfg.authDir, 'relay-state.json')
const relayedIds = new Set()
let lastRelayedTs = 0
let saveTimer = null

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (Array.isArray(s.relayedIds)) for (const id of s.relayedIds) relayedIds.add(id)
    if (typeof s.lastRelayedTs === 'number') lastRelayedTs = s.lastRelayedTs
  } catch { /* no state yet — first run */ }
  // Baseline on first ever run: set the mark to "now" so the initial history
  // dump on pairing is NOT relayed as a flood of old messages.
  if (!lastRelayedTs) { lastRelayedTs = nowSec(); scheduleSave() }
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const ids = Array.from(relayedIds).slice(-5000) // keep the file bounded
      fs.writeFileSync(STATE_FILE, JSON.stringify({ relayedIds: ids, lastRelayedTs }))
    } catch (e) {
      logger.warn(`Could not save relay state: ${e.message}`)
    }
  }, 1000)
}

function markRelayed(id, tsSec) {
  if (id) relayedIds.add(id)
  if (tsSec && tsSec > lastRelayedTs) lastRelayedTs = tsSec
  if (relayedIds.size > 8000) { // trim in-memory set
    const keep = Array.from(relayedIds).slice(-5000)
    relayedIds.clear()
    for (const k of keep) relayedIds.add(k)
  }
  scheduleSave()
}

function tsOf(m) {
  const t = m?.messageTimestamp
  if (t == null) return 0
  if (typeof t === 'number') return t
  if (typeof t.toNumber === 'function') return t.toNumber()
  return Number(t) || 0
}

// ---------------------------------------------------------------------------
// Uptime Kuma heartbeat — only while WhatsApp is actually connected.
// ---------------------------------------------------------------------------
async function pushHeartbeat() {
  if (!cfg.uptimeKumaPushUrl || !waConnected) return
  const base = cfg.uptimeKumaPushUrl.split('?')[0]
  try {
    const res = await fetch(`${base}?status=up&msg=${encodeURIComponent('WhatsApp connected')}`)
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200)
      const hint = res.status === 404 ? '  [monitor paused/deleted, or wrong token?]' : ''
      logger.warn(`Uptime Kuma push rejected: HTTP ${res.status} at ${maskToken(base)} — ${body || '(no body)'}${hint}`)
      kumaLastOk = false
    } else {
      if (kumaLastOk === false) logger.info('Uptime Kuma push recovered — heartbeats flowing again.')
      else logger.debug('Uptime Kuma heartbeat sent.')
      kumaLastOk = true
    }
  } catch (e) {
    logger.warn(`Uptime Kuma push error at ${maskToken(base)}: ${e.message}`)
    kumaLastOk = false
  }
}

function requireSignalConfig() {
  const missing = []
  if (!cfg.signalNumber) missing.push('SIGNAL_NUMBER')
  if (!cfg.signalGroupId) missing.push('SIGNAL_GROUP_ID')
  if (missing.length) {
    logger.error(`Missing required env: ${missing.join(', ')} — cannot forward to Signal.`)
    return false
  }
  return true
}

// Effective label for a group: explicit WA_GROUPS label, else its WhatsApp name.
function labelFor(jid) {
  if (!cfg.showLabel) return ''
  return cfg.groups.get(jid) ?? subjectByJid[jid] ?? ''
}

// ---------------------------------------------------------------------------
// Text extraction (text-only mode: unwrap common containers, ignore media)
// ---------------------------------------------------------------------------
function extractText(message) {
  if (!message) return null
  if (message.ephemeralMessage) return extractText(message.ephemeralMessage.message)
  if (message.viewOnceMessage) return extractText(message.viewOnceMessage.message)
  if (message.viewOnceMessageV2) return extractText(message.viewOnceMessageV2.message)
  if (message.documentWithCaptionMessage) return extractText(message.documentWithCaptionMessage.message)
  if (message.conversation) return message.conversation
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text
  return null // media captions intentionally ignored in text-only mode
}

// ---------------------------------------------------------------------------
// Signal send
// ---------------------------------------------------------------------------
async function sendToSignal(text) {
  const res = await fetch(`${cfg.signalApiUrl}/v2/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: text,
      number: cfg.signalNumber,
      recipients: [cfg.signalGroupId],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Signal API ${res.status}: ${body}`)
  }
  return res.json().catch(() => ({}))
}

// ---------------------------------------------------------------------------
// Shared relay path: used by both live messages and reconnect catch-up.
// Returns true if a message was actually sent.
// ---------------------------------------------------------------------------
async function relayMessage(m, source) {
  const jid = m.key?.remoteJid
  if (!jid || !jid.endsWith('@g.us')) return false     // groups only
  if (!cfg.groups.has(jid)) return false               // only configured groups (other groups skipped silently)

  const id = m.key?.id
  const where = labelFor(jid) || jid
  if (m.key.fromMe && !cfg.relayFromMe) { logger.debug(`skip own message in ${where} (RELAY_FROM_ME=false)`); return false }
  if (id && relayedIds.has(id)) { logger.debug(`skip duplicate ${id} in ${where}`); return false }

  const text = extractText(m.message)
  if (!text || !text.trim()) { logger.debug(`skip non-text message ${id} in ${where}`); return false }

  const sender = m.key.fromMe
    ? cfg.selfName
    : (m.pushName || (m.key.participant || '').split('@')[0] || 'Unknown')

  const label = labelFor(jid)
  const prefix = label ? `[${label}] ` : ''
  const outgoing = `${prefix}${sender}: ${text}`

  if (!requireSignalConfig()) {
    logger.info(`[dry-run] ${outgoing}`)
    return false
  }

  await sendToSignal(outgoing)
  markRelayed(id, tsOf(m))
  logger.info(`Relayed${source === 'catchup' ? ' (catch-up)' : ''} ${label ? `[${label}] ` : ''}from ${sender} (${text.length} chars)`)
  return true
}

// ---------------------------------------------------------------------------
// WhatsApp connection
// ---------------------------------------------------------------------------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(cfg.authDir)
  const { version } = await fetchLatestBaileysVersion()
  logger.info(`Using WA web version ${version.join('.')}`)

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    markOnlineOnConnect: false, // stay invisible so your phone keeps getting notifications
    syncFullHistory: false,
  })

  sock.ev.on('creds.update', saveCreds)

  // Keep group names fresh for label fallback.
  sock.ev.on('groups.update', (updates) => {
    for (const u of updates) if (u.id && u.subject) subjectByJid[u.id] = u.subject
  })
  sock.ev.on('groups.upsert', (groups) => {
    for (const g of groups) if (g.id && g.subject) subjectByJid[g.id] = g.subject
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('\nScan this QR with WhatsApp on your phone:')
      console.log('  Settings → Linked Devices → Link a Device\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'connecting') {
      logger.debug('Connecting to WhatsApp…')
    }

    if (connection === 'open') {
      waConnected = true
      if (reconnectAttempts > 0) logger.info(`WhatsApp reconnected after ${reconnectAttempts} attempt(s).`)
      reconnectAttempts = 0
      pushHeartbeat() // report up immediately, don't wait for the interval
      logger.info('WhatsApp connection open.')
      if (!requireSignalConfig()) {
        logger.warn('Running in read-only debug mode until Signal config is provided.')
      }

      // Learn all group names this account is in.
      let allGroups = {}
      try {
        allGroups = await sock.groupFetchAllParticipating()
        for (const g of Object.values(allGroups)) subjectByJid[g.id] = g.subject
      } catch (e) {
        logger.error(`Could not list groups: ${e.message}`)
      }

      if (cfg.groups.size === 0) {
        logger.warn('No groups configured (WA_GROUPS is empty). Groups this account is in:')
        for (const g of Object.values(allGroups)) console.log(`  ${g.id}   ${g.subject}`)
        logger.warn('Set WA_GROUPS to the ids you want to mirror (JID or JID=Label, comma-separated), then restart.')
      } else {
        logger.info(`Mirroring ${cfg.groups.size} WhatsApp group(s) → Signal group ${cfg.signalGroupId}:`)
        for (const jid of cfg.groups.keys()) {
          const known = jid in subjectByJid
          logger.info(`  ${jid}  →  label "${labelFor(jid) || '(none)'}"${known ? '' : '   [!] not found among your groups — check the JID / membership'}`)
        }
      }
    }

    if (connection === 'close') {
      waConnected = false
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        logger.error('Logged out by WhatsApp — delete the auth dir (relay-auth/) and re-pair. Not reconnecting.')
        return
      }
      reconnectAttempts++
      const delayMs = Math.min(30000, 2000 * reconnectAttempts) // backoff, capped at 30s
      logger.warn(`WhatsApp disconnected (code=${code}, ${reasonName(code)}). Heartbeats paused. Reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts}).`)
      setTimeout(() => start().catch((e) => logger.error(`Reconnect failed: ${e.message}`)), delayMs)
    }
  })

  // Live messages (includes WhatsApp's offline queue drained on reconnect).
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return // history backfill is handled separately below
    logger.debug(`messages.upsert: ${messages.length} live message(s)`)
    for (const m of messages) {
      try {
        await relayMessage(m, 'live')
      } catch (e) {
        logger.error(`Failed to relay a message: ${e.message}`)
      }
    }
  })

  // Reconnect catch-up: WhatsApp pushes recent history on (re)connect. Backfill
  // anything in our groups that we missed during an outage — bounded by age,
  // count, and the dedup set so it can never re-send or flood old history.
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    if (!cfg.catchupOnReconnect || !messages?.length) return
    const cutoff = Math.max(lastRelayedTs, nowSec() - cfg.catchupMaxHours * 3600)

    const candidates = messages
      .filter((m) => {
        const jid = m.key?.remoteJid
        return jid && cfg.groups.has(jid) &&
          !(m.key?.id && relayedIds.has(m.key.id)) &&
          tsOf(m) > cutoff
      })
      .sort((a, b) => tsOf(a) - tsOf(b))
      .slice(-cfg.catchupMaxCount)

    if (!candidates.length) return
    logger.info(`Catch-up: found ${candidates.length} missed message(s) to backfill.`)
    let sent = 0
    for (const m of candidates) {
      try {
        if (await relayMessage(m, 'catchup')) { sent++; await sleep(300) } // gentle pacing
      } catch (e) {
        logger.error(`Catch-up relay failed: ${e.message}`)
      }
    }
    if (sent) logger.info(`Catch-up: backfilled ${sent} message(s).`)
  })
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadState()

logger.info(
  `Config: ${cfg.groups.size} group(s) → ${cfg.signalGroupId || '(no Signal group set)'} | ` +
  `relayFromMe=${cfg.relayFromMe} | selfName="${cfg.selfName}" | ` +
  `catchup=${cfg.catchupOnReconnect} | kuma=${cfg.uptimeKumaPushUrl ? 'on' : 'off'} | logLevel=${cfg.logLevel}`
)

if (cfg.uptimeKumaPushUrl) {
  logger.info(`Uptime Kuma heartbeat enabled (every ${cfg.uptimeKumaIntervalSec}s while WhatsApp is connected).`)
  setInterval(pushHeartbeat, cfg.uptimeKumaIntervalSec * 1000)
}

if (cfg.catchupOnReconnect) {
  logger.info(`Reconnect catch-up enabled (backfill gaps up to ${cfg.catchupMaxHours}h, max ${cfg.catchupMaxCount}/burst).`)
}

start().catch((e) => {
  logger.error(e)
  process.exit(1)
})