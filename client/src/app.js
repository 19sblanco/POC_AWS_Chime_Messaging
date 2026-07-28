/**
 * Browser client for the Chime Messaging POC.
 *
 * Flow:
 *   1. Fetch the hardcoded user list from the local server; user picks one.
 *   2. Fetch /api/config?user=<id> -> user ARN, channel ARNs, AWS credentials.
 *   3. Talk to Chime directly from the browser:
 *      - realtime receive: amazon-chime-sdk-js messaging session (WebSocket)
 *      - history:          ListChannelMessages
 *      - send:             SendChannelMessage
 *
 * Bundled to client/app.js by esbuild (npm run build).
 */
import {
  ChimeSDKMessagingClient,
  ListChannelMessagesCommand,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  ConsoleLogger,
  DefaultMessagingSession,
  LogLevel,
  MessagingSessionConfiguration,
} from 'amazon-chime-sdk-js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let config = null; // /api/config response for the chosen user
let chime = null; // ChimeSDKMessagingClient
let session = null; // realtime messaging session
let activeChannelArn = null;
const messagesByChannel = new Map(); // channelArn -> [{ id, sender, content, timestamp, mine }]

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);

function renderMessages() {
  const container = el('messages');
  container.innerHTML = '';
  const messages = messagesByChannel.get(activeChannelArn) || [];
  for (const msg of messages) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg' + (msg.mine ? ' mine' : '');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
    meta.textContent = `${msg.sender} ${time}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.content;

    wrapper.appendChild(meta);
    wrapper.appendChild(bubble);
    container.appendChild(wrapper);
  }
  container.scrollTop = container.scrollHeight;
}

function setStatus(text) {
  el('status').textContent = text;
}

function addMessage(channelArn, message) {
  if (!messagesByChannel.has(channelArn)) {
    messagesByChannel.set(channelArn, []);
  }
  const list = messagesByChannel.get(channelArn);
  // Dedupe (history load + websocket echo can overlap).
  if (message.id && list.some((m) => m.id === message.id)) return;
  list.push(message);
  if (channelArn === activeChannelArn) renderMessages();
}

// ---------------------------------------------------------------------------
// Chime: history + send
// ---------------------------------------------------------------------------
async function loadHistory(channelArn) {
  const response = await chime.send(
    new ListChannelMessagesCommand({
      ChannelArn: channelArn,
      ChimeBearer: config.userArn,
      MaxResults: 50, // newest 50, returned newest-first
    })
  );
  // Reverse to oldest-first for display.
  for (const m of (response.ChannelMessages || []).reverse()) {
    addMessage(channelArn, {
      id: m.MessageId,
      sender: (m.Sender && m.Sender.Name) || 'unknown',
      content: m.Content,
      timestamp: m.CreatedTimestamp,
      mine: m.Sender && m.Sender.Arn === config.userArn,
    });
  }
}

async function sendMessage(content) {
  await chime.send(
    new SendChannelMessageCommand({
      ChannelArn: activeChannelArn,
      ChimeBearer: config.userArn,
      Content: content,
      Type: 'STANDARD',
      Persistence: 'PERSISTENT',
      ClientRequestToken: crypto.randomUUID(),
    })
  );
  // No optimistic append: the websocket echoes our own message back to us,
  // which is also a nice proof that the realtime path works.
}

// ---------------------------------------------------------------------------
// Chime: realtime session (WebSocket)
// ---------------------------------------------------------------------------
function connectSession() {
  const configuration = new MessagingSessionConfiguration(
    config.userArn,
    null, // session id (auto-generated)
    undefined, // endpoint (fetched automatically via GetMessagingSessionEndpoint)
    chime
  );
  const logger = new ConsoleLogger('ChimePOC', LogLevel.WARN);
  session = new DefaultMessagingSession(configuration, logger);

  session.addObserver({
    messagingSessionDidStart: () => setStatus('connected'),
    messagingSessionDidStartConnecting: (reconnecting) =>
      setStatus(reconnecting ? 'reconnecting...' : 'connecting...'),
    messagingSessionDidStop: (event) => setStatus(`disconnected (${event.code})`),
    messagingSessionDidReceiveMessage: (message) => {
      // The session receives events for every channel this user belongs to.
      if (message.type !== 'CREATE_CHANNEL_MESSAGE') return;
      const payload = JSON.parse(message.payload);
      addMessage(payload.ChannelArn, {
        id: payload.MessageId,
        sender: (payload.Sender && payload.Sender.Name) || 'unknown',
        content: payload.Content,
        timestamp: payload.CreatedTimestamp,
        mine: payload.Sender && payload.Sender.Arn === config.userArn,
      });
    },
  });

  return session.start();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function selectChannel(channel) {
  activeChannelArn = channel.arn;
  el('channel-name').textContent = channel.name;
  document.querySelectorAll('.channel-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.arn === channel.arn);
  });
  renderMessages();
  el('message-input').focus();
}

async function loginAs(userId) {
  const response = await fetch(`/api/config?user=${encodeURIComponent(userId)}`);
  config = await response.json();

  chime = new ChimeSDKMessagingClient({
    region: config.region,
    credentials: config.credentials, // POC only: vended by the local server
  });

  // Build the channel sidebar (only channels this user is a member of).
  el('me-name').textContent = config.userName;
  const channelList = el('channel-list');
  channelList.innerHTML = '';
  for (const channel of config.channels) {
    const btn = document.createElement('button');
    btn.className = 'channel-btn';
    btn.dataset.arn = channel.arn;
    btn.textContent = '# ' + channel.name;
    btn.addEventListener('click', () => selectChannel(channel));
    channelList.appendChild(btn);
  }

  el('login-screen').style.display = 'none';
  el('chat-screen').classList.add('active');
  document.title = `${config.userName} - Chime POC`;

  setStatus('connecting...');
  await connectSession();
  await Promise.all(config.channels.map((c) => loadHistory(c.arn)));
  selectChannel(config.channels[0]);
}

async function init() {
  // Login screen: one button per hardcoded user.
  const users = await (await fetch('/api/users')).json();
  const userList = el('user-list');
  for (const user of users) {
    const btn = document.createElement('button');
    btn.className = 'user-btn';
    btn.textContent = user.name;
    btn.addEventListener('click', () => {
      loginAs(user.id).catch((err) => {
        console.error(err);
        alert('Failed to connect: ' + err.message);
      });
    });
    userList.appendChild(btn);
  }

  // Composer.
  el('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el('message-input');
    const content = input.value.trim();
    if (!content || !activeChannelArn) return;
    input.value = '';
    sendMessage(content).catch((err) => {
      console.error(err);
      alert('Failed to send: ' + err.message);
    });
  });
}

init();
