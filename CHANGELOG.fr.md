# Journal des modifications

Les changements notables de TheLibrary, du plus récent au plus ancien. La version anglaise est
[CHANGELOG.md](CHANGELOG.md) ; quand l'app propose une mise à jour, elle en montre le résumé dans sa
langue.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et les versions suivent le
[versionnage sémantique](https://semver.org/lang/fr/). Chaque version peut avoir les rubriques
Ajouts, Modifications, Corrections et Suppressions.

## [Unreleased]

## [0.1.3] - 2026-11-13

### Ajouts

- Un replay de la partie sur la carte, dans l'onglet Chronologie : les 12 héros se déplacent seconde par seconde avec les objectifs, sous une barre de lecture, à côté d'un panneau « À mm:ss » qui liste les objectifs détruits et les joueurs morts, et des événements de la partie.

### Modifications

- Le résumé du Bilan place tes points faibles et tes points forts côte à côte quand la fenêtre est large.
- La liste des parties alterne le fond de ses lignes : chaque partie se lit d'un seul trait.
- L'ouverture d'une partie ou du Bilan passe par une courte étape « Analyse… » avant la page, même quand les données sont déjà là ; revenir en arrière la saute, pour retrouver la page là où tu l'avais laissée.
- Pendant une synchronisation, une partie dont le détail est encore attendu ne peut pas être ouverte : sa ligne indique « En cours… » jusqu'à ce que la synchronisation l'ait archivée.

### Suppressions

- Les parties Street Brawl : l'app ne les télécharge plus et supprime celles qu'elle avait enregistrées.

## [0.1.2] - 2026-11-02

### Ajouts

- Une page Paige : son illustration, ses mots-clés, toutes ses statistiques avec ce que chaque niveau ajoute, son arme et ses quatre compétences. Clique sur une compétence pour voir son détail et activer ou désactiver ses paliers d'amélioration (1, 2 et 5 points) pour voir ce qu'ils changent, y compris les délais que le jeu n'affiche pas.

### Modifications

- L'interface utilise les polices Alegreya, plus proches de l'aspect du jeu.

## [0.1.1] - 2026-10-28

### Modifications

- Réglages → Stockage : pendant que l'app vérifie ce qu'une limite plus basse supprimerait, une ligne « Vérification… » s'affiche à côté de la limite.

## [0.1.0] - 2026-10-28

Première bêta publique.

### Ajouts

- Liaison de ton compte Steam dans ton navigateur ; TheLibrary ne voit jamais ton mot de passe.
- Ton historique de parties de Deadlock, synchronisé depuis deadlock-api.com au démarrage, toutes les 13 minutes et à la demande.
- Le détail de tes parties de Paige des 90 derniers jours, gardé sur ton PC.
- Une page par partie avec tes points forts et tes points faibles comparés aux joueurs de Paige de ton rang et à tes habitudes, tes dégâts par source, ton build final, les 12 joueurs et la chronologie de la partie.
- Un bilan de tes 20 dernières parties : les points faibles et forts qui reviennent, tes morts par phase et le moment où tu achètes tes objets de résistance.
- Un tableau de bord sur tes dernières parties et un historique des parties avec des filtres.
- Des réglages : compte, synchronisation, limite de stockage, langue, diagnostic.
- Une interface en français et en anglais.
- Les mises à jour dans l'app : TheLibrary te dit au démarrage qu'une nouvelle version est sortie, et l'installe quand tu le choisis.
