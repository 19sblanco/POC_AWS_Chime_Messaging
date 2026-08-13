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
- Slack-style threads: replies live in a side panel instead of the channel
  timeline, and the message they hang off shows a "3 replies" link. Threading is
  not built into Chime, so this is layered on top of the message `Metadata` field

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
                      message Metadata carries the thread pointer (see Findings)
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
- Hover any message and hit **Reply** — a thread panel opens on the right. The
  reply does not join the channel timeline; instead a "1 reply" link appears
  under the original message in every tab. Click it to open the thread.
- Reply to a reply — threads are flat, so it lands in the same thread rather
  than nesting a level deeper.
- Reply to something, then **Edit** the reply — it stays in its thread.
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
- **Threads are not a built in Chime feature**. A channel is a flat list of
  messages. I implimented threading by storing the thread root's message id in
  the metadata of every reply, plus a snapshot of the root's sender and first
  120 characters. This way the client can read the message data and group the
  conversation however it wants — here, replies are pulled out of the channel
  timeline and into a side panel, Slack style. Threads are deliberately flat
  (a reply to a reply resolves up to the same root), because the pointer names
  a root rather than a parent. Its worth noting that the meta data of a message
  can contain 1KB of data, which is what caps the size of that root snapshot.
- **Redaction erases the thread pointer.** `RedactChannelMessage` clears
  metadata along with content, so a deleted reply comes back from history with
  no idea which thread it belonged to and shows up in the channel timeline as a
  stray "This message was deleted" row. The live UI does not show this because
  the redact event only flags the message and the client keeps the pointer it
  already had; reload and it moves. Keeping deleted replies in their thread
  would require storing the thread pointer somewhere other than Chime.
- **Reply counts are only as accurate as the loaded history.** The "3 replies"
  count is computed client-side from the messages currently loaded (newest 50).
  Chime cannot filter or count messages by metadata, so there is no way to ask
  it how many replies a message has; an accurate count needs a database.
- **Likes/hearts need a database** - This is because likes are not built into chime
and given that we expect upto several thousand users in a group and any number
of them could reply and/or heart a post, in order to manage that scale the only
appropriate workaround is to use a database.
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
