'use strict';

/* ============================================================
   Discord Bug Report Bot - single-file implementation
   ============================================================ */

const fs = require('fs');
const path = require('path');
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
  SlashCommandBuilder,
  Routes,
  REST,
} = require('discord.js');

/* ============================================================
   CONFIG - default values (override via Environment Variables)
   ============================================================ */

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || null;
const GUILD_ID = process.env.GUILD_ID || null;
// TICKET_CATEGORY_ID is configured at runtime via /bug set-ticket-category and stored in data.config
// LOG_CHANNEL_ID / ANNOUNCE_CHANNEL_ID / ADMIN_ROLE_ID / DEVELOPER_ROLE_ID
// are configured at runtime via /bug config commands and stored in data.json (data.config)

const COOLDOWN = 5 * 60 * 1000;                // 5 minutes
const RATE_LIMIT = 3;                          // 3 reports
const RATE_WINDOW = 10 * 60 * 1000;            // per 10 minutes
const CRITICAL_ESCALATION = 6 * 60 * 60 * 1000; // 6 hours
const ESCALATION_CHECK_INTERVAL = 5 * 60 * 1000; // check every 5 min
const DUPLICATE_THRESHOLD = 0.5;               // jaccard similarity
const PENDING_TTL = 10 * 60 * 1000;            // 10 min in-memory pending reports

const DATA_FILE = path.join(__dirname, 'data.json');

/* ============================================================
   STORAGE
   ============================================================ */

const DEFAULT_DATA = {
  counter: 0,
  bugs: {},          // bugId -> bug object
  blacklist: [],      // array of userIds
  activeTickets: {},  // userId -> bugId
  cooldowns: {},      // userId -> timestamp of last report
  rateLimits: {},     // userId -> [timestamps]
  config: {
    logChannelId: null,
    announceChannelId: null,
    adminRoleId: null,
    developerRoleId: null,
    ticketCategoryId: null,
    // customizable panel embed (edit via /bug embed)
    panelEmbed: {
      title: 'Tickets Report Bug Bot',
      description: 'กดปุ่มด้านล่างเพื่อรายงานบัคที่เกิดขึ้น ( กดเล่นโดน Blacklist )',
      color: 0x5865f2,
      image: null,
      footer: null,
    },
  },
};

// Deep-merge helper so that older/partial data.json files (saved before new
// config fields existed) don't wipe out newly-added defaults. A plain
// Object.assign only merges top-level keys, so nested objects like
// `config` or `config.panelEmbed` would otherwise be replaced wholesale
// and lose any new sub-fields, causing "Cannot read properties of
// undefined" crashes after an update.
function deepMerge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (override && typeof override === 'object') {
      for (const key of Object.keys(override)) {
        out[key] = deepMerge(base[key], override[key]);
      }
    }
    return out;
  }
  return override === undefined ? base : override;
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return deepMerge(JSON.parse(JSON.stringify(DEFAULT_DATA)), parsed);
  } catch (err) {
    console.error('[storage] failed to load data.json, using defaults:', err.message);
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

let data = loadData();

// simple write lock to avoid concurrent/racy writes corrupting the file
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

// mutex for critical sections (bug id creation etc.)
let mutex = Promise.resolve();
function withLock(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.catch(() => {});
  return run;
}

/* ============================================================
   CONSTANTS / MAPS
   ============================================================ */

const SEVERITY = {
  low: { emoji: '🟢', label: 'Low' },
  medium: { emoji: '🟡', label: 'Medium' },
  high: { emoji: '🟠', label: 'High' },
  critical: { emoji: '🔴', label: 'Critical' },
};

const STATUS = {
  open: { emoji: '🟡', label: 'Open' },
  investigating: { emoji: '🔵', label: 'Investigating' },
  in_progress: { emoji: '🟠', label: 'In Progress' },
  fixed: { emoji: '🟢', label: 'Fixed' },
  closed: { emoji: '⚫', label: 'Closed' },
  rejected: { emoji: '🔴', label: 'Rejected' },
};

const RESOLVED_STATUSES = ['fixed'];
const TERMINAL_STATUSES = ['fixed', 'closed', 'rejected'];

function sevText(key) {
  const s = SEVERITY[key] || SEVERITY.low;
  return `${s.emoji} ${s.label}`;
}
function statusText(key) {
  const s = STATUS[key] || STATUS.open;
  return `${s.emoji} ${s.label}`;
}

/* ============================================================
   IN-MEMORY PENDING REPORTS (title/description before severity picked)
   ============================================================ */

const pendingReports = new Map(); // userId -> { title, description, expiresAt }

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
setInterval(() => {
  const now = Date.now();
  for (const [uid, p] of pendingReports.entries()) {
    if (now > p.expiresAt) pendingReports.delete(uid);
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

function parseHexColor(str) {
  const cleaned = String(str).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
  return parseInt(cleaned, 16);
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
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

/* ============================================================
   EMBED BUILDERS
   ============================================================ */

function buildPanelEmbed() {
  const cfg = data.config.panelEmbed || DEFAULT_DATA.config.panelEmbed;
  const embed = new EmbedBuilder()
    .setTitle(cfg.title || DEFAULT_DATA.config.panelEmbed.title)
    .setDescription(cfg.description || DEFAULT_DATA.config.panelEmbed.description)
    .setColor(typeof cfg.color === 'number' ? cfg.color : DEFAULT_DATA.config.panelEmbed.color);
  if (cfg.image) embed.setImage(cfg.image);
  if (cfg.footer) embed.setFooter({ text: cfg.footer });
  return embed;
}

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bug_report_btn')
      .setLabel('Report Bug')
      .setEmoji('🚨')
      .setStyle(ButtonStyle.Danger)
  );
}

function computeResolutionMs(bug) {
  const end = bug.fixedAt || Date.now();
  return end - bug.createdAt;
}

function buildTicketEmbed(bug) {
  const embed = new EmbedBuilder()
    .setTitle(`🐛 ${bug.id}`)
    .addFields(
      { name: '👤 Reporter', value: `<@${bug.reporterId}>`, inline: false },
      { name: '📝 Title', value: bug.title.slice(0, 1024), inline: false },
      { name: '📄 Description', value: bug.description.slice(0, 1024), inline: false },
      { name: '🚨 Severity', value: sevText(bug.severity), inline: true },
      { name: '🔄 Status', value: statusText(bug.status), inline: true },
      { name: '⏱️ Resolution Time', value: formatDuration(computeResolutionMs(bug)), inline: true }
    )
    .setColor(bug.severity === 'critical' ? 0xed4245 : 0x5865f2)
    .setFooter({ text: `Created ${new Date(bug.createdAt).toLocaleString()}` });
  return embed;
}

function buildTicketRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bug_status_btn').setLabel('Status').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bug_severity_btn').setLabel('Severity').setEmoji('🚨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bug_resolve_btn').setLabel('Resolve').setEmoji('📢').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('bug_close_btn').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger)
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
   Slash command registration
   ------------------------------------------------------------ */

const commands = [
  new SlashCommandBuilder()
    .setName('bug')
    .setDescription('Bug report system management')
    .addSubcommand((sub) =>
      sub.setName('panel').setDescription('Post the bug report panel in this channel')
    )
    .addSubcommand((sub) =>
      sub
        .setName('blacklist')
        .setDescription('Blacklist a user from reporting bugs')
        .addUserOption((opt) => opt.setName('user').setDescription('User to blacklist').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('unblacklist')
        .setDescription('Remove a user from the blacklist')
        .addUserOption((opt) => opt.setName('user').setDescription('User to unblacklist').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-log-channel')
        .setDescription('Set the channel for critical/escalation alerts')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Log channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-announce-channel')
        .setDescription('Set the channel for resolved bug announcements')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Announcement channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-admin-role')
        .setDescription('Set the admin role allowed to manage tickets')
        .addRoleOption((opt) => opt.setName('role').setDescription('Admin role').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-developer-role')
        .setDescription('Set the developer role allowed to manage tickets')
        .addRoleOption((opt) => opt.setName('role').setDescription('Developer role').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-ticket-category')
        .setDescription('Set the category where bug ticket channels are created')
        .addChannelOption((opt) =>
          opt
            .setName('category')
            .setDescription('Ticket category')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('embed')
        .setDescription('Customize the report panel embed (title/description/image/footer/color)')
        .addStringOption((opt) => opt.setName('title').setDescription('Embed title').setMaxLength(256))
        .addStringOption((opt) => opt.setName('description').setDescription('Embed description').setMaxLength(4000))
        .addStringOption((opt) => opt.setName('color').setDescription('Hex color, e.g. #5865F2'))
        .addStringOption((opt) =>
          opt.setName('image').setDescription('Image URL (use "none" to remove)')
        )
        .addStringOption((opt) =>
          opt.setName('footer').setDescription('Footer text (use "none" to remove)').setMaxLength(2048)
        )
        .addBooleanOption((opt) => opt.setName('reset').setDescription('Reset the panel embed to default'))
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
  setInterval(runEscalationCheck, ESCALATION_CHECK_INTERVAL).unref();
});

/* ------------------------------------------------------------
   Escalation check
   ------------------------------------------------------------ */

async function runEscalationCheck() {
  try {
    const now = Date.now();
    for (const bugId of Object.keys(data.bugs)) {
      const bug = data.bugs[bugId];
      if (bug.severity !== 'critical') continue;
      if (TERMINAL_STATUSES.includes(bug.status)) continue;
      if (bug.escalated) continue;
      const since = bug.criticalSince || bug.createdAt;
      if (now - since >= CRITICAL_ESCALATION) {
        bug.escalated = true;
        saveData();
        await sendEscalationAlert(bug);
      }
    }
  } catch (err) {
    console.error('[escalation] check failed:', err.message);
  }
}

async function sendEscalationAlert(bug) {
  if (!data.config.logChannelId) return;
  try {
    const channel = await client.channels.fetch(data.config.logChannelId).catch(() => null);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('⏰ CRITICAL ESCALATION')
      .setDescription(`${bug.id}\nBug นี้อยู่ในสถานะ Critical เกิน ${formatDuration(CRITICAL_ESCALATION)} แล้ว`)
      .addFields(
        { name: 'Title', value: bug.title.slice(0, 1024) },
        { name: 'Status', value: statusText(bug.status), inline: true },
        { name: 'Elapsed', value: formatDuration(Date.now() - (bug.criticalSince || bug.createdAt)), inline: true }
      )
      .setColor(0xed4245);
    await channel.send({ content: bug.channelId ? `<#${bug.channelId}>` : undefined, embeds: [embed] });
  } catch (err) {
    console.error('[escalation] failed to send alert:', err.message);
  }
}

async function sendCriticalAlert(bug) {
  if (!data.config.logChannelId) return;
  try {
    const channel = await client.channels.fetch(data.config.logChannelId).catch(() => null);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('🔴 CRITICAL BUG ALERT')
      .setDescription(`${bug.id}\n${bug.title.slice(0, 1024)}`)
      .addFields({ name: 'Status', value: statusText(bug.status), inline: true })
      .setColor(0xed4245);
    await channel.send({ content: bug.channelId ? `<#${bug.channelId}>` : undefined, embeds: [embed] });
  } catch (err) {
    console.error('[critical] failed to send alert:', err.message);
  }
}

async function sendResolvedAnnouncement(bug) {
  if (!data.config.announceChannelId) return;
  try {
    const channel = await client.channels.fetch(data.config.announceChannelId).catch(() => null);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('✅ BUG RESOLVED')
      .setDescription(`${bug.id}\nปัญหา: ${bug.title.slice(0, 1024)}`)
      .addFields({ name: 'Status', value: statusText(bug.status), inline: true })
      .setColor(0x57f287);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[announcement] failed to send:', err.message);
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
   Ticket channel creation
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
  const sub = interaction.options.getSubcommand();

  if (sub === 'panel') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    await interaction.reply({ embeds: [buildPanelEmbed()], components: [buildPanelRow()] });
    return;
  }

  if (sub === 'blacklist' || sub === 'unblacklist') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const user = interaction.options.getUser('user', true);
    if (sub === 'blacklist') {
      if (!data.blacklist.includes(user.id)) data.blacklist.push(user.id);
      saveData();
      return safeReply(interaction, { content: `🚫 บล็อก <@${user.id}> จากการรายงานบั๊กแล้ว`, ephemeral: true });
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
    return safeReply(interaction, { content: `✅ ตั้งค่า Log Channel เป็น <#${channel.id}> แล้ว`, ephemeral: true });
  }

  if (sub === 'set-announce-channel') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const channel = interaction.options.getChannel('channel', true);
    data.config.announceChannelId = channel.id;
    saveData();
    return safeReply(interaction, { content: `✅ ตั้งค่า Announcement Channel เป็น <#${channel.id}> แล้ว`, ephemeral: true });
  }

  if (sub === 'set-admin-role') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const role = interaction.options.getRole('role', true);
    data.config.adminRoleId = role.id;
    saveData();
    return safeReply(interaction, { content: `✅ ตั้งค่า Admin Role เป็น <@&${role.id}> แล้ว`, ephemeral: true });
  }

  if (sub === 'set-developer-role') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const role = interaction.options.getRole('role', true);
    data.config.developerRoleId = role.id;
    saveData();
    return safeReply(interaction, { content: `✅ ตั้งค่า Developer Role เป็น <@&${role.id}> แล้ว`, ephemeral: true });
  }

  if (sub === 'set-ticket-category') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }
    const category = interaction.options.getChannel('category', true);
    data.config.ticketCategoryId = category.id;
    saveData();
    return safeReply(interaction, { content: `✅ ตั้งค่า Ticket Category เป็น **${category.name}** แล้ว`, ephemeral: true });
  }

  if (sub === 'embed') {
    if (!isAdmin(interaction.member)) {
      return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
    }

    const reset = interaction.options.getBoolean('reset');
    if (reset) {
      data.config.panelEmbed = { ...DEFAULT_DATA.config.panelEmbed };
      saveData();
      return safeReply(interaction, {
        content: '✅ รีเซ็ต Panel Embed กลับเป็นค่าเริ่มต้นแล้ว ใช้ `/bug panel` เพื่อโพสต์ใหม่',
        embeds: [buildPanelEmbed()],
        ephemeral: true,
      });
    }

    const titleOpt = interaction.options.getString('title');
    const descOpt = interaction.options.getString('description');
    const colorOpt = interaction.options.getString('color');
    const imageOpt = interaction.options.getString('image');
    const footerOpt = interaction.options.getString('footer');

    if (!titleOpt && !descOpt && !colorOpt && !imageOpt && !footerOpt) {
      return safeReply(interaction, {
        content: '⚠️ กรุณาระบุอย่างน้อย 1 ตัวเลือก (title/description/color/image/footer/reset)',
        ephemeral: true,
      });
    }

    const cfg = { ...(data.config.panelEmbed || DEFAULT_DATA.config.panelEmbed) };

    if (titleOpt) cfg.title = titleOpt;
    if (descOpt) cfg.description = descOpt;

    if (colorOpt) {
      const parsed = parseHexColor(colorOpt);
      if (parsed === null) {
        return safeReply(interaction, {
          content: '⚠️ สีไม่ถูกต้อง กรุณาใส่เป็น hex เช่น `#5865F2`',
          ephemeral: true,
        });
      }
      cfg.color = parsed;
    }

    if (imageOpt) {
      if (imageOpt.toLowerCase() === 'none') {
        cfg.image = null;
      } else if (!isValidUrl(imageOpt)) {
        return safeReply(interaction, { content: '⚠️ Image URL ไม่ถูกต้อง', ephemeral: true });
      } else {
        cfg.image = imageOpt;
      }
    }

    if (footerOpt) {
      cfg.footer = footerOpt.toLowerCase() === 'none' ? null : footerOpt;
    }

    data.config.panelEmbed = cfg;
    saveData();

    return safeReply(interaction, {
      content: '✅ อัปเดต Panel Embed แล้ว (ใช้ `/bug panel` เพื่อโพสต์แผงใหม่ในช่องนี้)',
      embeds: [buildPanelEmbed()],
      ephemeral: true,
    });
  }
}

/* -------------------- Buttons -------------------- */

async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === 'bug_report_btn') return handleReportButton(interaction);
  if (id === 'bug_report_new_anyway') return handleCreateNewAnyway(interaction);
  if (id === 'bug_status_btn') return handleStatusButton(interaction);
  if (id === 'bug_severity_btn') return handleSeverityButton(interaction);
  if (id === 'bug_resolve_btn') return handleResolveButton(interaction);
  if (id === 'bug_close_btn') return handleCloseButton(interaction);
}

async function handleReportButton(interaction) {
  const userId = interaction.user.id;

  if (isBlacklisted(userId)) {
    return safeReply(interaction, { content: '🚫 คุณถูกระงับสิทธิ์การรายงานบั๊ก', ephemeral: true });
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
      content: `⏳ กรุณารออีก ${formatDuration(cd.remaining)} ก่อนรายงานบั๊กครั้งถัดไป`,
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

  const modal = new ModalBuilder().setCustomId('bug_report_modal').setTitle('🐛 Report Bug');
  const titleInput = new TextInputBuilder()
    .setCustomId('bug_title')
    .setLabel('หัวข้อ Bug')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);
  const descInput = new TextInputBuilder()
    .setCustomId('bug_description')
    .setLabel('รายละเอียด Bug')
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
  await presentSeveritySelect(interaction, pending);
}

async function handleStatusButton(interaction) {
  const bug = data.bugs[getBugIdFromChannel(interaction.channelId)];
  if (!bug) return safeReply(interaction, { content: '⚠️ ไม่พบข้อมูล Bug ของ Ticket นี้', ephemeral: true });
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์เปลี่ยนสถานะ', ephemeral: true });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`bug_status_select_${bug.id}`)
    .setPlaceholder('เลือกสถานะใหม่')
    .addOptions(
      Object.entries(STATUS).map(([key, val]) => ({
        label: val.label,
        value: key,
        emoji: val.emoji,
        default: key === bug.status,
      }))
    );
  await safeReply(interaction, { components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true, content: `เปลี่ยนสถานะของ ${bug.id}` });
}

async function handleSeverityButton(interaction) {
  const bug = data.bugs[getBugIdFromChannel(interaction.channelId)];
  if (!bug) return safeReply(interaction, { content: '⚠️ ไม่พบข้อมูล Bug ของ Ticket นี้', ephemeral: true });
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์เปลี่ยนความรุนแรง', ephemeral: true });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`bug_severity_select_${bug.id}`)
    .setPlaceholder('เลือกความรุนแรงใหม่')
    .addOptions(
      Object.entries(SEVERITY).map(([key, val]) => ({
        label: val.label,
        value: key,
        emoji: val.emoji,
        default: key === bug.severity,
      }))
    );
  await safeReply(interaction, { components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true, content: `เปลี่ยนความรุนแรงของ ${bug.id}` });
}

async function handleResolveButton(interaction) {
  const bug = data.bugs[getBugIdFromChannel(interaction.channelId)];
  if (!bug) return safeReply(interaction, { content: '⚠️ ไม่พบข้อมูล Bug ของ Ticket นี้', ephemeral: true });
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ Resolve', ephemeral: true });
  }
  await interaction.deferUpdate().catch(() => {});
  await applyStatusChange(bug, 'fixed', interaction.channel);
  await sendResolvedAnnouncement(bug);
}

async function handleCloseButton(interaction) {
  const bug = data.bugs[getBugIdFromChannel(interaction.channelId)];
  if (!bug) return safeReply(interaction, { content: '⚠️ ไม่พบข้อมูล Bug ของ Ticket นี้', ephemeral: true });
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์ปิด Ticket', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  await archiveTicket(bug, interaction.channel);
  await safeReply(interaction, { content: `🔒 ปิด Ticket ${bug.id} เรียบร้อยแล้ว` });
}

/* -------------------- Modal submit -------------------- */

async function handleModalSubmit(interaction) {
  if (interaction.customId !== 'bug_report_modal') return;
  const userId = interaction.user.id;

  // re-verify critical checks in case of race between button click and submit
  if (isBlacklisted(userId)) {
    return safeReply(interaction, { content: '🚫 คุณถูกระงับสิทธิ์การรายงานBug', ephemeral: true });
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

  // Count this as a report attempt now (not only once severity is finally
  // picked) - otherwise a user could open the modal endlessly without ever
  // selecting a severity and completely bypass the cooldown/rate limit.
  recordReportAttempt(userId);
  saveData();

  // duplicate detection against user's most recent bug
  const lastBug = getUserLastBug(userId);
  if (lastBug) {
    const similarity = jaccardSimilarity(title, lastBug.title);
    if (similarity >= DUPLICATE_THRESHOLD) {
      setPending(userId, { title, description });
      const embed = new EmbedBuilder()
        .setTitle('🔎 Possible Duplicate')
        .setDescription(`${lastBug.id}\nTitle: ${lastBug.title.slice(0, 500)}`)
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

  await presentSeveritySelect(interaction, { title, description });
}

async function presentSeveritySelect(interaction, payload) {
  setPending(interaction.user.id, payload);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('bug_new_severity_select')
    .setPlaceholder('เลือกความรุนแรงของBug')
    .addOptions(
      Object.entries(SEVERITY).map(([key, val]) => ({ label: val.label, value: key, emoji: val.emoji }))
    );
  await safeReply(interaction, {
    content: 'กรุณาเลือกระดับความรุนแรงของBug',
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  });
}

/* -------------------- Select menus -------------------- */

async function handleSelectMenu(interaction) {
  const id = interaction.customId;

  if (id === 'bug_new_severity_select') {
    return handleNewSeveritySelected(interaction);
  }
  if (id.startsWith('bug_status_select_')) {
    return handleStatusSelected(interaction, id.replace('bug_status_select_', ''));
  }
  if (id.startsWith('bug_severity_select_')) {
    return handleSeveritySelected(interaction, id.replace('bug_severity_select_', ''));
  }
}

async function handleNewSeveritySelected(interaction) {
  const userId = interaction.user.id;
  const pending = getPending(userId);
  if (!pending) {
    return safeReply(interaction, { content: 'ข้อมูลรายงานหมดอายุ กรุณาเริ่มใหม่', ephemeral: true });
  }

  // final race-condition guard before creating the ticket
  if (isBlacklisted(userId)) {
    clearPending(userId);
    return safeReply(interaction, { content: '🚫 คุณถูกระงับสิทธิ์การรายงานBug', ephemeral: true });
  }
  if (getUserActiveBug(userId)) {
    clearPending(userId);
    return safeReply(interaction, { content: 'คุณมี Ticket ที่ยังเปิดอยู่แล้ว', ephemeral: true });
  }

  const severity = interaction.values[0];
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
      severity,
      status: 'open',
      createdAt: Date.now(),
      fixedAt: null,
      channelId: null,
      ticketMessageId: null,
      escalated: false,
      criticalSince: severity === 'critical' ? Date.now() : null,
    };
    data.bugs[bugId] = bug;
    data.activeTickets[userId] = bugId;
    saveData();
  });

  try {
    const channel = await createTicketChannel(guild, bug);
    bug.channelId = channel.id;

    const ticketMsg = await channel.send({ embeds: [buildTicketEmbed(bug)], components: [buildTicketRow()] });
    bug.ticketMessageId = ticketMsg.id;
    saveData();

    if (severity === 'critical') {
      await sendCriticalAlert(bug);
    }

    await safeReply(interaction, {
      content: `✅ สร้างรายงานBug **${bug.id}** เรียบร้อยแล้ว: <#${channel.id}>`,
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error('[ticket] failed to create channel:', err.message);
    delete data.activeTickets[userId];
    saveData();
    await safeReply(interaction, { content: '⚠️ ไม่สามารถสร้าง Ticket ได้ กรุณาแจ้งหัวดิส', components: [], embeds: [] });
  }
}

async function handleStatusSelected(interaction, bugId) {
  const bug = data.bugs[bugId];
  if (!bug) return safeReply(interaction, { content: '⚠️ ไม่พบ Bug นี้', ephemeral: true });
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์เปลี่ยนสถานะ', ephemeral: true });
  }
  const newStatus = interaction.values[0];
  await interaction.deferUpdate().catch(() => {});
  const channel = interaction.channel;
  await applyStatusChange(bug, newStatus, channel);
  if (newStatus === 'fixed') {
    await sendResolvedAnnouncement(bug);
  }
}

async function handleSeveritySelected(interaction, bugId) {
  const bug = data.bugs[bugId];
  if (!bug) return safeReply(interaction, { content: '⚠️ ไม่พบ Bug นี้', ephemeral: true });
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, { content: '❌ คุณไม่มีสิทธิ์เปลี่ยนความรุนแรง', ephemeral: true });
  }
  const newSeverity = interaction.values[0];
  await interaction.deferUpdate().catch(() => {});
  const channel = interaction.channel;
  await applySeverityChange(bug, newSeverity, channel);
}

/* -------------------- State transitions -------------------- */

async function applyStatusChange(bug, newStatus, channel) {
  const oldStatus = bug.status;
  if (oldStatus === newStatus) return;
  bug.status = newStatus;
  if (RESOLVED_STATUSES.includes(newStatus) && !bug.fixedAt) {
    bug.fixedAt = Date.now();
  }
  if (!RESOLVED_STATUSES.includes(newStatus)) {
    bug.fixedAt = null;
  }
  if (TERMINAL_STATUSES.includes(newStatus)) {
    if (data.activeTickets[bug.reporterId] === bug.id) {
      delete data.activeTickets[bug.reporterId];
    }
  } else {
    data.activeTickets[bug.reporterId] = bug.id;
  }
  saveData();

  if (channel) {
    await sendTicketUpdate(channel, 'BUG UPDATE', bug.id, statusText(oldStatus), statusText(newStatus));
    await refreshTicketEmbed(channel, bug);
  }
}

async function applySeverityChange(bug, newSeverity, channel) {
  const oldSeverity = bug.severity;
  if (oldSeverity === newSeverity) return;
  bug.severity = newSeverity;
  if (newSeverity === 'critical') {
    bug.escalated = false;
    bug.criticalSince = Date.now();
  } else {
    bug.criticalSince = null;
    bug.escalated = false;
  }
  saveData();

  if (channel) {
    await sendTicketUpdate(channel, 'SEVERS UPDATE', bug.id, sevText(oldSeverity), sevText(newSeverity));
    await refreshTicketEmbed(channel, bug);
  }
  if (newSeverity === 'critical') {
    await sendCriticalAlert(bug);
  }
}

async function refreshTicketEmbed(channel, bug) {
  try {
    let botMsg = null;
    if (bug.ticketMessageId) {
      botMsg = await channel.messages.fetch(bug.ticketMessageId).catch(() => null);
    }
    if (!botMsg) {
      // fallback for older tickets created before ticketMessageId was tracked
      const messages = await channel.messages.fetch({ limit: 20 });
      botMsg = messages.find(
        (m) => m.author.id === client.user.id && m.embeds[0] && m.embeds[0].title === `🐛 ${bug.id}`
      );
      if (botMsg) {
        bug.ticketMessageId = botMsg.id;
        saveData();
      }
    }
    if (botMsg) {
      await botMsg.edit({ embeds: [buildTicketEmbed(bug)], components: [buildTicketRow()] });
    }
  } catch (err) {
    console.error('[ticket] failed to refresh embed:', err.message);
  }
}

async function archiveTicket(bug, channel) {
  if (!TERMINAL_STATUSES.includes(bug.status)) {
    bug.status = 'closed';
  }
  if (data.activeTickets[bug.reporterId] === bug.id) {
    delete data.activeTickets[bug.reporterId];
  }
  bug.archived = true;
  bug.archivedAt = Date.now();
  saveData();

  if (channel) {
    try {
      await channel.permissionOverwrites.edit(bug.reporterId, { SendMessages: false });
      if (!channel.name.startsWith('closed-')) {
        await channel.setName(`closed-${bug.id}`.toLowerCase()).catch(() => {});
      }
      await channel.send({ content: `🔒 Ticket ${bug.id} ถูกปิดและเก็บเป็นข้อมูลถาวรแล้ว` });
    } catch (err) {
      console.error('[archive] failed:', err.message);
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
   MINI HTTP SERVER
   ------------------------------------------------------------
   Render's free tier only supports "Web Service" instances, which
   require the process to bind to $PORT and respond to HTTP
   requests (used for Render's own health checks). A plain
   background worker isn't available on the free plan, so this
   tiny server exists purely to satisfy that requirement - it has
   nothing to do with the bot's actual functionality.

   Note: Render's free web services spin down after ~15 minutes
   of no incoming HTTP traffic and cold-start on the next request,
   which will disconnect the Discord bot in between. If you need
   the bot online 24/7, either upgrade to a paid Render instance
   type, or set up an external uptime pinger (e.g. UptimeRobot,
   cron-job.org) to hit this server's URL every 5-10 minutes.
   ============================================================ */

const http = require('http');
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      client.isReady()
        ? `OK - logged in as ${client.user.tag}`
        : 'OK - bot is starting...'
    );
  })
  .listen(PORT, () => {
    console.log(`[http] health check server listening on port ${PORT}`);
  });

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
