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
| **Écouter** | Émulateur de lecteur, avec streaming et déplacement dans la piste |

## Le pool de cartes

Une carte Yoto porte un unique enregistrement NDEF : `https://yoto.io/<cardId>?<token>`. Le token
est frappé par le serveur et n'est pas forgeable hors-ligne, donc **relier une carte reste manuel,
une seule fois dans sa vie**, depuis l'app Yoto.

Mais le token est lié au `cardId`, pas à la carte physique — et `POST /content` avec un `cardId`
existant met à jour le contenu. Une carte enrôlée se reprogramme donc indéfiniment par l'API, sans
jamais toucher au tag.

## Encoder des cartes vierges

Une carte Yoto est un MIFARE Ultralight EV1 de 48 octets : exactement les puces vierges vendues par
lots. Il n'y manque que l'adresse — et l'adresse ne s'invente pas, puisque le token est signé par
Yoto.

Elle se relève. Lier un contenu à une carte MYO depuis l'app Yoto y écrit une adresse neuve : une
seule carte officielle suffit donc, comme **passeur**.

1. Publier le projet ici : Yoto crée le contenu et son `cardId`.
2. Dans l'app Yoto, « Link to a card » sur le passeur.
3. `/cartes/encoder` relève le passeur, recopie son adresse sur la vierge, et relit pour vérifier.
4. Le passeur redevient libre pour le contenu suivant ; la vierge garde le sien pour de bon.

La vierge rejoint le pool avec son adresse : elle se republie ensuite par l'API, sans NFC ni app.
La même adresse recopiée sur deux puces donne deux jumelles, qui jouent la même chose — de quoi
remplacer une carte perdue.

Web NFC oblige : **Chrome sur Android, en HTTPS**. Prendre la variante **48 octets** (MF0UL11) ;
celle de 128 octets se formate autrement. Une puce sortie d'usine sans en-tête NDEF se formate une
fois pour toutes avec deux commandes brutes, que la page affiche.

## Développement

```sh
npm install
cp .env.example .env     # puis renseigner les clés
npm run dev              # http://localhost:3000
npm test                 # 54 tests, hors réseau
npm run typecheck
```

Outils externes attendus sur la machine : `ffmpeg`, `ffprobe`, et `yt-dlp` pour l'ingestion
YouTube.

## Déploiement

Conteneur Docker derrière Traefik. Voir [deploy/README.md](deploy/README.md).

## Licence

Usage personnel.
