-- Tout l'etat vit ici. Le cookie de session ne porte qu'un identifiant.
-- (L'application Flask de reference stockait la liste des pistes dans le cookie signe,
--  qui deborde silencieusement la limite de 4 Ko au-dela d'une dizaine de titres.)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Le pool : une ligne par carte physique enrolee une fois pour toutes.
CREATE TABLE IF NOT EXISTS cards (
  id                 INTEGER PRIMARY KEY,
  card_id            TEXT NOT NULL UNIQUE,      -- identifiant Yoto, 5 caracteres
  nickname           TEXT NOT NULL,             -- « la bleue », « celle du dinosaure »
  ndef_url           TEXT,                      -- relevee par Web NFC, jamais reecrite
  track_count        INTEGER NOT NULL DEFAULT 0,-- pour verifier la limite de 100
  current_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  enrolled_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Un projet = une fabrication, de la source jusqu'a la publication.
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'draft'
               CHECK (state IN ('draft','fetching','segmenting','reviewing',
                                'uploading','published','failed')),
  source_kind  TEXT CHECK (source_kind IN ('upload','youtube','rss','voice')),
  source_ref   TEXT,                            -- URL, GUID d'episode, nom de fichier
  source_path  TEXT,                            -- fichier long telecharge, purge apres publication
  card_id      TEXT REFERENCES cards(card_id) ON DELETE SET NULL,
  cover_url    TEXT,                            -- donne metadata.cover.imageL
  artwork_json TEXT,                            -- theme, sous-titre, choix de mise en page
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Une piste = une frontiere validee par l'humain, puis un fichier, puis un sha transcode.
CREATE TABLE IF NOT EXISTS tracks (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx               INTEGER NOT NULL,           -- 0-base, ordre d'affichage
  title             TEXT NOT NULL,
  -- Texte a lire a voix haute, quand la piste vient d'une histoire ecrite.
  text              TEXT,
  start_ms          INTEGER NOT NULL,
  end_ms            INTEGER NOT NULL,
  file_path         TEXT,
  duration_ms       INTEGER,
  file_size         INTEGER,
  -- Controle de coupe : niveau moyen sur 0,6 s en tete et en queue. Doit etre <= -40 dB.
  head_db           REAL,
  tail_db           REAL,
  transcoded_sha256 TEXT,                       -- donne trackUrl = "yoto:#" || ce sha
  icon_media_id     TEXT,                       -- donne display.icon16x16 = "yoto:#" || ce media
  icon_url          TEXT,                       -- apercu seulement, jamais envoye a Yoto
  UNIQUE (project_id, idx)
);

-- File de travaux longs. Un worker in-process, reprise au demarrage.
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                   -- fetch | segment | upload | artwork
  payload_json TEXT NOT NULL DEFAULT '{}',
  state        TEXT NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued','running','cancelling','done','error','cancelled')),
  progress     INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  message      TEXT NOT NULL DEFAULT '',
  result_json  TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Les jobs termines sont conserves jusqu'a cette date, pas supprimes a la premiere lecture :
  -- sinon un simple rafraichissement de page perd le resultat.
  expires_at   TEXT
);

CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (state, id) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS tracks_project ON tracks (project_id, idx);

-- Jetons Yoto, cookies YouTube, reglages divers.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
