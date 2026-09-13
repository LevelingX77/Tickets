'use strict';

/* ============================================================
   Discord Bug Report Bot
   ทำเป็นไฟล์เดียวจบ อ่านง่ายกว่าแยกหลายไฟล์สำหรับบอทขนาดนี้
   ============================================================ */

const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ActivityType,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  SlashCommandBuilder,
  Routes,
  REST,
} = require('discord.js');

/* ============================================================
   CONFIG - ค่าเริ่มต้น (override ผ่าน Environment Variables ได้)
   ============================================================ */

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || null;
const GUILD_ID = process.env.GUILD_ID || null;

const COOLDOWN = 5 * 60 * 1000;                // กันสแปม 5 นาทีต่อคน
const RATE_LIMIT = 3;                          // แจ้งได้ 3 ครั้ง
const RATE_WINDOW = 10 * 60 * 1000;            // ต่อ 10 นาที
const DUPLICATE_THRESHOLD = 0.5;               // jaccard similarity เอาไว้เช็คบั๊กซ้ำ
const PENDING_TTL = 10 * 60 * 1000;            // อายุของข้อมูลที่ค้างอยู่ในแรม (รายงานที่ยังไม่เลือกบอท / draft panel)
const MAX_BOT_LIST = 25;                       // Discord select menu จำกัด option ไว้ที่ 25 ตัว
const DEFAULT_EMBED_COLOR = 0x5865f2;

const DATA_FILE = path.join(__dirname, 'data.json');

/* ============================================================
   STORAGE
   ============================================================ */

const DEFAULT_DATA = {
  counter: 0,
  bugs: {},           // bugId -> bug object
  blacklist: [],       // userId ที่โดนแบนไม่ให้แจ้งบั๊ก
  activeTickets: {},   // userId -> bugId (ที่ยังเปิดอยู่)
  cooldowns: {},       // userId -> เวลาแจ้งล่าสุด
  rateLimits: {},      // userId -> [timestamps]
  config: {
    logChannelId: null,
    adminRoleId: null,
    developerRoleId: null,
    ticketCategoryId: null,
    bots: [],           // รายชื่อบอทที่ให้เลือกตอนแจ้งบั๊ก (แอดมินเป็นคนตั้ง)
  },
};

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DATA)), parsed);
    // merge config แยกอีกชั้น ไม่งั้นถ้า data.json เก่าไม่มีคีย์ใหม่ ค่า default ของ config จะหายไปทั้งก้อน
    merged.config = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DATA.config)), parsed.config || {});
    if (!Array.isArray(merged.config.bots)) merged.config.bots = [];
    // เผื่อ data.json เก่าเก็บลิสต์บอทเป็น string ธรรมดา (ก่อนเปลี่ยนมาใช้ user picker) กรองทิ้งกันพัง
    merged.config.bots = merged.config.bots.filter((b) => b && typeof b === 'object' && typeof b.id === 'string');
    return merged;
  } catch (err) {
    console.error('[storage] failed to load data.json, using defaults:', err.message);
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

let data = loadData();

// write lock กัน race condition ตอนเขียนไฟล์พร้อมกันหลาย ๆ ที
let writeChain = Promise.resolve();
function saveData() {
  writeChain = writeChain.then(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[storage] failed to save data.json:', err.message);
    }
  }).catch((err) => console.error('[storage] write chain error:', err.message));
  return writeChain;
}

// mutex สำหรับ critical section (ตอนสร้างเลข bug id ใหม่)
let mutex = Promise.resolve();
function withLock(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.catch(() => {});
  return run;
}

/* ============================================================
   รายงานที่ยังค้างอยู่ / draft ของ panel ที่ยังแต่งไม่เสร็จ
   เก็บในแรมพอ ไม่จำเป็นต้องลง data.json เพราะเป็นของชั่วคราว
   ============================================================ */

const pendingReports = new Map(); // userId -> { title, description, expiresAt }
const pendingPanels = new Map();  // userId -> { title, description, image, footer, color, colorRaw, expiresAt }

function setPending(userId, payload) {
  pendingReports.set(userId, { ...payload, expiresAt: Date.now() + PENDING_TTL });
}
function getPending(userId) {
  const p = pendingReports.get(userId);
  if (!p) return null;
  if (Date.now() > p.expiresAt) {
    pendingReports.delete(userId);
    return null;
  }
  return p;
}
function clearPending(userId) {
  pendingReports.delete(userId);
}

function setPanelDraft(userId, draft) {
  pendingPanels.set(userId, { ...draft, expiresAt: Date.now() + PENDING_TTL });
}
function getPanelDraft(userId) {
  const d = pendingPanels.get(userId);
  if (!d) return null;
  if (Date.now() > d.expiresAt) {
    pendingPanels.delete(userId);
    return null;
  }
  return d;
}
function clearPanelDraft(userId) {
  pendingPanels.delete(userId);
}

setInterval(() => {
  const now = Date.now();
  for (const [uid, p] of pendingReports.entries()) {
    if (now > p.expiresAt) pendingReports.delete(uid);
  }
  for (const [uid, d] of pendingPanels.entries()) {
    if (now > d.expiresAt) pendingPanels.delete(uid);
  }
}, 60 * 1000).unref();

/* ============================================================
   UTIL
   ============================================================ */

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function normalizeText(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardSimilarity(a, b) {
  const setA = new Set(normalizeText(a));
  const setB = new Set(normalizeText(b));
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function isBlacklisted(userId) {
  return data.blacklist.includes(userId);
}

function isAdmin(member) {
  if (!member) return false;
  if (member.permissions && member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const { adminRoleId, developerRoleId } = data.config;
  if (adminRoleId && member.roles.cache.has(adminRoleId)) return true;
  if (developerRoleId && member.roles.cache.has(developerRoleId)) return true;
  return false;
}

function getUserActiveBug(userId) {
  const bugId = data.activeTickets[userId];
  if (!bugId) return null;
  const bug = data.bugs[bugId];
  if (!bug) return null;
  return bug;
}

function getUserLastBug(userId) {
  let last = null;
  for (const bugId of Object.keys(data.bugs)) {
    const bug = data.bugs[bugId];
    if (bug.reporterId === userId) {
      if (!last || bug.createdAt > last.createdAt) last = bug;
    }
  }
  return last;
}

function checkCooldown(userId) {
  const last = data.cooldowns[userId];
  if (!last) return { ok: true };
  const elapsed = Date.now() - last;
  if (elapsed < COOLDOWN) {
    return { ok: false, remaining: COOLDOWN - elapsed };
  }
  return { ok: true };
}

function checkRateLimit(userId) {
  const now = Date.now();
  const arr = (data.rateLimits[userId] || []).filter((t) => now - t < RATE_WINDOW);
  data.rateLimits[userId] = arr;
  if (arr.length >= RATE_LIMIT) {
    const retryAfter = RATE_WINDOW - (now - arr[0]);
    return { ok: false, retryAfter };
  }
  return { ok: true };
}

function recordReportAttempt(userId) {
  const now = Date.now();
  data.cooldowns[userId] = now;
  const arr = data.rateLimits[userId] || [];
  arr.push(now);
  data.rateLimits[userId] = arr;
}

async function safeReply(interaction, options) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(options);
    }
    return await interaction.reply(options);
  } catch (err) {
    console.error('[interaction] reply failed:', err.message);
    return null;
  }
}

function parseColor(input) {
  if (!input) return DEFAULT_EMBED_COLOR;
  const hex = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return parseInt(hex, 16);
  }
  return DEFAULT_EMBED_COLOR;
}

/* ============================================================
   รายชื่อบอทที่แอดมินตั้งไว้ให้เลือกตอนแจ้งบั๊ก
   ============================================================ */

function getBotList() {
  return Array.isArray(data.config.bots) ? data.config.bots : [];
}

function addBotToList(user) {
  if (!user.bot) return { ok: false, reason: 'not_bot' };
  const list = getBotList();
  if (list.some((b) => b.id === user.id)) {
    return { ok: false, reason: 'duplicate' };
  }
  if (list.length >= MAX_BOT_LIST) {
    return { ok: false, reason: 'full' };
  }
  list.push({ id: user.id, name: user.username });
  data.config.bots = list;
  saveData();
  return { ok: true };
}

function removeBotFromList(userId) {
  const list = getBotList();
  const next = list.filter((b) => b.id !== userId);
  if (next.length === list.length) return { ok: false };
  data.config.bots = next;
  saveData();
  return { ok: true };
}

/* ============================================================
   EMBED BUILDERS
   ============================================================ */

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bug_report_btn')
      .setLabel('แจ้งบั๊ก')
      .setEmoji('🚨')
      .setStyle(ButtonStyle.Danger)
  );
}

function buildPanelPreviewEmbed(draft) {
  const embed = new EmbedBuilder()
    .setTitle(draft.title)
    .setDescription(draft.description)
    .setColor(draft.color);
  if (draft.image) embed.setImage(draft.image);
  if (draft.footer) embed.setFooter({ text: draft.footer });
  return embed;
}

function buildPanelModal(draft) {
  const modal = new ModalBuilder().setCustomId('bug_panel_modal').setTitle('ตกแต่ง Panel แจ้งบั๊ก');

  const titleInput = new TextInputBuilder()
    .setCustomId('panel_title')
    .setLabel('หัวข้อ (Title)')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(256)
    .setRequired(true);
  if (draft && draft.title) titleInput.setValue(draft.title);

  const descInput = new TextInputBuilder()
    .setCustomId('panel_description')
    .setLabel('รายละเอียด (Description)')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(2000)
    .setRequired(true);
  if (draft && draft.description) descInput.setValue(draft.description);

  const imageInput = new TextInputBuilder()
    .setCustomId('panel_image')
    .setLabel('ลิงก์รูปภาพ (เว้นว่างได้)')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(300)
    .setRequired(false);
  if (draft && draft.image) imageInput.setValue(draft.image);

  const footerInput = new TextInputBuilder()
    .setCustomId('panel_footer')
    .setLabel('ข้อความท้าย Embed (เว้นว่างได้)')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(200)
    .setRequired(false);
  if (draft && draft.footer) footerInput.setValue(draft.footer);

  const colorInput = new TextInputBuilder()
    .setCustomId('panel_color')
    .setLabel('สีขอบ Embed เช่น #5865F2 (เว้นว่างได้)')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(7)
    .setRequired(false);
  if (draft && draft.colorRaw) colorInput.setValue(draft.colorRaw);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(descInput),
    new ActionRowBuilder().addComponents(imageInput),
    new ActionRowBuilder().addComponents(footerInput),
    new ActionRowBuilder().addComponents(colorInput)
  );
  return modal;
}

function buildTicketEmbed(bug) {
  return new EmbedBuilder()
    .setTitle(`🐛 ${bug.id}`)
    .addFields(
      { name: '👤 ผู้แจ้ง', value: `<@${bug.reporterId}>`, inline: false },
      { name: '📝 หัวข้อ', value: bug.title.slice(0, 1024), inline: false },
      { name: '📄 รายละเอียด', value: bug.description.slice(0, 1024), inline: false },
      { name: '🤖 บอทที่แจ้ง', value: bug.targetBot ? `<@${bug.targetBot}>` : '-', inline: true }
    )
    .setColor(DEFAULT_EMBED_COLOR)
    .setFooter({ text: `แจ้งเมื่อ ${new Date(bug.createdAt).toLocaleString('th-TH')}` });
}

function buildTicketRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bug_bot_btn').setLabel('เปลี่ยนบอท').setEmoji('🤖').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bug_close_btn').setLabel('ปิด (ลบ)').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
  );
}

/* ============================================================
   DISCORD CLIENT
   ============================================================ */

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

/* ------------------------------------------------------------
   ลงทะเบียน Slash command
   ------------------------------------------------------------ */

const commands = [
  new SlashCommandBuilder()
    .setName('bug')
    .setDescription('จัดการระบบแจ้งบั๊ก')
    .addSubcommand((sub) =>
      sub.setName('panel').setDescription('ตกแต่งและโพสต์แผงปุ่มแจ้งบั๊ก')
    )
    .addSubcommand((sub) =>
      sub
        .setName('blacklist')
        .setDescription('แบนไม่ให้ผู้ใช้คนนี้แจ้งบั๊ก')
        .addUserOption((opt) => opt.setName('user').setDescription('ผู้ใช้ที่ต้องการแบน').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('unblacklist')
        .setDescription('ปลดแบนผู้ใช้ออกจากลิสต์')
        .addUserOption((opt) => opt.setName('user').setDescription('ผู้ใช้ที่ต้องการปลดแบน').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-log-channel')
        .setDescription('ตั้งห้องสำหรับแจ้งเตือนเวลามีบั๊กใหม่')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('ห้อง log')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-admin-role')
        .setDescription('ตั้งยศแอดมินที่จัดการ Ticket ได้')
        .addRoleOption((opt) => opt.setName('role').setDescription('ยศแอดมิน').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-developer-role')
        .setDescription('ตั้งยศนักพัฒนาที่จัดการ Ticket ได้')
        .addRoleOption((opt) => opt.setName('role').setDescription('ยศนักพัฒนา').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-ticket-category')
        .setDescription('ตั้งหมวดหมู่ที่จะใช้สร้างห้อง Ticket')
        .addChannelOption((opt) =>
          opt
            .setName('category')
            .setDescription('หมวดหมู่ Ticket')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('bot')
        .setDescription('จัดการรายชื่อบอทที่ให้เลือกตอนแจ้งบั๊ก')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('เพิ่มบอทเข้าลิสต์ให้เลือก')
            .addUserOption((opt) => opt.setName('user').setDescription('บอทที่จะเพิ่มเข้าลิสต์').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('เอาบอทออกจากลิสต์')
            .addUserOption((opt) => opt.setName('user').setDescription('บอทที่จะเอาออกจากลิสต์').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('ดูรายชื่อบอททั้งหมดในลิสต์ตอนนี้')
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
];

async function registerCommands() {
  if (!TOKEN) return;
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const appId = CLIENT_ID || client.user.id;
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: commands });
      console.log('[commands] registered guild commands');
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: commands });
      console.log('[commands] registered global commands');
    }
  } catch (err) {
    console.error('[commands] registration failed:', err.message);
  }
}

/* ------------------------------------------------------------
   Ready
   ------------------------------------------------------------ */

client.once(Events.ClientReady, async () => {
  console.log(`[ready] logged in as ${client.user.tag}`);
  try {
    client.user.setPresence({
      activities: [{ name: 'Developer : LevelingX', type: ActivityType.Custom, state: 'Developer : LevelingX' }],
      status: 'online',
    });
  } catch (err) {
    console.error('[presence] failed to set presence:', err.message);
  }
  await registerCommands();
});

/* ------------------------------------------------------------
   แจ้งเตือนต่าง ๆ
   ------------------------------------------------------------ */

async function sendNewTicketLog(bug) {
  if (!data.config.logChannelId) return;
  try {
    const channel = await client.channels.fetch(data.config.logChannelId).catch(() => null);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('🆕 มีการแจ้งบั๊กใหม่')
      .setDescription(`${bug.id}\n${bug.title.slice(0, 1024)}`)
      .addFields(
        { name: 'บอท', value: bug.targetBot ? `<@${bug.targetBot}>` : '-', inline: true },
        { name: 'ผู้แจ้ง', value: `<@${bug.reporterId}>`, inline: true }
      )
      .setColor(DEFAULT_EMBED_COLOR);
    await channel.send({ content: bug.channelId ? `<#${bug.channelId}>` : undefined, embeds: [embed] });
  } catch (err) {
    console.error('[log] failed to send new ticket log:', err.message);
  }
}

async function sendTicketUpdate(channel, title, bugId, fromText, toText) {
  try {
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(`${bugId}\n${fromText} → ${toText}`)
      .setColor(0xfee75c);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[ticket update] failed to send:', err.message);
  }
}

/* ------------------------------------------------------------
   สร้างห้อง Ticket
   ------------------------------------------------------------ */

async function createTicketChannel(guild, bug) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: bug.reporterId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory],
    },
  ];
  if (data.config.adminRoleId) {
    overwrites.push({
      id: data.config.adminRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }
  if (data.config.developerRoleId) {
    overwrites.push({
      id: data.config.developerRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const channelOptions = {
    name: bug.id.toLowerCase(),
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    topic: `${bug.id} | Reporter: ${bug.reporterId}`,
  };
  if (data.config.ticketCategoryId) channelOptions.parent = data.config.ticketCategoryId;

  return guild.channels.create(channelOptions);
}

/* ------------------------------------------------------------
   Interaction handling
   ------------------------------------------------------------ */

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    } else if (interaction.isChannelSelectMenu()) {
      await handlePanelChannelSelected(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
    }
  } catch (err) {
    console.error('[interaction] unhandled error:', err);
    await safeReply(interaction, { content: '⚠️ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง', ephemeral: true }).catch(() => {});
  }
});

/* -------------------- Slash commands -------------------- */

async function handleSlashCommand(interaction) {
  if (interaction.commandName !== 'bug') return;

  const group = interaction.options.getSubcommandGroup(false);
  if (group === 'bot') {
    return handleBotListCommand(interaction, interaction.options.getSubcommand());
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'panel') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const existingDraft = getPanelDraft(interaction.user.id);
    return interaction.showModal(buildPanelModal(existingDraft));
  }

  if (sub === 'blacklist' || sub === 'unblacklist') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const user = interaction.options.getUser('user', true);
    if (sub === 'blacklist') {
      if (!data.blacklist.includes(user.id)) data.blacklist.push(user.id);
      saveData();
      return safeReply(interaction, { content: `🚫 บล็อก <@${user.id}> จากการแจ้งบั๊กแล้ว`, ephemeral: true });
    } else {
      data.blacklist = data.blacklist.filter((id) => id !== user.id);
      saveData();
      return safeReply(interaction, { content: `✅ ปลดบล็อก <@${user.id}> แล้ว`, ephemeral: true });
    }
  }

  if (sub === 'set-log-channel') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const channel = interaction.options.getChannel('channel', true);
    data.config.logChannelId = channel.id;
    saveData();
    return safeReply(interaction, { content: `✅ ตั้งค่าห้อง Log เป็น <#${channel.id}> แล้ว`, ephemeral: true });
  }

  if (sub === 'set-admin-role') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const role = interaction.options.getRole('role', true);
    data.config.adminRoleId = role.id;
    saveData();
    return safeReply(interaction, { content: `✅ ตั้งค่ายศแอดมินเป็น <@&${role.id}> แล้ว`, ephemeral: true });
  }

  if (sub === 'set-developer-role') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const role = interaction.options.getRole('role', true);
    data.config.developerRoleId = role.id;
    saveData();
    return safeReply(interaction, { content: `✅ ตั้งค่ายศนักพัฒนาเป็น <@&${role.id}> แล้ว`, ephemeral: true });
  }

  if (sub === 'set-ticket-category') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const category = interaction.options.getChannel('category', true);
    data.config.ticketCategoryId = category.id;
    saveData();
    return safeReply(interaction, { content: `✅ ตั้งค่าหมวดหมู่ Ticket เป็น **${category.name}** แล้ว`, ephemeral: true });
  }
}

async function handleBotListCommand(interaction, sub) {
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
  }

  if (sub === 'add') {
    const user = interaction.options.getUser('user', true);
    const result = addBotToList(user);
    if (!result.ok) {
      const msg =
        result.reason === 'not_bot' ? '⚠️ ต้องเลือกบัญชีที่เป็นบอทเท่านั้นนะ' :
        result.reason === 'duplicate' ? '⚠️ มีบอทนี้อยู่ในลิสต์อยู่แล้ว' :
        result.reason === 'full' ? `⚠️ ลิสต์เต็มแล้ว (สูงสุด ${MAX_BOT_LIST} รายการ)` :
        '⚠️ เกิดข้อผิดพลาด';
      return safeReply(interaction, { content: msg, ephemeral: true });
    }
    return safeReply(interaction, { content: `✅ เพิ่ม <@${user.id}> เข้าลิสต์ให้เลือกตอนแจ้งบั๊กแล้ว`, ephemeral: true });
  }

  if (sub === 'remove') {
    const user = interaction.options.getUser('user', true);
    const result = removeBotFromList(user.id);
    if (!result.ok) {
      return safeReply(interaction, { content: '⚠️ ไม่พบบอทนี้ในลิสต์', ephemeral: true });
    }
    return safeReply(interaction, { content: `✅ เอา <@${user.id}> ออกจากลิสต์แล้ว`, ephemeral: true });
  }

  if (sub === 'list') {
    const list = getBotList();
    if (list.length === 0) {
      return safeReply(interaction, { content: 'ตอนนี้ยังไม่มีบอทในลิสต์เลย ใช้ `/bug bot add` เพื่อเพิ่มก่อนนะ', ephemeral: true });
    }
    const listText = list.map((b, i) => `${i + 1}. <@${b.id}>`).join('\n');
    return safeReply(interaction, { content: `📋 รายชื่อบอทที่แจ้งบั๊กได้ตอนนี้:\n${listText}`, ephemeral: true });
  }
}

/* -------------------- Buttons -------------------- */

async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === 'bug_report_btn') return handleReportButton(interaction);
  if (id === 'bug_report_new_anyway') return handleCreateNewAnyway(interaction);
  if (id === 'bug_bot_btn') return handleBotButton(interaction);
  if (id === 'bug_close_btn') return handleCloseButton(interaction);
  if (id === 'bug_panel_confirm') return handlePanelConfirm(interaction);
  if (id === 'bug_panel_edit') return handlePanelEdit(interaction);
  if (id === 'bug_panel_cancel') return handlePanelCancel(interaction);
}

async function handleReportButton(interaction) {
  const userId = interaction.user.id;

  if (isBlacklisted(userId)) {
    return safeReply(interaction, { content: '🚫 คุณถูกระงับสิทธิ์การแจ้งบั๊ก', ephemeral: true });
  }

  const active = getUserActiveBug(userId);
  if (active) {
    return safeReply(interaction, {
      content: `⚠️ คุณมี Ticket ที่ยังเปิดอยู่: **${active.id}** กรุณารอให้ปิดก่อน`,
      ephemeral: true,
    });
  }

  const cd = checkCooldown(userId);
  if (!cd.ok) {
    return safeReply(interaction, {
      content: `⏳ กรุณารออีก ${formatDuration(cd.remaining)} ก่อนแจ้งบั๊กครั้งถัดไป`,
      ephemeral: true,
    });
  }

  const rl = checkRateLimit(userId);
  if (!rl.ok) {
    return safeReply(interaction, {
      content: `🚦 คุณส่งรายงานถี่เกินไป กรุณารออีก ${formatDuration(rl.retryAfter)}`,
      ephemeral: true,
    });
  }

  const modal = new ModalBuilder().setCustomId('bug_report_modal').setTitle('🐛 แจ้งบั๊ก');
  const titleInput = new TextInputBuilder()
    .setCustomId('bug_title')
    .setLabel('หัวข้อบั๊ก')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);
  const descInput = new TextInputBuilder()
    .setCustomId('bug_description')
    .setLabel('รายละเอียดบั๊ก')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(true);
  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(descInput)
  );
  await interaction.showModal(modal);
}

async function handleCreateNewAnyway(interaction) {
  const userId = interaction.user.id;
  const pending = getPending(userId);
  if (!pending) {
    return safeReply(interaction, { content: '⚠️ ไม่พบข้อมูลรายงานที่ค้างไว้ กรุณาเริ่มใหม่', ephemeral: true });
  }
  await presentBotSelect(interaction, pending);
}

async function handleBotButton(interaction) {
  const bug = data.bugs[getBugIdFromChannel(interaction.channelId)];
  if (!bug) return safeReply(interaction, { content: '⚠️ ไม่พบข้อมูล Bug ของ Ticket นี้', ephemeral: true });
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์เปลี่ยนบอทที่แจ้ง', ephemeral: true });
  }
  const list = getBotList();
  if (list.length === 0) {
    return safeReply(interaction, { content: '⚠️ ยังไม่มีรายชื่อบอทให้เลือกเลย (ใช้ /bug bot add ก่อน)', ephemeral: true });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`bug_bot_select_${bug.id}`)
    .setPlaceholder('เลือกบอทใหม่')
    .addOptions(
      list.slice(0, MAX_BOT_LIST).map((b) => ({
        label: b.name.slice(0, 100),
        value: b.id,
        default: b.id === bug.targetBot,
      }))
    );
  await safeReply(interaction, { components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true, content: `เปลี่ยนบอทที่แจ้งของ ${bug.id}` });
}

async function handleCloseButton(interaction) {
  const bugId = getBugIdFromChannel(interaction.channelId);
  const bug = data.bugs[bugId];
  if (!bug) return safeReply(interaction, { content: '⚠️ ไม่พบข้อมูล Bug ของ Ticket นี้', ephemeral: true });
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ปิด Ticket', ephemeral: true });
  }
  await safeReply(interaction, { content: `🗑️ กำลังลบ Ticket ${bug.id}...` });
  await deleteTicket(bug, interaction.channel);
}

/* -------------------- Modal submit -------------------- */

async function handleModalSubmit(interaction) {
  if (interaction.customId === 'bug_report_modal') return handleReportModalSubmit(interaction);
  if (interaction.customId === 'bug_panel_modal') return handlePanelModalSubmit(interaction);
}

async function handleReportModalSubmit(interaction) {
  const userId = interaction.user.id;

  // เช็คซ้ำอีกรอบเผื่อมีอะไรเปลี่ยนไประหว่างกดปุ่มกับตอนกด submit modal
  if (isBlacklisted(userId)) {
    return safeReply(interaction, { content: '🚫 คุณถูกระงับสิทธิ์การแจ้งบั๊ก', ephemeral: true });
  }
  if (getUserActiveBug(userId)) {
    return safeReply(interaction, { content: '⚠️ คุณมี Ticket ที่ยังเปิดอยู่แล้ว', ephemeral: true });
  }
  const cd = checkCooldown(userId);
  if (!cd.ok) {
    return safeReply(interaction, { content: `⏳ กรุณารออีก ${formatDuration(cd.remaining)}`, ephemeral: true });
  }
  const rl = checkRateLimit(userId);
  if (!rl.ok) {
    return safeReply(interaction, { content: `🚦 คุณส่งรายงานถี่เกินไป กรุณารออีก ${formatDuration(rl.retryAfter)}`, ephemeral: true });
  }

  const title = interaction.fields.getTextInputValue('bug_title').trim();
  const description = interaction.fields.getTextInputValue('bug_description').trim();

  if (!title || !description) {
    return safeReply(interaction, { content: '⚠️ กรุณากรอกข้อมูลให้ครบถ้วน', ephemeral: true });
  }

  // เช็คว่าซ้ำกับบั๊กล่าสุดของคนเดิมไหม (เทียบด้วย jaccard)
  const lastBug = getUserLastBug(userId);
  if (lastBug) {
    const similarity = jaccardSimilarity(title, lastBug.title);
    if (similarity >= DUPLICATE_THRESHOLD) {
      setPending(userId, { title, description });
      const embed = new EmbedBuilder()
        .setTitle('🔎 อาจจะซ้ำกับรายงานเดิม')
        .setDescription(`${lastBug.id}\nหัวข้อ: ${lastBug.title.slice(0, 500)}`)
        .setColor(0xfee75c);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bug_report_new_anyway').setLabel('สร้าง Bug ใหม่').setStyle(ButtonStyle.Primary)
      );
      if (lastBug.channelId) {
        row.addComponents(
          new ButtonBuilder()
            .setLabel('ดู Bug เดิม')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${interaction.guildId}/${lastBug.channelId}`)
        );
      }
      return safeReply(interaction, { embeds: [embed], components: [row], ephemeral: true });
    }
  }

  await presentBotSelect(interaction, { title, description });
}

async function handlePanelModalSubmit(interaction) {
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
  }

  const title = interaction.fields.getTextInputValue('panel_title').trim();
  const description = interaction.fields.getTextInputValue('panel_description').trim();
  const image = interaction.fields.getTextInputValue('panel_image').trim();
  const footer = interaction.fields.getTextInputValue('panel_footer').trim();
  const colorRaw = interaction.fields.getTextInputValue('panel_color').trim();

  if (!title || !description) {
    return safeReply(interaction, { content: '⚠️ กรุณากรอกหัวข้อและรายละเอียดด้วย', ephemeral: true });
  }

  const validImage = /^https?:\/\//i.test(image) ? image : null;
  const color = parseColor(colorRaw);

  const draft = {
    title,
    description,
    image: validImage,
    footer: footer || null,
    color,
    colorRaw: colorRaw || null,
  };
  setPanelDraft(interaction.user.id, draft);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bug_panel_confirm').setLabel('ยืนยัน').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('bug_panel_edit').setLabel('แก้ไข').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bug_panel_cancel').setLabel('ยกเลิก').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
  );

  await safeReply(interaction, {
    content: 'นี่คือตัวอย่าง Panel ที่จะโพสต์ ลองดูก่อนแล้วค่อยเลือกว่าจะยืนยัน / แก้ไข / ยกเลิก',
    embeds: [buildPanelPreviewEmbed(draft)],
    components: [row],
    ephemeral: true,
  });
}

async function presentBotSelect(interaction, payload) {
  const list = getBotList();
  if (list.length === 0) {
    // ไม่ล้าง pending ตรงนี้ เผื่อแอดมินรีบเพิ่มลิสต์แล้วผู้ใช้กด "สร้าง Bug ใหม่" ซ้ำได้ทันที
    return safeReply(interaction, {
      content: '⚠️ แอดมินยังไม่ได้ตั้งรายชื่อบอทให้เลือกเลย รบกวนแจ้งแอดมินให้เพิ่มก่อน (คำสั่ง `/bug bot add`)',
      ephemeral: true,
    });
  }

  setPending(interaction.user.id, payload);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('bug_new_bot_select')
    .setPlaceholder('เลือกบอทที่เจอบั๊ก')
    .addOptions(
      list.slice(0, MAX_BOT_LIST).map((b) => ({ label: b.name.slice(0, 100), value: b.id }))
    );
  await safeReply(interaction, {
    content: 'กรุณาเลือกว่าบั๊กนี้เจอในบอทตัวไหน',
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  });
}

/* -------------------- Panel flow (confirm / edit / cancel / ส่งไปห้องไหน) -------------------- */

async function handlePanelConfirm(interaction) {
  const draft = getPanelDraft(interaction.user.id);
  if (!draft) {
    return safeReply(interaction, { content: '⚠️ ข้อมูล Panel หมดอายุแล้ว กรุณาใช้ `/bug panel` ใหม่', embeds: [], components: [] });
  }

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('bug_panel_channel_select')
    .setPlaceholder('เลือกห้องที่จะส่ง Panel นี้')
    .addChannelTypes(ChannelType.GuildText);

  await safeReply(interaction, {
    content: 'จะส่ง Panel นี้ไว้ห้องไหน?',
    embeds: [],
    components: [new ActionRowBuilder().addComponents(channelSelect)],
  });
}

async function handlePanelEdit(interaction) {
  const draft = getPanelDraft(interaction.user.id);
  await interaction.showModal(buildPanelModal(draft));
}

async function handlePanelCancel(interaction) {
  clearPanelDraft(interaction.user.id);
  await safeReply(interaction, { content: '🗑️ ยกเลิกการสร้าง Panel แล้ว', embeds: [], components: [] });
}

async function handlePanelChannelSelected(interaction) {
  if (interaction.customId !== 'bug_panel_channel_select') return;

  const draft = getPanelDraft(interaction.user.id);
  if (!draft) {
    return safeReply(interaction, { content: '⚠️ ข้อมูล Panel หมดอายุแล้ว กรุณาใช้ `/bug panel` ใหม่', embeds: [], components: [] });
  }

  const channel = interaction.channels.first();
  if (!channel || !channel.isTextBased()) {
    return safeReply(interaction, { content: '⚠️ เลือกห้องไม่ถูกต้อง ลองใหม่อีกครั้ง', components: [] });
  }

  clearPanelDraft(interaction.user.id);

  try {
    await channel.send({ embeds: [buildPanelPreviewEmbed(draft)], components: [buildPanelRow()] });
    await safeReply(interaction, { content: `✅ โพสต์ Panel ไว้ที่ <#${channel.id}> เรียบร้อยแล้ว`, embeds: [], components: [] });
  } catch (err) {
    console.error('[panel] failed to send:', err.message);
    await safeReply(interaction, { content: '⚠️ ส่ง Panel ไม่สำเร็จ เช็คสิทธิ์บอทในห้องนั้นด้วยนะ', embeds: [], components: [] });
  }
}

/* -------------------- Select menus -------------------- */

async function handleSelectMenu(interaction) {
  const id = interaction.customId;

  if (id === 'bug_new_bot_select') {
    return handleNewBotSelected(interaction);
  }
  if (id.startsWith('bug_bot_select_')) {
    return handleBotSelected(interaction, id.replace('bug_bot_select_', ''));
  }
}

async function handleNewBotSelected(interaction) {
  const userId = interaction.user.id;
  const pending = getPending(userId);
  if (!pending) {
    return safeReply(interaction, { content: 'ข้อมูลรายงานหมดอายุ กรุณาเริ่มใหม่', ephemeral: true });
  }

  // กันเคสสุดท้ายก่อนสร้าง ticket จริง เผื่อมีอะไรเปลี่ยนระหว่างที่เลือกบอทอยู่
  if (isBlacklisted(userId)) {
    clearPending(userId);
    return safeReply(interaction, { content: '🚫 คุณถูกระงับสิทธิ์การแจ้งบั๊ก', ephemeral: true });
  }
  if (getUserActiveBug(userId)) {
    clearPending(userId);
    return safeReply(interaction, { content: 'คุณมี Ticket ที่ยังเปิดอยู่แล้ว', ephemeral: true });
  }

  const targetBot = interaction.values[0];
  await interaction.deferUpdate().catch(() => {});
  clearPending(userId);

  const guild = interaction.guild;
  if (!guild) {
    return safeReply(interaction, { content: 'คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์เท่านั้น', ephemeral: true });
  }

  let bug;
  await withLock(async () => {
    data.counter += 1;
    const bugId = `BUG-${String(data.counter).padStart(4, '0')}`;
    bug = {
      id: bugId,
      reporterId: userId,
      title: pending.title,
      description: pending.description,
      targetBot,
      createdAt: Date.now(),
      channelId: null,
    };
    data.bugs[bugId] = bug;
    data.activeTickets[userId] = bugId;
    recordReportAttempt(userId);
    saveData();
  });

  try {
    const channel = await createTicketChannel(guild, bug);
    bug.channelId = channel.id;
    saveData();

    await channel.send({ embeds: [buildTicketEmbed(bug)], components: [buildTicketRow()] });
    await sendNewTicketLog(bug);

    await safeReply(interaction, {
      content: `✅ สร้างรายงานบั๊ก **${bug.id}** เรียบร้อยแล้ว: <#${channel.id}>`,
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error('[ticket] failed to create channel:', err.message);
    delete data.activeTickets[userId];
    saveData();
    await safeReply(interaction, { content: '⚠️ ไม่สามารถสร้าง Ticket ได้ กรุณาแจ้งแอดมิน', components: [], embeds: [] });
  }
}

async function handleBotSelected(interaction, bugId) {
  const bug = data.bugs[bugId];
  if (!bug) return safeReply(interaction, { content: '⚠️ ไม่พบ Bug นี้', ephemeral: true });
  const newBot = interaction.values[0];
  await interaction.deferUpdate().catch(() => {});
  const channel = interaction.channel;
  await applyBotChange(bug, newBot, channel);
}

/* -------------------- State transitions -------------------- */

async function applyBotChange(bug, newBot, channel) {
  const oldBot = bug.targetBot;
  if (oldBot === newBot) return;
  bug.targetBot = newBot;
  saveData();

  if (channel) {
    await sendTicketUpdate(channel, '🤖 เปลี่ยนบอทที่แจ้ง', bug.id, oldBot ? `<@${oldBot}>` : '-', `<@${newBot}>`);
    await refreshTicketEmbed(channel, bug);
  }
}

async function refreshTicketEmbed(channel, bug) {
  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    const botMsg = messages.find(
      (m) => m.author.id === client.user.id && m.embeds[0] && m.embeds[0].title === `🐛 ${bug.id}`
    );
    if (botMsg) {
      await botMsg.edit({ embeds: [buildTicketEmbed(bug)], components: [buildTicketRow()] });
    }
  } catch (err) {
    console.error('[ticket] failed to refresh embed:', err.message);
  }
}

async function deleteTicket(bug, channel) {
  if (data.activeTickets[bug.reporterId] === bug.id) {
    delete data.activeTickets[bug.reporterId];
  }
  delete data.bugs[bug.id];
  saveData();

  if (channel) {
    try {
      await channel.delete(`ปิด Ticket ${bug.id}`);
    } catch (err) {
      console.error('[ticket] failed to delete channel:', err.message);
    }
  }
}

/* -------------------- Helpers -------------------- */

function getBugIdFromChannel(channelId) {
  for (const bugId of Object.keys(data.bugs)) {
    if (data.bugs[bugId].channelId === channelId) return bugId;
  }
  return null;
}

/* ============================================================
   KEEP-ALIVE SERVER (สำหรับ Render ฟรี ที่ต้องมี PORT เปิดไว้เช็ค health)
   ถ้ารันเป็น Background Worker ไม่มี PORT ให้มา ก็แค่ข้ามส่วนนี้ไปเฉย ๆ
   ============================================================ */

const PORT = process.env.PORT;

if (PORT) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('bot is alive');
    })
    .listen(PORT, () => {
      console.log(`[keepalive] listening on port ${PORT}`);
    });
}

/* ============================================================
   SAFETY NETS
   ============================================================ */

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

/* ============================================================
   LOGIN
   ============================================================ */

if (!TOKEN) {
  console.error('[fatal] DISCORD_TOKEN environment variable is not set.');
  process.exit(1);
}

client.login(TOKEN).catch((err) => {
  console.error('[fatal] failed to login:', err.message);
  process.exit(1);
});
