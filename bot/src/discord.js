import {
  ActivityType,
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

// Orange FICSIT quand on joue, bleu-gris en pause, ambre au démarrage, gris éteint.
const COLORS = { online: 0xfa9549, paused: 0x5f7ea3, starting: 0xf2c14e, unresponsive: 0xd9822b, offline: 0x6e7774 };
const LABELS = { online: 'Ouvert', paused: 'En pause', starting: 'Démarrage…', unresponsive: 'Ne répond pas', offline: 'Fermé' };
const MB = 1024 * 1024;

const ts = (date, style = 'R') => (date ? `<t:${Math.floor(date.getTime() / 1000)}:${style}>` : '—');
export const fmtBytes = (n) =>
  n >= 1024 * MB ? `${(n / (1024 * MB)).toFixed(1)} Go`
    : n >= MB ? `${(n / MB).toFixed(n >= 100 * MB ? 0 : 1)} Mo`
      : `${Math.ceil(n / 1024)} Ko`;
export const fmtDuration = (s) => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} j ${h} h` : h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
};

function explain(err, channelVar) {
  if (err?.code === 50001) return `pas d'accès au salon ${channelVar} : donne au rôle du bot « Voir le salon » sur ce salon (ou vérifie l'ID)`;
  if (err?.code === 50013) return `permission manquante dans le salon ${channelVar} (envoyer, intégrer des liens, joindre des fichiers, épingler)`;
  if (err?.code === 10003) return `salon ${channelVar} introuvable : l'ID ne correspond à aucun salon de ce serveur`;
  return err?.message ?? String(err);
}

const COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('État du serveur Satisfactory'),
  new SlashCommandBuilder().setName('pionniers').setDescription('Combien de pionniers sont connectés ?'),
  new SlashCommandBuilder().setName('backup').setDescription('(Admin) Sauvegarde l\'usine et envoie le fichier'),
  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('(Admin) Redémarre le serveur')
    .addBooleanOption((o) => o.setName('forcer').setDescription('Redémarrer même si des pionniers sont connectés')),
].map((c) => c.toJSON());

export class DiscordBot {
  constructor({ config, state, poller, backups, store, log = console }) {
    this.config = config;
    this.state = state;
    this.poller = poller;
    this.backups = backups;
    this.store = store;
    this.log = log;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.pendingRefresh = null;
    this.lastStats = null;
  }

  async start() {
    this.client.once(Events.ClientReady, async () => {
      this.log.info(`Connecté à Discord en tant que ${this.client.user.tag}.`);
      try {
        const guild = await this.client.guilds.fetch(this.config.guildId);
        await guild.commands.set(COMMANDS);
      } catch (err) {
        this.log.error('Enregistrement des commandes impossible :', err.message);
      }
      await this.refreshStatus({ withStats: true });
      setInterval(() => this.refreshStatus({ withStats: true }), this.config.statusRefreshSeconds * 1000);
    });
    this.client.on(Events.InteractionCreate, (i) => this.onInteraction(i));
    this.state.on('change', () => this.scheduleRefresh());
    this.state.on('notify', (n) => this.notify(n.text));
    await this.client.login(this.config.discordToken);
  }

  // --- Statut -----------------------------------------------------------

  displayStatus() {
    const s = this.state;
    return s.status === 'online' && s.paused ? 'paused' : s.status;
  }

  scheduleRefresh() {
    if (this.pendingRefresh) return;
    this.pendingRefresh = setTimeout(() => {
      this.pendingRefresh = null;
      this.refreshStatus();
    }, 2000);
  }

  buildEmbed() {
    const s = this.state;
    const c = this.config;
    const ds = this.displayStatus();
    const up = s.status === 'online';
    const lim = s.playerLimit ? `/${s.playerLimit}` : '';

    const lines = [`${c.emojis[ds]} **${LABELS[ds]}**` +
      (up ? ` · ${s.players}${lim} pionnier${s.players > 1 ? 's' : ''}` : '')];
    if (up && s.paused) lines.push('-# L\'usine tourne au ralenti tant que personne n\'est connecté.');
    if (c.connectAddress && s.status !== 'offline') {
      lines.push(`🔑 \`${c.connectAddress}\` · **Server Manager → Add Server**`);
    }

    const embed = new EmbedBuilder()
      .setTitle(c.serverLabel || s.session || 'Satisfactory')
      .setColor(COLORS[ds])
      .setDescription(lines.join('\n'));
    const avatar = this.client.user?.displayAvatarURL({ size: 128 });
    if (avatar) embed.setThumbnail(avatar);

    const res = this.lastStats && s.status !== 'offline'
      ? `CPU ${this.lastStats.cpu.toFixed(0)} % · ${fmtBytes(this.lastStats.mem)}`
      : '—';
    embed.addFields(
      { name: 'Palier', value: s.techTier != null ? String(s.techTier) : '—', inline: true },
      { name: 'Projet Assemblage', value: s.phase ?? '—', inline: true },
      { name: 'Temps de jeu', value: fmtDuration(s.gameDuration), inline: true },
      { name: 'Ouvert depuis', value: up ? ts(s.onlineSince) : '—', inline: true },
      { name: 'Tick rate', value: up && s.tickRate != null ? `${Math.round(s.tickRate)} Hz` : '—', inline: true },
      { name: 'Version', value: s.version ?? '—', inline: true },
      { name: 'Session', value: s.session ?? '—', inline: true },
      { name: 'Dernière archive', value: ts(this.backups.lastBackupAt), inline: true },
      { name: 'Ressources', value: res, inline: true },
    );
    embed.setFooter({ text: 'Statut automatique' }).setTimestamp(new Date());
    return embed;
  }

  async refreshStatus({ withStats = false } = {}) {
    try {
      if (withStats) this.lastStats = this.state.status === 'offline' ? null : await this.poller.stats();
      this.updatePresence();
      const channel = await this.client.channels.fetch(this.config.statusChannelId);
      const embed = this.buildEmbed();
      const id = this.store.data.statusMessageId;
      if (id) {
        try {
          const msg = await channel.messages.fetch(id);
          await msg.edit({ embeds: [embed] });
          return;
        } catch {
          // message supprimé : on en recrée un
        }
      }
      const msg = await channel.send({ embeds: [embed] });
      await msg.pin().catch(() => {});
      this.store.data.statusMessageId = msg.id;
      await this.store.save();
    } catch (err) {
      this.log.warn('Mise à jour du statut impossible :', explain(err, 'STATUS_CHANNEL_ID'));
    }
  }

  updatePresence() {
    const user = this.client.user;
    if (!user) return;
    const s = this.state;
    const lim = s.playerLimit ? `/${s.playerLimit}` : '';
    if (s.status === 'online') {
      user.setPresence({
        status: s.paused ? 'idle' : 'online',
        activities: [{ name: `Satisfactory · ${s.players}${lim}`, type: ActivityType.Playing }],
      });
    } else if (s.status === 'offline') {
      user.setPresence({ status: 'dnd', activities: [{ name: 'Serveur hors ligne', type: ActivityType.Custom }] });
    } else {
      user.setPresence({ status: 'idle', activities: [{ name: LABELS[s.status], type: ActivityType.Custom }] });
    }
  }

  async notify(text) {
    try {
      const channel = await this.client.channels.fetch(this.config.eventsChannelId);
      await channel.send({ content: text, allowedMentions: { parse: [] } });
    } catch (err) {
      this.log.warn('Notification impossible :', explain(err, 'EVENTS_CHANNEL_ID'));
    }
  }

  // --- Sauvegardes ------------------------------------------------------

  async autoUploadLimit() {
    let tierLimit = 0;
    try {
      const guild = await this.client.guilds.fetch(this.config.guildId);
      tierLimit = { 2: 50 * MB, 3: 100 * MB }[guild.premiumTier] ?? 0;
    } catch {
      // ignore
    }
    return Math.max(this.config.uploadLimitMb * MB, tierLimit);
  }

  backupMessage(result, reason) {
    const labels = { session: 'de fin de session', periodique: 'périodique', manuel: 'manuelle' };
    return `💾 Sauvegarde ${labels[reason] ?? reason} de **${this.state.session ?? 'l\'usine'}** ` +
      `(${fmtBytes(result.size)}, ${ts(result.at, 'f')}).`;
  }

  async postBackup(result, reason) {
    try {
      const channel = await this.client.channels.fetch(this.config.backupChannelId);
      const limit = await this.autoUploadLimit();
      if (result.size > limit) {
        await channel.send(
          `💾 Sauvegarde créée (${fmtBytes(result.size)}), trop lourde pour un envoi automatique ` +
            `(limite ${fmtBytes(limit)}). Elle est gardée sur le serveur ; un admin peut faire \`/backup\`.`,
        );
        return;
      }
      await channel.send({
        content: this.backupMessage(result, reason),
        files: [new AttachmentBuilder(result.path, { name: result.name })],
      });
    } catch (err) {
      this.log.warn('Envoi de la sauvegarde impossible :', explain(err, 'BACKUP_CHANNEL_ID'));
    }
  }

  // --- Commandes --------------------------------------------------------

  isAdmin(interaction) {
    if (this.config.adminRoleId) return interaction.member?.roles?.cache?.has(this.config.adminRoleId) ?? false;
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  }

  async onInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;
    try {
      switch (interaction.commandName) {
        case 'status':
          await interaction.reply({ embeds: [this.buildEmbed()] });
          break;
        case 'pionniers': {
          const s = this.state;
          const lim = s.playerLimit ? `/${s.playerLimit}` : '';
          await interaction.reply(
            s.status !== 'online' ? `${this.config.emojis[s.status]} Le serveur est ${LABELS[s.status].toLowerCase()}.`
              : s.players ? `👷 ${s.players}${lim} pionnier${s.players > 1 ? 's' : ''} dans l'usine.`
                : '👻 Personne dans l\'usine pour le moment.',
          );
          break;
        }
        case 'backup':
          await this.cmdBackup(interaction);
          break;
        case 'restart':
          await this.cmdRestart(interaction);
          break;
        default:
          break;
      }
    } catch (err) {
      this.log.error(`Commande /${interaction.commandName} :`, err);
      const payload = { content: `❌ Erreur : ${err.message}`, flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  }

  async cmdBackup(interaction) {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: '⛔ Réservé aux admins.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (this.state.status !== 'online') {
      await interaction.reply({ content: '🔴 Le serveur doit être en ligne pour sauvegarder.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();
    const result = await this.backups.create({ session: this.state.session, reason: 'manuel' });
    this.scheduleRefresh();
    const limit = interaction.attachmentSizeLimit ?? (await this.autoUploadLimit());
    if (result.size > limit) {
      await interaction.editReply(
        `💾 Sauvegarde créée (${fmtBytes(result.size)}) mais trop lourde pour Discord (limite ${fmtBytes(limit)}). ` +
          `Elle est sur le serveur : \`${result.name}\`.`,
      );
      return;
    }
    await interaction.editReply({
      content: this.backupMessage(result, 'manuel'),
      files: [new AttachmentBuilder(result.path, { name: result.name })],
    });
  }

  async cmdRestart(interaction) {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: '⛔ Réservé aux admins.', flags: MessageFlags.Ephemeral });
      return;
    }
    const force = interaction.options.getBoolean('forcer') ?? false;
    const n = this.state.players;
    if (n && !force) {
      await interaction.reply({
        content: `⚠️ ${n} pionnier(s) connecté(s). Relance avec \`forcer: True\` pour redémarrer quand même.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply(`🔄 Redémarrage demandé par **${interaction.user.displayName}**. ` +
      'Le chargement de l\'usine prend environ une minute.');
    await this.poller.restart();
  }
}
