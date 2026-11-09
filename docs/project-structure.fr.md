# Structure du projet

_Version française de la section « Project structure » du [README](../README.md). En cas d'écart, c'est la version anglaise qui fait foi._

TheLibrary est une application [Tauri](https://tauri.app/) : un petit noyau en Rust ouvre une fenêtre, et tout ce que vous voyez comme tout ce que fait l'application est écrit en TypeScript et React et tourne dans cette fenêtre. Les dossiers principaux :

```text
TheLibrary/
├── src/                    L'application elle-même, en TypeScript
│   ├── main.tsx            Point de départ : choisit les adaptateurs, construit les services, affiche la fenêtre
│   ├── core/               Logique pure : données du jeu, règles de l'API, analyse des matchs
│   ├── ports/              Interfaces de tout ce qui touche au monde extérieur
│   ├── adapters/           Implémentations de ces interfaces
│   │   ├── tauri/          …dans l'application de bureau (HTTP, base de données, fichiers, journaux, connexion Steam, mises à jour)
│   │   ├── browser/        …avec les API du navigateur, dans toutes les versions (le worker de compression)
│   │   └── dev/            …pour les tests et `pnpm dev` (données synthétiques, stockage en mémoire)
│   ├── services/           Ce que fait l'application : synchronisation, archive, analyse, bilan, compte, mises à jour
│   ├── workers/            Travail lourd hors du fil principal (compression zstd)
│   ├── ui/                 Les écrans, en React
│   │   ├── app/            Cadre de la fenêtre, navigation, écrans d'erreur
│   │   ├── features/       Un dossier par écran (tableau de bord, matchs, détail d'un match, bilan, Paige, paramètres…)
│   │   ├── components/     Briques partagées (boutons, panneaux, onglets…)
│   │   ├── i18n/           Textes en anglais et en français
│   │   └── theme/          Couleurs, espacements et polices
│   └── test/               Aides de test partagées et vérification hebdomadaire de la vraie API
├── src-tauri/              Le noyau de bureau en Rust
│   ├── src/                Plugins natifs, durcissement de la fenêtre, liste des migrations de la base
│   ├── capabilities/       Ce que la fenêtre a le droit de faire, réduit au minimum
│   ├── tauri.conf.json     Réglages de la fenêtre, de la politique de sécurité, de l'installateur et des mises à jour
│   └── icons/              Icônes de l'application, dans toutes les tailles utilisées par Windows et l'installateur
├── migrations/             Schéma de la base SQLite, un fichier numéroté par changement
├── scripts/                check-dev-code.ts (aucun code de développement dans une version publiée) et release/ (outils de publication)
├── .github/                Workflows de CI, de publication et du canari de l'API, réglages de Renovate
├── docs/adr/               Décisions d'architecture : pourquoi chaque choix principal a été fait
├── assets/                 Le dessin source de l'icône de l'application
└── types/                  Déclarations de types pour un outil qui n'en fournit pas
```

À la racine se trouvent aussi la configuration de la compilation et des outils (`package.json`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.js`…) et les documents destinés aux joueurs et aux contributeurs : les journaux des modifications en anglais et en français, [CONTRIBUTING.md](../CONTRIBUTING.md), [PRIVACY.md](../PRIVACY.md), [SECURITY.md](../SECURITY.md), la [politique de signature du code](../CODE_SIGNING_POLICY.md) et les [mentions des logiciels tiers](../THIRD_PARTY_NOTICES.md).

## Comment les pièces s'assemblent

Le code de `src/` est découpé en couches, et chaque couche ne parle qu'à celles qui sont en dessous d'elle (ESLint le vérifie) :

- **`core/`** connaît le jeu et les règles, et rien d'autre : il prend des données et rend des données, sans réseau, sans disque ni horloge.
- **`ports/`** décrivent ce dont l'application a besoin du monde extérieur (télécharger une page, lancer une requête SQL, écrire un fichier…) sans dire comment.
- **`adapters/`** le font : avec les plugins Tauri dans l'application de bureau, avec la mémoire et des données synthétiques dans les tests et dans `pnpm dev`. C'est pour cela que toute l'application tourne dans un simple navigateur, sur de fausses données.
- **`services/`** sont les actions de l'application (synchroniser, archiver un match, l'analyser, construire le bilan…). Ils s'appuient sur `core/` pour les règles et sur les ports pour les effets de bord.
- **`ui/`** affiche les résultats et n'appelle que les services.

Le trajet d'un match, de deadlock-api jusqu'à l'écran :

1. **Télécharger l'historique.** Au démarrage, toutes les 13 minutes et à la demande, la synchronisation demande vos matchs récents à [deadlock-api](https://deadlock-api.com). `core/deadlock-api/` vérifie et traduit la réponse, et les matchs sont enregistrés dans la base SQLite locale.
2. **Archiver le détail.** Pour chaque match de Paige des 90 derniers jours, l'application télécharge le détail complet, ne garde que ce qui vous concerne, le compresse en zstd dans un Web Worker pour que la fenêtre ne se fige jamais, et l'enregistre sur votre PC, un fichier par match ([ADR 0003](adr/0003-user-centric-archive-zstd.md)).
3. **L'analyser.** Juste après, les métriques de `core/analysis/` sont calculées sur chaque nouvelle archive. Leurs valeurs sont stockées dans la base, si bien que les pages comparent les matchs sans rouvrir les archives.
4. **L'afficher.** Quand vous ouvrez un match, son écran dans `ui/features/match-detail/` le demande au service d'analyse. Le service compare vos chiffres avec vos propres habitudes et avec les joueurs de votre rang ([ADR 0004](adr/0004-analysis-references.md)), et l'écran dessine le résultat.

Chaque couche a un README, en anglais, qui liste ses dossiers et ses règles : [core](../src/core/README.md), [ports](../src/ports/README.md), [adapters](../src/adapters/README.md), [services](../src/services/README.md), [workers](../src/workers/README.md), [ui](../src/ui/README.md) et [migrations](../migrations/README.md). [CONTRIBUTING.md](../CONTRIBUTING.md) explique les conventions et comment publier une version.
