/**
 * One-time setup script for the Chime Messaging POC.
 *
 * Creates (in your AWS account):
 *   - 1 AppInstance
 *   - 4 AppInstanceUsers: alice, bob, charlie, david
 *   - 2 Channels:
 *       "Everyone"    -> alice, bob, charlie, david
 *       "Small Group" -> alice, bob, charlie
 *
 * Writes all resulting ARNs to chime-config.json (read by server.js).
 *
 * Run with: npm run setup
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ChimeSDKIdentityClient,
  CreateAppInstanceCommand,
  CreateAppInstanceUserCommand,
} = require('@aws-sdk/client-chime-sdk-identity');
const {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
} = require('@aws-sdk/client-chime-sdk-messaging');

const REGION = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_NAME = 'poc-chime-messaging';
const CONFIG_PATH = path.join(__dirname, '..', 'chime-config.json');

// Hardcoded users for the POC.
const USERS = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
  { id: 'charlie', name: 'Charlie' },
  { id: 'david', name: 'David' },
];

// Hardcoded groups for the POC. The first listed member creates the channel.
const CHANNELS = [
  { name: 'Everyone', members: ['alice', 'bob', 'charlie', 'david'] },
  { name: 'Small Group', members: ['alice', 'bob', 'charlie'] },
];

async function main() {
  if (fs.existsSync(CONFIG_PATH)) {
    console.error(
      `${CONFIG_PATH} already exists.\n` +
        'Setup has already been run. To start over, delete the AppInstance in the\n' +
        'AWS console (Chime SDK -> AppInstances) or with the CLI\n' +
        '(aws chime-sdk-identity delete-app-instance --app-instance-arn <arn>),\n' +
        'then delete chime-config.json and re-run npm run setup.'
    );
    process.exit(1);
  }

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('Missing AWS credentials. Copy .env.example to .env and fill in your keys.');
    process.exit(1);
  }

  const identity = new ChimeSDKIdentityClient({ region: REGION });
  const messaging = new ChimeSDKMessagingClient({ region: REGION });

  // 1. AppInstance -------------------------------------------------------
  console.log(`Creating AppInstance "${APP_INSTANCE_NAME}" in ${REGION}...`);
  const { AppInstanceArn } = await identity.send(
    new CreateAppInstanceCommand({
      Name: APP_INSTANCE_NAME,
      ClientRequestToken: crypto.randomUUID(),
    })
  );
  console.log(`  -> ${AppInstanceArn}`);

  // 2. Users -------------------------------------------------------------
  const users = {};
  for (const user of USERS) {
    console.log(`Creating AppInstanceUser "${user.id}"...`);
    const { AppInstanceUserArn } = await identity.send(
      new CreateAppInstanceUserCommand({
        AppInstanceArn,
        AppInstanceUserId: user.id,
        Name: user.name,
        ClientRequestToken: crypto.randomUUID(),
      })
    );
    users[user.id] = { name: user.name, arn: AppInstanceUserArn };
    console.log(`  -> ${AppInstanceUserArn}`);
  }

  // 3. Channels + memberships ---------------------------------------------
  const channels = [];
  for (const channel of CHANNELS) {
    const [creatorId, ...otherMemberIds] = channel.members;
    const creatorArn = users[creatorId].arn;

    console.log(`Creating channel "${channel.name}" (created by ${creatorId})...`);
    const { ChannelArn } = await messaging.send(
      new CreateChannelCommand({
        AppInstanceArn,
        Name: channel.name,
        Mode: 'UNRESTRICTED',
        Privacy: 'PRIVATE',
        ClientRequestToken: crypto.randomUUID(),
        ChimeBearer: creatorArn, // creator automatically becomes a member
      })
    );
    console.log(`  -> ${ChannelArn}`);

    for (const memberId of otherMemberIds) {
      console.log(`  Adding ${memberId} to "${channel.name}"...`);
      await messaging.send(
        new CreateChannelMembershipCommand({
          ChannelArn,
          MemberArn: users[memberId].arn,
          Type: 'DEFAULT',
          ChimeBearer: creatorArn,
        })
      );
    }

    channels.push({ name: channel.name, arn: ChannelArn, members: channel.members });
  }

  // 4. Save config ---------------------------------------------------------
  const config = { region: REGION, appInstanceArn: AppInstanceArn, users, channels };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`\nDone. Wrote ${CONFIG_PATH}`);
  console.log('Next: npm run build && npm start, then open http://localhost:3000');
}

main().catch((err) => {
  console.error('\nSetup failed:', err);
  console.error(
    '\nNote: this script is not idempotent. If it failed partway through, delete the\n' +
      'AppInstance in the AWS console (deleting it cascades to users and channels)\n' +
      'and re-run npm run setup.'
  );
  process.exit(1);
});
