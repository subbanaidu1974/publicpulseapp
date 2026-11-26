import type { Lang } from "../../i18n";

/** Media tab text, English and Telugu together. The Telugu is a machine-drafted first pass and has not been reviewed by a native speaker. */
const EN = {
  "m.title": "Media",
  "m.intro": "News, videos and live channels, each from its own publisher. We link to the source and never copy it.",
  "m.tabs": "Media sections",
  "m.tab.news": "News", "m.tab.watch": "Watch", "m.tab.live": "Live", "m.tab.ours": "From us",
  "m.news.h": "Daily news", "m.news.none": "No news is shown yet. Headlines will appear here only from outlets that have allowed it, each linking to the publisher.",
  "m.live.h": "Live channels", "m.live.none": "No live channels are listed yet. A channel is listed only after it confirms that we may show its official stream.",
  "m.ours.h": "From us", "m.ours.none": "No videos from us yet. Short explainers on how to vote, how to read a result and how to report an issue will appear here.",
  "m.watch.h": "Watch and listen", "m.watch.lead": "A free player. Pick a video or audio file from your device. Nothing is uploaded and nothing about what you play is kept.",
  "m.pick": "Choose a video or audio file", "m.pick.bad": "That file is not a video or audio file the player knows.",
  "m.nofile": "No file chosen yet.",
  "m.player": "Media player", "m.speed": "Speed", "m.audioonly": "Audio only", "m.captions": "Captions file (optional, .vtt)", "m.captions.bad": "Captions must be a .vtt file.",
  "m.error": "This file could not be played in your browser. Try another file or format (mp4, webm, mp3, wav).",
  "m.nowplaying": "Now playing", "m.clear": "Remove file", "m.noauto": "It will not start by itself.",
} as const;
export type MediaKey = keyof typeof EN;
const TE: Record<MediaKey, string> = {
  "m.title": "మీడియా",
  "m.intro": "వార్తలు, వీడియోలు, ప్రత్యక్ష ఛానళ్లు, ప్రతిదీ దాని ప్రచురణకర్త నుంచే. మూలానికి లింక్ ఇస్తాం, కాపీ చేయం.",
  "m.tabs": "మీడియా విభాగాలు",
  "m.tab.news": "వార్తలు", "m.tab.watch": "చూడండి", "m.tab.live": "ప్రత్యక్షం", "m.tab.ours": "మా నుంచి",
  "m.news.h": "రోజువారీ వార్తలు", "m.news.none": "ఇంకా వార్తలు చూపడం లేదు. అనుమతించిన సంస్థల శీర్షికలు మాత్రమే, ప్రచురణకర్తకు లింక్‌తో ఇక్కడ కనిపిస్తాయి.",
  "m.live.h": "ప్రత్యక్ష ఛానళ్లు", "m.live.none": "ఇంకా ప్రత్యక్ష ఛానళ్లు లేవు. అధికారిక స్ట్రీమ్ చూపడానికి అనుమతి ఇచ్చిన ఛానల్ మాత్రమే జాబితాలో చేరుతుంది.",
  "m.ours.h": "మా నుంచి", "m.ours.none": "మా వీడియోలు ఇంకా లేవు. ఎలా ఓటు వేయాలి, ఫలితాన్ని ఎలా చదవాలి, సమస్యను ఎలా నమోదు చేయాలి అనే చిన్న వివరణలు ఇక్కడ వస్తాయి.",
  "m.watch.h": "చూడండి, వినండి", "m.watch.lead": "ఉచిత ప్లేయర్. మీ పరికరం నుంచి వీడియో లేదా ఆడియో ఫైల్ ఎంచుకోండి. ఏదీ అప్‌లోడ్ కాదు, మీరు ఏమి ప్లే చేశారో ఏదీ నిల్వ చేయం.",
  "m.pick": "వీడియో లేదా ఆడియో ఫైల్ ఎంచుకోండి", "m.pick.bad": "ఆ ఫైల్ ప్లేయర్‌కు తెలిసిన వీడియో లేదా ఆడియో ఫైల్ కాదు.",
  "m.nofile": "ఇంకా ఫైల్ ఎంచుకోలేదు.",
  "m.player": "మీడియా ప్లేయర్", "m.speed": "వేగం", "m.audioonly": "ఆడియో మాత్రమే", "m.captions": "శీర్షికల ఫైల్ (ఐచ్ఛికం, .vtt)", "m.captions.bad": "శీర్షికలు .vtt ఫైల్ అయి ఉండాలి.",
  "m.error": "ఈ ఫైల్‌ను మీ బ్రౌజర్‌లో ప్లే చేయలేకపోయాం. మరో ఫైల్ లేదా ఫార్మాట్ (mp4, webm, mp3, wav) ప్రయత్నించండి.",
  "m.nowplaying": "ఇప్పుడు ప్లే అవుతోంది", "m.clear": "ఫైల్ తొలగించు", "m.noauto": "ఇది దానంతట అదే మొదలవదు.",
};
export const mediaText = (lang: Lang, k: MediaKey): string => (lang === "te" ? TE[k] : EN[k]);
