/** Formes de l'API Yoto, en camelCase tel quel sur le fil. */

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | undefined;
  /** Epoch en secondes. */
  expiresAt: number;
}

export interface UploadSlot {
  uploadId: string;
  /** Absent quand Yoto connait deja ce sha256 : le fichier est deduplique, on saute le PUT. */
  uploadUrl?: string | undefined;
}

export interface TranscodedInfo {
  duration?: number;
  fileSize?: number;
  format?: string;
  /** Documente a la fois comme 2 et comme "stereo". */
  channels?: number | string;
}

export interface Transcoded {
  transcodedSha256: string;
  transcodedInfo?: TranscodedInfo;
}

export interface DisplayIcon {
  mediaId: string;
  title?: string;
  publicTags?: string[];
  /** Re-uploader une icone existante renvoie `{}` au lieu d'une chaine — traite comme absent. */
  url?: string;
  new?: boolean;
}

export interface CoverImage {
  mediaId?: string;
  mediaUrl: string;
}

/**
 * `icon16x16` s'ecrit avec un x minuscule. Une conversion camelCase naive produit `icon16X16`
 * et l'icone est ignoree sans la moindre erreur.
 */
export interface TrackDisplay {
  icon16x16?: string;
  iconUrl16x16?: string;
}

export interface Track {
  key: string;
  title: string;
  trackUrl: string;
  type: 'audio' | 'stream';
  format?: string;
  duration?: number;
  fileSize?: number;
  overlayLabel?: string;
  display?: TrackDisplay;
}

export interface Chapter {
  key: string;
  title: string;
  tracks: Track[];
  display?: TrackDisplay;
  overlayLabel?: string;
}

export interface CardContent {
  chapters: Chapter[];
  config?: Record<string, unknown>;
}

export interface CardMetadata {
  cover?: { imageL?: string };
  author?: string;
  description?: string;
  category?: string;
  languages?: string[];
  minAge?: number;
  maxAge?: number;
  media?: { duration?: number; fileSize?: number };
}

/**
 * Les champs inconnus (`sortkey`, `userId`, `content.activity`, `chapters[].ambient`,
 * `tracks[].events`…) doivent transiter intacts lors d'une mise a jour, d'ou l'index libre.
 */
export interface Card {
  cardId?: string;
  title: string;
  content?: CardContent;
  metadata?: CardMetadata;
  slug?: string;
  createdAt?: string;
  updatedAt?: string;
  [unknown: string]: unknown;
}

export interface CardSummary {
  cardId: string;
  title: string;
  content?: { chapters?: unknown[] };
  [unknown: string]: unknown;
}
