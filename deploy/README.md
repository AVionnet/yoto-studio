# Déploiement

Cible : la KVM Hostinger, où **Traefik occupe déjà 80 et 443** et route les services par labels
Docker. L'application s'y insère comme les autres conteneurs — pas de serveur web supplémentaire,
pas de port publié sur l'hôte.

## Prérequis

Le domaine doit pointer sur la machine **avant** le premier démarrage : Traefik demande le
certificat par challenge HTTP, et un domaine qui ne résout pas fait échouer l'émission.

```sh
dig +short yoto.vadech.tech     # doit rendre l'IP de la KVM
```

HTTPS n'est pas un confort ici. Le micro (`getUserMedia`), la sonde NFC (Web NFC) et le callback
OAuth de Yoto exigent tous les trois un contexte sécurisé.

## Installation

Le dépôt est privé : donner au serveur une clé de déploiement en lecture seule.

```sh
ssh-keygen -t ed25519 -f /root/.ssh/yoto-deploy -N '' -C 'yoto-studio deploy'
# puis, depuis un poste authentifié :
#   gh repo deploy-key add /root/.ssh/yoto-deploy.pub -R AVionnet/yoto-studio -t kvm

git clone git@github.com:AVionnet/yoto-studio.git /docker/yoto-studio
cd /docker/yoto-studio && cp deploy/docker-compose.yml .
```

Créer le `.env` à côté :

```
COMPOSE_PROJECT_NAME=yoto-studio
TRAEFIK_HOST=yoto.vadech.tech

SESSION_SECRET=<openssl rand -hex 32>
APP_PASSWORD=<un mot de passe solide>

YOTO_CLIENT_ID=<portail développeur Yoto>
YOTO_CLIENT_SECRET=<idem, si client confidentiel>
YOTO_SCOPES=<facultatif : à aligner sur les scopes cochés dans le portail>
DEEPSEEK_API_KEY=<platform.deepseek.com>
```

```sh
chmod 600 .env
docker compose up -d --build
```

**Déclarer le callback** `https://yoto.vadech.tech/auth/yoto/callback` dans les *Allowed Callback
URLs* du portail développeur Yoto. Sans lui, la connexion échoue avec une erreur de redirection.

## Mises à jour

```sh
cd /docker/yoto-studio
git pull && cp deploy/docker-compose.yml .
docker compose build --pull && docker compose up -d
```

Les migrations de schéma s'appliquent seules au démarrage.

## État persistant

Deux volumes nommés, `yoto-studio_data` et `yoto-studio_media`. La base contient les jetons Yoto,
le pool de cartes et les projets ; un redéploiement n'y touche jamais.

```sh
docker compose exec app node -e "console.log(process.env.DATA_DIR)"
docker run --rm -v yoto-studio_data:/d -v "$PWD":/out alpine \
  tar czf /out/yoto-data.tgz -C /d .
```

## Diagnostic

```sh
docker compose logs -f app          # journal applicatif
docker logs traefik-mtso-traefik-1 --tail 50 | grep -i acme   # émission du certificat
```

## Le point qui cassera un jour

Depuis une IP de datacenter, YouTube applique son traitement le plus strict et aucun drapeau n'y
remédie durablement. Fournir un `cookies.txt` d'un compte connecté via `YTDLP_COOKIES_FILE`
repousse l'échéance ; le dépôt de fichiers et l'enregistrement au micro, eux, ne dépendent de
personne.

### Fournir le cookies.txt

Le `docker-compose.yml` monte `./cookies.txt` (à côté du `.env`) sur `/data/cookies.txt` dans le
conteneur. Ce fichier doit exister **avant** `docker compose up`, même vide, sinon Docker crée un
dossier à sa place.

```sh
# à côté du .env, tant qu'on n'a pas de vrais cookies
touch /docker/yoto-studio/cookies.txt
```

Pour débloquer l'ingestion YouTube :

1. Se connecter à un compte YouTube dans un navigateur, installer une extension du type
   *Get cookies.txt LOCALLY*, exporter les cookies du domaine `youtube.com`.
2. Copier le fichier sur le serveur, à côté du `.env` :
   ```sh
   scp cookies.txt root@<kvm>:/docker/yoto-studio/cookies.txt
   ```
3. Ajouter dans le `.env` :
   ```
   YTDLP_COOKIES_FILE=/data/cookies.txt
   ```
4. Redémarrer :
   ```sh
   docker compose up -d
   ```

Le compte utilisé se fera éventuellement bloquer par YouTube au bout d'un moment ; il faudra alors
recommencer l'export.
