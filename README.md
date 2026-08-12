# Chime Messaging POC

Proof of concept for a **text-only group chat** built on the
[Amazon Chime SDK Messaging](https://docs.aws.amazon.com/chime-sdk/latest/dg/using-the-messaging-sdk.html)
service. Runs entirely locally.

## What it demonstrates

- 4 hardcoded users: **Alice, Bob, Charlie, David**
- 2 channels, themed as a nonprofit charity 5K fundraiser:
  - **Miles for Meals 5K** — the team channel, all 4 users. **Alice is a
    channel moderator** and can redact other members' messages.
  - **Alice & David** — a 1:1 DM (in Chime a DM is just a 2-member channel).
    Bob and Charlie are not members and never see these messages, proving
    Chime enforces membership server-side. 
- Seeding demo messages (`npm run seed`) by sending as each user via
  `ChimeBearer`
- Sending messages, loading message history, and receiving messages in real
  time over Chime's WebSocket
- Editing and redaction, with both changes fanned out to other
  users live — members redact their own; Alice (moderator) can also redact
  others on Miles for Meals 5K
- Replying to a specific earlier message, quoted Slack-style. Chime has no
  threading, so this is layered on top of the message `Metadata` field

## How it works

```
setup.js (run once) ──creates──> AWS Chime: AppInstance, 4 AppInstanceUsers,
    │                            Alice as AppInstanceAdmin + ChannelModerator
    │                            on Miles for Meals 5K, 2 Channels + memberships
    └──writes──> chime-config.json (ARNs)

server.js (Express, :3000)
    ├── serves client/ statically
    └── GET /api/config?user=alice ──> user ARN, channel ARNs, AWS credentials

browser (plain HTML/JS, no framework)
    ├── WebSocket to Chime (amazon-chime-sdk-js) ── receive messages realtime
    └── AWS SDK v3 ── SendChannelMessage / ListChannelMessages (send + history)
                      UpdateChannelMessage / RedactChannelMessage (edit + delete)
                      message Metadata carries the reply pointer (see Findings)
```

The browser talks to Chime **directly**; the local server only serves the page
and hands out configuration + credentials.

> **POC shortcut — not for production:** the server hands the raw AWS keys from
> `.env` to the browser so it can sign Chime API calls and the WebSocket
> connection. Any real implementation would vend short-lived, per-user scoped
> credentials instead (STS `AssumeRole` with a policy scoped to the user's
> `AppInstanceUser` ARN is the usual non-Cognito approach).

## Prerequisites

- Node.js 18+
- An AWS access key ID + secret access key with Chime SDK permissions.
- Region: `us-east-1`

## Running it

```bash
# 1. Install dependencies
npm install

# 2. Add your AWS keys
cp .env.example .env   # then edit .env

# 3. Create the Chime resources (one time; writes chime-config.json)
npm run setup

# 4. Seed the demo conversation (optional; re-running appends duplicates)
npm run seed

# 5. Bundle the browser client (writes client/app.js)
npm run build

# 6. Start the local server
npm start
```

Open http://localhost:3000 in **two or more tabs**, pick a different user in
each, and chat. Things to try:

- Send messages back and forth between tabs — they appear in real time.
- Reload a tab — history loads via `ListChannelMessages`.
- Hover any message and hit **Reply** — the composer shows a "Replying to..."
  bar, and the sent message appears under a quote of its parent in every tab.
  Click a quote to jump to the original and flash it.
- Reply to something, then **Edit** the reply — the quote stays attached.
- Hover one of your own messages and hit **Edit** — the new text (plus an
  `(edited)` marker) shows up in the other tabs immediately.
- Hover one of your own messages and hit **Delete** — it turns into a
  "This message was deleted" placeholder everywhere. Reload to confirm the
  placeholder survives: the message still exists in Chime, only redacted.
- As **Alice** on *Miles for Meals 5K*, hover someone else's message and hit
  **Delete** — Alice is a channel moderator, so she can redact others. As
  **Bob**, you will not see Delete on other people's messages.
- Log in as **Bob** or **Charlie** — they only see the *Miles for Meals 5K*
  channel and receive nothing from the *Alice & David* DM.

## Cleanup

Deleting the AppInstance cascades to all users and channels:

```bash
aws chime-sdk-identity delete-app-instance \
  --app-instance-arn "$(node -p "require('./chime-config.json').appInstanceArn")" \
  --region us-east-1
rm chime-config.json
```

(`npm run setup` refuses to run while `chime-config.json` exists, so clean up
first if you want to recreate everything.)

## Findings relevant to the long-term project

- The Client talks directly to the Chime app instance in AWS. 
  Chime websocket, message sending, and message history fetch are implemented
  on the client side, not the server side.
- Channel membership is enforced by the service, not by the client.
- There are **two** ways to remove a message, and the difference matters:
  - `RedactChannelMessage` — soft delete. The message row stays, content and
    metadata are cleared, and it comes back flagged `Redacted: true`. Members
    can redact their own messages; **channel moderators** can redact anyone's
    in that channel. This is what the UI's "Delete" button calls.
  - `DeleteChannelMessage` — a real hard delete; the message disappears from
    history. **Only an `AppInstanceAdmin` can call it.** Not wired in this UI.
- **Replies are not a built in Chime feature**. I implimented replies by storing 
the parent message's id in the meta data of the reply message. This way the client
can simply view the message data and render replies how it wants. This approach
also allows for reply threads if wanted. Its worth noting that the meta data of 
a message can contain 1KB of data.

- **Replies and reactions are not Chime features.** There is no threading API and
  no reactions API; `SendChannelMessage` has no parent-message field. What Chime
  gives you is `Metadata`, an arbitrary string of up to 1KB on every `STANDARD`
  message, returned by `ListChannelMessages` and included in the WebSocket
  payload — so custom data fans out in realtime for free and only the client has
  to interpret it. (`MessageAttributes` looks similar but is only used for push
  notification filter rules, and `Target` restricts a message's *visibility* to
  one member rather than marking it as a reply.)
  - **Replies** (implemented) store `{ replyTo: { messageId, sender, preview } }`
    in the reply's own metadata. The quoted text is copied in rather than looked
    up, because `ListChannelMessages` only loads the newest 50 messages and the
    parent is often not among them. The tradeoff is that the quote is a snapshot:
    if the parent is later edited, the quote keeps the older text.
  - **Likes** (researched, not implemented) cannot store a who-liked-what map on
    the target message: `UpdateChannelMessage` is restricted to the message's
    original sender, and that restriction also applies to channel moderators and
    AppInstanceAdmins, so no privileged backend user can write to someone else's
    message. A like therefore has to be its own message whose metadata points at
    the target, which the client filters out of the timeline and folds into a
    count. Two consequences: un-liking should `UpdateChannelMessage` your own
    reaction message to mark it removed rather than redact it (redaction clears
    metadata, leaving a tombstone the client can no longer recognise), and
    reaction messages share history with real ones, so the `MaxResults: 50`
    history load has to paginate to still get 50 real messages.
- Because `UpdateChannelMessage` replaces metadata with whatever it is given,
  every edit has to resend the existing metadata or it silently strips whatever
  the app stored there.
- Roles (Chime auth-by-role):
  - **Member** — view history, send, edit/redact own messages in channels they
    belong to.
  - **Channel moderator** (per channel) — everything a member can do, plus
    redact others' messages and manage channel membership (add/remove members,
    promote/demote moderators, ban/unban). This POC only exercises redact-others.
  - **AppInstanceAdmin** (AppInstance-wide) — all moderator powers across
    channels plus hard `DeleteChannelMessage`. Created via
    `CreateAppInstanceAdmin` with IAM credentials (setup script / CLI), not a
    chat UI role. Admins typically operate from backend tooling with
    `ChimeBearer` set to the admin user ARN. This POC promotes Alice to
    AppInstanceAdmin so setup can bootstrap the first `ChannelModerator` (a
    brand-new channel has no moderators otherwise); hard delete remains CLI-only.
