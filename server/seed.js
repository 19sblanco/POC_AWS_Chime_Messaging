/**
 * Seeds demo messages into the channels created by setup.js.
 *
 * Story: a nonprofit charity 5K ("Miles for Meals") three weeks out.
 * The conversation is written as a single morning burst of chatter, since
 * Chime stamps messages at send time and they cannot be backdated.
 *
 * The POC's admin credentials let us send as any user by passing that
 * user's ARN as ChimeBearer. Messages are sent sequentially because
 * channel ordering follows send order.
 *
 * Run with: npm run seed (after npm run setup)
 * Safe to re-run, but doing so will append the messages a second time.
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ChimeSDKMessagingClient,
  SendChannelMessageCommand,
} = require('@aws-sdk/client-chime-sdk-messaging');

const CONFIG_PATH = path.join(__dirname, '..', 'chime-config.json');

// Keep in step with REPLY_PREVIEW_LIMIT in client/src/app.js so seeded quotes
// truncate the same way the UI's own replies do.
const REPLY_PREVIEW_LIMIT = 120;

// Demo conversation, keyed by channel name. `sender` is a user id from
// setup.js. Order within each channel is the order messages will appear.
//
// `key` labels a message so a later one can point at it with `replyTo`. Chime has
// no threading, so a reply is an ordinary message whose metadata carries the
// parent's real MessageId (only known once the parent has been sent) plus a
// snapshot of its text for the quote the client renders.
const SEED_MESSAGES = {
  'Miles for Meals 5K': [
    { sender: 'alice', content: 'Morning team! Three weeks until the Miles for Meals 5K -- who is officially registered?' },
    { sender: 'bob', content: 'Me! Signed up last night and my fundraising page is LIVE' },
    { sender: 'charlie', content: 'Registered and already at 40% of my goal. Feeling unstoppable' },
    { key: 'david-nervous', sender: 'david', content: 'Just signed up. Fair warning: I have not run more than a mile since high school' },
    { replyTo: 'david-nervous', sender: 'bob', content: 'No stress David, I will pace the first mile with you. Easy start, strong finish' },
    { key: 'alice-meals', sender: 'alice', content: 'And remember: every $25 raised = 1 meal for a family in our community' },
    { replyTo: 'alice-meals', sender: 'charlie', content: 'Told my aunt that and she donated $50 on the spot. LEGEND' },
    { key: 'bob-total', sender: 'bob', content: 'Team total just hit $1,240 -- let us push for $2K before race day!' },
    { replyTo: 'bob-total', sender: 'david', content: 'Challenge accepted. Sharing my page with EVERYONE I know' },
  ],
  'Alice & David': [
    { sender: 'alice', content: 'Hey! Saw your message in the group -- first 5K nerves are totally normal' },
    { key: 'david-worry', sender: 'david', content: 'Thanks. I just do not want to slow everyone down' },
    { replyTo: 'david-worry', sender: 'alice', content: 'You will not. Bob has your first mile and I will stick nearby the rest of the way' },
    { sender: 'david', content: 'Okay, deal. But when I cross that finish line, coffee is on you' },
    { sender: 'alice', content: 'Done. You are going to crush it' },
  ],
};

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`${CONFIG_PATH} not found. Run npm run setup first.`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const messaging = new ChimeSDKMessagingClient({ region: config.region });

  for (const [channelName, messages] of Object.entries(SEED_MESSAGES)) {
    const channel = config.channels.find((c) => c.name === channelName);
    if (!channel) {
      console.error(`Channel "${channelName}" not found in chime-config.json. Skipping.`);
      continue;
    }

    console.log(`Seeding ${messages.length} messages into "${channelName}"...`);
    const sent = new Map(); // seed key -> { messageId, sender, preview }
    for (const message of messages) {
      const user = config.users[message.sender];

      let metadata;
      if (message.replyTo) {
        const parent = sent.get(message.replyTo);
        if (!parent) {
          throw new Error(
            `Seed message replies to "${message.replyTo}", which is not an earlier key in "${channelName}".`
          );
        }
        metadata = JSON.stringify({ replyTo: parent });
      }

      const response = await messaging.send(
        new SendChannelMessageCommand({
          ChannelArn: channel.arn,
          ChimeBearer: user.arn,
          Content: message.content,
          Type: 'STANDARD',
          Persistence: 'PERSISTENT',
          Metadata: metadata,
          ClientRequestToken: crypto.randomUUID(),
        })
      );

      if (message.key) {
        sent.set(message.key, {
          messageId: response.MessageId,
          sender: user.name,
          preview: message.content.slice(0, REPLY_PREVIEW_LIMIT),
        });
      }

      const prefix = message.replyTo ? '  ↳ ' : '  ';
      console.log(`${prefix}${user.name}: ${message.content.slice(0, 60)}...`);
    }
  }

  console.log('\nDone. Open http://localhost:3000 to see the demo conversation.');
}

main().catch((err) => {
  console.error('\nSeeding failed:', err);
  process.exit(1);
});
