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
 *      - edit:             UpdateChannelMessage (own messages only)
 *      - delete:           RedactChannelMessage (own messages; channel
 *                          moderators can also redact others')
 *
 * Chime also has DeleteChannelMessage for a true hard delete, but it requires an
 * AppInstanceAdmin and is not wired in this UI. Redaction is the soft delete:
 * the message row survives, its content is cleared, and it comes back from the
 * API flagged as redacted.
 *
 * Replies are not a Chime feature. Chime has no threading, so a reply is an
 * ordinary message carrying a pointer to its parent in the 1KB `Metadata` field
 * that every STANDARD message has. Chime returns metadata from
 * ListChannelMessages and includes it in the WebSocket payload, so replies fan
 * out in realtime like any other message; only this client interprets them.
 *
 * Bundled to client/app.js by esbuild (npm run build).
 */
import {
  ChimeSDKMessagingClient,
  ListChannelMessagesCommand,
  RedactChannelMessageCommand,
  SendChannelMessageCommand,
  UpdateChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  ConsoleLogger,
  DefaultMessagingSession,
  LogLevel,
  MessagingSessionConfiguration,
} from 'amazon-chime-sdk-js';

// Quoted parent text is copied into the reply's metadata, so it has to stay
// well inside Chime's 1KB metadata cap alongside the parent's id and sender.
const REPLY_PREVIEW_LIMIT = 120;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let config = null; // /api/config response for the chosen user
let chime = null; // ChimeSDKMessagingClient
let session = null; // realtime messaging session
let activeChannelArn = null;
let editing = null; // { messageId, draft } while an edit is in progress
let replyingTo = null; // { messageId, sender, preview } while composing a reply
// channelArn ->
//   [{ id, sender, content, timestamp, mine, redacted, edited, metadata, replyTo }]
const messagesByChannel = new Map();

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);

function isModeratorForActiveChannel() {
  const channel = (config.channels || []).find((c) => c.arn === activeChannelArn);
  return !!(channel && channel.isModerator);
}

function buildActions(msg, { canReply, canEdit, canDelete }) {
  const actions = document.createElement('div');
  actions.className = 'actions';

  if (canReply) {
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.textContent = 'Reply';
    reply.addEventListener('click', () => startReply(msg));
    actions.appendChild(reply);
  }

  if (canEdit) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => startEdit(msg));
    actions.appendChild(edit);
  }

  if (canDelete) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => {
      if (!window.confirm('Delete this message?')) return;
      redactMessage(activeChannelArn, msg.id).catch((err) => {
        console.error(err);
        alert('Failed to delete: ' + err.message);
      });
    });
    actions.appendChild(remove);
  }

  return actions;
}

function buildEditor(msg) {
  const form = document.createElement('form');
  form.className = 'edit-form';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'edit-input';
  input.autocomplete = 'off';
  input.value = editing.draft;
  // Kept in state so an incoming message re-render does not wipe the draft.
  input.addEventListener('input', () => {
    editing.draft = input.value;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancelEdit();
  });

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'edit-save';
  save.textContent = 'Save';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'edit-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', cancelEdit);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    const channelArn = activeChannelArn;
    editing = null;
    renderMessages();
    editMessage(channelArn, msg.id, content, msg.metadata).catch((err) => {
      console.error(err);
      alert('Failed to edit: ' + err.message);
    });
  });

  form.appendChild(input);
  form.appendChild(save);
  form.appendChild(cancel);

  queueMicrotask(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  return form;
}

// The quoted text travels inside the reply's own metadata, so it renders even
// when the parent is older than the history we loaded. Jumping to the parent is
// therefore best effort: it only works while the parent is on screen.
function buildQuote(replyTo) {
  const quote = document.createElement('button');
  quote.type = 'button';
  quote.className = 'quote';

  const sender = document.createElement('span');
  sender.className = 'quote-sender';
  sender.textContent = replyTo.sender || 'unknown';
  quote.appendChild(sender);

  const preview = document.createElement('span');
  preview.className = 'quote-preview';
  preview.textContent = replyTo.preview || '';
  quote.appendChild(preview);

  quote.addEventListener('click', () => jumpToMessage(replyTo.messageId));
  return quote;
}

function jumpToMessage(messageId) {
  const target = document
    .getElementById('messages')
    .querySelector(`[data-id="${CSS.escape(messageId)}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('flash');
  // Restart the animation even if this message was just highlighted.
  void target.offsetWidth;
  target.classList.add('flash');
}

function renderMessages() {
  const container = el('messages');
  container.innerHTML = '';
  const messages = messagesByChannel.get(activeChannelArn) || [];
  const canModerate = isModeratorForActiveChannel();
  for (const msg of messages) {
    const isEditing = editing && editing.messageId === msg.id;

    const wrapper = document.createElement('div');
    wrapper.className =
      'msg' + (msg.mine ? ' mine' : '') + (isEditing ? ' editing' : '');
    wrapper.dataset.id = msg.id;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
    meta.textContent = `${msg.sender} ${time}` + (msg.edited && !msg.redacted ? ' (edited)' : '');
    wrapper.appendChild(meta);

    if (isEditing) {
      wrapper.appendChild(buildEditor(msg));
    } else {
      // Redaction clears metadata server-side, so a redacted reply loses its
      // quote on reload; drop it here too so both states look the same.
      if (msg.replyTo && !msg.redacted) {
        wrapper.appendChild(buildQuote(msg.replyTo));
      }

      const bubble = document.createElement('div');
      bubble.className = 'bubble' + (msg.redacted ? ' redacted' : '');
      // A redacted message still exists in Chime, it just comes back with no content.
      bubble.textContent = msg.redacted ? 'This message was deleted' : msg.content;
      wrapper.appendChild(bubble);

      // Reply: anyone's message. Edit: own messages only.
      // Delete: own, or any message if channel moderator.
      const canReply = !msg.redacted;
      const canEdit = msg.mine && !msg.redacted;
      const canDelete = !msg.redacted && (msg.mine || canModerate);
      if (canReply || canEdit || canDelete) {
        wrapper.appendChild(buildActions(msg, { canReply, canEdit, canDelete }));
      }
    }

    container.appendChild(wrapper);
  }
  container.scrollTop = container.scrollHeight;
}

function renderReplyBanner() {
  const banner = el('reply-banner');
  banner.hidden = !replyingTo;
  if (!replyingTo) return;
  el('reply-banner-sender').textContent = replyingTo.sender;
  el('reply-banner-preview').textContent = replyingTo.preview;
}

function setStatus(text) {
  el('status').textContent = text;
}

function startEdit(msg) {
  editing = { messageId: msg.id, draft: msg.content || '' };
  renderMessages();
}

function cancelEdit() {
  editing = null;
  renderMessages();
}

function startReply(msg) {
  replyingTo = {
    messageId: msg.id,
    sender: msg.sender,
    preview: (msg.content || '').slice(0, REPLY_PREVIEW_LIMIT),
  };
  renderReplyBanner();
  el('message-input').focus();
}

function cancelReply() {
  replyingTo = null;
  renderReplyBanner();
}

function messagesFor(channelArn) {
  if (!messagesByChannel.has(channelArn)) {
    messagesByChannel.set(channelArn, []);
  }
  return messagesByChannel.get(channelArn);
}

// History load, websocket echo, and edits all arrive under the same MessageId,
// so merge by id rather than appending or dropping.
function upsertMessage(channelArn, message) {
  const list = messagesFor(channelArn);
  const index = list.findIndex((m) => m.id === message.id);
  if (index === -1) {
    list.push(message);
  } else {
    list[index] = { ...list[index], ...message };
  }
  if (channelArn === activeChannelArn) renderMessages();
}

function patchMessage(channelArn, messageId, patch) {
  const message = messagesFor(channelArn).find((m) => m.id === messageId);
  if (!message) return;
  Object.assign(message, patch);
  if (channelArn === activeChannelArn) renderMessages();
}

function removeMessage(channelArn, messageId) {
  const list = messagesFor(channelArn);
  const index = list.findIndex((m) => m.id === messageId);
  if (index === -1) return;
  list.splice(index, 1);
  if (channelArn === activeChannelArn) renderMessages();
}

// ---------------------------------------------------------------------------
// Chime: history, send, edit, delete
// ---------------------------------------------------------------------------

// Metadata is a free-form string as far as Chime is concerned, so treat anything
// we did not write as "no reply" rather than letting a parse error break render.
function parseReplyTo(metadata) {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    const replyTo = parsed && parsed.replyTo;
    return replyTo && replyTo.messageId ? replyTo : null;
  } catch {
    return null;
  }
}

function buildReplyMetadata(replyTo) {
  if (!replyTo) return undefined;
  return JSON.stringify({
    replyTo: {
      messageId: replyTo.messageId,
      sender: replyTo.sender,
      preview: replyTo.preview,
    },
  });
}

// Maps a Chime ChannelMessage / ChannelMessageSummary to our local shape.
// `metadata` is kept verbatim so an edit can round-trip it: UpdateChannelMessage
// overwrites metadata with whatever it is given, so dropping it would strip the
// reply pointer off any reply that gets edited.
function toMessage(raw) {
  return {
    id: raw.MessageId,
    sender: (raw.Sender && raw.Sender.Name) || 'unknown',
    content: raw.Content,
    timestamp: raw.CreatedTimestamp,
    mine: !!(raw.Sender && raw.Sender.Arn === config.userArn),
    redacted: !!raw.Redacted,
    edited: !!raw.LastEditedTimestamp,
    metadata: raw.Metadata,
    replyTo: parseReplyTo(raw.Metadata),
  };
}

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
    upsertMessage(channelArn, toMessage(m));
  }
}

async function sendMessage(content, replyTo) {
  await chime.send(
    new SendChannelMessageCommand({
      ChannelArn: activeChannelArn,
      ChimeBearer: config.userArn,
      Content: content,
      Type: 'STANDARD',
      Persistence: 'PERSISTENT',
      Metadata: buildReplyMetadata(replyTo),
      ClientRequestToken: crypto.randomUUID(),
    })
  );
  // No optimistic append: the websocket echoes our own message back to us,
  // which is also a nice proof that the realtime path works.
}

// Chime only allows a member to edit their own messages; anyone else gets a 403.
// Metadata is resent unchanged so editing a reply keeps it attached to its parent.
async function editMessage(channelArn, messageId, content, metadata) {
  await chime.send(
    new UpdateChannelMessageCommand({
      ChannelArn: channelArn,
      MessageId: messageId,
      ChimeBearer: config.userArn,
      Content: content,
      Metadata: metadata,
    })
  );
}

// Soft delete: clears content but leaves the message in place. Members can
// redact their own; channel moderators can redact anyone's in that channel.
async function redactMessage(channelArn, messageId) {
  await chime.send(
    new RedactChannelMessageCommand({
      ChannelArn: channelArn,
      MessageId: messageId,
      ChimeBearer: config.userArn,
    })
  );
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
      // Chime fans out edits and redactions to every channel member, so the UI
      // never applies them optimistically; it waits for the event.
      switch (message.type) {
        case 'CREATE_CHANNEL_MESSAGE': {
          const payload = JSON.parse(message.payload);
          upsertMessage(payload.ChannelArn, toMessage(payload));
          break;
        }
        case 'UPDATE_CHANNEL_MESSAGE': {
          const payload = JSON.parse(message.payload);
          upsertMessage(payload.ChannelArn, { ...toMessage(payload), edited: true });
          break;
        }
        case 'REDACT_CHANNEL_MESSAGE': {
          const payload = JSON.parse(message.payload);
          patchMessage(payload.ChannelArn, payload.MessageId, { redacted: true });
          break;
        }
        case 'DELETE_CHANNEL_MESSAGE': {
          // Only an AppInstanceAdmin can trigger this, so it will not fire from
          // this UI; handled so an admin hard delete elsewhere still lands here.
          const payload = JSON.parse(message.payload);
          removeMessage(payload.ChannelArn, payload.MessageId);
          break;
        }
        default:
          break;
      }
    },
  });

  return session.start();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function selectChannel(channel) {
  editing = null;
  // A reply target belongs to the channel it was picked in, so drop it here
  // rather than letting it follow the user into another channel.
  replyingTo = null;
  activeChannelArn = channel.arn;
  el('channel-name').textContent = channel.name;
  document.querySelectorAll('.channel-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.arn === channel.arn);
  });
  renderReplyBanner();
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
    const replyTo = replyingTo;
    cancelReply();
    sendMessage(content, replyTo).catch((err) => {
      console.error(err);
      alert('Failed to send: ' + err.message);
    });
  });

  el('message-input').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancelReply();
  });
  el('reply-cancel').addEventListener('click', cancelReply);
}

init();
