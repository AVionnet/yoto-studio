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
| **Écouter** | Émulateur de lecteur, avec streaming et déplacement dans la piste |

## Le pool de cartes

Une carte Yoto porte un unique enregistrement NDEF : `https://yoto.io/<cardId>?<token>`. Le token
est frappé par le serveur et n'est pas forgeable hors-ligne, donc **relier une carte reste manuel,
une seule fois dans sa vie**, depuis l'app Yoto.

Mais le token est lié au `cardId`, pas à la carte physique — et `POST /content` avec un `cardId`
existant met à jour le contenu. Une carte enrôlée se reprogramme donc indéfiniment par l'API, sans
jamais toucher au tag.

## Développement

```sh
npm install
cp .env.example .env     # puis renseigner les clés
npm run dev              # http://localhost:3000
npm test                 # 34 tests, hors réseau
npm run typecheck
```

Outils externes attendus sur la machine : `ffmpeg`, `ffprobe`, et `yt-dlp` pour l'ingestion
YouTube.

## Déploiement

Voir [deploy/README.md](deploy/README.md).

## Licence

Usage personnel.
