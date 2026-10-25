# Yoto Studio

Fabriquer des cartes à écouter pour un lecteur [Yoto](https://yotoplay.com), sans rien connaître
au découpage audio ni aux formats de fichiers.

Écrire une histoire, la lire à voix haute au micro, ou partir d'un fichier — puis publier sur une
carte MYO et l'imprimer. Application personnelle, non affiliée à Yoto.

## Ce que ça fait

| | |
|---|---|
| **Écrire** | Une histoire originale en chapitres, via DeepSeek, adaptée à l'âge de l'enfant |
| **Raconter** | Enregistrement au micro du navigateur, un chapitre par piste |
| **Ingérer** | Dépôt de fichiers audio, ou téléchargement depuis une adresse YouTube |
| **Découper** | Détection de silences et contrôle automatique des coupes *(sans interface à ce jour)* |
| **Publier** | Upload, transcodage et création du contenu MYO par l'API officielle |
| **Encoder** | Recopier l'adresse d'un contenu sur une carte NFC vierge, par Web NFC |
| **Dessiner** | Couverture et icônes 16×16 dictées par DeepSeek, rasterisées par le serveur |
| **Décorer** | Étiquette PNG à imprimer puis découper à la Cricut, aux dimensions de la carte |
| **Écouter** | Émulateur de lecteur, avec streaming et déplacement dans la piste |

## Histoires et cartes

Une **histoire** est ce qu'on écoute : elle vit chez Yoto sous un identifiant de contenu
(`cardId`). Une **carte** est ce qu'on pose sur le lecteur : ici, une copie sur une puce du
commerce, qui porte `https://yoto.io/<cardId>?<token>`. Une histoire peut être sur plusieurs
cartes, et une carte change d'histoire en la réécrivant.

Republier une histoire met à jour son contenu : les copies qui portent son adresse jouent la
nouvelle version sans être réécrites. Les copies se nomment (« la rouge ») depuis la page Cartes
ou en les lisant ; Réglages resynchronise les contenus avec le compte Yoto.

## Encoder des cartes vierges

Une carte Yoto est un MIFARE Ultralight EV1 de 48 octets portant `https://yoto.io/<cardId>?<token>`.
Les puces vierges vendues par lots sont la même puce — il ne manque que l'adresse, et l'adresse ne
s'invente pas : le token est signé par Yoto, et seule l'app Yoto l'écrit, sur une carte MYO qui sert
de **passeur**.

Le passeur s'enregistre **une seule fois** (par son uid) depuis `/cartes/encoder`. Ensuite l'atelier
reconnaît seul ce qu'on pose sur le téléphone : le passeur (on relève et on mémorise son adresse),
une vierge (on y copie l'histoire choisie), une copie déjà faite (rien à faire), une carte qui porte
autre chose (on confirme avant d'écraser). On change de passeur par « changer de passeur » (Réglages
ou page d'encodage).

1. Publier le projet ici : Yoto crée le contenu et son `cardId`.
2. Dans l'app Yoto, « Link to a card » sur le passeur.
3. `/cartes/encoder` : poser le passeur (son adresse est gardée), puis poser les vierges.

Relevé depuis la page d'un projet, le passeur rattache son adresse au projet quand les titres
concordent : ensuite, « Écrire cette histoire sur une carte » suffit, sans repasser par le passeur.
Une carte déjà formatée est lue avant d'être écrite, et change d'histoire en un seul geste.

`/cartes/verifier` lit n'importe quelle carte et dit quelle histoire elle porte ; chaque erreur
(NFC refusé, puce non formatée, mauvais modèle de puce…) s'affiche avec sa correction.

**Limite d'une copie.** Yoto ne connaît pas l'uid d'une puce vierge : le serveur la refuse, et l'app
du téléphone affiche « Échec de lecture ». Une copie ne joue que sur un **lecteur** qui a déjà
téléchargé l'histoire en entier (via le passeur), et il faut recommencer après chaque republication.

Web NFC oblige : **Chrome sur Android, en HTTPS**. Prendre la variante **48 octets** (MF0UL11) ;
celle de 128 octets se formate autrement. Une puce sortie d'usine sans en-tête NDEF se formate une
fois pour toutes avec deux commandes brutes, que la page affiche.

## Faire dessiner l'IA

DeepSeek n'a pas de sortie image : son API ne sert que du texte, et `/images/generations`
répond 404. Mais un modèle de texte sait décrire un dessin — alors on lui demande du **SVG**,
et c'est le serveur qui rasterise.

- **Couverture** : une illustration en aplats découpés, rendue en PNG 1024×1024, téléversée
  chez Yoto et réutilisée telle quelle par l'étiquette Cricut.
- **Icônes** : le même procédé sur une grille de 64, réduite à 16×16 — seuil d'alpha et palette
  ramenée à huit couleurs, sans quoi la réduction ne donne qu'une bouillie de demi-teintes.
  Une piste à la fois, ou tout un projet en tâche de fond.

Le SVG reçu vient d'une source non fiable : il est filtré par liste blanche avant d'atteindre le
moteur de rendu. Le risque n'est pas le script — librsvg n'en exécute pas — mais la référence
externe, un `<image href="http://…">` qui ferait sortir une requête du serveur vers une adresse
choisie par le modèle.

Deux pièges de l'API, payés tous les deux : `response_format: json_object` exige que le mot
« json » figure dans les messages, et le modèle doit rester `deepseek-chat`. Appelés par leur
nom, `deepseek-flash` et `deepseek-v4-pro` réfléchissent d'abord et épuisent parfois tout leur
budget de jetons en raisonnement, sans jamais écrire la réponse.

## Décorer les cartes

La couverture d'un projet ressort en étiquette à coller : un PNG 300 ppp, 82,6 × 51 mm — une
carte Yoto est un CR80 de 85,6 × 54 mm, et le liseré nu qui reste autour absorbe l'imprécision
de la découpe. Le fond est transparent : dans Design Space, « Imprimer puis découper » suit le
contour arrondi de la zone opaque, il n'y a pas de trait de coupe à dessiner.

`/cartes/etiquettes` en compose une planche de huit, la limite d'une feuille. L'original
téléversé est conservé à côté des pistes : Yoto ne renvoie qu'une version réduite, trop pauvre
pour l'impression.

## Développement

```sh
npm install
cp .env.example .env     # puis renseigner les clés
npm run dev              # http://localhost:3000
npm test                 # 77 tests, hors réseau
npm run typecheck
```

Outils externes attendus sur la machine : `ffmpeg`, `ffprobe`, et `yt-dlp` pour l'ingestion
YouTube.

## Déploiement

Conteneur Docker derrière Traefik. Voir [deploy/README.md](deploy/README.md).

## Licence

Usage personnel.
