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
  "m.yt.h": "Play a YouTube link", "m.yt.lead": "Paste a link to a video on YouTube. It plays here, in YouTube's own player. Nothing is saved: we do not keep your links or what you watch.", "m.yt.label": "YouTube video link", "m.yt.go": "Play", "m.yt.bad": "That is not a YouTube video link. Use a link like youtube.com/watch?v=… or youtu.be/…", "m.yt.clear": "Remove video", "m.wp.h": "Watch", "m.wp.all": "All", "m.wp.related": "Related videos", "m.wp.filters": "Show", "m.wp.nodesc": "No description.", "m.wp.ours.badge": "Ours", "m.wp.pick": "Choose a video from the list to play it here.", "m.wp.upnext": "Videos", "m.wp.prev": "Previous video", "m.wp.next": "Next video", "m.wp.own": "From us", "m.wp.yt": "YouTube", "m.wp.none": "No videos are listed yet. News videos from YouTube and our own videos appear here once they are switched on.", "m.wp.now": "Now showing", "m.pick": "Choose a video or audio file", "m.pick.bad": "That file is not a video or audio file the player knows.",
  "m.nofile": "No file chosen yet.",
  "m.player": "Media player", "m.speed": "Speed", "m.audioonly": "Audio only", "m.captions": "Captions file (optional, .vtt)", "m.captions.bad": "Captions must be a .vtt file.",
  "m.error": "This file could not be played in your browser. Try another file or format (mp4, webm, mp3, wav).",
  "m.new": "New", "m.credit": "Credit", "m.error.remote": "This video could not be played. It may have been moved. Please try again later.", "m.ours.signin": "Sign in to see the videos we send to members.", "m.badge": "new videos",
  "m.top": "Top today", "m.more": "Earlier this week", "m.from": "From", "m.open.pub": "Read at the publisher", "m.pubnote": "Headlines are the publisher's own. We link to them and do not copy the story.", "m.stale": "These sources have not updated recently:",
  "m.yt.play": "Play here (YouTube)", "m.yt.hide": "Hide video", "m.yt.note": "Playing loads YouTube's own player, so YouTube can see your address. Nothing loads until you tap.", "m.live.open": "Open on the channel's own site", "m.live.play": "Watch here", "m.live.hide": "Hide player", "m.live.down": "The stream is not available right now. Use the channel's own site.", "m.live.note": "Official streams only. Some browsers cannot play a live stream here.",
  "m.lib.h": "Our explainers", "m.lib.none": "No explainers yet.", "m.transcript": "Transcript",
  "m.report": "Report", "m.report.why": "What is wrong?", "m.reason.wrong": "It is wrong or misleading", "m.reason.partisan": "It promotes a party or candidate", "m.reason.offensive": "It is offensive", "m.reason.broken": "It does not play or open", "m.reason.other": "Something else", "m.report.send": "Send report", "m.report.thanks": "Thank you. An admin will look at it.", "m.report.dup": "You have already reported this.", "m.report.signin": "Sign in to report",
  "m.mute": "Do not alert me about new videos", "m.mute.note": "Kept only in this browser. You can still open From us at any time.", "m.withdrawn": "Withdrawn", "m.withdrawn.h": "Withdrawn recently", "m.withdrawn.none": "No reason was given.",
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
  "m.yt.h": "YouTube లింక్ ప్లే చేయండి", "m.yt.lead": "YouTubeలోని వీడియో లింక్‌ను అతికించండి. ఇది ఇక్కడే YouTube స్వంత ప్లేయర్‌లో ప్లే అవుతుంది. ఏదీ సేవ్ కాదు: మీ లింక్‌లను లేదా మీరు చూసేదాన్ని మేము ఉంచుకోము.", "m.yt.label": "YouTube వీడియో లింక్", "m.yt.go": "ప్లే", "m.yt.bad": "అది YouTube వీడియో లింక్ కాదు. youtube.com/watch?v=… లేదా youtu.be/… లాంటి లింక్ వాడండి.", "m.yt.clear": "వీడియో తీసివేయండి", "m.wp.h": "చూడండి", "m.wp.all": "అన్నీ", "m.wp.related": "సంబంధిత వీడియోలు", "m.wp.filters": "చూపు", "m.wp.nodesc": "వివరణ లేదు.", "m.wp.ours.badge": "మనవి", "m.wp.pick": "ఇక్కడ ప్లే చేయడానికి జాబితా నుంచి వీడియో ఎంచుకోండి.", "m.wp.upnext": "వీడియోలు", "m.wp.prev": "మునుపటి వీడియో", "m.wp.next": "తర్వాతి వీడియో", "m.wp.own": "మా నుంచి", "m.wp.yt": "YouTube", "m.wp.none": "ఇంకా వీడియోలు లేవు. YouTube వార్తా వీడియోలు మరియు మా స్వంత వీడియోలు ఆన్ చేసిన తర్వాత ఇక్కడ కనిపిస్తాయి.", "m.wp.now": "ఇప్పుడు చూపుతున్నది", "m.pick": "వీడియో లేదా ఆడియో ఫైల్ ఎంచుకోండి", "m.pick.bad": "ఆ ఫైల్ ప్లేయర్‌కు తెలిసిన వీడియో లేదా ఆడియో ఫైల్ కాదు.",
  "m.nofile": "ఇంకా ఫైల్ ఎంచుకోలేదు.",
  "m.player": "మీడియా ప్లేయర్", "m.speed": "వేగం", "m.audioonly": "ఆడియో మాత్రమే", "m.captions": "శీర్షికల ఫైల్ (ఐచ్ఛికం, .vtt)", "m.captions.bad": "శీర్షికలు .vtt ఫైల్ అయి ఉండాలి.",
  "m.error": "ఈ ఫైల్‌ను మీ బ్రౌజర్‌లో ప్లే చేయలేకపోయాం. మరో ఫైల్ లేదా ఫార్మాట్ (mp4, webm, mp3, wav) ప్రయత్నించండి.",
  "m.new": "కొత్త", "m.credit": "క్రెడిట్", "m.error.remote": "ఈ వీడియో ప్లే కాలేదు. అది మార్చబడి ఉండవచ్చు. దయచేసి తర్వాత మళ్లీ ప్రయత్నించండి.", "m.ours.signin": "మేము సభ్యులకు పంపే వీడియోలను చూడటానికి సైన్ ఇన్ చేయండి.", "m.badge": "కొత్త వీడియోలు",
  "m.top": "ఈరోజు ముఖ్యమైనవి", "m.more": "ఈ వారం ముందువి", "m.from": "మూలం", "m.open.pub": "ప్రచురణకర్త వద్ద చదవండి", "m.pubnote": "శీర్షికలు ప్రచురణకర్తవే. వాటికి లింక్ ఇస్తాం, కథనాన్ని కాపీ చేయం.", "m.stale": "ఈ మూలాలు ఇటీవల నవీకరించలేదు:",
  "m.yt.play": "ఇక్కడ ప్లే చేయండి (YouTube)", "m.yt.hide": "వీడియో దాచండి", "m.yt.note": "ప్లే చేస్తే YouTube స్వంత ప్లేయర్ లోడ్ అవుతుంది, కాబట్టి YouTube మీ చిరునామాను చూడగలదు. మీరు నొక్కే వరకు ఏదీ లోడ్ కాదు.", "m.live.open": "ఛానల్ స్వంత సైట్‌లో తెరవండి", "m.live.play": "ఇక్కడ చూడండి", "m.live.hide": "ప్లేయర్ దాచండి", "m.live.down": "స్ట్రీమ్ ప్రస్తుతం అందుబాటులో లేదు. ఛానల్ స్వంత సైట్ వాడండి.", "m.live.note": "అధికారిక స్ట్రీమ్‌లు మాత్రమే. కొన్ని బ్రౌజర్‌లు ప్రత్యక్ష ప్రసారాన్ని ఇక్కడ ప్లే చేయలేవు.",
  "m.lib.h": "మా వివరణ వీడియోలు", "m.lib.none": "ఇంకా వివరణ వీడియోలు లేవు.", "m.transcript": "పాఠ్యం",
  "m.report": "నివేదించండి", "m.report.why": "ఏమి తప్పు?", "m.reason.wrong": "ఇది తప్పు లేదా తప్పుదారి పట్టించేది", "m.reason.partisan": "ఇది పార్టీ లేదా అభ్యర్థిని ప్రచారం చేస్తోంది", "m.reason.offensive": "ఇది అభ్యంతరకరం", "m.reason.broken": "ఇది ప్లే కావడం లేదు లేదా తెరవడం లేదు", "m.reason.other": "మరేదైనా", "m.report.send": "నివేదిక పంపండి", "m.report.thanks": "ధన్యవాదాలు. అడ్మిన్ దీన్ని పరిశీలిస్తారు.", "m.report.dup": "మీరు ఇప్పటికే దీన్ని నివేదించారు.", "m.report.signin": "నివేదించడానికి సైన్ ఇన్ చేయండి",
  "m.mute": "కొత్త వీడియోల గురించి నన్ను హెచ్చరించవద్దు", "m.mute.note": "ఈ బ్రౌజర్‌లో మాత్రమే ఉంటుంది. మీరు ఎప్పుడైనా మా నుంచి విభాగం తెరవవచ్చు.", "m.withdrawn": "ఉపసంహరించబడింది", "m.withdrawn.h": "ఇటీవల ఉపసంహరించినవి", "m.withdrawn.none": "కారణం ఇవ్వలేదు.",
  "m.nowplaying": "ఇప్పుడు ప్లే అవుతోంది", "m.clear": "ఫైల్ తొలగించు", "m.noauto": "ఇది దానంతట అదే మొదలవదు.",
};
export const mediaText = (lang: Lang, k: MediaKey): string => (lang === "te" ? TE[k] : EN[k]);
