/**
 * Media hub (S-225, S-226, S-228, S-234, S-236): the sources behind the Media tab, daily news from permitted feeds, the live channel directory,
 * member reports, and aggregate counts. Mounted at /api/v1/civic/media. See docs/MEDIA_HUB.md.
 *
 * Nothing is shown from a source until an admin recorded WHY we may (permission note, date, contact) and a DIFFERENT admin switched it on.
 * News is headline, outlet, time and a link to the publisher; a snippet only where the source allows it; never the article. Live channels are
 * a link to the channel's own site, plus its own official stream when it gave one. We fetch nothing from a source that is switched off.
 *
 *   GET  /news?state=AP|TG        public: recent items from enabled news sources, a top-today digest, and which sources look stale
 *   GET  /live                    public: enabled live channels with their last health check
 *   POST /click                   public: {kind: "news"|"live", id} one counter per item per day, no person
 *   POST /report                  signed-in: {kind: "video"|"news"|"live", id, reason, note?}
 *   GET  /admin/sources           admin: all sources
 *   POST /admin/sources           admin: add a source (starts switched off)
 *   POST /admin/sources/:id/enable   a DIFFERENT admin: switch on (needs the permission record)
 *   POST /admin/sources/:id/disable  any admin: switch off at once; its news is hidden immediately
 *   POST /admin/sources/:id/refresh  admin: fetch a news feed now
 *   POST /admin/sources/:id/check    admin: check a live stream address now
 *   GET  /admin/reports           admin: reports, open first
 *   POST /admin/reports/:id/resolve  admin: {action: "dismiss"|"takedown"}
 *   GET  /admin/numbers           admin: aggregate counts per item (hidden under the minimum)
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import { audit, getKeys, registerMigration, requireAuth, requireRole } from "../core";
import { identityDb } from "../core/asyncBridge";
import { MediaHubStore, type SourceRow } from "../../data/repos/mediahub";
import { isProductionEnv } from "../guards";
import { mediaVideoHosts } from "../../security";
import { asksPartyPreference, asksSecret, hasLink } from "../broadcast";
import { recallVideo } from "../videocast";

registerMigration("mhub_001_core", `
CREATE TABLE mhub_sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('news','live')),
  name_en TEXT NOT NULL, name_te TEXT, site_url TEXT NOT NULL, feed_url TEXT, stream_url TEXT,
  allow TEXT NOT NULL CHECK (allow IN ('headline','snippet')), state TEXT NOT NULL CHECK (state IN ('AP','TG','BOTH')),
  permission_note TEXT, permission_date TEXT, contact TEXT,
  enabled INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, enabled_by TEXT, enabled_at TEXT,
  last_fetch_at TEXT, last_ok_at TEXT, last_error TEXT, health_ok INTEGER, health_at TEXT
);
CREATE TABLE mhub_news (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, title TEXT NOT NULL, link TEXT NOT NULL, snippet TEXT,
  published_at TEXT NOT NULL, fetched_at TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, link)
);
CREATE INDEX idx_mhub_news_pub ON mhub_news(published_at);
CREATE TABLE mhub_reports (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, item_id TEXT NOT NULL, reason TEXT NOT NULL, note TEXT,
  reporter TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolved_by TEXT, resolved_at TEXT, resolution TEXT,
  UNIQUE (kind, item_id, reporter)
);
CREATE TABLE mhub_counts (kind TEXT NOT NULL, item_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, item_id, day));
`);

// Candidate sources (S-242): The Hindu's official state feeds, loaded SWITCHED OFF with no permission record. Nothing is shown to members until an admin records
// the written permission and a different admin switches the source on. The feed addresses were checked on 2026-11-26; the permission is the owner's to obtain.
registerMigration("mhub_002_candidates", `
ALTER TABLE mhub_sources ADD COLUMN permission_by TEXT;
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,allow,state,created_by,created_at) VALUES
 ('cand-hindu-ap','news','The Hindu: Andhra Pradesh','ది హిందూ: ఆంధ్రప్రదేశ్','https://www.thehindu.com/news/national/andhra-pradesh/','https://www.thehindu.com/news/national/andhra-pradesh/feeder/default.rss','headline','AP','system','2026-11-26T00:00:00.000Z'),
 ('cand-hindu-tg','news','The Hindu: Telangana','ది హిందూ: తెలంగాణ','https://www.thehindu.com/news/national/telangana/','https://www.thehindu.com/news/national/telangana/feeder/default.rss','headline','TG','system','2026-11-26T00:00:00.000Z');
`);

// Telugu channel and newspaper feeds (S-244): the same rule as above. Each address answered with a valid RSS feed on 2026-11-26; none has a permission record.
registerMigration("mhub_003_telugu_candidates", `
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,allow,state,created_by,created_at) VALUES
 ('cand-ntv','news','NTV Telugu','ఎన్టీవీ తెలుగు','https://ntvtelugu.com/','https://ntvtelugu.com/feed','headline','BOTH','system','2026-11-26T00:00:00.000Z'),
 ('cand-tv9','news','TV9 Telugu','టీవీ9 తెలుగు','https://tv9telugu.com/','https://tv9telugu.com/feed','headline','BOTH','system','2026-11-26T00:00:00.000Z'),
 ('cand-10tv','news','10TV','10టీవీ','https://10tv.in/','https://10tv.in/feed','headline','BOTH','system','2026-11-26T00:00:00.000Z'),
 ('cand-sakshi','news','Sakshi','సాక్షి','https://www.sakshi.com/','https://www.sakshi.com/rss.xml','headline','BOTH','system','2026-11-26T00:00:00.000Z');
`);

// Google News topic feeds for Andhra Pradesh and Telangana (S-246 area, see tracker S-278): the same rule as above. Each address answered with a valid RSS feed on 2026-11-26.
// A Google News feed is an index of many publishers: the headline links go to those publishers, and Google's own terms for the feed are for the owner to read before it is switched on.
registerMigration("mhub_004_google_news_candidates", `
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,allow,state,created_by,created_at) VALUES
 ('cand-gnews-ap-en','news','Google News: Andhra Pradesh (English)','గూగుల్ న్యూస్: ఆంధ్రప్రదేశ్ (ఇంగ్లీష్)','https://news.google.com/','https://news.google.com/rss/search?q=Andhra+Pradesh&hl=en-IN&gl=IN&ceid=IN:en','headline','AP','system','2026-11-26T00:00:00.000Z'),
 ('cand-gnews-tg-en','news','Google News: Telangana (English)','గూగుల్ న్యూస్: తెలంగాణ (ఇంగ్లీష్)','https://news.google.com/','https://news.google.com/rss/search?q=Telangana&hl=en-IN&gl=IN&ceid=IN:en','headline','TG','system','2026-11-26T00:00:00.000Z'),
 ('cand-gnews-ap-te','news','Google News: Andhra Pradesh (Telugu)','గూగుల్ న్యూస్: ఆంధ్రప్రదేశ్ (తెలుగు)','https://news.google.com/','https://news.google.com/rss/search?q=%E0%B0%86%E0%B0%82%E0%B0%A7%E0%B1%8D%E0%B0%B0%E0%B0%AA%E0%B1%8D%E0%B0%B0%E0%B0%A6%E0%B1%87%E0%B0%B6%E0%B1%8D&hl=te&gl=IN&ceid=IN:te','headline','AP','system','2026-11-26T00:00:00.000Z'),
 ('cand-gnews-tg-te','news','Google News: Telangana (Telugu)','గూగుల్ న్యూస్: తెలంగాణ (తెలుగు)','https://news.google.com/','https://news.google.com/rss/search?q=%E0%B0%A4%E0%B1%86%E0%B0%B2%E0%B0%82%E0%B0%97%E0%B0%BE%E0%B0%A3&hl=te&gl=IN&ceid=IN:te','headline','TG','system','2026-11-26T00:00:00.000Z');
`);

// Telugu news channels' YouTube videos (S-279): the same rule as above. Each channel id was read from the channel's own page and its video feed answered with 15 recent videos on 2026-11-27.
// Nothing is shown until an admin records the channel's written permission and a different admin switches it on; the Watch tab then plays each video in YouTube's no-cookie embed after a tap.
registerMigration("mhub_005_telugu_youtube_candidates", `
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,allow,state,created_by,created_at) VALUES
 ('cand-yt-ntv','news','NTV Telugu (YouTube videos)','ఎన్టీవీ తెలుగు (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCumtYpCY26F6Jr3satUgMvA','https://www.youtube.com/feeds/videos.xml?channel_id=UCumtYpCY26F6Jr3satUgMvA','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-yt-tv9','news','TV9 Telugu (YouTube videos)','టీవీ9 తెలుగు (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCPXTXMecYqnRKNdqdVOGSFg','https://www.youtube.com/feeds/videos.xml?channel_id=UCPXTXMecYqnRKNdqdVOGSFg','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-yt-10tv','news','10TV News Telugu (YouTube videos)','10టీవీ న్యూస్ తెలుగు (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCfymZbh17_3T_UhgjkQ9fRQ','https://www.youtube.com/feeds/videos.xml?channel_id=UCfymZbh17_3T_UhgjkQ9fRQ','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-yt-sakshi','news','Sakshi TV (YouTube videos)','సాక్షి టీవీ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCZ9m4KOh8Ei60428xeGYDCQ','https://www.youtube.com/feeds/videos.xml?channel_id=UCZ9m4KOh8Ei60428xeGYDCQ','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-yt-abn','news','ABN Telugu (YouTube videos)','ఏబీఎన్ తెలుగు (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UC_2irx_BQR7RsBKmUV9fePQ','https://www.youtube.com/feeds/videos.xml?channel_id=UC_2irx_BQR7RsBKmUV9fePQ','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-yt-tv5','news','TV5 News (YouTube videos)','టీవీ5 న్యూస్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCAR3h_9fLV82N2FH4cE4RKw','https://www.youtube.com/feeds/videos.xml?channel_id=UCAR3h_9fLV82N2FH4cE4RKw','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-yt-v6','news','V6 News Telugu (YouTube videos)','వీ6 న్యూస్ తెలుగు (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCDCMjD1XIAsCZsYHNMGVcog','https://www.youtube.com/feeds/videos.xml?channel_id=UCDCMjD1XIAsCZsYHNMGVcog','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-yt-tnews','news','T News Telugu (YouTube videos)','టీ న్యూస్ తెలుగు (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCu6edg8_eu3-A8ylgaWereA','https://www.youtube.com/feeds/videos.xml?channel_id=UCu6edg8_eu3-A8ylgaWereA','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-yt-mahaa','news','Mahaa News (YouTube videos)','మహా న్యూస్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCDKjhgRoPF1CQk7HluMz23A','https://www.youtube.com/feeds/videos.xml?channel_id=UCDKjhgRoPF1CQk7HluMz23A','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-yt-etv','news','ETV Andhra Pradesh (YouTube videos)','ఈటీవీ ఆంధ్రప్రదేశ్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCJi8M0hRKjz8SLPvJKEVTOg','https://www.youtube.com/feeds/videos.xml?channel_id=UCJi8M0hRKjz8SLPvJKEVTOg','headline','BOTH','system','2026-11-27T00:00:00.000Z');
`);

// Live news channels (S-282): each channel's current live stream on its own YouTube channel (youtube.com/channel/UC.../live), loaded SWITCHED OFF with no permission record.
// Every channel had a live stream that YouTube allows to be embedded on 2026-11-27. When a channel is not live, YouTube's own player says so. Nothing loads until a member taps Play.
registerMigration("mhub_006_live_candidates", `
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,stream_url,allow,state,created_by,created_at) VALUES
 ('cand-live-ntv','live','NTV Telugu Live','ఎన్టీవీ తెలుగు లైవ్','https://www.youtube.com/channel/UCtzYV2L-m8ew93mZb3qhf5w',NULL,'https://www.youtube.com/channel/UCtzYV2L-m8ew93mZb3qhf5w/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-tv9','live','TV9 Telugu Live','టీవీ9 తెలుగు లైవ్','https://www.youtube.com/channel/UCPXTXMecYqnRKNdqdVOGSFg',NULL,'https://www.youtube.com/channel/UCPXTXMecYqnRKNdqdVOGSFg/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-sakshi','live','Sakshi TV Live','సాక్షి టీవీ లైవ్','https://www.youtube.com/channel/UCQ_FATLW83q-4xJ2fsi8qAw',NULL,'https://www.youtube.com/channel/UCQ_FATLW83q-4xJ2fsi8qAw/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-10tv','live','10TV News Telugu Live','10టీవీ న్యూస్ తెలుగు లైవ్','https://www.youtube.com/channel/UCfymZbh17_3T_UhgjkQ9fRQ',NULL,'https://www.youtube.com/channel/UCfymZbh17_3T_UhgjkQ9fRQ/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-tv5','live','TV5 News Live','టీవీ5 న్యూస్ లైవ్','https://www.youtube.com/channel/UCAR3h_9fLV82N2FH4cE4RKw',NULL,'https://www.youtube.com/channel/UCAR3h_9fLV82N2FH4cE4RKw/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-abn','live','ABN Telugu Live','ఏబీఎన్ తెలుగు లైవ్','https://www.youtube.com/channel/UC_2irx_BQR7RsBKmUV9fePQ',NULL,'https://www.youtube.com/channel/UC_2irx_BQR7RsBKmUV9fePQ/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-v6','live','V6 News Telugu Live','వీ6 న్యూస్ తెలుగు లైవ్','https://www.youtube.com/channel/UCDCMjD1XIAsCZsYHNMGVcog',NULL,'https://www.youtube.com/channel/UCDCMjD1XIAsCZsYHNMGVcog/live','headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-tnews','live','T News Telugu Live','టీ న్యూస్ తెలుగు లైవ్','https://www.youtube.com/channel/UCu6edg8_eu3-A8ylgaWereA',NULL,'https://www.youtube.com/channel/UCu6edg8_eu3-A8ylgaWereA/live','headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-mahaa','live','Mahaa News Live','మహా న్యూస్ లైవ్','https://www.youtube.com/channel/UCDKjhgRoPF1CQk7HluMz23A',NULL,'https://www.youtube.com/channel/UCDKjhgRoPF1CQk7HluMz23A/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-etv','live','ETV Andhra Pradesh Live','ఈటీవీ ఆంధ్రప్రదేశ్ లైవ్','https://www.youtube.com/channel/UCJi8M0hRKjz8SLPvJKEVTOg',NULL,'https://www.youtube.com/channel/UCJi8M0hRKjz8SLPvJKEVTOg/live','headline','AP','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-ddnews','live','DD News Live (Doordarshan)','డీడీ న్యూస్ లైవ్ (దూరదర్శన్)','https://www.youtube.com/channel/UCKwucPzHZ7zCUIf7If-Wo1g',NULL,'https://www.youtube.com/channel/UCKwucPzHZ7zCUIf7If-Wo1g/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-sansad','live','Sansad TV Live (Parliament)','సంసద్ టీవీ లైవ్ (పార్లమెంట్)','https://www.youtube.com/channel/UCISgnSNwqQ2i8lhCun3KtQg',NULL,'https://www.youtube.com/channel/UCISgnSNwqQ2i8lhCun3KtQg/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-ddsaptagiri','live','DD Saptagiri (Doordarshan, Andhra Pradesh)','డీడీ సప్తగిరి (దూరదర్శన్, ఆంధ్రప్రదేశ్)','https://www.youtube.com/channel/UCDytyrifMKGH-A2snskPcVw',NULL,'https://www.youtube.com/channel/UCDytyrifMKGH-A2snskPcVw/live','headline','AP','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-aljazeera','live','Al Jazeera English Live','అల్ జజీరా ఇంగ్లీష్ లైవ్','https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg',NULL,'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-dw','live','DW News Live','డీడబ్ల్యూ న్యూస్ లైవ్','https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg',NULL,'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg/live','headline','BOTH','system','2026-11-27T00:00:00.000Z');
`);

// More daily news feeds (S-280), loaded SWITCHED OFF with no permission record: Telugu outlets, state editions of national papers, government and public-broadcaster feeds.
// Each feed address answered with a feed our reader parses (headline, link, time) on 2026-11-27. Terms differ by outlet; a public feed is not permission, so each stays off until written permission is recorded.
registerMigration("mhub_007_news_feed_candidates", `
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,stream_url,allow,state,created_by,created_at) VALUES
 ('cand-feed-bbc-te','news','BBC News Telugu','బీబీసీ తెలుగు','https://www.bbc.com/telugu','https://feeds.bbci.co.uk/telugu/rss.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-oneindia-te','news','Oneindia Telugu','వన్ఇండియా తెలుగు','https://telugu.oneindia.com/','https://telugu.oneindia.com/rss/telugu-news-fb.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-visalaandhra','news','Visalaandhra','విశాలాంధ్ర','https://www.visalaandhra.com/','https://www.visalaandhra.com/feed',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-prabha','news','Andhra Prabha','ఆంధ్రప్రభ','https://www.prabhanews.com/','https://www.prabhanews.com/feed',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-andhrajyothy','news','Andhra Jyothy','ఆంధ్రజ్యోతి','https://www.andhrajyothy.com/','https://www.andhrajyothy.com/rss/feed.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-namasthe','news','Namasthe Telangana','నమస్తే తెలంగాణ','https://www.ntnews.com/','https://www.ntnews.com/rss',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-news18-ap','news','News18 Telugu: Andhra Pradesh','న్యూస్18 తెలుగు: ఆంధ్రప్రదేశ్','https://telugu.news18.com/','https://telugu.news18.com/commonfeeds/v1/tel/rss/andhra-pradesh.xml',NULL,'headline','AP','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-news18-tg','news','News18 Telugu: Telangana','న్యూస్18 తెలుగు: తెలంగాణ','https://telugu.news18.com/','https://telugu.news18.com/commonfeeds/v1/tel/rss/telangana.xml',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-asianet-te','news','Asianet News Telugu','ఏషియానెట్ న్యూస్ తెలుగు','https://telugu.asianetnews.com/','https://telugu.asianetnews.com/rss',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-abp-te','news','ABP Desam (Telugu)','ఏబీపీ దేశం','https://telugu.abplive.com/','https://telugu.abplive.com/home/feed',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-telanganatoday','news','Telangana Today','తెలంగాణ టుడే','https://telanganatoday.com/','https://telanganatoday.com/feed',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-hans-ap','news','The Hans India: Andhra Pradesh','ది హన్స్ ఇండియా: ఆంధ్రప్రదేశ్','https://www.thehansindia.com/andhra-pradesh','https://www.thehansindia.com/andhra-pradesh/feed',NULL,'headline','AP','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-hans-tg','news','The Hans India: Telangana','ది హన్స్ ఇండియా: తెలంగాణ','https://www.thehansindia.com/telangana','https://www.thehansindia.com/telangana/feed',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-hindu-hyd','news','The Hindu: Hyderabad','ది హిందూ: హైదరాబాద్','https://www.thehindu.com/news/cities/Hyderabad/','https://www.thehindu.com/news/cities/Hyderabad/feeder/default.rss',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-hindu-vja','news','The Hindu: Vijayawada','ది హిందూ: విజయవాడ','https://www.thehindu.com/news/cities/Vijayawada/','https://www.thehindu.com/news/cities/Vijayawada/feeder/default.rss',NULL,'headline','AP','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-nie-ap','news','The New Indian Express: Andhra Pradesh','ది న్యూ ఇండియన్ ఎక్స్‌ప్రెస్: ఆంధ్రప్రదేశ్','https://www.newindianexpress.com/states/andhra-pradesh','https://www.newindianexpress.com/states/andhra-pradesh/rssfeed/?id=190',NULL,'headline','AP','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-toi-hyd','news','Times of India: Hyderabad','టైమ్స్ ఆఫ్ ఇండియా: హైదరాబాద్','https://timesofindia.indiatimes.com/city/hyderabad','https://timesofindia.indiatimes.com/rssfeeds/-2128816011.cms',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-ie-hyd','news','The Indian Express: Hyderabad','ది ఇండియన్ ఎక్స్‌ప్రెస్: హైదరాబాద్','https://indianexpress.com/section/cities/hyderabad/','https://indianexpress.com/section/cities/hyderabad/feed/',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-tg-gov','news','Government of Telangana: press releases','తెలంగాణ ప్రభుత్వం: పత్రికా ప్రకటనలు','https://www.telangana.gov.in/','https://www.telangana.gov.in/feed/',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-pib','news','Press Information Bureau (Government of India)','పత్రికా సమాచార కార్యాలయం (భారత ప్రభుత్వం)','https://pib.gov.in/','https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-air','news','All India Radio News (Prasar Bharati)','ఆల్ ఇండియా రేడియో వార్తలు (ప్రసార భారతి)','https://newsonair.gov.in/','https://newsonair.gov.in/rss-feeds/',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z');
`);

// Videos from public-broadcaster, government and news YouTube channels for the Watch tab (S-281), loaded SWITCHED OFF with no permission record.
// Each channel id was read from the channel's own page and its video feed answered with recent videos on 2026-11-27.
registerMigration("mhub_008_video_channel_candidates", `
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,stream_url,allow,state,created_by,created_at) VALUES
 ('cand-ytv-ddnews','news','DD News (Doordarshan) (YouTube videos)','డీడీ న్యూస్ (దూరదర్శన్) (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCKwucPzHZ7zCUIf7If-Wo1g','https://www.youtube.com/feeds/videos.xml?channel_id=UCKwucPzHZ7zCUIf7If-Wo1g',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-sansad','news','Sansad TV (Parliament) (YouTube videos)','సంసద్ టీవీ (పార్లమెంట్) (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCISgnSNwqQ2i8lhCun3KtQg','https://www.youtube.com/feeds/videos.xml?channel_id=UCISgnSNwqQ2i8lhCun3KtQg',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-pib','news','PIB India (YouTube videos)','పీఐబీ ఇండియా (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCGn6a5SI8SNlj7WylmPD6GQ','https://www.youtube.com/feeds/videos.xml?channel_id=UCGn6a5SI8SNlj7WylmPD6GQ',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-bbc-te','news','BBC News Telugu (YouTube videos)','బీబీసీ న్యూస్ తెలుగు (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCiTCB-B_weEmwHk7ifNobQw','https://www.youtube.com/feeds/videos.xml?channel_id=UCiTCB-B_weEmwHk7ifNobQw',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-hans','news','The Hans India (YouTube videos)','ది హన్స్ ఇండియా (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCE5KgJvhksSdNnI3xzizfEA','https://www.youtube.com/feeds/videos.xml?channel_id=UCE5KgJvhksSdNnI3xzizfEA',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-ddsaptagiri','news','DD Saptagiri (Doordarshan, Andhra Pradesh) (YouTube videos)','డీడీ సప్తగిరి (దూరదర్శన్, ఆంధ్రప్రదేశ్) (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCDytyrifMKGH-A2snskPcVw','https://www.youtube.com/feeds/videos.xml?channel_id=UCDytyrifMKGH-A2snskPcVw',NULL,'headline','AP','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-dw','news','DW News (YouTube videos)','డీడబ్ల్యూ న్యూస్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg','https://www.youtube.com/feeds/videos.xml?channel_id=UCknLrEdhRCp1aegoMqRaCZg',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-aljazeera','news','Al Jazeera English (YouTube videos)','అల్ జజీరా ఇంగ్లీష్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg','https://www.youtube.com/feeds/videos.xml?channel_id=UCNye-wNBqNL5ZzHSJj3l8Bg',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z');
`);

// More live news channels (S-286), loaded SWITCHED OFF with no permission record: Telugu (Prime9, ETV Telangana, CVR), Akashvani AIR, Indian national and international news.
// Each was live with a stream YouTube allows to be embedded on 2026-11-27.
registerMigration("mhub_009_more_live_candidates", `
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,stream_url,allow,state,created_by,created_at) VALUES
 ('cand-live-prime9','live','Prime9 News Live','ప్రైమ్9 న్యూస్ లైవ్','https://www.youtube.com/channel/UCLTZ5y21NnklrxpU5AfWd8w',NULL,'https://www.youtube.com/channel/UCLTZ5y21NnklrxpU5AfWd8w/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-etv-tg','live','ETV Telangana Live','ఈటీవీ తెలంగాణ లైవ్','https://www.youtube.com/channel/UC6ickpgDIsltU_-8CbZaksQ',NULL,'https://www.youtube.com/channel/UC6ickpgDIsltU_-8CbZaksQ/live','headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-cvr','live','CVR News Telugu Live','సీవీఆర్ న్యూస్ తెలుగు లైవ్','https://www.youtube.com/channel/UCixD-KrpjXtMupkzkdFFlFg',NULL,'https://www.youtube.com/channel/UCixD-KrpjXtMupkzkdFFlFg/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-akashvani','live','Akashvani AIR Live (Prasar Bharati)','ఆకాశవాణి ఏఐఆర్ లైవ్ (ప్రసార భారతి)','https://www.youtube.com/channel/UCdwm5QNss1TpY_whBkql0dw',NULL,'https://www.youtube.com/channel/UCdwm5QNss1TpY_whBkql0dw/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-ndtv','live','NDTV 24x7 Live','ఎన్డీటీవీ 24x7 లైవ్','https://www.youtube.com/channel/UCZFMm1mMw0F81Z37aaEzTUA',NULL,'https://www.youtube.com/channel/UCZFMm1mMw0F81Z37aaEzTUA/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-indiatoday','live','India Today Live','ఇండియా టుడే లైవ్','https://www.youtube.com/channel/UCYPvAwZP8pZhSMW8qs7cVCw',NULL,'https://www.youtube.com/channel/UCYPvAwZP8pZhSMW8qs7cVCw/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-timesnow','live','Times Now Live','టైమ్స్ నౌ లైవ్','https://www.youtube.com/channel/UC6RJ7-PaXg6TIH2BzZfTV7w',NULL,'https://www.youtube.com/channel/UC6RJ7-PaXg6TIH2BzZfTV7w/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-cnn18','live','CNN-News18 Live','సీఎన్ఎన్-న్యూస్18 లైవ్','https://www.youtube.com/channel/UCef1-8eOpJgud7szVPlZQAQ',NULL,'https://www.youtube.com/channel/UCef1-8eOpJgud7szVPlZQAQ/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-euronews','live','Euronews English Live','యూరోన్యూస్ ఇంగ్లీష్ లైవ్','https://www.youtube.com/channel/UCSrZ3UV4jOidv8ppoVuvW9Q',NULL,'https://www.youtube.com/channel/UCSrZ3UV4jOidv8ppoVuvW9Q/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-france24','live','FRANCE 24 English Live','ఫ్రాన్స్ 24 ఇంగ్లీష్ లైవ్','https://www.youtube.com/channel/UCQfwfsi5VrQ8yKZ-UWmAEFg',NULL,'https://www.youtube.com/channel/UCQfwfsi5VrQ8yKZ-UWmAEFg/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-sky','live','Sky News Live','స్కై న్యూస్ లైవ్','https://www.youtube.com/channel/UCoMdktPbSTixAyNGwb-UYkQ',NULL,'https://www.youtube.com/channel/UCoMdktPbSTixAyNGwb-UYkQ/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-abc-au','live','ABC News Australia Live','ఏబీసీ న్యూస్ ఆస్ట్రేలియా లైవ్','https://www.youtube.com/channel/UCVgO39Bk5sMo66-6o6Spn6Q',NULL,'https://www.youtube.com/channel/UCVgO39Bk5sMo66-6o6Spn6Q/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-nhk','live','NHK World-Japan Live','ఎన్‌హెచ్‌కే వరల్డ్-జపాన్ లైవ్','https://www.youtube.com/channel/UCSPEjw8F2nQDtmUKPFNF7_A',NULL,'https://www.youtube.com/channel/UCSPEjw8F2nQDtmUKPFNF7_A/live','headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-live-trt','live','TRT World Live','టీఆర్‌టీ వరల్డ్ లైవ్','https://www.youtube.com/channel/UC7fWeaHhqgM4Ry-RMpM2YYw',NULL,'https://www.youtube.com/channel/UC7fWeaHhqgM4Ry-RMpM2YYw/live','headline','BOTH','system','2026-11-27T00:00:00.000Z');
`);

// More daily news feeds (S-284), loaded SWITCHED OFF with no permission record: national, state and international. Each answered with a feed our reader parses on 2026-11-27.
registerMigration("mhub_010_more_feed_candidates", `
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,stream_url,allow,state,created_by,created_at) VALUES
 ('cand-feed-ht-india','news','Hindustan Times: India','హిందుస్థాన్ టైమ్స్: భారత్','https://www.hindustantimes.com/india-news','https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-firstpost','news','Firstpost: India','ఫస్ట్‌పోస్ట్: భారత్','https://www.firstpost.com/india','https://www.firstpost.com/commonfeeds/v1/mfp/rss/india.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-vaartha','news','Vaartha (Telugu)','వార్త','https://www.vaartha.com/','https://www.vaartha.com/feed/',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-tnie-tg','news','The New Indian Express: Telangana','ది న్యూ ఇండియన్ ఎక్స్‌ప్రెస్: తెలంగాణ','https://www.newindianexpress.com/states/telangana','https://www.newindianexpress.com/states/telangana/rssfeed/?id=213',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-dc','news','Deccan Chronicle','డెక్కన్ క్రానికల్','https://www.deccanchronicle.com/','https://www.deccanchronicle.com/rss_feed/',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-indiatoday-rss','news','India Today','ఇండియా టుడే','https://www.indiatoday.in/','https://www.indiatoday.in/rss/1206578',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-ndtv-rss','news','NDTV: latest','ఎన్డీటీవీ: తాజా','https://www.ndtv.com/','https://feeds.feedburner.com/NDTV-LatestNews',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-news18-in','news','News18: India','న్యూస్18: భారత్','https://www.news18.com/india/','https://www.news18.com/commonfeeds/v1/eng/rss/india.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-hindu-natl','news','The Hindu: National','ది హిందూ: జాతీయం','https://www.thehindu.com/news/national/','https://www.thehindu.com/news/national/feeder/default.rss',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-hindu-tg-state','news','Telangana news in The Hindu (state page)','తెలంగాణ వార్తలు, ది హిందూ (రాష్ట్ర పేజీ)','https://www.thehindu.com/news/national/telangana/','https://www.thehindu.com/news/national/telangana/feeder/default.rss',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-ie-india','news','The Indian Express: India','ది ఇండియన్ ఎక్స్‌ప్రెస్: భారత్','https://indianexpress.com/section/india/','https://indianexpress.com/section/india/feed/',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-ie-explained','news','The Indian Express: Explained','ది ఇండియన్ ఎక్స్‌ప్రెస్: ఎక్స్‌ప్లెయిన్డ్','https://indianexpress.com/section/explained/','https://indianexpress.com/section/explained/feed/',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-toi-top','news','Times of India: top stories','టైమ్స్ ఆఫ్ ఇండియా: ముఖ్య వార్తలు','https://timesofindia.indiatimes.com/','https://timesofindia.indiatimes.com/rssfeedstopstories.cms',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-toi-india','news','Times of India: India','టైమ్స్ ఆఫ్ ఇండియా: భారత్','https://timesofindia.indiatimes.com/india','https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-bbc-world','news','BBC News: World','బీబీసీ న్యూస్: ప్రపంచం','https://www.bbc.com/news/world','https://feeds.bbci.co.uk/news/world/rss.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-bbc-india','news','BBC News: India','బీబీసీ న్యూస్: భారత్','https://www.bbc.com/news/world/asia/india','https://feeds.bbci.co.uk/news/world/asia/india/rss.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-sky-world','news','Sky News: World','స్కై న్యూస్: ప్రపంచం','https://news.sky.com/world','https://feeds.skynews.com/feeds/rss/world.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-euronews-rss','news','Euronews','యూరోన్యూస్','https://www.euronews.com/','https://www.euronews.com/rss?format=mrss',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-abc-au-rss','news','ABC News (Australia)','ఏబీసీ న్యూస్ (ఆస్ట్రేలియా)','https://www.abc.net.au/news/','https://www.abc.net.au/news/feed/51120/rss.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-npr','news','NPR: top stories','ఎన్‌పీఆర్: ముఖ్య వార్తలు','https://www.npr.org/','https://feeds.npr.org/1001/rss.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-cna-asia','news','CNA: Asia','సీఎన్‌ఏ: ఆసియా','https://www.channelnewsasia.com/asia','https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-un-news','news','UN News','ఐక్యరాజ్యసమితి వార్తలు','https://news.un.org/','https://news.un.org/feed/subscribe/en/news/all/rss.xml',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-nasa','news','NASA: breaking news','నాసా: తాజా వార్తలు','https://www.nasa.gov/','https://www.nasa.gov/rss/dyn/breaking_news.rss',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-greatandhra','news','GreatAndhra: politics','గ్రేట్‌ఆంధ్ర: రాజకీయాలు','https://www.greatandhra.com/','https://www.greatandhra.com/rss',NULL,'headline','AP','system','2026-11-27T00:00:00.000Z'),
 ('cand-feed-bizstd','news','Business Standard: top stories','బిజినెస్ స్టాండర్డ్: ముఖ్య వార్తలు','https://www.business-standard.com/','https://www.business-standard.com/rss/home_page_top_stories.rss',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z');
`);

// More video channels for the Watch tab (S-285), loaded SWITCHED OFF with no permission record. Each channel id was read from the channel's own page and its video feed answered on 2026-11-27.
registerMigration("mhub_011_more_video_candidates", `
INSERT INTO mhub_sources (id,kind,name_en,name_te,site_url,feed_url,stream_url,allow,state,created_by,created_at) VALUES
 ('cand-ytv-prime9','news','Prime9 News (YouTube videos)','ప్రైమ్9 న్యూస్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCLTZ5y21NnklrxpU5AfWd8w','https://www.youtube.com/feeds/videos.xml?channel_id=UCLTZ5y21NnklrxpU5AfWd8w',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-etv-tg','news','ETV Telangana (YouTube videos)','ఈటీవీ తెలంగాణ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UC6ickpgDIsltU_-8CbZaksQ','https://www.youtube.com/feeds/videos.xml?channel_id=UC6ickpgDIsltU_-8CbZaksQ',NULL,'headline','TG','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-cvr','news','CVR News Telugu (YouTube videos)','సీవీఆర్ న్యూస్ తెలుగు (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCixD-KrpjXtMupkzkdFFlFg','https://www.youtube.com/feeds/videos.xml?channel_id=UCixD-KrpjXtMupkzkdFFlFg',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-studion','news','Studio N (Telugu) (YouTube videos)','స్టూడియో ఎన్ (తెలుగు) (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCJkSrimcnkPCDvlDgsOOzNQ','https://www.youtube.com/feeds/videos.xml?channel_id=UCJkSrimcnkPCDvlDgsOOzNQ',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-akashvani','news','Akashvani AIR (YouTube videos)','ఆకాశవాణి ఏఐఆర్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCdwm5QNss1TpY_whBkql0dw','https://www.youtube.com/feeds/videos.xml?channel_id=UCdwm5QNss1TpY_whBkql0dw',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-mygov','news','MyGov India (YouTube videos)','మైగవ్ ఇండియా (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCTJpJk8bqQQEqeX58z8eimA','https://www.youtube.com/feeds/videos.xml?channel_id=UCTJpJk8bqQQEqeX58z8eimA',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-ndtv','news','NDTV (YouTube videos)','ఎన్డీటీవీ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCZFMm1mMw0F81Z37aaEzTUA','https://www.youtube.com/feeds/videos.xml?channel_id=UCZFMm1mMw0F81Z37aaEzTUA',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-indiatoday','news','India Today (YouTube videos)','ఇండియా టుడే (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCYPvAwZP8pZhSMW8qs7cVCw','https://www.youtube.com/feeds/videos.xml?channel_id=UCYPvAwZP8pZhSMW8qs7cVCw',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-timesnow','news','Times Now (YouTube videos)','టైమ్స్ నౌ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UC6RJ7-PaXg6TIH2BzZfTV7w','https://www.youtube.com/feeds/videos.xml?channel_id=UC6RJ7-PaXg6TIH2BzZfTV7w',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-cnn18','news','CNN-News18 (YouTube videos)','సీఎన్ఎన్-న్యూస్18 (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCef1-8eOpJgud7szVPlZQAQ','https://www.youtube.com/feeds/videos.xml?channel_id=UCef1-8eOpJgud7szVPlZQAQ',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-euronews','news','Euronews (YouTube videos)','యూరోన్యూస్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCSrZ3UV4jOidv8ppoVuvW9Q','https://www.youtube.com/feeds/videos.xml?channel_id=UCSrZ3UV4jOidv8ppoVuvW9Q',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-france24','news','FRANCE 24 English (YouTube videos)','ఫ్రాన్స్ 24 ఇంగ్లీష్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCQfwfsi5VrQ8yKZ-UWmAEFg','https://www.youtube.com/feeds/videos.xml?channel_id=UCQfwfsi5VrQ8yKZ-UWmAEFg',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-sky','news','Sky News (YouTube videos)','స్కై న్యూస్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCoMdktPbSTixAyNGwb-UYkQ','https://www.youtube.com/feeds/videos.xml?channel_id=UCoMdktPbSTixAyNGwb-UYkQ',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-abc-au','news','ABC News (Australia) (YouTube videos)','ఏబీసీ న్యూస్ (ఆస్ట్రేలియా) (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCVgO39Bk5sMo66-6o6Spn6Q','https://www.youtube.com/feeds/videos.xml?channel_id=UCVgO39Bk5sMo66-6o6Spn6Q',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-nhk','news','NHK World-Japan (YouTube videos)','ఎన్‌హెచ్‌కే వరల్డ్-జపాన్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UCSPEjw8F2nQDtmUKPFNF7_A','https://www.youtube.com/feeds/videos.xml?channel_id=UCSPEjw8F2nQDtmUKPFNF7_A',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z'),
 ('cand-ytv-trt','news','TRT World (YouTube videos)','టీఆర్‌టీ వరల్డ్ (యూట్యూబ్ వీడియోలు)','https://www.youtube.com/channel/UC7fWeaHhqgM4Ry-RMpM2YYw','https://www.youtube.com/feeds/videos.xml?channel_id=UC7fWeaHhqgM4Ry-RMpM2YYw',NULL,'headline','BOTH','system','2026-11-27T00:00:00.000Z');
`);

export const MIN_COUNT_SHOWN = 10;
export const NEWS_KEEP_DAYS = 7, STALE_HOURS = 6, REFRESH_MINUTES = 15;
const MAX_ITEMS_PER_FETCH = 50, MAX_FEED_BYTES = 1_000_000, FETCH_TIMEOUT_MS = 8000;
const REASONS = ["wrong", "partisan", "offensive", "broken", "other"] as const;

class Bad extends Error { constructor(public code: string, m: string) { super(m); } }
const str = (v: unknown): string => (typeof v === "string" ? v.normalize("NFKC").trim() : "");
const fail = (res: express.Response, status: number, code: string, message: string): void => { res.status(status).json({ error: code, code, message }); };
const st = (): MediaHubStore => new MediaHubStore(identityDb());
const isLocal = (h: string) => h === "localhost" || h === "127.0.0.1";

type Src = SourceRow;

/** https only (http for localhost outside production); no login in the address; not too long. */
export function checkUrl(label: string, raw: string, opts: { allowedHostsOnly?: boolean } = {}): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Bad("bad_url", `${label}: not a valid web address`); }
  const local = isLocal(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && !isProductionEnv())) throw new Bad("bad_url", `${label}: must start with https://`);
  if (u.username || u.password) throw new Bad("bad_url", `${label}: must not contain a login`);
  if (raw.length > 500) throw new Bad("bad_url", `${label}: too long`);
  if (local && isProductionEnv()) throw new Bad("bad_url", `${label}: a local address is not allowed`);
  if (opts.allowedHostsOnly && !local && !mediaVideoHosts().includes(u.hostname.toLowerCase())) throw new Bad("host_not_allowed", `${label}: this host is not on the approved list for media (MEDIA_VIDEO_HOSTS)`);
  return u.toString();
}

function text(label: string, v: unknown, min: number, max: number, required: boolean): string | null {
  const s = str(v);
  if (!s) { if (required) throw new Bad("bad_" + label, `${label} is required`); return null; }
  if (s.length < min || s.length > max) throw new Bad("bad_" + label, `${label}: ${min} to ${max} characters`);
  if (asksSecret(s)) throw new Bad("text_refused", `${label} asks for a code, PIN, password or ID number`);
  return s;
}

const srcPublic = (s: Src) => ({ id: s.id, kind: s.kind, name_en: s.name_en, name_te: s.name_te, site_url: s.site_url, state: s.state });

/** A YouTube video id from a watch or short link on youtube.com / youtu.be, else null. Used only to offer YouTube's own embed player; nothing is downloaded. */
export function youtubeId(link: string): string | null {
  try {
    const u = new URL(link);
    const h = u.hostname.toLowerCase();
    const id = h === "youtu.be" ? u.pathname.slice(1) : (h === "www.youtube.com" || h === "youtube.com" || h === "m.youtube.com") ? (u.pathname === "/watch" ? (u.searchParams.get("v") ?? "") : u.pathname.startsWith("/shorts/") ? u.pathname.slice(8) : "") : "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
/** YouTube publishes an official public feed for every channel. We build its address from the channel id so an admin cannot point it anywhere else. */
/** A YouTube channel live address (youtube.com/channel/UC.../live): the channel's current live stream, played in YouTube's own embed. */
export const isYoutubeLiveChannel = (link: string): boolean => /^https:\/\/(www\.)?youtube\.com\/channel\/UC[A-Za-z0-9_-]{22}\/live\/?$/.test(link);
export const youtubeFeedUrl = (channelId: string): string => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

export async function addSource(adminId: string, body: Record<string, unknown>, now: Date = new Date()): Promise<Src> {
  const kind = body.kind === "live" ? "live" : body.kind === "news" ? "news" : null;
  if (!kind) throw new Bad("bad_kind", "kind must be news or live");
  const name_en = text("name", body.name_en, 2, 80, true)!, name_te = text("name_te", body.name_te, 1, 120, false);
  const yt = str(body.youtube_channel_id);
  if (yt && (kind !== "news" || !/^UC[A-Za-z0-9_-]{22}$/.test(yt))) throw new Bad("bad_youtube", "a YouTube channel id starts with UC and is 24 characters, and is only for a news source");
  const site_url = checkUrl("site address", str(body.site_url) || (yt ? `https://www.youtube.com/channel/${yt}` : ""));
  const feed_url = kind === "news" ? (yt ? youtubeFeedUrl(yt) : checkUrl("feed address", str(body.feed_url))) : null;
  const stream_url = kind === "live" && str(body.stream_url) ? (youtubeId(str(body.stream_url)) || isYoutubeLiveChannel(str(body.stream_url)) ? checkUrl("stream address", str(body.stream_url)) : checkUrl("stream address", str(body.stream_url), { allowedHostsOnly: true })) : null;
  const allow = body.allow === "snippet" ? "snippet" : "headline";
  const state = body.state === "AP" || body.state === "TG" ? body.state : "BOTH";
  const id = crypto.randomUUID();
  await st().insertSource({ id, kind, name_en, name_te, site_url, feed_url, stream_url, allow, state, created_by: adminId, created_at: now.toISOString(), permission_note: text("permission_note", body.permission_note, 10, 500, false), permission_date: str(body.permission_date) || null, contact: text("contact", body.contact, 5, 160, false) });
  audit(adminId, "media.source.add", "mhub-source:" + id, { kind });
  return await getSource(id);
}

/**
 * Paste-a-link (S-239): one YouTube video from a channel that gave us permission. It is stored as its own news source with no feed, so it needs the same
 * permission record and a different admin to switch it on, and it can be switched off or taken down like any source. The title is typed by the admin
 * (we do not fetch the page); the video is shown for 7 days like other news. Nothing is downloaded.
 */
export async function addVideoLink(adminId: string, body: Record<string, unknown>, now: Date = new Date()): Promise<Src> {
  const link = str(body.link);
  const vid = youtubeId(link);
  if (!vid) throw new Bad("bad_youtube", "paste a YouTube video link (youtube.com/watch?v=..., youtu.be/... or youtube.com/shorts/...)");
  const title = text("title", body.title, 3, 200, true)!;
  const watch = `https://www.youtube.com/watch?v=${vid}`;
  const s = await addSource(adminId, { kind: "news", name_en: body.channel_name, name_te: body.channel_name_te, site_url: watch, feed_url: watch, allow: "headline", state: body.state, permission_note: body.permission_note, permission_date: body.permission_date, contact: body.contact }, now);
  await st().clearFeed(s.id, now.toISOString());
  await st().insertNews({ id: crypto.randomUUID(), source_id: s.id, title, link: watch, snippet: null, published_at: now.toISOString(), fetched_at: now.toISOString() });
  audit(adminId, "media.video-link.add", "mhub-source:" + s.id, { video: vid });
  return await getSource(s.id);
}

export async function getSource(id: string): Promise<Src> {
  const s = await st().source(id);
  if (!s) throw new Bad("not_found", "no such source");
  return s;
}

/** Records the permission for a source that was added without one (for example a candidate loaded switched off). The admin who records it cannot also switch it on. */
export async function recordPermission(adminId: string, id: string, body: Record<string, unknown>, now: Date = new Date()): Promise<Src> {
  const s = await getSource(id);
  if (s.enabled) throw new Bad("already_on", "switch the source off before changing its permission record");
  const note = text("permission_note", body.permission_note, 10, 500, true)!, contact = text("contact", body.contact, 5, 160, true)!;
  const d = new Date(str(body.permission_date));
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime() + 86_400_000) throw new Bad("bad_date", "the permission date must be a real date, not in the future");
  await st().setPermission(id, note, str(body.permission_date), contact, adminId);
  audit(adminId, "media.source.permission", "mhub-source:" + id);
  return await getSource(id);
}

/** Switching on needs the permission record AND a different admin than the one who added it or recorded the permission. */
export async function enableSource(adminId: string, id: string, now: Date = new Date()): Promise<Src> {
  const s = await getSource(id);
  if (s.created_by === adminId || s.permission_by === adminId) throw new Bad("same_person", "a different admin must switch a source on");
  const date = s.permission_date ? new Date(s.permission_date) : null;
  if (!s.permission_note || !s.contact || !date || Number.isNaN(date.getTime()) || date.getTime() > now.getTime() + 86_400_000)
    throw new Bad("permission_missing", "record the permission first: a note saying why we may show it, the date it was given, and a contact at the source");
  await st().enable(id, adminId, now.toISOString());
  audit(adminId, "media.source.enable", "mhub-source:" + id);
  return await getSource(id);
}

export async function disableSource(adminId: string, id: string): Promise<Src> {
  await getSource(id);
  await st().disable(id);
  audit(adminId, "media.source.disable", "mhub-source:" + id);
  return await getSource(id);
}

/* ---------------- feeds ---------------- */

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
const decode = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENT[m] ?? m).replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));
const plain = (s: string): string => decode(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const tag = (block: string, name: string): string | null => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block); return m ? m[1] : null; };

export interface FeedItem { title: string; link: string; published: string; snippet: string | null }
/** A small RSS 2.0 / Atom reader. Items without a title, a usable link or a date are skipped; the article body is never kept. */
export function parseFeed(xml: string, now: Date = new Date()): FeedItem[] {
  const out: FeedItem[] = [];
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  for (const b of blocks.slice(0, 200)) {
    const title = plain(tag(b, "title") ?? "").slice(0, 200);
    let link = plain(tag(b, "link") ?? "");
    if (!link) { const m = /<link[^>]*\shref=["']([^"']+)["']/i.exec(b); link = m ? decode(m[1]) : ""; }
    const when = plain(tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date") ?? "");
    const d = new Date(when);
    const snippet = plain(tag(b, "description") ?? tag(b, "summary") ?? "").slice(0, 240) || null;
    if (title.length < 3 || !link) continue;
    try { const u = new URL(link); if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u.hostname) && !isProductionEnv())) continue; link = u.toString(); } catch { continue; }
    const published = Number.isNaN(d.getTime()) ? now : d;
    if (published.getTime() > now.getTime() + 86_400_000) continue; // a date far in the future is a broken feed, not news
    out.push({ title, link, published: published.toISOString(), snippet });
  }
  return out;
}

export type Fetcher = (url: string, init: { method?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
const realFetch: Fetcher = (url, init) => fetch(url, init) as unknown as ReturnType<Fetcher>;

export async function refreshSource(id: string, fetcher: Fetcher = realFetch, now: Date = new Date()): Promise<{ added: number }> {
  const s = await getSource(id);
  if (s.kind !== "news" || !s.feed_url) throw new Bad("not_news", "this source has no news feed");
  if (!s.enabled) throw new Bad("not_enabled", "this source is switched off, so nothing is fetched from it");
  await st().markFetch(id, now.toISOString());
  try {
    const r = await fetcher(s.feed_url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`the source answered ${r.status}`);
    const body = await r.text();
    if (body.length > MAX_FEED_BYTES) throw new Error("the feed is larger than 1 MB");
    const items = parseFeed(body, now).slice(0, MAX_ITEMS_PER_FETCH);
    let added = 0;
    for (const it of items) {
      if (await st().addNewsIfNew({ id: crypto.randomUUID(), source_id: id, title: it.title, link: it.link, snippet: s.allow === "snippet" ? it.snippet : null, published_at: it.published, fetched_at: now.toISOString() })) added++;
    }
    await st().markOk(id, now.toISOString());
    await st().deleteNewsBefore(new Date(now.getTime() - NEWS_KEEP_DAYS * 86_400_000).toISOString());
    return { added };
  } catch (e) {
    await st().markError(id, String((e as Error).message).slice(0, 200));
    throw new Bad("fetch_failed", `could not read the feed: ${(e as Error).message}`);
  }
}

/** Refreshes every enabled news source not fetched in the last REFRESH_MINUTES. Used by the news route (without waiting) and by tests. */
export async function refreshDue(fetcher: Fetcher = realFetch, now: Date = new Date()): Promise<void> {
  const due = await st().dueIds(new Date(now.getTime() - REFRESH_MINUTES * 60_000).toISOString());
  for (const d of due) await refreshSource(d, fetcher, now).catch(() => undefined);
}

export async function newsFor(state: string | undefined, now: Date = new Date()) {
  const since = new Date(now.getTime() - NEWS_KEEP_DAYS * 86_400_000).toISOString();
  const stt = state === "AP" || state === "TG" ? state : null;
  // Headlines and YouTube videos are read separately: with many channels switched on, the newest 100 rows would otherwise be all videos (or all headlines).
  const heads = await st().newsRows(since, stt, false, 150);
  const vids = await st().newsRows(since, stt, true, 400);
  const rows = [...heads, ...vids].sort((a, b) => (a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0));
  const items = rows.map((r) => ({ id: r.id, title: r.title, link: r.link, snippet: r.snippet, published_at: r.published_at, outlet_en: r.name_en, outlet_te: r.name_te, source_id: r.sid, youtube: youtubeId(r.link) }));
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const digest = items.filter((i) => i.published_at >= dayAgo).slice(0, 5);
  const srcs = await st().enabledNewsSources();
  const staleBefore = new Date(now.getTime() - STALE_HOURS * 3_600_000).toISOString();
  return { items, digest, sources: srcs.map((s) => ({ ...srcPublic(s), stale: !!s.feed_url && (!s.last_ok_at || s.last_ok_at < staleBefore) })), label: "publisher" };
}

/* ---------------- live channels ---------------- */

export async function checkStream(id: string, fetcher: Fetcher = realFetch, now: Date = new Date()): Promise<boolean> {
  const s = await getSource(id);
  if (s.kind !== "live" || !s.stream_url) throw new Bad("no_stream", "this channel has no stream address to check");
  if (youtubeId(s.stream_url) || isYoutubeLiveChannel(s.stream_url)) throw new Bad("youtube_unchecked", "a YouTube stream plays in YouTube's own player; we cannot check it from here");
  let ok = false;
  try { const r = await fetcher(s.stream_url, { method: "HEAD", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); ok = r.ok; } catch { ok = false; }
  await st().setHealth(id, ok, now.toISOString());
  return ok;
}
export const liveChannels = async () => (await st().enabledLive())
  .map((s) => ({ ...srcPublic(s), stream_url: s.stream_url, health_ok: s.health_ok === null ? null : s.health_ok === 1, health_at: s.health_at }));

/* ---------------- counts, reports ---------------- */

export async function countClick(kind: string, id: string, now: Date = new Date()): Promise<void> {
  if (kind !== "news" && kind !== "live") throw new Bad("bad_kind", "kind must be news or live");
  const ok = kind === "news" ? await st().newsClickable(id) : await st().liveClickable(id);
  if (!ok) throw new Bad("not_found", "no such item");
  await st().bump(kind, id, now.toISOString().slice(0, 10));
}

export async function reportItem(personId: string, body: Record<string, unknown>, now: Date = new Date()): Promise<void> {
  const kind = str(body.kind), item = str(body.id), reason = str(body.reason);
  if (!["video", "news", "live"].includes(kind)) throw new Bad("bad_kind", "kind must be video, news or live");
  if (!(REASONS as readonly string[]).includes(reason)) throw new Bad("bad_reason", "choose a reason from the list");
  const note = str(body.note);
  if (note && (note.length > 200 || hasLink(note) || asksSecret(note) || asksPartyPreference(note))) throw new Bad("bad_note", "the note is at most 200 characters, with no link, no code or ID number and no party choice");
  const exists = kind === "video" ? await st().videoExists(item) : kind === "news" ? await st().newsExists(item) : await st().liveExists(item);
  if (!exists) throw new Bad("not_found", "no such item");
  const reporter = getKeys().hmac("media-report", `${kind}:${item}:${personId}`); // one report per person per item, and no person id in the table
  if (!(await st().addReport({ id: crypto.randomUUID(), kind, item_id: item, reason, note: note || null, reporter, at: now.toISOString() }))) throw new Bad("already_reported", "you have already reported this item");
}

export async function resolveReport(adminId: string, id: string, action: unknown, now: Date = new Date()): Promise<void> {
  const r = await st().openReport(id);
  if (!r) throw new Bad("not_found", "no open report with that id");
  if (action !== "dismiss" && action !== "takedown") throw new Bad("bad_action", "action must be dismiss or takedown");
  if (action === "takedown") {
    if (r.kind === "video") { try { await recallVideo(adminId, r.item_id, "Withdrawn after a member report"); } catch (e) { if ((e as { code?: string }).code !== "not_live") throw e; } }
    else if (r.kind === "news") await st().hideNews(r.item_id);
    else await st().disable(r.item_id);
  }
  // every open report on the same item is closed together
  await st().closeReports(r.kind, r.item_id, adminId, now.toISOString(), String(action));
  audit(adminId, "media.report." + String(action), `mhub-${r.kind}:${r.item_id}`);
}

export async function numbers() {
  const rows = await st().counts();
  const names = new Map<string, string>();
  for (const r of rows) names.set(r.kind + ":" + r.item_id, ((r.kind === "news" ? await st().newsTitle(r.item_id) : await st().sourceName(r.item_id)) ?? r.item_id));
  const name = (kind: string, id: string): string => names.get(kind + ":" + id) ?? id;
  const videos = await st().countedVideos();
  return {
    min_shown: MIN_COUNT_SHOWN,
    items: [
      ...rows.map((r) => ({ kind: r.kind === "news" ? "news link opens" : "live channel opens", item_id: r.item_id, name: name(r.kind, r.item_id), total: r.total >= MIN_COUNT_SHOWN ? r.total : null, last_day: r.last_day })),
      ...videos.map((v) => ({ kind: "video plays", item_id: v.id, name: v.title_en, total: v.views >= MIN_COUNT_SHOWN ? v.views : null, last_day: null })),
    ],
  };
}

/* ---------------- demo news (S-245) ---------------- */

/** Preview only: CIVIC_DEMO_NEWS=1, never in production. One clearly labelled sample source with sample headlines we wrote, so the News tab can be looked at before any real outlet is cleared. */
/** DEV-ONLY preview of the loaded candidate sources (CIVIC_PREVIEW_SOURCES=1, never in production). It switches the candidates on, with a plain note that no permission is recorded,
 * so the News, Watch and Live tabs can be tried with real content. Turning the setting off puts them back. It never touches a source an admin switched on or recorded permission for. */
export const previewSourcesEnabled = (): boolean => !isProductionEnv() && process.env.CIVIC_PREVIEW_SOURCES === "1";
export const PREVIEW_NOTE = "PREVIEW ONLY (development setting): no permission has been recorded for this source";
export async function applyPreviewSources(now: Date = new Date()): Promise<void> {
  const d = st();
  if (previewSourcesEnabled()) await d.previewOn(now.toISOString(), PREVIEW_NOTE, now.toISOString().slice(0, 10));
  else await d.previewOff();
}

export const demoNewsEnabled = (): boolean => !isProductionEnv() && process.env.CIVIC_DEMO_NEWS === "1";
const DEMO_ID = "demo-news";
const DEMO_ITEMS = [
  "Sample headline: a village water scheme opens (not real news)",
  "Sample headline: road repair work begins near a market town (not real news)",
  "Sample headline: a school reopens after repairs (not real news)",
  "Sample headline: a health camp is held in a mandal (not real news)",
  "Sample headline: a bus service is extended to a new route (not real news)",
];
export async function ensureDemoNews(now: Date = new Date()): Promise<void> {
  if (!demoNewsEnabled()) return;
  const d = st(), iso = now.toISOString(), day = iso.slice(0, 10);
  if (!(await d.sourceExists(DEMO_ID))) {
    await d.insertSource({ id: DEMO_ID, kind: "news", name_en: "DEMO outlet (sample headlines, not real news)", name_te: "డెమో (నమూనా శీర్షికలు, నిజమైన వార్తలు కావు)", site_url: "https://example.com/", feed_url: null, allow: "headline", state: "BOTH", created_by: "system", created_at: iso, permission_note: "Sample content written by us for a preview; no real outlet is involved", permission_date: day, contact: "demo@example.invalid", enabled: 1, enabled_by: "system", enabled_at: iso, last_ok_at: iso });
  }
  // One sample live channel that "streams" a looping sample clip from our own server, so the Live tab player can be seen working. Clearly labelled; demo only.
  if (!(await d.sourceExists("demo-live"))) {
    await d.insertSource({ id: "demo-live", kind: "live", name_en: "DEMO live channel (sample clip, not a real broadcast)", name_te: "డెమో ప్రత్యక్ష ఛానల్ (నమూనా క్లిప్, నిజమైన ప్రసారం కాదు)", site_url: "https://example.com/", feed_url: null, stream_url: "/demo/sample-1.webm", allow: "headline", state: "BOTH", created_by: "system", created_at: iso, permission_note: "Sample clip made by us for a preview; no real channel is involved", permission_date: day, contact: "demo@example.invalid", enabled: 1, enabled_by: "system", enabled_at: iso });
  }
  // Fresh times on every call so the samples never age out of the 7-day window.
  await d.markOk(DEMO_ID, iso);
  for (const [i, t] of DEMO_ITEMS.entries()) {
    await d.refreshNews({ id: crypto.randomUUID(), source_id: DEMO_ID, title: t, link: `https://example.com/demo-story-${i + 1}`, snippet: null, published_at: new Date(now.getTime() - (20 + i * 45) * 60_000).toISOString(), fetched_at: iso });
  }
}

/** Three short sample clips (made for the preview, files in public/demo) so the Watch tab can be played before any real video is cleared. */
export const demoVideos = () => demoNewsEnabled() ? [
  { id: "demo-1", title: "Sample clip 1: how to read a result sheet (demo, not news)", media_url: "/demo/sample-1.webm", credit: "People Pulse demo clip" },
  { id: "demo-2", title: "Sample clip 2: where to report a local issue (demo, not news)", media_url: "/demo/sample-2.webm", credit: "People Pulse demo clip" },
  { id: "demo-3", title: "Sample clip 3: how a survey result is published (demo, not news)", media_url: "/demo/sample-3.webm", credit: "People Pulse demo clip" },
] : [];

/* ---------------- routes ---------------- */

export const mediaRouter = Router();
mediaRouter.use(express.json({ limit: "16kb" }));
const wrap = (fn: (req: express.Request, res: express.Response) => void | Promise<void>) => (req: express.Request, res: express.Response): void => {
  Promise.resolve().then(() => fn(req, res)).catch((e) => {
    if (e instanceof Bad) fail(res, e.code === "not_found" ? 404 : ["same_person", "not_enabled", "already_reported"].includes(e.code) ? 409 : e.code === "fetch_failed" ? 502 : 400, e.code, e.message);
    else { console.error(e); fail(res, 500, "error", "server error"); }
  });
};
const adminOnly = [requireAuth, requireRole("admin")];

mediaRouter.get("/news", wrap(async (req, res) => {
  res.set("Cache-Control", "no-store");
  await ensureDemoNews(); await applyPreviewSources();
  void refreshDue().catch(() => undefined); // never makes the reader wait
  res.json(await newsFor(typeof req.query.state === "string" ? req.query.state : undefined));
}));
mediaRouter.get("/preview", wrap((_req, res) => { res.set("Cache-Control", "no-store"); res.json({ preview: previewSourcesEnabled() }); }));
mediaRouter.get("/demo-videos", wrap((_req, res) => { res.set("Cache-Control", "no-store"); res.json({ videos: demoVideos() }); }));
mediaRouter.get("/live", wrap(async (_req, res) => { res.set("Cache-Control", "no-store"); await ensureDemoNews(); await applyPreviewSources(); res.json({ channels: await liveChannels(), preview: previewSourcesEnabled() }); }));
mediaRouter.post("/click", wrap(async (req, res) => { await countClick(str(req.body?.kind), str(req.body?.id)); res.json({ ok: true }); }));
mediaRouter.post("/report", requireAuth, wrap(async (req, res) => { await reportItem(req.person!.id, req.body ?? {}); res.status(201).json({ ok: true }); }));

mediaRouter.get("/admin/sources", ...adminOnly, wrap(async (req, res) => {
  const rows = await st().allSources();
  res.json({ sources: rows.map((s) => ({ ...s, enabled: s.enabled === 1, mine: s.created_by === req.person!.id || s.permission_by === req.person!.id, created_by: undefined, enabled_by: undefined, permission_by: undefined })), min_shown: MIN_COUNT_SHOWN, hosts: mediaVideoHosts() });
}));
mediaRouter.post("/admin/videos", ...adminOnly, wrap(async (req, res) => { const s = await addVideoLink(req.person!.id, req.body ?? {}); res.status(201).json({ id: s.id }); }));
mediaRouter.post("/admin/sources", ...adminOnly, wrap(async (req, res) => { const s = await addSource(req.person!.id, req.body ?? {}); res.status(201).json({ id: s.id }); }));
mediaRouter.post("/admin/sources/:id/permission", ...adminOnly, wrap(async (req, res) => { await recordPermission(req.person!.id, String(req.params.id), req.body ?? {}); res.json({ ok: true }); }));
mediaRouter.post("/admin/sources/:id/enable", ...adminOnly, wrap(async (req, res) => { await enableSource(req.person!.id, String(req.params.id)); res.json({ ok: true }); }));
mediaRouter.post("/admin/sources/:id/disable", ...adminOnly, wrap(async (req, res) => { await disableSource(req.person!.id, String(req.params.id)); res.json({ ok: true }); }));
mediaRouter.post("/admin/sources/:id/refresh", ...adminOnly, wrap(async (req, res) => { res.json(await refreshSource(String(req.params.id))); }));
mediaRouter.post("/admin/sources/:id/check", ...adminOnly, wrap(async (req, res) => { res.json({ ok: await checkStream(String(req.params.id)) }); }));
mediaRouter.get("/admin/reports", ...adminOnly, wrap(async (_req, res) => {
  const rows = await st().reports();
  res.json({ reports: rows });
}));
mediaRouter.post("/admin/reports/:id/resolve", ...adminOnly, wrap(async (req, res) => { await resolveReport(req.person!.id, String(req.params.id), req.body?.action); res.json({ ok: true }); }));
mediaRouter.get("/admin/numbers", ...adminOnly, wrap(async (_req, res) => { res.json(await numbers()); }));
