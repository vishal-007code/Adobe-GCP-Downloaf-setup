const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
const message = process.env.GOOGLE_CHAT_MESSAGE?.trim();
const threadKey = process.env.GOOGLE_CHAT_THREAD_KEY?.trim();

if (!webhookUrl || !message) {
  process.exit(0);
}

const url = new URL(webhookUrl);
if (threadKey) {
  url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
}

const payload = {
  text: message,
};

if (threadKey) {
  payload.thread = { threadKey };
}

const response = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json; charset=UTF-8',
  },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`Google Chat webhook failed: ${response.status} ${response.statusText} ${body}`);
}
