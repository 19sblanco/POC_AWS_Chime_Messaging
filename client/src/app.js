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
 * Threads are not a Chime feature. Chime stores a flat list of messages per
 * channel, so a reply is an ordinary message carrying a pointer to its thread
 * root in the 1KB `Metadata` field that every STANDARD message has. Chime
 * returns metadata from ListChannelMessages and includes it in the WebSocket
 * payload, so replies fan out in realtime like any other message; only this
 * client interprets them, grouping replies out of the channel timeline and into
 * a thread panel. Threads are flat: replying to a reply resolves up to that
 * reply's root, so a thread is never more than two levels deep.
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

// A snapshot of the root's text travels in every reply's metadata, so it has to
// stay well inside Chime's 1KB metadata cap alongside the root's id and sender.
const ROOT_PREVIEW_LIMIT = 120;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let config = null; // /api/config response for the chosen user
let chime = null; // ChimeSDKMessagingClient
let session = null; // realtime messaging session
let activeChannelArn = null;
let editing = null; // { messageId, draft, scope } while an edit is in progress
let openThread = null; // { channelArn, rootId } while the thread panel is open
// channelArn ->
//   [{ id, sender, content, timestamp, mine, redacted, edited, metadata, thread }]
const messagesByChannel = new Map();

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);

function isModeratorForActiveChannel() {
  const channel = (config.channels || []).find((c) => c.arn === activeChannelArn);
  return !!(channel && channel.isModerator);
}

function buildActions(msg, { canReply, canEdit, canDelete }, scope) {
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
    edit.addEventListener('click', () => startEdit(msg, scope));
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
    if (event.key === 'Escape') {
      event.stopPropagation();
      cancelEdit();
    }
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
    render();
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

// One row renderer for both the channel timeline and the thread panel. `scope`
// keeps an in-progress edit pinned to the pane it was started from, since a
// thread root is on screen in both places at once.
function buildMessageRow(msg, scope, { canReply, threadLink }) {
  const isEditing = editing && editing.messageId === msg.id && editing.scope === scope;

  const wrapper = document.createElement('div');
  wrapper.className =
    'msg' +
    (msg.mine ? ' mine' : '') +
    (msg.stub ? ' stub' : '') +
    (isEditing ? ' editing' : '');
  wrapper.dataset.id = msg.id;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
  meta.textContent =
    `${msg.sender} ${time}`.trim() + (msg.edited && !msg.redacted ? ' (edited)' : '');
  wrapper.appendChild(meta);

  if (isEditing) {
    wrapper.appendChild(buildEditor(msg));
    return wrapper;
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (msg.redacted ? ' redacted' : '');
  // A redacted message still exists in Chime, it just comes back with no content.
  bubble.textContent = msg.redacted ? 'This message was deleted' : msg.content;
  if (msg.stub) {
    bubble.title = 'Original message is older than the loaded history';
  }
  wrapper.appendChild(bubble);

  // Sits between the bubble and the hover actions, whose reserved-but-hidden
  // row would otherwise push the badge away from the message it belongs to.
  if (threadLink) wrapper.appendChild(threadLink);

  // Reply: anyone's message. Edit: own messages only.
  // Delete: own, or any message if channel moderator.
  // A stub root was never loaded, so there is nothing local to edit or delete.
  const canEdit = msg.mine && !msg.redacted && !msg.stub;
  const canDelete = !msg.redacted && !msg.stub && (msg.mine || isModeratorForActiveChannel());
  const replyable = canReply && !msg.redacted;
  if (replyable || canEdit || canDelete) {
    wrapper.appendChild(
      buildActions(msg, { canReply: replyable, canEdit, canDelete }, scope)
    );
  }

  return wrapper;
}

// ---------------------------------------------------------------------------
// Threading
// ---------------------------------------------------------------------------

// A reply whose root is older than the history we loaded still knows its root's
// sender and text, so the thread stays reachable from the timeline via a stub.
function stubRoot(thread) {
  return {
    id: thread.rootId,
    sender: thread.rootSender || 'unknown',
    content: thread.rootPreview || '',
    timestamp: null,
    mine: false,
    redacted: false,
    edited: false,
    thread: null,
    stub: true,
  };
}

// Splits a channel's flat message list into the timeline (roots, in send order,
// with a stub standing in for any root we never loaded) and its replies.
function buildTimeline(messages) {
  const repliesByRoot = new Map();
  const byId = new Map();
  for (const msg of messages) {
    byId.set(msg.id, msg);
    if (!msg.thread) continue;
    const siblings = repliesByRoot.get(msg.thread.rootId) || [];
    siblings.push(msg);
    repliesByRoot.set(msg.thread.rootId, siblings);
  }
  for (const replies of repliesByRoot.values()) {
    replies.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  const entries = [];
  const stubbed = new Set();
  for (const msg of messages) {
    if (!msg.thread) {
      entries.push({ root: msg, replies: repliesByRoot.get(msg.id) || [] });
      continue;
    }
    const { rootId } = msg.thread;
    if (byId.has(rootId) || stubbed.has(rootId)) continue;
    stubbed.add(rootId);
    entries.push({ root: stubRoot(msg.thread), replies: repliesByRoot.get(rootId) || [] });
  }
  return entries;
}

// The pointer a new reply should carry. Threads are flat, so replying to a reply
// reuses its root pointer rather than nesting another level.
function threadDescriptor(msg) {
  if (msg.thread) return msg.thread;
  return {
    rootId: msg.id,
    rootSender: msg.sender,
    rootPreview: (msg.content || '').slice(0, ROOT_PREVIEW_LIMIT),
  };
}

function threadDescriptorFor(channelArn, rootId) {
  const messages = messagesFor(channelArn);
  const root = messages.find((m) => m.id === rootId);
  if (root) return threadDescriptor(root);
  const reply = messages.find((m) => m.thread && m.thread.rootId === rootId);
  return reply ? reply.thread : null;
}

function threadEntry(channelArn, rootId) {
  return buildTimeline(messagesFor(channelArn)).find((entry) => entry.root.id === rootId);
}

function buildThreadLink(entry) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className =
    'thread-link' +
    (openThread && openThread.rootId === entry.root.id ? ' active' : '');

  const count = document.createElement('span');
  count.className = 'thread-count';
  count.textContent = `${entry.replies.length} ${entry.replies.length === 1 ? 'reply' : 'replies'}`;
  link.appendChild(count);

  const last = entry.replies[entry.replies.length - 1];
  if (last && last.timestamp) {
    const when = document.createElement('span');
    when.className = 'thread-last';
    when.textContent = new Date(last.timestamp).toLocaleTimeString();
    link.appendChild(when);
  }

  link.addEventListener('click', () => openThreadPanel(entry.root.id));
  return link;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  renderMessages();
  renderThread();
}

function renderMessages() {
  const container = el('messages');
  container.innerHTML = '';
  for (const entry of buildTimeline(messagesFor(activeChannelArn))) {
    container.appendChild(
      buildMessageRow(entry.root, 'timeline', {
        canReply: true,
        threadLink: entry.replies.length ? buildThreadLink(entry) : null,
      })
    );
  }
  container.scrollTop = container.scrollHeight;
}

function renderThread() {
  const panel = el('thread-panel');
  const openHere = openThread && openThread.channelArn === activeChannelArn;
  const entry = openHere ? threadEntry(activeChannelArn, openThread.rootId) : null;
  // The root can disappear from under us (an admin hard delete elsewhere), which
  // leaves nothing to reply to.
  if (!entry) {
    panel.hidden = true;
    if (openHere) openThread = null;
    return;
  }

  panel.hidden = false;
  el('thread-channel').textContent = el('channel-name').textContent;

  const body = el('thread-messages');
  body.innerHTML = '';
  body.appendChild(buildMessageRow(entry.root, 'thread', { canReply: false }));

  const divider = document.createElement('div');
  divider.className = 'thread-divider';
  divider.textContent = entry.replies.length
    ? `${entry.replies.length} ${entry.replies.length === 1 ? 'reply' : 'replies'}`
    : 'No replies yet';
  body.appendChild(divider);

  for (const reply of entry.replies) {
    body.appendChild(buildMessageRow(reply, 'thread', { canReply: true }));
  }
  body.scrollTop = body.scrollHeight;
}

function setStatus(text) {
  el('status').textContent = text;
}

function startEdit(msg, scope) {
  editing = { messageId: msg.id, draft: msg.content || '', scope };
  render();
}

function cancelEdit() {
  editing = null;
  render();
}

// Threads are flat, so replying to anything in a thread just aims the panel
// composer at the same root.
function startReply(msg) {
  openThreadPanel(threadDescriptor(msg).rootId);
}

function openThreadPanel(rootId) {
  openThread = { channelArn: activeChannelArn, rootId };
  render();
  el('thread-input').focus();
}

function closeThread() {
  if (!openThread) return;
  openThread = null;
  render();
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
  if (channelArn === activeChannelArn) render();
}

function patchMessage(channelArn, messageId, patch) {
  const message = messagesFor(channelArn).find((m) => m.id === messageId);
  if (!message) return;
  Object.assign(message, patch);
  if (channelArn === activeChannelArn) render();
}

function removeMessage(channelArn, messageId) {
  const list = messagesFor(channelArn);
  const index = list.findIndex((m) => m.id === messageId);
  if (index === -1) return;
  list.splice(index, 1);
  if (channelArn === activeChannelArn) render();
}

// ---------------------------------------------------------------------------
// Chime: history, send, edit, delete
// ---------------------------------------------------------------------------

// Metadata is a free-form string as far as Chime is concerned, so treat anything
// we did not write as "not a reply" rather than letting a parse error break
// render. The legacy `replyTo` shape (an earlier build of this POC quoted the
// immediate parent instead of threading) is read as a root pointer so old
// conversations still group.
function parseThread(metadata) {
  if (!metadata) return null;
  let parsed;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (!parsed) return null;

  const thread = parsed.thread;
  if (thread && thread.rootId) {
    return {
      rootId: thread.rootId,
      rootSender: thread.rootSender,
      rootPreview: thread.rootPreview,
    };
  }

  const legacy = parsed.replyTo;
  if (legacy && legacy.messageId) {
    return {
      rootId: legacy.messageId,
      rootSender: legacy.sender,
      rootPreview: legacy.preview,
    };
  }
  return null;
}

function buildThreadMetadata(thread) {
  if (!thread) return undefined;
  return JSON.stringify({
    thread: {
      rootId: thread.rootId,
      rootSender: thread.rootSender,
      rootPreview: thread.rootPreview,
    },
  });
}

// Maps a Chime ChannelMessage / ChannelMessageSummary to our local shape.
// `metadata` is kept verbatim so an edit can round-trip it: UpdateChannelMessage
// overwrites metadata with whatever it is given, so dropping it would tear an
// edited reply out of its thread.
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
    thread: parseThread(raw.Metadata),
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

async function sendMessage(channelArn, content, thread) {
  await chime.send(
    new SendChannelMessageCommand({
      ChannelArn: channelArn,
      ChimeBearer: config.userArn,
      Content: content,
      Type: 'STANDARD',
      Persistence: 'PERSISTENT',
      Metadata: buildThreadMetadata(thread),
      ClientRequestToken: crypto.randomUUID(),
    })
  );
  // No optimistic append: the websocket echoes our own message back to us,
  // which is also a nice proof that the realtime path works.
}

// Chime only allows a member to edit their own messages; anyone else gets a 403.
// Metadata is resent unchanged so editing a reply keeps it in its thread.
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
          // Redaction wipes metadata server-side, so only the redacted flag is
          // patched here; the local thread pointer survives until a reload.
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
  // A thread belongs to the channel it was opened in, so close it rather than
  // letting it follow the user into another channel.
  openThread = null;
  activeChannelArn = channel.arn;
  el('channel-name').textContent = channel.name;
  document.querySelectorAll('.channel-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.arn === channel.arn);
  });
  render();
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

  // Channel composer: always sends a new root message.
  el('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el('message-input');
    const content = input.value.trim();
    if (!content || !activeChannelArn) return;
    input.value = '';
    sendMessage(activeChannelArn, content, null).catch((err) => {
      console.error(err);
      alert('Failed to send: ' + err.message);
    });
  });

  // Thread composer: always sends into the open thread.
  el('thread-composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el('thread-input');
    const content = input.value.trim();
    if (!content || !openThread) return;
    const channelArn = openThread.channelArn;
    const thread = threadDescriptorFor(channelArn, openThread.rootId);
    if (!thread) return;
    input.value = '';
    sendMessage(channelArn, content, thread).catch((err) => {
      console.error(err);
      alert('Failed to reply: ' + err.message);
    });
  });

  el('thread-close').addEventListener('click', closeThread);
  // Escape closes the thread from anywhere. An open message editor swallows the
  // key first so Escape cancels the edit rather than the whole panel.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeThread();
  });
}

init();
