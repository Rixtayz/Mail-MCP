# Mail-MCP

Serveur MCP (stdio, TypeScript) qui donne à Claude l'accès à une boîte **Outlook.com / Hotmail personnelle** via Microsoft Graph : lire, chercher, classer dans des dossiers, supprimer et **se désabonner des newsletters**.

9 outils, préfixe `mail_` :

| Outil | Rôle |
|---|---|
| `mail_list_folders` | Arbre des dossiers avec compteurs |
| `mail_create_folder` | Créer un dossier (idempotent) |
| `mail_search` | Lister/chercher des messages (filtres expéditeur, dates, non lus, plein texte), paginé |
| `mail_get_message` | Contenu complet d'un message + infos de désabonnement |
| `mail_senders_summary` | **Synthèse par expéditeur** : volume, dernier message, méthode de désabonnement disponible |
| `mail_move` | Déplacer jusqu'à 500 messages vers un dossier |
| `mail_delete` | Corbeille par défaut, `permanent: true` pour purger |
| `mail_bulk_by_sender` | Déplacer ou supprimer tous les messages d'un expéditeur (`dryRun` disponible) |
| `mail_unsubscribe` | Un-clic RFC 8058 → courriel `mailto:` → sinon URL à ouvrir dans le navigateur |

Aucun outil d'envoi générique n'est exposé. La permission `Mail.Send` sert uniquement au désabonnement par `mailto:`.

## 1. Prérequis

- Node.js 20 ou plus (`node --version`).
- Un compte Microsoft personnel (Outlook.com, Hotmail, Live).

## 2. Inscription d'application Microsoft Entra (une fois, gratuit)

IMAP par mot de passe n'existe plus sur Outlook.com : il faut une « app registration ». Aucun abonnement Azure n'est nécessaire.

1. Ouvrez <https://entra.microsoft.com> et connectez-vous avec votre compte personnel.
2. Menu **Identity → Applications → App registrations → New registration**.
3. Remplissez :
   - **Name** : `Mail-MCP`
   - **Supported account types** : **Personal Microsoft accounts only**
   - **Redirect URI** : plateforme **Mobile and desktop applications**, valeur `http://localhost`
4. Cliquez **Register**, puis copiez l'**Application (client) ID** (format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
5. Dans **Authentication**, vérifiez que `http://localhost` est bien listé sous « Mobile and desktop applications » et que **Allow public client flows** est sur **Yes**.
6. Dans **API permissions**, ajoutez (Microsoft Graph, *Delegated*) : `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`. Pas besoin de « grant admin consent » : le consentement est demandé à la première connexion.

Aucun secret client n'est créé : l'application est un client public (code d'autorisation + PKCE).

## 3. Installation et connexion

```bash
cd /chemin/vers/Mail-MCP
npm install
npm run build
MAIL_MCP_CLIENT_ID=<votre-client-id> npm run login
```

`npm run login` ouvre le navigateur système, vous connecte à Microsoft, puis enregistre le jeton (rafraîchi automatiquement pendant 90 jours glissants) dans `~/.mail-mcp/token-cache.json` (permissions 600). Si un outil répond « Jeton expiré », relancez simplement cette commande.

Variables d'environnement :

| Variable | Rôle |
|---|---|
| `MAIL_MCP_CLIENT_ID` | **Obligatoire.** Application (client) ID de l'étape 2 |
| `MAIL_MCP_CACHE_PATH` | Optionnel. Emplacement du cache de jeton |

## 4. Brancher dans Claude Desktop (Cowork)

Fichier : `~/Library/Application Support/Claude/claude_desktop_config.json` (menu **Settings → Developer → Edit Config**). Chemins absolus obligatoires.

```json
{
  "mcpServers": {
    "mail": {
      "command": "/usr/local/bin/node",
      "args": ["/chemin/vers/Mail-MCP/dist/index.js"],
      "env": {
        "MAIL_MCP_CLIENT_ID": "<votre-client-id>"
      }
    }
  }
}
```

Quittez complètement Claude Desktop (Cmd+Q) puis relancez-le. Logs : `~/Library/Logs/Claude/mcp-server-mail.log`.

Note : Cowork n'exécute les serveurs MCP locaux qu'en **session locale** (pas dans les sessions cloud).

## 5. Brancher dans Claude Code

```bash
claude mcp add --scope user --env MAIL_MCP_CLIENT_ID=<votre-client-id> --transport stdio mail -- /usr/local/bin/node /chemin/vers/Mail-MCP/dist/index.js
```

## 6. Exemples de prompts

- « Fais-moi la synthèse des expéditeurs de ma boîte de réception et repère les newsletters. »
- « Désabonne-moi de toutes les newsletters que je n'ai pas ouvertes depuis 6 mois, puis mets leurs messages à la corbeille. »
- « Crée un dossier Factures et déplace-y tous les courriels de facture@fournisseur.com. »
- « Montre-moi le dernier courriel de la banque. »

Flux typique : `mail_senders_summary` → validation avec vous → `mail_unsubscribe(lastMessageId)` par newsletter (si la réponse est `method: "browser"`, Claude ouvre l'URL dans son navigateur) → `mail_bulk_by_sender(action: "delete")`.

## 7. Développement

```bash
npm test          # vitest (parse des en-têtes, retry/batch Graph, service avec Graph simulé)
npm run typecheck
npm run inspect   # MCP Inspector sur dist/index.js
```

Structure : `src/auth.ts` (MSAL, cache fichier), `src/graph.ts` (fetch + retry 429, pagination, $batch par 20), `src/mail.ts` (logique métier), `src/unsubscribe.ts` (List-Unsubscribe, RFC 8058), `src/tools/*.ts` (définition des 9 outils), `scripts/login.ts`.

## Limites connues

- Throttling Microsoft : 10 000 requêtes / 10 min par boîte et 4 requêtes concurrentes ; le serveur sérialise les lots et réessaie sur 429.
- `mail_search` avec `query` (plein texte) ne se combine pas avec les autres filtres (limitation Graph) et plafonne à environ 250 résultats.
- Le désabonnement réel dépend de l'expéditeur : le un-clic et le `mailto:` envoient la demande, la radiation effective est de son ressort.
