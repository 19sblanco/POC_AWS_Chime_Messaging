/**
 * Local POC server.
 *
 * Responsibilities (kept intentionally tiny):
 *   1. Serve the static client from client/.
 *   2. GET /api/config?user=<id> -> the ARNs + AWS credentials the browser
 *      needs to talk to Chime directly.
 *
 * POC NOTE: this hands the raw .env AWS keys to the browser so the client can
 * sign the Chime messaging WebSocket and API calls. That is fine for a local
 * proof of concept but must never ship to production -- a real app would vend
 * short-lived, per-user scoped credentials (e.g. via STS or Cognito).
 *
 * Run with: npm start
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PORT_ATTEMPTS = 10;
const CONFIG_PATH = path.join(__dirname, '..', 'chime-config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('chime-config.json not found. Run `npm run setup` first.');
  process.exit(1);
}
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('Missing AWS credentials. Copy .env.example to .env and fill in your keys.');
  process.exit(1);
}

const chimeConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));

// List of hardcoded users, for the login screen.
app.get('/api/users', (req, res) => {
  res.json(
    Object.entries(chimeConfig.users).map(([id, u]) => ({ id, name: u.name }))
  );
});

// Everything the browser needs to act as the given user.
app.get('/api/config', (req, res) => {
  const userId = req.query.user;
  const user = chimeConfig.users[userId];
  if (!user) {
    return res.status(404).json({ error: `Unknown user "${userId}"` });
  }

  res.json({
    region: chimeConfig.region,
    userId,
    userName: user.name,
    userArn: user.arn,
    // Only the channels this user is a member of.
    channels: chimeConfig.channels
      .filter((c) => c.members.includes(userId))
      .map((c) => ({
        name: c.name,
        arn: c.arn,
        isModerator: (c.moderators || []).includes(userId),
      })),
    // POC only: raw account credentials handed to the browser (see note above).
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
});

// Running two copies of the POC side by side (say, to compare branches) is
// useful, so take the next free port instead of failing when one is taken. The
// client only ever uses relative URLs, so it does not care which port it is on.
function listen(port, attemptsLeft) {
  const server = app.listen(port, () => {
    console.log(`Chime messaging POC running at http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    if (attemptsLeft === 0) {
      console.error(`Ports ${PORT}-${port} are all in use. Set PORT to pick another.`);
      process.exit(1);
    }
    console.log(`Port ${port} is in use, trying ${port + 1}...`);
    listen(port + 1, attemptsLeft - 1);
  });
}

listen(PORT, MAX_PORT_ATTEMPTS);
