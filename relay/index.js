import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from 'baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'

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
}

const logger = pino({ level: cfg.logLevel })
const subjectByJid = {}   // jid -> WhatsApp group name, learned at runtime

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

    if (connection === 'open') {
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
      const code = lastDisconnect?.error?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut
      logger.warn(`Connection closed (code=${code}). ${loggedOut ? 'Logged out — delete auth dir and re-pair.' : 'Reconnecting…'}`)
      if (!loggedOut) start().catch((e) => logger.error(e))
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return // only live messages, not history backfill
    for (const m of messages) {
      try {
        const jid = m.key?.remoteJid
        if (!jid || !jid.endsWith('@g.us')) continue     // groups only
        if (!cfg.groups.has(jid)) continue               // only configured groups
        if (m.key.fromMe && !cfg.relayFromMe) continue

        const text = extractText(m.message)
        if (!text || !text.trim()) continue              // text-only: skip media/other

        const sender = m.key.fromMe
          ? cfg.selfName
          : (m.pushName || (m.key.participant || '').split('@')[0] || 'Unknown')

        const label = labelFor(jid)
        const prefix = label ? `[${label}] ` : ''
        const outgoing = `${prefix}${sender}: ${text}`

        if (!requireSignalConfig()) {
          logger.info(`[dry-run] ${outgoing}`)
          continue
        }

        await sendToSignal(outgoing)
        logger.info(`Relayed ${label ? `[${label}] ` : ''}from ${sender} (${text.length} chars)`)
      } catch (e) {
        logger.error(`Failed to relay a message: ${e.message}`)
      }
    }
  })
}

start().catch((e) => {
  logger.error(e)
  process.exit(1)
})
