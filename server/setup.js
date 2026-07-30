/**
 * One-time setup script for the Chime Messaging POC.
 *
 * Creates (in your AWS account):
 *   - 1 AppInstance
 *   - 4 AppInstanceUsers: alice, bob, charlie, david
 *   - Alice as AppInstanceAdmin (needed to bootstrap the first channel moderator;
 *     also enables hard DeleteChannelMessage via CLI/backend — not wired in UI)
 *   - 2 Channels:
 *       "Miles for Meals 5K" -> alice (moderator), bob, charlie, david (team channel);
 *       "Alice & David"      -> alice, david (a 1:1 DM; a DM is just a
 *                               2-member channel in Chime; members only)
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
  CreateAppInstanceAdminCommand,
  CreateAppInstanceCommand,
  CreateAppInstanceUserCommand,
} = require('@aws-sdk/client-chime-sdk-identity');
const {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  CreateChannelModeratorCommand,
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
// moderators are promoted via CreateChannelModerator after memberships.
const CHANNELS = [
  {
    name: 'Miles for Meals 5K',
    members: ['alice', 'bob', 'charlie', 'david'],
    moderators: ['alice'],
  },
  { name: 'Alice & David', members: ['alice', 'david'] },
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

  // 3. AppInstanceAdmin (Alice) ------------------------------------------
  // Required to create the first ChannelModerator on a new channel.
  console.log('Promoting alice to AppInstanceAdmin...');
  await identity.send(
    new CreateAppInstanceAdminCommand({
      AppInstanceArn,
      AppInstanceAdminArn: users.alice.arn,
    })
  );
  console.log(`  -> ${users.alice.arn}`);

  // 4. Channels + memberships + moderators -------------------------------
  const channels = [];
  for (const channel of CHANNELS) {
    const [creatorId, ...otherMemberIds] = channel.members;
    const creatorArn = users[creatorId].arn;
    const moderators = channel.moderators || [];

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

    for (const moderatorId of moderators) {
      console.log(`  Promoting ${moderatorId} to ChannelModerator on "${channel.name}"...`);
      await messaging.send(
        new CreateChannelModeratorCommand({
          ChannelArn,
          ChannelModeratorArn: users[moderatorId].arn,
          ChimeBearer: users.alice.arn, // AppInstanceAdmin bootstraps the first moderator
        })
      );
    }

    channels.push({
      name: channel.name,
      arn: ChannelArn,
      members: channel.members,
      moderators,
    });
  }

  // 5. Save config ---------------------------------------------------------
  const config = { region: REGION, appInstanceArn: AppInstanceArn, users, channels };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`\nDone. Wrote ${CONFIG_PATH}`);
  console.log('Next: npm run seed (optional demo messages), then npm run build && npm start,');
  console.log('then open http://localhost:3000');
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
