# Media sources research (2026-11-27)

What was searched, what answered, what is loaded and what is not. Everything loaded is **switched off with no permission record**; the Media hub rules (permission note, date, contact, a different admin to switch on) are unchanged. A public feed or a public YouTube channel is not permission, and nothing here was switched on.

## Method
Each address was fetched on 2026-11-27 and read with the app's own reader (`parseFeed`), so "works" means our reader gets headline, link and time. YouTube channel ids were read from each channel's own page, each video feed was fetched, and each live stream was checked for "live now" and for an oEmbed answer (YouTube answers oEmbed only for videos that allow embedding).

## News tab: 21 new feeds (S-280)
| Group | Feeds | Result |
|---|---|---|
| Telugu-language | BBC News Telugu (14 items), Oneindia Telugu (30), Visalaandhra (10), Andhra Prabha (10), Andhra Jyothy (200), Namasthe Telangana (200), News18 Telugu AP and TG (200 each), Asianet News Telugu (131), ABP Desam (21) | all parsed, titles in Telugu |
| English, state editions | Telangana Today, The Hans India AP and TG, The Hindu Hyderabad and Vijayawada, The New Indian Express AP, Times of India Hyderabad, The Indian Express Hyderabad | parsed |
| Government and public broadcaster | Government of Telangana press releases, PIB (national), All India Radio News | parsed (PIB returns 20 items, Hindi first; AIR returns 100) |

Terms found: **PIB's copyright policy says its material may be reproduced free of charge and no prior approval is needed** (not for third-party material inside a release), so PIB is the strongest "free" candidate: an admin can record that policy page as the permission note. BBC's current feed terms and DW's terms could not be confirmed from the search (older BBC terms allowed linking feeds on websites with conditions); read them before use. Other outlets' terms were not read; assume permission is needed.

Not loaded (failed or not useful): DD News website feed (timed out), AIR English feed address (fetch failed), Mana Telangana and Teluguglobal (fetch failed), Eenadu (no feed), Greatandhra, Samayam Telugu, Zee News Telugu, Hindustan Times Telugu (404, 503 or zero items), ETV Bharat (404 or 410), Tribune, The Wire (blocked or empty), AP and Telangana CMO sites (unreachable), Wikinews (feed address changed, 404), Telugu360 (entertainment only), a Google News Hyderabad topic (single item). International feeds (DW, Al Jazeera, France 24, BBC India) answered but are not AP or Telangana news and were left out of the News tab.

## Watch tab: 8 YouTube channels (S-281)
DD News, Sansad TV, PIB India, BBC News Telugu, The Hans India, DD Saptagiri, DW News, Al Jazeera English. All answered with recent videos (DD Saptagiri only 7, the last on 2026-11-20). With the 10 Telugu channels from S-279 this makes 18 video channels. Not added: Telangana CMO, Telangana Today and AP Government channels (YouTube returned errors, or one feed had a single video), DD India and AIR News (errors). Public-body channels are the best fit for "free", but a channel's content can include third-party material.

## Live tab: 15 live channels (S-282)
NTV, TV9 Telugu, Sakshi TV, 10TV, TV5, ABN, V6, T News, Mahaa and ETV Andhra Pradesh Telugu news; DD News, Sansad TV and DD Saptagiri (Doordarshan and Parliament); Al Jazeera English and DW News. Fourteen were live on 2026-11-27 with an embeddable stream (DD Saptagiri showed a weaker live signal; confirm). Each plays through YouTube's no-cookie live embed by channel (`youtube.com/channel/UC.../live`), so the address stays right when the channel starts a new broadcast. When a channel is not live, YouTube's player says so.

## What is still the owner's
Permission from each source (or recording a published open licence such as PIB's policy), reading each outlet's and YouTube's terms, confirming that TV9, TV5 and DD Saptagiri are the right YouTube channels, and a Telugu review of the machine-drafted Telugu names. Nothing is shown to members until an admin records permission and a different admin switches a source on.

## Second pass (S-284 to S-286)
Added after more searching: 25 news feeds, 16 video channels and 14 live channels, every one fetched and checked the same way. Live channels added: Prime9, ETV Telangana, CVR News Telugu, Akashvani AIR, NDTV, India Today, Times Now, CNN-News18, Euronews, FRANCE 24 English, Sky News, ABC News Australia, NHK World-Japan, TRT World (all live with an embeddable stream on 2026-11-27).

Tried and not added: HMTV (old channel, 2 videos), Studio N is added for video only (no live), Swatantra TV (not live, last upload May 2026), Bharat Today and TV1 (old or non-news), Raj News, News Capital and Suman TV (no channel found under the guessed name), WION and Lok Sabha TV (channel id found but no recent videos), The Hindu's YouTube channel (last upload 2016), CNA's channel (not found). Feeds that failed or returned nothing: ThePrint (empty), The Wire, Deccan Herald, The News Minute, TNIE national (404), Sakshi Post, Teluguone, Way2News, TeluguStop, MEA, ECI, HMDA, Tirumala, ISRO, Guardian (403), TRT and NHK (empty or 404). WHO's feed returned old items.

Preview mode (S-283) is the way to try all of this without permission records: see docs/MEDIA_HUB.md.
