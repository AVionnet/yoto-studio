# Déploiement

Cible : une KVM Debian/Ubuntu, servie en HTTPS derrière Caddy.

## Prérequis

**Un vrai nom de domaine pointé sur la machine.** Caddy ne peut pas obtenir de certificat pour
une adresse IP nue, et sans HTTPS trois fonctions tombent : le micro (`getUserMedia`), la sonde
NFC (Web NFC) et le callback OAuth de Yoto, qui refuse le HTTP en clair.

Vérifier avant tout le reste :

```sh
dig +short yoto.vadech.tech     # doit rendre l'IP de la KVM
```

## Installation, une fois

```sh
# Node 22, ffmpeg, Caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs ffmpeg caddy git

# yt-dlp : depuis les binaires officiels, les paquets de distribution sont trop vieux
sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp

# Utilisateur de service et emplacements
sudo useradd --system --home /srv/yoto-studio --shell /usr/sbin/nologin yoto
sudo mkdir -p /srv/yoto-studio /var/lib/yoto-studio/{data,media}
sudo chown -R yoto:yoto /srv/yoto-studio /var/lib/yoto-studio
```

## Le dépôt et la configuration

```sh
sudo -u yoto git clone git@github.com:AVionnet/yoto-studio.git /srv/yoto-studio
cd /srv/yoto-studio
sudo -u yoto cp .env.example .env
sudo -u yoto nano .env          # voir ci-dessous
sudo chmod 600 .env
```

`.env` de production, au minimum :

```
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://yoto.vadech.tech
SESSION_SECRET=<openssl rand -hex 32>
APP_PASSWORD=<un mot de passe solide>

YOTO_CLIENT_ID=<portail développeur Yoto>
YOTO_CLIENT_SECRET=<idem, si client confidentiel>
DEEPSEEK_API_KEY=<platform.deepseek.com>

DATA_DIR=/var/lib/yoto-studio/data
MEDIA_DIR=/var/lib/yoto-studio/media
```

**Déclarer le callback** `https://yoto.vadech.tech/auth/yoto/callback` dans les *Allowed Callback
URLs* de l'application, sur le portail développeur Yoto. Sans lui, la connexion échoue.

## Services

```sh
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo cp deploy/yoto-studio.service /etc/systemd/system/

sudo -u yoto npm ci --omit=dev && sudo -u yoto npm run build
sudo systemctl daemon-reload
sudo systemctl enable --now yoto-studio caddy
```

## Mises à jour

```sh
cd /srv/yoto-studio
sudo -u yoto git pull
sudo -u yoto npm ci --omit=dev
sudo -u yoto npm run build
sudo systemctl restart yoto-studio
```

Les migrations de schéma s'appliquent seules au démarrage. La base vit dans
`/var/lib/yoto-studio/data`, hors du dépôt : un déploiement ne l'efface jamais.

## Sauvegarde

Un seul fichier compte — il contient les jetons Yoto, le pool de cartes et les projets :

```sh
sqlite3 /var/lib/yoto-studio/data/yoto-studio.db ".backup /tmp/yoto.db"
```

## Le point qui cassera un jour

Depuis une IP de datacenter, YouTube applique son traitement le plus strict et aucun drapeau n'y
remédie durablement. Fournir un `cookies.txt` d'un compte connecté via `YTDLP_COOKIES_FILE`
repousse l'échéance ; le dépôt de fichiers et l'enregistrement au micro, eux, ne dépendent de
personne.
