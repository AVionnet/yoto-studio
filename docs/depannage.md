# Dépannage NFC

Ce qu'on fait quand l'encodage ou la lecture d'une carte bloque : un symptôme, une correction.
Ces conseils figuraient en bas des pages « Fabriquer une carte » et « Lire une carte » ; ils
vivent désormais ici, hors de l'interface.

Web NFC n'existe que sur **Chrome pour Android, en HTTPS**.

## Rien ne se passe quand je pose la carte

Le NFC est-il activé (Réglages Android → Appareils connectés → NFC) ? Fais glisser la carte
lentement sur tout le dos du téléphone : la zone NFC est souvent au centre ou près de l'appareil
photo. Une coque épaisse ou métallique bloque le signal.

## L'app Yoto ou une page yoto.io s'ouvre au lieu de la page

La lecture n'était pas lancée : appuie d'abord sur « Lire une carte » ou « Écrire sur une carte »,
puis pose la carte. Garde la page au premier plan, écran allumé.

## Le passeur relevé n'est pas la bonne histoire

Dans l'app Yoto, relie la bonne histoire au passeur, attends la confirmation, puis repose-le.

## « Échec de lecture » dans l'app Yoto du téléphone

Normal pour une copie : Yoto ne connaît pas sa puce et la refuse. Seul un lecteur qui a déjà
téléchargé l'histoire la joue (voir « Pour qu'une copie joue » sur la page).

## Le lecteur affiche un panneau rouge avec la copie

Il n'a pas encore l'histoire en entier. Joue-la avec le passeur jusqu'à ce qu'elle marche wifi
coupé, puis remets la copie.

## Le téléphone refuse d'écrire sur la puce (« IO error »)

Une puce neuve doit être formatée NDEF une fois avant la première écriture, et Chrome ne sait pas
le faire. Avec l'app **NFC Tools** : onglet « Autres » → « Effacer le tag », pose la puce, puis
reviens écrire.

Si ça ne suffit pas, toujours dans NFC Tools (Autres → Commandes NFC avancées), envoie ces deux
commandes une fois sur la puce :

```
A2 03 E1 10 06 00
A2 04 03 00 FE 00
```

La première déclare un tag NDEF de 48 octets, la seconde y dépose un message vide. Achète bien la
variante **48 octets** (MIFARE Ultralight EV1, MF0UL11) : celle de 128 octets se formate
autrement. Si NFC Tools affiche « Inscriptible : non », la puce est verrouillée ou d'un mauvais
type : il en faut une autre.
