# WhatsApp → Signal one-way relay

Mirrors **text** messages from one or more WhatsApp groups into a **single** Signal group.
One-way only: nothing is ever sent back to WhatsApp.

- **WhatsApp side:** a Baileys client links as a companion device to your WhatsApp
  (same mechanism as WhatsApp Web) and listens to the groups you configure. Each mirrored
  message is tagged with a per-group label (e.g. `[Admins]`, `[Chat]`) so the merged
  Signal feed stays readable.
- **Signal side:** messages are posted into the Signal group via `signal-cli-rest-api`,
  linked as a secondary device to **your own** Signal number. Mirrored messages therefore
  appear in Signal as coming from you: `[Tiedoitus] Alice: see you at the range`.

```
WhatsApp "Admins" ─┐
                   ├─(Baileys, read-only)─▶ relay ─HTTP─▶ signal-cli-rest-api ─▶ Signal group
WhatsApp "Chat" ───┘
```

Your linked WhatsApp account must be a member of every group you mirror (it already is, if
they're your club's groups).

## Layout

```
docker-compose.yml      the two services
.env.example            copy to .env and fill in
relay/                  the Baileys relay (index.js, Dockerfile)
signal-cli-config/      created at runtime — Signal account state (keep private, back up)
relay-auth/             created at runtime — WhatsApp link state (keep private, back up)
```

## Setup

Everything below assumes you run the commands from the project directory on your DietPi host.

### 1. Link Signal to your own number

```bash
cp .env.example .env          # fill in SIGNAL_NUMBER at least
docker compose up -d signal-cli-rest-api
```

Open this in a browser (replace host/port if needed) to get a linking QR:

```
http://127.0.0.1:8080/v1/qrcodelink?device_name=wa-relay
```

On your phone: **Signal → Settings → Linked Devices → Link New Device**, scan the QR.
This adds the API as a *secondary* device on your number — it does not take over your phone.
Give it a minute to sync.

### 2. Find the Signal group id

```bash
curl http://127.0.0.1:8080/v1/groups/$SIGNAL_NUMBER
```

Copy the `"id"` of your target group — the full `group.XXXX…` string, **with** the
`group.` prefix — into `SIGNAL_GROUP_ID` in `.env`.

> If the list is empty, send a message in that Signal group from your phone, wait, and
> re-run — a freshly linked device only learns about a group after it syncs activity.

### 3. Pair WhatsApp and find the group JIDs

Leave `WA_GROUPS` blank for now, then:

```bash
docker compose up -d --build wa-signal-relay
docker compose logs -f wa-signal-relay
```

A QR appears in the logs. On your phone: **WhatsApp → Settings → Linked Devices →
Link a Device**, scan it. Once connected, the logs print every group this account is in:

```
  120363012345678901@g.us   PRS Admins / Info
  120363099999999999@g.us   PRS Range Chat
  120363011111111111@g.us   Family
```

Copy the JIDs of the two groups you want and set `WA_GROUPS` in `.env`, giving each a short
label:

```
WA_GROUPS=120363012345678901@g.us=Tiedoitus,120363099999999999@g.us=Yleinen
```

(Omit `=Label` for any group and its WhatsApp name is used instead. Set
`SHOW_GROUP_LABEL=false` to drop the prefixes entirely.)

### 4. Go live

```bash
docker compose up -d wa-signal-relay
docker compose logs -f wa-signal-relay
```

Send a test message in either WhatsApp group; it should land in the Signal group within a
second, tagged with that group's label and the sender's name.

## Notes and gotchas

- **Multiple groups, one feed.** List as many WhatsApp groups as you like in `WA_GROUPS`;
  all of them mirror into the single `SIGNAL_GROUP_ID`. The `[Label]` prefix is how you
  tell them apart in Signal — keep it on when mirroring 2+ groups. Direction is still
  one-way per group: a Signal reply goes nowhere near WhatsApp.
- **Text only.** Images, files, stickers, voice notes, and reactions are ignored. Media
  captions are dropped too. (Say the word and I'll add attachment forwarding — the Signal
  API takes base64 attachments, so it's a modest extension.)
- **Your own messages** are mirrored by default (`RELAY_FROM_ME=true`) and show as
  `Me: …`. Set it to `false` if you don't want your WhatsApp posts echoed into Signal.
- **Ban risk.** This uses an unofficial WhatsApp client. Reading is lower-risk than
  sending, but if you'd rather isolate the risk, link the relay to a throwaway WhatsApp
  number that's a member of the group instead of your main account. Re-pairing then only
  needs a change of which phone scans the QR.
- **Re-pairing.** A linked device drops if the phone stays offline ~14 days, or if you
  unlink it. The relay auto-reconnects on transient drops; on a full logout, delete
  `relay-auth/` and repeat step 3.
- **Persistence.** `signal-cli-config/` and `relay-auth/` hold your account sessions.
  Back them up (privately) and they survive container rebuilds — no re-linking needed.
- **Baileys version.** Pinned to `7.0.0-rc13` (the 7.x line — no final 7.0.0 tag exists
  yet). Starting on 7 avoids the 6→7 auth/libsignal migration later. To move to a newer
  RC or the eventual stable, bump the version in `relay/package.json` and
  `docker compose up -d --build wa-signal-relay`.
- **Consent.** Everyone in both groups should know the WhatsApp group is mirrored into
  Signal, since it changes who can read their messages.

## Update

```bash
docker compose pull signal-cli-rest-api
docker compose up -d --build
```
