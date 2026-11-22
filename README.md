# Satisfactory : serveur dédié + bot Discord

Stack Portainer (gérée par Git) : le serveur `satisfactory`, un bot Discord `sf-bot` et un proxy du socket Docker. Le bot remplace l'ancien script `sf-status` (webhook).

## Ce que fait le bot

- **Statut épinglé** mis à jour dès qu'il change : ouvert / en pause / fermé, pionniers connectés, palier, phase du Projet Assemblage, temps de jeu, tick rate, version, ressources.
- **Notifications** : en ligne, démarrage, hors ligne, plantage (y compris quand Docker relance le serveur tout seul), serveur qui ne répond plus, arrivées et départs, nouveau palier, nouvelle phase.
- **Sauvegardes** via l'API du jeu (`SaveGame` puis `DownloadSaveGame`) :
  - à la fin de chaque session (dernier pionnier parti), postée sur Discord ;
  - toutes les 3 h pendant qu'on joue, gardée sur le serveur ;
  - `/backup` (admin), postée tout de suite.
  - Rotation : tout pendant 7 jours, puis une par jour jusqu'à 30 jours.
  - Sur le serveur, le bot écrase toujours la même sauvegarde `<session>_discord` ; les autosaves du jeu ne sont pas touchées.
- **Commandes** : `/status`, `/pionniers`, `/backup` (admin), `/restart` (admin, refuse si quelqu'un joue sauf `forcer: True`).

Limite connue : le serveur n'écrit pas les noms des joueurs dans ses logs et l'API ne donne que leur nombre. Les annonces disent donc « un pionnier a rejoint (2/4) », sans nom.

## Installation

1. **Application Discord** : <https://discord.com/developers/applications> → New Application. Onglet Bot → Reset Token (c'est `DISCORD_TOKEN`), décocher « Public Bot ». OAuth2 → URL Generator : scopes `bot` + `applications.commands`, permissions Voir les salons, Envoyer des messages, Intégrer des liens, Joindre des fichiers, Voir les anciens messages, Épingler les messages.
2. **Variables de la stack** (Portainer → Stacks → sf-status-broccoli → Environment variables). `SF_TOKEN` existe déjà. Ajouter :

| Variable | Obligatoire | Rôle |
|---|---|---|
| `DISCORD_TOKEN` | oui | token du bot |
| `GUILD_ID` | oui | ID du serveur Discord |
| `STATUS_CHANNEL_ID` | oui | salon du statut |
| `EVENTS_CHANNEL_ID` | non | salon des notifications (sinon celui du statut) |
| `BACKUP_CHANNEL_ID` | non | salon des sauvegardes (sinon celui du statut) |
| `ADMIN_ROLE_ID` | non | rôle autorisé à `/backup` et `/restart` (sinon « Gérer le serveur ») |
| `CONNECT_ADDRESS` | non | adresse affichée, ex. `100.83.87.232:7777` |
| `SERVER_LABEL` | non | titre du statut (sinon le nom de la session) |

   `DISCORD_WEBHOOK` et `INTERVAL` ne servent plus.
3. **Pull and redeploy**. Portainer construit l'image `sf-bot:local` depuis `bot/`.

Si une nouvelle version du bot n'est pas prise en compte après un redéploiement, supprimer l'image `sf-bot:local` (Images) puis redéployer.

## Réglages avancés (service `sf-bot`)

| Variable | Défaut | Rôle |
|---|---|---|
| `POLL_SECONDS` | `30` | fréquence de relevé de l'API |
| `PERIODIC_BACKUP_HOURS` | `3` | sauvegardes pendant le jeu (`0` = désactivé) |
| `POST_SESSION_BACKUPS` | `true` | sauvegarde + envoi en fin de session |
| `KEEP_ALL_DAYS` / `KEEP_DAILY_DAYS` | `7` / `30` | rotation |
| `UPLOAD_LIMIT_MB` | `20` | limite d'envoi automatique (relevée à 50/100 Mo si le serveur Discord est boosté niveau 2/3) |
| `STATUS_REFRESH_SECONDS` | `300` | rafraîchissement CPU/RAM |
| `EMOJI_ONLINE` … `EMOJI_OFFLINE` | `🏭 ⏸️ ⚙️ ⚠️ 💤` | émojis de l'état (`<:nom:ID>` pour un émoji du serveur) |

## Restaurer une sauvegarde

Depuis le jeu : Server Manager → Manage Saves → Upload, puis charger la sauvegarde.

## Tests

```bash
cd bot && npm install && npm test
```
