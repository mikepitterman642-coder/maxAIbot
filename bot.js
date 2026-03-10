import { Bot, ImageAttachment, Keyboard } from '@maxhub/max-bot-api';
import {
  clearChatContext,
  getUserState,
  incrementChatGptUsage,
  initDb,
  getCurrentMskDay,
  saveUserState,
  resetUserStateOnStart,
  setChatContext,
  setPendingNanoRequest,
  setUserMode,
  spendCoins,
} from './db.js';

const BOT_TOKEN = 'f9LHodD0cOLk5aywv2KzpMyWDLeqseaCqJHHOKDlFwilcs2-OCK7NuMtznhMenLpZrk19yznJPDQJNpLLrIb';
const START_IMAGE_TOKEN = 'PASTE_START_IMAGE_TOKEN_HERE';
const WAVESPEED_API_TOKEN = '5cbe2727bbd19b0cb7304de4500536263f492ee3f487be60385500c41ed763c8';

const WAVESPEED_LLM_BASE_URL = 'https://llm.wavespeed.ai/v1';
const WAVESPEED_API_V3_BASE_URL = 'https://api.wavespeed.ai/api/v3';
const WAVESPEED_CHAT_MODEL = 'openai/gpt-4.1';

const MAX_CHAT_CONTEXT_MESSAGES = 12;
const FREE_LIMITS = { chatgpt: 10 };
const NANOBANANA_COST = 5;

if (!BOT_TOKEN || BOT_TOKEN === 'PASTE_YOUR_BOT_TOKEN_HERE') throw new Error('Укажите BOT_TOKEN.');
if (!WAVESPEED_API_TOKEN) throw new Error('Укажите WAVESPEED_API_TOKEN.');

const bot = new Bot(BOT_TOKEN);

const getChatGptRemaining = (state) => Math.max(0, FREE_LIMITS.chatgpt - state.usage.chatgptUsed);

const refreshDailyGptQuotaIfNeeded = async (userId, state) => {
  const currentDay = getCurrentMskDay();
  if (state.usage.chatgptDay !== currentDay) {
    state.usage.chatgptDay = currentDay;
    state.usage.chatgptUsed = 0;
    await saveUserState(userId, state);
  }
  return state;
};

const escapeMarkdown = (value = '') => String(value).replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');

const mainKeyboard = Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('💬 Работа с ChatGpt', 'menu:chatgpt'),
    Keyboard.button.callback('🎨 Работа с NanoBanana', 'menu:nanobanana'),
  ],
  [
    Keyboard.button.callback('👤 Профиль', 'menu:profile'),
    Keyboard.button.callback('❓ Помощь', 'menu:help'),
  ],
]);

const resetContextKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('🧹 Сбросить контекст', 'chatgpt:reset')],
  [Keyboard.button.callback('🏠 Главное меню', 'menu:main')],
]);

const formatKeyboard = Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('⬜ Квадратное 1:1', 'nanobanana:format:1:1'),
    Keyboard.button.callback('📱 Вертикальное 9:16', 'nanobanana:format:9:16'),
  ],
  [Keyboard.button.callback('🖥 Горизонтальное 16:9', 'nanobanana:format:16:9')],
  [Keyboard.button.callback('🏠 Главное меню', 'menu:main')],
]);

const nanoStartKeyboard = (ratio = '1:1') => Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('🚀 Начать', 'nanobanana:start'),
    Keyboard.button.callback('🖼 Формат фото', 'nanobanana:format'),
  ],
  [Keyboard.button.callback(`📐 Формат: ${ratio}`, 'nanobanana:format')],
  [Keyboard.button.callback('🏠 Главное меню', 'menu:main')],
]);

const profileKeyboard = Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('💎 Подписка', 'profile:subscription'),
    Keyboard.button.callback('🧾 Запросы', 'profile:plans'),
  ],
  [Keyboard.button.callback('⬅️ Назад', 'profile:back')],
]);

const getWelcomeText = (username) => `👋 Добро пожаловать, ${username}!\n\n✨ Что умеет Бот?\n\n🤖 ChatGpt:\n• Ответы на любые вопросы\n• Написание кода\n• Работа с текстами любой сложности\n• Обучать\n• Быть наставником или помощником\n\n🍌 NanoBanana:\n• Генерация уникальных изображений\n• Генерация ваших фото по вашему описанию\n\n📌 Просто выбери в меню нужный раздел и приступай.\n\n🚀 Что будем генерировать сегодня?`;

const getUserDisplayName = (ctx) => ctx.user?.first_name || ctx.user?.username || ctx.user?.name || 'друг';
const extractTextFromMessage = (ctx) => ctx.message?.body?.text || ctx.message?.text || '';
const extractImageUrlFromMessage = (ctx) => {
  const attachments = ctx.message?.body?.attachments || [];
  for (const a of attachments) {
    const candidates = [a?.payload?.url, a?.payload?.src, a?.payload?.image?.url, a?.payload?.photo?.url, a?.url, a?.src];
    const found = candidates.find((v) => typeof v === 'string' && v.startsWith('http'));
    if (found) return found;
  }
  return null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const requestWavespeedChat = async ({ messages }) => {
  const response = await fetch(`${WAVESPEED_LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WAVESPEED_API_TOKEN}` },
    body: JSON.stringify({ model: WAVESPEED_CHAT_MODEL, messages, temperature: 0.7 }),
  });
  if (!response.ok) throw new Error(`Wavespeed chat error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || 'Не удалось получить ответ от модели.';
};

const submitNanoBananaTask = async ({ endpoint, payload }) => {
  const response = await fetch(`${WAVESPEED_API_V3_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WAVESPEED_API_TOKEN}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Wavespeed NanoBanana submit error ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const requestId = data?.data?.id;
  if (!requestId) throw new Error(`Wavespeed NanoBanana submit error: request id not found ${JSON.stringify(data)}`);
  return requestId;
};

const waitNanoBananaResult = async (requestId) => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await fetch(`${WAVESPEED_API_V3_BASE_URL}/predictions/${requestId}/result`, {
      method: 'GET', headers: { Authorization: `Bearer ${WAVESPEED_API_TOKEN}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Wavespeed NanoBanana polling error ${response.status}: ${JSON.stringify(data)}`);
    const status = data?.data?.status;
    if (status === 'completed') return { imageUrl: data?.data?.outputs?.[0] || null, raw: data };
    if (status === 'failed') throw new Error(`Wavespeed NanoBanana failed: ${JSON.stringify(data?.data?.error || data)}`);
    await sleep(1000);
  }
  throw new Error('Wavespeed NanoBanana timeout.');
};

const requestNanoBanana = async ({ prompt, imageUrl, ratio }) => {
  const resolution = ratio === '9:16' ? '720x1280' : ratio === '16:9' ? '1280x720' : '1k';

  const payload = {
    prompt,
    resolution,
    enable_web_search: false,
    output_format: 'png',
    enable_sync_mode: false,
    enable_base64_output: false,
    ...(imageUrl ? { images: [imageUrl] } : {}),
  };

  const requestId = await submitNanoBananaTask({
    endpoint: imageUrl ? 'google/nano-banana-2/edit' : 'google/nano-banana-2/text-to-image',
    payload,
  });

  return waitNanoBananaResult(requestId);
};

const getCallbackMessageMeta = (ctx) => ({
  chatId: ctx.chat?.chat_id || ctx.chat_id || ctx.message?.recipient?.chat_id || ctx.callback?.message?.recipient?.chat_id || null,
  mid: ctx.message?.body?.mid || ctx.callback?.message?.body?.mid || ctx.callback?.message?.mid || null,
});

const updateMenuMessage = async (ctx, text, options = {}) => {
  const { chatId, mid } = getCallbackMessageMeta(ctx);
  if (chatId && mid) {
    try {
      await ctx.api.raw.patch('chats/{chat_id}/messages/{message_id}', {
        path: { chat_id: chatId, message_id: mid },
        body: { text, format: options.format, attachments: options.attachments },
      });
      return;
    } catch {}
  }
  await ctx.reply(text, options);
};

const sendStartMessage = async (ctx) => {
  const username = getUserDisplayName(ctx);
  const attachments = [mainKeyboard];
  if (START_IMAGE_TOKEN && START_IMAGE_TOKEN !== 'PASTE_START_IMAGE_TOKEN_HERE') {
    attachments.unshift(new ImageAttachment({ token: START_IMAGE_TOKEN }).toJson());
  }
  await ctx.reply(getWelcomeText(username), { attachments });
};

const sendProfileMessage = async (ctx, preferEdit = false) => {
  const userId = ctx.user?.user_id;
  if (!userId) return;

  const state = await refreshDailyGptQuotaIfNeeded(userId, await getUserState(userId));
  const name = escapeMarkdown(getUserDisplayName(ctx));

  const profileText = state.subscriptionActive
    ? `👋 **Привет, ${name}**\!\n🆔 Ваш id: **${userId}**\n💎 Подписка: **Активна ✅**\n🪙 Ваши монеты: **${state.balance}**\n\n🚀 Вам доступны запросы без ограничений\.\n\n🕛 Лимит ChatGpt обновляется в **00:00 по МСК**\.`
    : `👋 **Привет, ${name}**\!\n🆔 Ваш id: **${userId}**\n💎 Подписка: **Нету ❌**\n🪙 Ваши монеты: **${state.balance}**\n\n🎁 Бесплатные запросы:\n• ChatGpt: **${getChatGptRemaining(state)}/${FREE_LIMITS.chatgpt}** в день\n\n🕛 Лимит ChatGpt обновляется в **00:00 по МСК**\.`;

  if (preferEdit) return updateMenuMessage(ctx, profileText, { format: 'markdown', attachments: [profileKeyboard] });
  await ctx.reply(profileText, { format: 'markdown', attachments: [profileKeyboard] });
};

const openChatGptMode = async (ctx, preferEdit = false) => {
  const userId = ctx.user?.user_id;
  if (!userId) return;
  await setUserMode(userId, 'chatgpt');
  await setPendingNanoRequest(userId, null);

  const text = '💬 Задавайте вопросы — я всё проанализирую и найду лучшее решение.\n\n🧹 **Кнопка «Сбросить контекст»** — начинает разговор заново.\n↩️ Выйти — команда /start';
  if (preferEdit) return updateMenuMessage(ctx, text, { format: 'markdown', attachments: [resetContextKeyboard] });
  await ctx.reply(text, { format: 'markdown', attachments: [resetContextKeyboard] });
};

const openNanoBananaMode = async (ctx, preferEdit = false) => {
  const userId = ctx.user?.user_id;
  if (!userId) return;
  await setUserMode(userId, 'nanobanana');

  const text = '🎨 **Работа с NanoBanana**\n\n**🖼️ Редактирование фото** — загрузи фото и опиши изменения\n\n**✍️ Генерация по тексту** — просто напиши описание\n\n💰 Стоимость генерации: **5 монет**\n📐 Можно выбрать формат фото через кнопку «Формат фото».\n\n⬇️ Для выхода нажмите «Главное меню».';
  const attachments = [Keyboard.inlineKeyboard([[Keyboard.button.callback('🏠 Главное меню', 'menu:main')]])];
  if (preferEdit) return updateMenuMessage(ctx, text, { format: 'markdown', attachments });
  await ctx.reply(text, { format: 'markdown', attachments });
};

bot.command('start', async (ctx) => {
  const userId = ctx.user?.user_id;
  if (userId) await resetUserStateOnStart(userId);
  await sendStartMessage(ctx);
});
bot.command('chatgpt', openChatGptMode);
bot.command('nanobanana', openNanoBananaMode);
bot.command('profile', sendProfileMessage);
bot.command('help', async (ctx) => ctx.reply('Помощь/Сотрудничество: https://clck.ru/3STi9X'));

bot.action('menu:chatgpt', async (ctx) => openChatGptMode(ctx, true));
bot.action('menu:nanobanana', async (ctx) => openNanoBananaMode(ctx, true));
bot.action('menu:profile', async (ctx) => sendProfileMessage(ctx, true));
bot.action('menu:help', async (ctx) => updateMenuMessage(ctx, 'Помощь/Сотрудничество: https://clck.ru/3STi9X', {
  attachments: [Keyboard.inlineKeyboard([[Keyboard.button.callback('🏠 Главное меню', 'menu:main')]])],
}));

bot.action('menu:main', async (ctx) => {
  const userId = ctx.user?.user_id;
  if (userId) {
    await setUserMode(userId, 'idle');
    await setPendingNanoRequest(userId, null);
  }
  await updateMenuMessage(ctx, getWelcomeText(getUserDisplayName(ctx)), { attachments: [mainKeyboard] });
});

bot.action('profile:subscription', async (ctx) => updateMenuMessage(ctx,
  '💎 **Подписка**\n\nСкоро здесь появится оформление подписки и управление тарифом.',
  { format: 'markdown', attachments: [profileKeyboard] },
));

bot.action('profile:plans', async (ctx) => updateMenuMessage(ctx,
  '🧾 **Пакеты монет**\n\n20 монет → 59 ₽\n50 монет → 139 ₽\n100 монет → 269 ₽\n200 монет → 499 ₽\n500 монет → 1 190 ₽',
  { format: 'markdown', attachments: [profileKeyboard] },
));

bot.action('profile:back', async (ctx) => {
  const userId = ctx.user?.user_id;
  if (userId) {
    await setUserMode(userId, 'idle');
    await setPendingNanoRequest(userId, null);
  }
  await updateMenuMessage(ctx, getWelcomeText(getUserDisplayName(ctx)), { attachments: [mainKeyboard] });
});

bot.action('chatgpt:reset', async (ctx) => {
  const userId = ctx.user?.user_id;
  if (!userId) return;
  await clearChatContext(userId);
  await updateMenuMessage(ctx, '🧹 Контекст сброшен. Начинаем заново!', { format: 'markdown', attachments: [resetContextKeyboard] });
});

bot.action('nanobanana:format', async (ctx) => updateMenuMessage(ctx,
  '📐 **Выберите формат фото**',
  { format: 'markdown', attachments: [formatKeyboard] },
));

for (const ratio of ['1:1', '9:16', '16:9']) {
  bot.action(`nanobanana:format:${ratio}`, async (ctx) => {
    const userId = ctx.user?.user_id;
    if (!userId) return;
    const state = await getUserState(userId);
    const pending = state.pendingNanoRequest;
    if (!pending) {
      await updateMenuMessage(ctx, '⚠️ Сначала отправьте запрос или фото для NanoBanana.', { attachments: [Keyboard.inlineKeyboard([[Keyboard.button.callback('🏠 Главное меню', 'menu:main')]])] });
      return;
    }
    pending.ratio = ratio;
    await setPendingNanoRequest(userId, pending);
    await updateMenuMessage(ctx,
      `✅ Формат установлен: **${ratio}**\n💰 Стоимость генерации: **${NANOBANANA_COST} монет**\n\nНажмите «🚀 Начать».`,
      { format: 'markdown', attachments: [nanoStartKeyboard(ratio)] },
    );
  });
}

bot.action('nanobanana:start', async (ctx) => {
  const userId = ctx.user?.user_id;
  if (!userId) return;

  const state = await refreshDailyGptQuotaIfNeeded(userId, await getUserState(userId));
  const pending = state.pendingNanoRequest;
  if (!pending) return ctx.reply('⚠️ Нет подготовленного запроса.');

  if (!state.subscriptionActive) {
    const ok = await spendCoins(userId, NANOBANANA_COST);
    if (!ok) {
      await ctx.reply('⚠️ У вас недостаточно монет для NanoBanana. Оформите подписку или пополните монеты.', {
        attachments: [Keyboard.inlineKeyboard([[Keyboard.button.callback('💎 Подписка', 'profile:subscription')]])],
      });
      return;
    }
  }

  try {
    await ctx.reply(`⏳ **Генерация запущена**\n\n💰 Стоимость: **${NANOBANANA_COST} монет**\nЭто может занять 30–120 секунд.`, { format: 'markdown' });
    const result = await requestNanoBanana({ prompt: pending.prompt, imageUrl: pending.imageUrl, ratio: pending.ratio || '1:1' });
    await setPendingNanoRequest(userId, null);
    await ctx.reply(result.imageUrl ? `🎨 **Готово!**\n\n🔗 ${result.imageUrl}` : '🎨 Генерация завершена.', { format: 'markdown' });
  } catch (error) {
    await ctx.reply('⚠️ Ошибка генерации. Попробуй ещё раз.');
    console.error(error);
  }
});

bot.on('message_created', async (ctx) => {
  const userId = ctx.user?.user_id;
  if (!userId) return;

  const text = extractTextFromMessage(ctx).trim();
  const imageUrl = extractImageUrlFromMessage(ctx);
  const state = await refreshDailyGptQuotaIfNeeded(userId, await getUserState(userId));

  if (state.mode === 'chatgpt') {
    if (!state.subscriptionActive && getChatGptRemaining(state) <= 0) {
      await ctx.reply('⚠️ Вы истратили все запросы ChatGpt. Оформите подписку.', {
        attachments: [Keyboard.inlineKeyboard([[Keyboard.button.callback('💎 Подписка', 'profile:subscription')]])],
      });
      return;
    }

    if (!text && !imageUrl) return ctx.reply('⚠️ Отправьте текст или фото.');

    const userContent = [];
    if (text) userContent.push({ type: 'text', text });
    if (imageUrl) userContent.push({ type: 'image_url', image_url: { url: imageUrl } });

    if (!state.subscriptionActive) await incrementChatGptUsage(userId);
    await ctx.reply('⏳ Думаю...');

    try {
      const messages = [{ role: 'system', content: 'Отвечай на русском и структурировано в Markdown.' }, ...state.chatContext, { role: 'user', content: userContent }];
      const answer = await requestWavespeedChat({ messages });
      const nextContext = [...state.chatContext, { role: 'user', content: userContent }, { role: 'assistant', content: answer }].slice(-MAX_CHAT_CONTEXT_MESSAGES);
      await setChatContext(userId, nextContext);
      await ctx.reply(`**🤖 Ответ GPT**\n\n${answer.trim().slice(0, 3900)}`, { format: 'markdown', attachments: [resetContextKeyboard] });
    } catch (error) {
      await ctx.reply('⚠️ Ошибка ChatGPT. Попробуй позже.');
      console.error(error);
    }
    return;
  }

  if (state.mode === 'nanobanana') {
    if (!text && !imageUrl) return ctx.reply('⚠️ Для NanoBanana отправьте текст или фото.');

    if (imageUrl && !text) {
      await setPendingNanoRequest(userId, { imageUrl, prompt: null, ratio: '1:1' });
      await ctx.reply('🖼️ Фото получил! Теперь напишите, что именно нужно изменить.\n\n💰 Стоимость: 5 монет.');
      return;
    }

    if (state.pendingNanoRequest?.imageUrl && !state.pendingNanoRequest.prompt && text) {
      const nextPending = { ...state.pendingNanoRequest, prompt: text, ratio: state.pendingNanoRequest.ratio || '1:1' };
      await setPendingNanoRequest(userId, nextPending);
      await ctx.reply(
        `✅ Запрос: **${escapeMarkdown(nextPending.prompt)}**\n📐 Формат: **${nextPending.ratio}**\n💰 Стоимость: **5 монет**\n\nНажмите «🚀 Начать».`,
        { format: 'markdown', attachments: [nanoStartKeyboard(nextPending.ratio)] },
      );
      return;
    }

    const nextPending = { imageUrl: imageUrl || null, prompt: text || 'Сгенерируй изображение', ratio: '1:1' };
    await setPendingNanoRequest(userId, nextPending);
    await ctx.reply(
      `✅ Запрос: **${escapeMarkdown(nextPending.prompt)}**\n📐 Формат: **1:1**\n💰 Стоимость: **5 монет**\n\nНажмите «🚀 Начать».`,
      { format: 'markdown', attachments: [nanoStartKeyboard('1:1')] },
    );
  }
});

await initDb();
bot.start();
